import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createStore } from "./store.js";
import { classifyEntry, compileKeywordRe, DEFAULT_EXEMPT_KEYWORDS, DEFAULT_PROJECT_KEYWORDS, buildLlmPrompt, parseLlmDecisions } from "./triage.js";
import { planClusters, buildMergePlan } from "./merge.js";
import { syncMirror } from "./mirror.js";

export const name = "dsh-memory-triage";
export const inject = ["llm", "agentDefaultModel", "commands"];

const DEFAULTS = {
  memoryDir: "~/.dsh/memory",
  enabled: true,
  debounceMs: 5000,
  triggerThresholdCount: 3,
  triggerThresholdChars: 3000,
  archiveLowImportance: true,
  minDice: 0.62,
  exemptKeywords: DEFAULT_EXEMPT_KEYWORDS,
  projectKeywords: DEFAULT_PROJECT_KEYWORDS,
  llmFallback: true,
  llmBatchSize: 8,
  llmMaxTokens: 2048,
  purgeDays: 30,
  purgeOnSchedule: false
};

export const apply = (ctx, config) => {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const memoryDir = cfg.memoryDir.startsWith("~") ? join(homedir(), cfg.memoryDir.slice(1)) : cfg.memoryDir;
  const logger = ctx.logger;
  let disposed = false;
  let store = null;

  const exemptRe = compileKeywordRe(cfg.exemptKeywords);
  const projectRe = compileKeywordRe(cfg.projectKeywords);

  function statePath() { return join(memoryDir, "triage-state.json"); }
  function readState() { try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return null; } }
  function writeState(s) { try { writeFileSync(statePath(), JSON.stringify(s), "utf8"); } catch { /* non-fatal */ } }

  function resolveRoute() {
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.();
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
    } catch { /* fall through to config */ }
    if (cfg.llmProvider && cfg.llmModel) return { provider: cfg.llmProvider, model: cfg.llmModel };
    return undefined;
  }

  async function llmStream(options) {
    let text = "";
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) return undefined;
    }
    return text;
  }

  async function runTriage({ full = false } = {}) {
    if (!store) store = createStore(memoryDir);
    const result = { retyped: 0, archivedLow: 0, merged: 0, archivedByMerge: 0, llmJudged: 0, llmSkipped: 0, purged: 0 };

    const rows = store.listActive().filter((m) => m.type !== "summary");

    if (!full) {
      const state = readState();
      const count = rows.length;
      const chars = rows.reduce((s, m) => s + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
      if (state && count < state.count + (cfg.triggerThresholdCount ?? 3) && chars < state.chars + (cfg.triggerThresholdChars ?? 3000)) {
        return { skipped: true, ...result };
      }
    }

    // Phase 1: rule-based classification of preference/decision entries.
    const retypeIds = [];
    const archiveLowIds = [];
    const ambiguous = [];
    for (const m of rows) {
      const verdict = classifyEntry(m, exemptRe, projectRe, cfg.archiveLowImportance);
      if (verdict === "retype-project") retypeIds.push(m.id);
      else if (verdict === "archive-low") archiveLowIds.push(m.id);
      else if (verdict === "ambiguous") ambiguous.push(m);
    }

    for (const id of retypeIds) result.retyped += store.retype(id, "project");
    for (const id of archiveLowIds) result.archivedLow += store.archive(id);

    // Phase 2: near-duplicate merge per bucket (soft archive, recoverable).
    const current = store.listActive().filter((m) => m.type !== "summary");
    for (const type of ["preference", "project", "decision"]) {
      const bucket = current.filter((m) => m.type === type);
      const { merges, archiveIds } = buildMergePlan(planClusters(bucket, { minDice: cfg.minDice }));
      for (const p of merges) store.updateContent(p.keepId, p.title, p.content, p.importance);
      for (const id of archiveIds) store.archive(id);
      result.merged += merges.length;
      result.archivedByMerge += archiveIds.length;
    }

    // Phase 3: LLM fallback for entries the rules could not decide.
    if (cfg.llmFallback && ambiguous.length > 0) {
      const route = resolveRoute();
      if (route) {
        const batch = ambiguous.slice(0, Math.max(1, cfg.llmBatchSize ?? 8));
        try {
          const raw = await llmStream({
            provider: route.provider,
            model: route.model,
            purpose: "triage",
            maxTokens: cfg.llmMaxTokens ?? 2048,
            messages: buildLlmPrompt(batch).messages
          });
          const decisions = parseLlmDecisions(raw);
          const byId = new Map(batch.map((e) => [e.id, e]));
          for (const d of decisions) {
            const entry = byId.get(d.id);
            if (!entry) continue;
            if (d.action === "retype_project") store.retype(d.id, "project");
            else if (d.action === "archive") store.archive(d.id);
            result.llmJudged++;
          }
        } catch (error) {
          logger?.warn?.(`dsh-memory-triage: llm fallback failed: ${String(error)}`);
        }
      } else {
        result.llmSkipped = ambiguous.length;
      }
    } else {
      result.llmSkipped = ambiguous.length;
    }

    // Phase 4: mirror sync, state, optional scheduled purge.
    syncMirror(memoryDir, store.listActive());
    writeState({ count: store.activeCount(), chars: store.totalChars(), lastRun: new Date().toISOString() });
    if (cfg.purgeOnSchedule && cfg.purgeDays > 0) result.purged = store.purgeArchivedOlderThan(cfg.purgeDays);

    logger?.info?.(`dsh-memory-triage: retyped=${result.retyped} archivedLow=${result.archivedLow} merged=${result.merged} archivedByMerge=${result.archivedByMerge} llm=${result.llmJudged}/${result.llmSkipped}`);
    return result;
  }

  function renderResult(r) {
    if (r.skipped) return "记忆分诊：未达触发阈值，本轮跳过。";
    const lines = [
      "记忆分诊完成：",
      `- 迁入项目桶：${r.retyped} 条`,
      `- 低价值归档：${r.archivedLow} 条`,
      `- 合并去重：${r.merged} 组（归档 ${r.archivedByMerge} 条）`,
      `- LLM 兜底判定：${r.llmJudged} 条${r.llmSkipped ? `，跳过 ${r.llmSkipped} 条` : ""}`,
      r.purged ? `- 超期归档清理：${r.purged} 条` : ""
    ];
    return lines.filter(Boolean).join("\n");
  }

  const commandDisposers = [];
  if (ctx.commands) {
    try {
      commandDisposers.push(ctx.commands.register({
        name: "triage-run",
        description: "立即全库执行记忆分诊（分类/去重/归档）",
        handler: async () => {
          const r = await runTriage({ full: true }).catch((error) => ({ error: String(error) }));
          return { kind: "success", text: r.error ? `记忆分诊失败：${r.error}` : renderResult(r) };
        }
      }));
    } catch (error) { logger?.warn?.(`dsh-memory-triage: /triage-run register failed: ${String(error)}`); }
    try {
      commandDisposers.push(ctx.commands.register({
        name: "triage-purge",
        description: "彻底删除归档超过指定天数的记忆（仅限已归档条目，默认 30 天）",
        handler: async () => {
          if (!store) store = createStore(memoryDir);
          const days = cfg.purgeDays > 0 ? cfg.purgeDays : 30;
          const n = store.purgeArchivedOlderThan(days);
          syncMirror(memoryDir, store.listActive());
          return { kind: "success", text: `已彻底删除归档超过 ${days} 天的记忆 ${n} 条。` };
        }
      }));
    } catch (error) { logger?.warn?.(`dsh-memory-triage: /triage-purge register failed: ${String(error)}`); }
  }

  let timer = null;
  let running = false;
  const unsubscribe = ctx.on("session/event", (session, event) => {
    if (disposed || !cfg.enabled || event.type !== "turn/end") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (running) return;
      running = true;
      runTriage({ full: false })
        .catch((error) => logger?.warn?.(`dsh-memory-triage: run failed: ${String(error)}`))
        .finally(() => { running = false; });
    }, cfg.debounceMs ?? 5000);
  });

  return () => {
    disposed = true;
    unsubscribe?.();
    if (timer) clearTimeout(timer);
    for (const d of commandDisposers) { try { d?.(); } catch { /* ignore */ } }
    store?.close();
  };
};
