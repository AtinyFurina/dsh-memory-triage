// Pure near-duplicate clustering and merge planning. Same algorithm the
// one-off reorg scripts used: same-bucket entries cluster when title dice
// similarity >= minDice or when one content contains the other (>= 8 chars).

export function normTitle(t) {
  return String(t || "").toLowerCase().replace(/[\s\-—_·,，。.()（）\[\]【】:：;；'"''""“”!！?？/\\|@#&*+=~^]+/g, "");
}

export function bigrams(s) {
  const b = new Set();
  for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2));
  return b;
}

export function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

export function normContent(t) {
  return String(t || "").replace(/\s+/g, "");
}

export function planClusters(bucket, { minDice = 0.62 } = {}) {
  const n = bucket.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dice(normTitle(bucket[i].title), normTitle(bucket[j].title)) >= minDice) {
        union(i, j);
        continue;
      }
      const ci = normContent(bucket[i].content), cj = normContent(bucket[j].content);
      if (ci.length >= 8 && cj.length >= 8 && (ci.includes(cj) || cj.includes(ci))) union(i, j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(bucket[i]);
  }
  return [...clusters.values()];
}

function uniqueLines(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = String(s || "").toLowerCase().replace(/\s+/g, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Turn clusters into merge plans: keeper keeps the richest content (up to
 * MAX_LINES lines), every other member gets archived by the caller.
 * @returns { merges: [{keepId, ids, title, content, importance}], archiveIds: string[] }
 */
export function buildMergePlan(clusters, { maxLines = 7 } = {}) {
  const merges = [];
  const archiveIds = [];
  for (const group of clusters) {
    if (group.length < 2) continue;
    let keeper = group[0];
    for (const m of group.slice(1)) {
      if (m.importance > keeper.importance) keeper = m;
      else if (m.importance === keeper.importance && (m.content || "").length > (keeper.content || "").length) keeper = m;
    }
    const extras = group
      .filter((m) => m.id !== keeper.id)
      .flatMap((m) => String(m.content || "").split(/\r?\n/).flatMap((x) => x.split(/(?<=[。；;])\s*/)).map((s) => s.trim()).filter(Boolean));
    const merged = uniqueLines([keeper.content, ...extras]).slice(0, maxLines).join("\n");
    const importance = Math.max(...group.map((m) => m.importance));
    merges.push({ keepId: keeper.id, ids: group.map((m) => m.id), title: keeper.title, content: merged, importance });
    for (const m of group) if (m.id !== keeper.id) archiveIds.push(m.id);
  }
  return { merges, archiveIds };
}
