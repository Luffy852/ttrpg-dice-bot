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
  /* ★ P1（补丁轮次第 1 步）：run 必须返回行数组。
   *   原实现 `db.run(sql, p)` 无返回值，而 hasIds / brief / reflow / recent 四个方法
   *   都依赖它的结果 —— 只要那条路径被跑到就 TypeError / undefined（坑 #42：
   *   接口对齐 ≠ 口径对齐）。改成走同一个 q()，写语句返回空数组、读语句返回行，
   *   顺带把「两条 SQL 执行路径」收敛成一条（单一源，不再各写一份 bind）。 */
  const run = (sql, ...p) => q(sql, ...p);
  const rows2msgs = rows => rows.map(row2msg);
  function row2msg(r){
    return {seq:r.seq, id:r.id, ts:r.ts, kind:r.kind, from:r.from_name, actor:r.actor,
      anon_id:r.anon_id, req_id:r.req_id, rule_at:r.rule_at, payload:JSON.parse(r.payload)};
  }
  /* ★ S2 模块 B：先攻快照单一源（combatSnapshot 与 combatApply 返回值共用）。
   *   P1 后 run() 已能返回行；这里仍只用 q / one，保持快照查询路径独立可读。 */
  const combatSnapshot = () => {
    const c = one('SELECT id, round, cursor_entry_id, started_at, started_by FROM combat LIMIT 1');
    const entries = q('SELECT id, combat_id, name, owner, card_ref, value, dex_mod, created_at, created_by ' +
      'FROM combat_entry ORDER BY value DESC, dex_mod DESC, id ASC')
      .map(r => ({id:r.id, combat_id:r.combat_id, name:r.name, owner:r.owner, card_ref:r.card_ref,
        value:r.value, dex_mod:r.dex_mod, created_at:r.created_at, created_by:r.created_by}));
    return {combat:c ? {id:c.id, round:c.round, cursor_entry_id:c.cursor_entry_id,
      started_at:c.started_at, started_by:c.started_by} : null, entries};
  };
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
    /* ★ 与 room.js 同口径：按 actor 查（roll 的 anon_id 恒为 null，见 core.js apply）。 */
    async recentRolls(actor, n){
      return rows2msgs(q('SELECT * FROM messages WHERE kind = ? AND actor = ? ORDER BY seq DESC LIMIT ?', 'roll', actor, n)).reverse();
    },
    /* ★ 现存量 COUNT(*)，不用 room.seq —— seq 删后不回退，30 天清理后虚高。与 room.js 同构。 */
    async hasIds(ids){ const has = new Set(run('SELECT id FROM messages').map(r => r.id)); return new Set((ids || []).filter(i => has.has(i))); },
    async brief(){ return run('SELECT id, seq, ts FROM messages ORDER BY seq'); },
    async reflow(plan){
      (plan.reseq || []).forEach(([id, seq]) => run('UPDATE messages SET seq = ? WHERE id = ?', seq, id));
      (plan.add || []).forEach(m => run('INSERT INTO messages (seq, id, ts, kind, from_name, actor, anon_id, req_id, rule_at, keep_until, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        m.seq, m.id, m.ts, m.kind, m.from, m.actor || null, m.anon_id || null, m.req_id || null, m.rule_at || null, m.keep_until || null, JSON.stringify(m.payload)));
      if(plan.seqEnd != null) run('UPDATE room SET seq = ? WHERE id = 1', plan.seqEnd);
      const map = new Map((plan.idem || []).map(([o, n]) => [o, n]));
      run('SELECT req_id, seq FROM idempotency').forEach(r => {
        if(map.has(r.seq)) run('UPDATE idempotency SET seq = ? WHERE req_id = ?', map.get(r.seq), r.req_id);
        else run('DELETE FROM idempotency WHERE req_id = ?', r.req_id);
      });
    },
    async maxKeepUntil(){ const r = one('SELECT MAX(keep_until) AS k FROM messages'); return (r && r.k) || null; },
    async countMsgs(){ return one('SELECT COUNT(*) AS c FROM messages').c; },
    async since(cursor, limit){ return rows2msgs(q('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', cursor, limit)); },
    async recent(limit){ return run('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit || 200).reverse().map(row2msg); },
    async history(beforeSeq, limit){ return rows2msgs(q('SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?', beforeSeq, limit)).reverse(); },
    /* ---------- S2 模块 B · 先攻（与 room.js 的 SQL 语句逐 op 等价）---------- */
    async combatSnapshot(){ return combatSnapshot(); },
    async combatApply(ops){
      for(const op of (ops || [])){
        if(op.op === 'open'){
          if(!one('SELECT 1 FROM combat LIMIT 1'))
            run('INSERT INTO combat (room_code, round, cursor_entry_id, started_at, started_by) VALUES (?, 1, NULL, ?, ?)',
              code, op.now, op.by);
        } else if(op.op === 'upsert'){
          for(const r of (op.rows || [])){
            const hit = one('SELECT id FROM combat_entry WHERE name = ?', r.name);
            if(hit) run('UPDATE combat_entry SET value = ? WHERE id = ?', r.value, hit.id);
            else {
              const cid = one('SELECT id FROM combat LIMIT 1');
              run('INSERT INTO combat_entry (combat_id, name, owner, card_ref, value, dex_mod, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                cid ? cid.id : 0, r.name, r.owner, r.card_ref, r.value, r.dex_mod, r.now, r.by);
            }
          }
        } else if(op.op === 'setvalue'){
          run('UPDATE combat_entry SET value = ? WHERE name = ?', op.value, op.name);
        } else if(op.op === 'delete'){
          for(const n of (op.names || [])) run('DELETE FROM combat_entry WHERE name = ?', n);
        } else if(op.op === 'cursor'){
          run('UPDATE combat SET cursor_entry_id = ?', op.id);
        } else if(op.op === 'round'){
          run('UPDATE combat SET round = ?', op.n);
        } else if(op.op === 'clear'){
          run('DELETE FROM combat_entry'); run('DELETE FROM combat');
        }
      }
      return combatSnapshot();
    },
    // 测试辅助
    cleanOlderThan(ts){ run('DELETE FROM messages WHERE ts < ?', ts); run('DELETE FROM idempotency WHERE ts < ?', ts); },
    count(t){ return one('SELECT COUNT(*) AS c FROM ' + t).c; },
  };
}
