// Pure classification + LLM fallback parsing for memory triage.
// Rules-first: exempt keywords keep the entry global, project keywords move it
// to the project bucket, low-importance non-exempt entries get archived.
// Anything undecided becomes an "ambiguous" candidate for the LLM fallback.

export const DEFAULT_EXEMPT_KEYWORDS = [
  "工具", "纪律", "检查", "真实", "自主", "决策", "确认", "推进", "主动", "催促",
  "沟通", "回答", "回复", "输出", "解释", "教学", "指导", "步骤", "排版", "简洁",
  "简短", "分段", "结论", "长内容", "搜索", "核实", "联网", "断言", "网址", "检索",
  "道德", "服从", "限制", "安全", "实例", "密钥", "token", "Token", "通知", "UI",
  "动效", "光效", "质感", "Flash", "视觉", "开源", "插件", "生态", "透明", "硬件",
  "显示", "宽带", "网络", "浏览器", "小鱼干", "流式", "渲染", "记忆", "自查", "编译",
  "终端", "编码", "JSON", "合规", "术语", "鲸鱼", "内容偏好", "成人", "R18", "巨乳",
  "Kink", "话题", "作品", "评价", "粉丝", "官方", "不信任", "怀疑", "更换模型",
  "模型选择", "AI模型", "模型偏好", "API选择", "感兴趣", "推荐", "截图"
];

export const DEFAULT_PROJECT_KEYWORDS = [
  "小米", "通话", "互联", "Mac", "ADB", "adb", "无线调试", "隐私空间", "蓝牙", "SIM",
  "双卡", "登录", "root", "MT管理器", "签名", "APK", "将军", "训练师", "解锁", "存档",
  "游戏", "剧情", "生图", "出图", "绘图", "图像", "图片", "画风", "belly", "LoRA",
  "底模", "提示词", "构图", "脚部", "姿势", "四肢", "比例", "薇尔琪塔", "男性角色",
  "面部", "无脸", "设定", "GPU", "服务器", "算力", "带宽", "续费", "充值", "智星云",
  "付款", "视频生成", "Wan", "标签", "e621", "rule34", "图像板", "训练", "筛选",
  "保存", "目录", "整理", "kinks", "素材", "VPN", "机场", "节点", "中转", "代理",
  "OpenAI", "Sakura", "Frp", "frpc", "隧道", "远程", "免授权", "RDP", "包头", "樱花",
  "小红书", "桌宠", "主题", "Cyberpunk", "赛博朋克", "Minecraft", "FTB", "整合包",
  "Verity", "任务线", "门诊", "HIS", "Z Flow", "电信卡", "来电提醒", "无线方案",
  "无线连接", "逆向分析环境", "设备与连接", "设备与网络", "外观学习", "外观描述",
  "创作者", "角色", "生成", "生成模型", "图像模型", "NSFW模型", "Noob", "noob", "API"
];

export function compileKeywordRe(list) {
  return new RegExp((list ?? []).filter((k) => typeof k === "string" && k).join("|"));
}

/**
 * Classify one preference/decision entry.
 * @returns {"keep-global"|"retype-project"|"archive-low"|"ambiguous"}
 */
export function classifyEntry(entry, exemptRe, projectRe, archiveLowImportance = true) {
  if (entry.type !== "preference" && entry.type !== "decision") return "keep-global";
  const title = String(entry.title ?? "");
  if (exemptRe && exemptRe.test(title)) return "keep-global";
  if (projectRe && projectRe.test(title)) return "retype-project";
  if (archiveLowImportance && entry.type === "preference" && entry.importance <= 2) return "archive-low";
  return "ambiguous";
}

const LLM_DECIDE_PROMPT = `你是记忆分诊助手。下面是几条记忆（id、类型、标题、内容、重要性）。
对每条输出一个决策：keep（保留不动）、archive（过时/琐碎/重复，归档）、retype_project（内容只与某个具体项目相关，应归入项目记忆）。
规则：只输出 JSON 数组 [{"id":"...","action":"keep|archive|retype_project"}]，不要其他文字。拿不准就 keep。`;

