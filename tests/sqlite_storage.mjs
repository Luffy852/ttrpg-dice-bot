/* ============================================================================
 * sqlite_storage.mjs —— core.js 的 SQLite 实现（**与 room.js 的 storage() 同构**）
 * ----------------------------------------------------------------------------
 * 【为什么有两个实现】
 *   - `memory_storage.mjs`：纯内存，快，用于协议层断言
 *   - 本文件：真 SQLite（sql.js），用于验 **SQL 语义**（建表/索引/游标查询/清理）
 *   两者都必须与 `apps/worker/src/room.js` 的 storage() **逐方法对齐**，
 *   由 tools/check-worker.mjs 扫 —— 三处漂移 = 沙盒全绿、线上全错。
 *
 * 【★ 只替换方言，不替换契约】方法签名与返回结构与 room.js 完全一致。
 * ========================================================================== */

export function createSqliteStorage(db, code){
  const q = (sql, ...p) => {
    const st = db.prepare(sql);
    st.bind(p);
    const out = [];
    while(st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };
  const one = (sql, ...p) => q(sql, ...p)[0] || null;
  const run = (sql, ...p) => { db.run(sql, p); };
  const rows2msgs = rows => rows.map(row2msg);
  function row2msg(r){
    return {seq:r.seq, id:r.id, ts:r.ts, kind:r.kind, from:r.from_name, actor:r.actor,
      anon_id:r.anon_id, req_id:r.req_id, rule_at:r.rule_at, payload:JSON.parse(r.payload)};
  }
  return {
    code,
    init({code:c, now}){
      run(`INSERT OR IGNORE INTO room (id, code, created_at, last_active, rule, baredice, seq)
           VALUES (1, ?, ?, ?, 'generic', 0, 0)`, c, now, now);
    },
    async getRoom(){
      const r = one('SELECT * FROM room WHERE id = 1');
      return r ? {code:r.code, rule:r.rule, baredice:!!r.baredice, ruleSetBy:r.rule_set_by,
                  ruleSetAt:r.rule_set_at, seq:r.seq, created_at:r.created_at}
               : {code, rule:'generic', baredice:false, ruleSetBy:null, ruleSetAt:null, seq:0, created_at:Date.now()};
    },
    async setRoom(p){
      run('UPDATE room SET rule = ?, baredice = ?, rule_set_by = ?, rule_set_at = ? WHERE id = 1',
        p.rule, p.baredice ? 1 : 0, p.ruleSetBy, p.ruleSetAt);
    },
    async allocSeq(n){
      const r = one('SELECT seq FROM room WHERE id = 1');
      const base = (r ? r.seq : 0) + 1;
      run('UPDATE room SET seq = ? WHERE id = 1', base + n - 1);
      return base;
    },
    async getCard(a){
      const r = one('SELECT family, data FROM pcs WHERE anon_id = ?', a);
      return r ? {family:r.family, data:JSON.parse(r.data)} : null;
    },
    async setCard(a, card){
      run(`INSERT INTO pcs (anon_id, family, version, data, updated_at) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(anon_id) DO UPDATE SET family = excluded.family, data = excluded.data,
           version = version + 1, updated_at = excluded.updated_at`,
        a, card.family, JSON.stringify(card.data), Date.now());
    },
    async delCard(a){ run('DELETE FROM pcs WHERE anon_id = ?', a); },
    async setNick(a, n){ run('UPDATE members SET nick = ? WHERE anon_id = ?', n, a); },
    async getIdem(reqId){
      const r = one('SELECT seq, ts FROM idempotency WHERE req_id = ?', reqId);
      return r ? {req_id:reqId, seq:r.seq, ts:r.ts} : null;
    },
    async putIdem(reqId, seq, ts){ run('INSERT OR IGNORE INTO idempotency (req_id, seq, ts) VALUES (?, ?, ?)', reqId, seq, ts); },
    async existsSeq(seq){ return !!one('SELECT 1 FROM messages WHERE seq = ?', seq); },
    async insertMsgs(list){
      for(const m of list) run(
        'INSERT INTO messages (seq, id, ts, kind, from_name, actor, anon_id, req_id, rule_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        m.seq, m.id, m.ts, m.kind, m.from, m.actor || null, m.anon_id || null, m.req_id || null, m.rule_at || null, JSON.stringify(m.payload));
    },
    async recentRolls(anonId, n){
      return rows2msgs(q('SELECT * FROM messages WHERE kind = ? AND anon_id = ? ORDER BY seq DESC LIMIT ?', 'roll', anonId, n)).reverse();
    },
    /* ★ 现存量 COUNT(*)，不用 room.seq —— seq 删后不回退，30 天清理后虚高。与 room.js 同构。 */
    async maxSeq(){ const r = run('SELECT MAX(seq) AS s FROM messages')[0]; return (r && r.s) || 0; },
    async hasIds(ids){ const has = new Set(run('SELECT id FROM messages').map(r => r.id)); return new Set((ids || []).filter(i => has.has(i))); },
    async countMsgs(){ return one('SELECT COUNT(*) AS c FROM messages').c; },
    async since(cursor, limit){ return rows2msgs(q('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', cursor, limit)); },
    async recent(limit){ return run('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit || 200).reverse().map(row2msg); },
    async history(beforeSeq, limit){ return rows2msgs(q('SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?', beforeSeq, limit)).reverse(); },
    // 测试辅助
    cleanOlderThan(ts){ run('DELETE FROM messages WHERE ts < ?', ts); run('DELETE FROM idempotency WHERE ts < ?', ts); },
    count(t){ return one('SELECT COUNT(*) AS c FROM ' + t).c; },
  };
}
