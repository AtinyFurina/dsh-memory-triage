// Mirror renderer. Format is byte-compatible with dsh-mneme's mirror.js
// (MIT, modusensus/dsh-mneme) so human edits in the md files keep merging
// back into the store via mneme's own readHumanEdits parser.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const TYPE_FILE = {
  preference: "preferences.md",
  project: "projects.md",
  decision: "decisions.md",
  history: "history.md",
  summary: "summary.md"
};

const ESCAPE = /([\\`*_[\]{}()#+.!|>~-])/g;

function esc(text) {
  return String(text).replace(ESCAPE, "\\$1");
}

function renderMemory(m) {
  const lines = [];
  lines.push(`## ${esc(m.title)}`);
  lines.push("");
  lines.push(`- **ID**: \`${m.id}\``);
  lines.push(`- **类型**: ${m.type}`);
  lines.push(`- **重要性**: ${m.importance}`);
  lines.push(`- **标签**: ${m.tags.map((t) => `\`${esc(t)}\``).join(" ")}`);
  lines.push(`- **更新时间**: ${m.updated_at}`);
  if (m.source) lines.push(`- **来源**: ${esc(m.source)}`);
  lines.push("");
  lines.push(m.content);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export function syncMirror(dir, memories) {
  mkdirSync(dir, { recursive: true });
  const byType = {};
  for (const m of memories) (byType[m.type] ??= []).push(m);
  for (const type of Object.keys(TYPE_FILE)) {
    const file = join(dir, TYPE_FILE[type]);
    const items = (byType[type] ?? []).slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    if (items.length === 0) {
      rmSync(file, { force: true });
      continue;
    }
    const header = `# ${TYPE_FILE[type]} — dsh-mneme 镜像\n\n<!-- 手工编辑此文件会被合并回记忆库（人工优先）。 -->\n\n`;
    writeFileSync(file, header + items.map(renderMemory).join("\n"), "utf8");
  }
}