export function buildLlmPrompt(entries) {
  const list = entries
    .map((e) => `id=${e.id} | type=${e.type} | importance=${e.importance} | title=${e.title} | content=${String(e.content).slice(0, 200)}`)
    .join("\n");
  return {
    messages: [
      { role: "system", content: [{ type: "text", text: LLM_DECIDE_PROMPT }] },
      { role: "user", content: [{ type: "text", text: list }] }
    ]
  };
}

/**
 * Parse the LLM fallback decision JSON. Tolerant of prose around the array;
 * only whitelisted actions survive; unknown ids are dropped by the caller.
 */
export function parseLlmDecisions(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const VALID = new Set(["keep", "archive", "retype_project"]);
  return arr
    .filter((d) => d && typeof d === "object" && typeof d.id === "string" && VALID.has(d.action))
    .map((d) => ({ id: d.id, action: d.action }));
}

// --- persona tagging (dsh-memory-triage) -------------------------------

/** Visibility rule shared with dsh-mneme's filterByPersona. */
export function matchesPersona(tags, current) {
  if (!current) return true;
  const list = Array.isArray(tags) ? tags : [];
  const personaTags = list.filter((t) => typeof t === "string" && t.startsWith("persona:"));
  if (personaTags.length === 0) return true; // untagged = global
  return personaTags.includes(`persona:${current}`);
}

const PERSONA_TAG_PROMPT = `你是人格记忆分类助手。下面是若干条未打人格标签的记忆。请判断每条是"人格专属记忆"还是"通用记忆"。
人格专属：AI 的自我认知、情感、口气、人设备注、仅属于某个特定人设的内容 → 输出 tag_persona。
通用：用户偏好、项目事实、纪律规则，与人格无关 → 输出 keep。
只输出 JSON 数组 [{"id":"...","action":"tag_persona"|"keep"}]，不要其他文字。`;

export function buildPersonaTagPrompt(entries) {
  const list = entries.map((e) => `id=${e.id} | type=${e.type} | title=${e.title} | content=${String(e.content).slice(0, 200)}`).join("\n");
  return {
    messages: [
      { role: "system", content: [{ type: "text", text: PERSONA_TAG_PROMPT }] },
      { role: "user", content: [{ type: "text", text: list }] }
    ]
  };
}

export function parsePersonaTagDecisions(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const VALID = new Set(["tag_persona", "keep"]);
  return arr
    .filter((d) => d && typeof d === "object" && typeof d.id === "string" && VALID.has(d.action))
    .map((d) => ({ id: d.id, action: d.action }));
}

const PERSONA_REWRITE_PROMPT = `你是人格记忆改写助手。把下列带旧人格标签的记忆改写为新人设视角：保留全部事实与要求，只把自称、语气、身份认知换成新人设。
新人设描述：{{DESC}}
对每条输出 {"id":"...","action":"rewrite"|"keep","title":"改写后的标题","content":"改写后的内容"}；keep 表示该条与人格无关无需改写。只输出 JSON 数组。`;

export function buildPersonaRewritePrompt(entries, desc) {
  const sys = PERSONA_REWRITE_PROMPT.replace("{{DESC}}", String(desc || "").slice(0, 2000) || "（未提供，按通用助理口吻）");
  const list = entries.map((e) => `id=${e.id} | type=${e.type} | importance=${e.importance} | title=${e.title} | content=${String(e.content).slice(0, 300)}`).join("\n");
  return {
    messages: [
      { role: "system", content: [{ type: "text", text: sys }] },
      { role: "user", content: [{ type: "text", text: list }] }
    ]
  };
}

export function parsePersonaRewrite(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const VALID = new Set(["rewrite", "keep"]);
  return arr
    .filter((d) => d && typeof d === "object" && typeof d.id === "string" && VALID.has(d.action))
    .filter((d) => d.action !== "rewrite" || (typeof d.title === "string" && d.title.trim() && typeof d.content === "string" && d.content.trim()))
    .map((d) => ({ id: d.id, action: d.action, title: d.title?.trim(), content: d.content?.trim() }));
}
