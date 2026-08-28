import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// Direct SQLite access to the dsh-mneme memory store. Multi-connection WAL
// access is safe (the mneme host plugin and this plugin coexist); all writes
// go through a busy timeout so concurrent writers serialize instead of
// failing. Only soft mutations happen automatically: retype and archive.
// Hard deletion is limited to the explicit purge path (archived rows only).
export function createStore(memoryDir) {
  const db = new DatabaseSync(memoryDir + "/memory.db");
  db.exec("PRAGMA busy_timeout = 8000;");

  function nowIso() {
    return new Date().toISOString();
  }

  function listActive() {
    return db
      .prepare(
        "SELECT id, type, title, content, tags, importance, source, created_at, updated_at FROM memories WHERE archived=0 AND forgotten=0 ORDER BY importance DESC, updated_at DESC"
      )
      .all()
      .map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        tags: (() => { try { const t = JSON.parse(r.tags); return Array.isArray(t) ? t : []; } catch { return []; } })(),
        importance: r.importance,
        source: r.source ?? undefined,
        created_at: r.created_at,
        updated_at: r.updated_at
      }));
  }

  function getById(id) {
    const r = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!r) return undefined;
    return { ...r, tags: (() => { try { const t = JSON.parse(r.tags); return Array.isArray(t) ? t : []; } catch { return []; } })() };
  }

  function retype(id, type) {
    return db.prepare("UPDATE memories SET type = ?, updated_at = ? WHERE id = ? AND archived=0").run(type, nowIso(), id).changes;
  }

  function archive(id) {
    return db.prepare("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ? AND archived=0").run(nowIso(), id).changes;
  }

  function updateContent(id, title, content, importance) {
    return db.prepare("UPDATE memories SET title = ?, content = ?, importance = ?, updated_at = ? WHERE id = ? AND archived=0")
      .run(title, content, importance, nowIso(), id).changes;
  }

  /** Replace the tags array of a memory (persona tagging). */
  function setTags(id, tags) {
    const list = Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : [];
    return db.prepare("UPDATE memories SET tags = ?, updated_at = ? WHERE id = ? AND archived=0")
      .run(JSON.stringify(list), nowIso(), id).changes;
  }

  /** Insert a brand-new memory (used by the persona-inherit rewrite). */
  function saveEntry(entry) {
    const id = entry.id ?? randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
    ).run(
      id,
      entry.type,
      entry.title,
      entry.content,
      JSON.stringify(Array.isArray(entry.tags) ? entry.tags : []),
      Number.isInteger(entry.importance) ? entry.importance : 3,
      entry.source ?? "triage",
      now,
      now
    );
    return id;
  }

  // --- persona marker (shared with dsh-mneme's user_settings table) ------
  function getPersona() {
    const row = db.prepare("SELECT value FROM user_settings WHERE key = 'current_persona'").get();
    return row ? String(row.value).trim() : "";
  }

  function setPersona(name) {
    db.prepare(
      "INSERT INTO user_settings (key, value) VALUES ('current_persona', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(name ?? "").trim());
  }

  function totalChars() {
    const rows = db.prepare("SELECT title, content FROM memories WHERE archived=0 AND forgotten=0 AND type != 'summary'").all();
    return rows.reduce((sum, r) => sum + (r.title?.length ?? 0) + (r.content?.length ?? 0), 0);
  }

  function activeCount() {
    return db.prepare("SELECT COUNT(*) AS c FROM memories WHERE archived=0 AND forgotten=0 AND type != 'summary'").get().c;
  }

  /** Hard-delete archived rows older than `days` (the only delete path). */
  function purgeArchivedOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare("DELETE FROM memories WHERE archived=1 AND updated_at < ?").run(cutoff).changes;
  }

  function close() {
    db.close();
  }

  return { listActive, getById, retype, archive, updateContent, setTags, saveEntry, getPersona, setPersona, purgeArchivedOlderThan, totalChars, activeCount, close };
}
