/* ============================================================================
 * memory_storage.js —— core.js 的内存实现（测试用）
 * ----------------------------------------------------------------------------
 * 【为什么单独写一份】core.js 的全部机制（幂等 / 游标 / 防重掷）必须能在**没有
 *   Cloudflare** 的地方验证 —— 沙盒部署不了 DO，但这不代表这些逻辑不能验。
 *   DO 版（apps/worker/src/room.js）只是把同一套接口换成 SQLite。
 * 【注意】它是**测试替身**，不是生产实现；接口与 DO 版必须逐方法对齐。
 * ========================================================================== */
export function createMemoryStorage(code){
  const room = {code, rule:'generic', baredice:false, ruleSetBy:null, ruleSetAt:null, seq:0, created_at:Date.now()};
  const msgs = [];                // 按 seq 升序
  const cards = new Map();
  const nicks = new Map();
  const idem = new Map();
  const bySeq = new Map();
  return {
    code,
    async getRoom(){ return {...room}; },
    async setRoom(p){ Object.assign(room, p); },
    async allocSeq(n){ const base = room.seq + 1; room.seq += n; return base; },   // ★ seq 从 1 开始：cursor=0 = 首屏
    async getCard(a){ return cards.get(a) || null; },
    async setCard(a, card){ cards.set(a, JSON.parse(JSON.stringify(card))); },
    /* ★ 解绑 = 真删（.st clear）；不删的话下次 .st 又从库里读回来，卡会"复活" */
    async delCard(a){ cards.delete(a); },
    async setNick(a, n){ nicks.set(a, n); },
    async getIdem(reqId){ return idem.get(reqId) || null; },
    async putIdem(reqId, seq, ts){ idem.set(reqId, {req_id:reqId, seq, ts}); },
    async existsSeq(seq){ return bySeq.has(seq); },
    async insertMsgs(list){
      for(const m of list){ msgs.push(m); bySeq.set(m.seq, m); }
      msgs.sort((x, y) => x.seq - y.seq);
    },
    async recentRolls(anonId, n){
      return msgs.filter(m => m.kind === 'roll' && m.anon_id === anonId).slice(-n);
    },
    /* ★ 现存量 COUNT(*) —— 与 room.seq 的区别：seq 删后不回退，清理后会虚高。
     *   这里是内存替身，直接用数组长度就是"现存量"（清理走 _deleteOlderThan，会同步删）。 */
    async countMsgs(){ return msgs.length; },
    async maxKeepUntil(){ let k = null; msgs.forEach(m => { if(m.keep_until && (!k || m.keep_until > k)) k = m.keep_until; }); return k; },
    async hasIds(ids){ const has = new Set(msgs.map(m => m.id)); return new Set((ids || []).filter(i => has.has(i))); },
    async brief(){ return msgs.slice().sort((a, b) => a.seq - b.seq).map(m => ({id:m.id, seq:m.seq, ts:m.ts})); },
    /* ★ 与 DO 版一样"要么全成要么全不成"：先算好再整体替换，
       做到一半的顺序损坏在内存里同样无法自愈。 */
    async reflow(plan){
      const map = new Map((plan.reseq || []).map(([id, seq]) => [id, seq]));
      msgs.forEach(m => { if(map.has(m.id)) m.seq = map.get(m.id); });
      (plan.add || []).forEach(m => msgs.push(m));
      msgs.sort((a, b) => a.seq - b.seq);
      bySeq.clear(); msgs.forEach(m => bySeq.set(m.seq, m));
      if(plan.seqEnd != null) room.seq = plan.seqEnd;
      const imap = new Map((plan.idem || []).map(([o, n]) => [o, n]));
      idem.forEach((v, k) => { if(imap.has(v.seq)) v.seq = imap.get(v.seq); else idem.delete(k); });
    },
    async since(cursor, limit){
      return msgs.filter(m => m.seq > cursor).slice(0, limit);   // ★ cursor = 已渲染的最大 seq，补齐是它之后
    },
    async recent(limit){ return msgs.slice(-(limit || 200)); },   // 最近 N 条
    async history(beforeSeq, limit){
      return msgs.filter(m => m.seq < beforeSeq).slice(-limit);
    },
    // 测试辅助
    _all: () => msgs, _room: () => room, _idem: () => idem,
    _deleteOlderThan(ts){ for(let i = msgs.length - 1; i >= 0; i--) if(msgs[i].ts < ts){ bySeq.delete(msgs[i].seq); msgs.splice(i, 1); } },
  };
}
