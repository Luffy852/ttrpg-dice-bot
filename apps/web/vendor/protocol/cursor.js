/* ============================================================================
 * cursor.js —— 游标 / 幂等键 / 重连退避（前后端共用同一份算法）
 * ----------------------------------------------------------------------------
 * 【★ 游标为什么用 seq 不用 ts】
 *   手册增补 6.7 的坑："时钟不是单调的"（回拨、同一毫秒两条消息）。
 *   DO 是单线程 + 自增整数 → seq 天然严格单调，且**不因删除而重用**。
 *   ts 只用于展示与 30 天清理，不参与任何排序/分页判定。
 *   这比 "ts + msg_id 复合游标" 更简单，也更可靠 —— 少一个维度少一类 bug。
 *
 * 【去重为什么两层都要】
 *   服务端幂等（req_id）：保证**这条指令只执行一次**，掷骰只掷一次。
 *   客户端去重（msg_id）：保证**同一条消息只渲染一次**（重连补齐可能重复投递）。
 *   只做一层都不够：只有前者，重连补齐会重复渲染；只有后者，重试会重掷。
 * ========================================================================== */

/** req_id：客户端生成，格式 `${clientId}-${n}`。同一条指令重发必须带同一个值 */
export function makeReqId(clientId, n){ return clientId + '-' + n; }

/** 客户端 id：每个标签页一个，刷新即换（换页后旧的 req_id 不再复用，语义清晰） */
export function makeClientId(cryptoObj){
  const c = cryptoObj || globalThis.crypto;
  const buf = new Uint32Array(2);
  if(c && c.getRandomValues) c.getRandomValues(buf);
  else { buf[0] = Math.floor(Math.random() * 4294967296); buf[1] = Math.floor(Math.random() * 4294967296); }
  return buf[0].toString(36) + buf[1].toString(36);
}

/** msg_id：服务端生成，`${code}:${seq}` —— 全局唯一、可反解出房间与游标 */
export const msgId = (code, seq) => code + ':' + seq;

/** 从消息列表取游标（= 已渲染的最大 seq） */
export function cursorOf(msgs){ let c = 0; for(const m of msgs) if(m.seq > c) c = m.seq; return c; }

/** 客户端侧按 msg_id 去重 —— 重连补齐 / 广播重复投递都可能带来同一条 */
export function dedupe(msgs, seen){
  const s = seen || new Set(), out = [];
  for(const m of msgs){
    const key = m.id || msgId(m.code, m.seq);
    if(s.has(key)) continue;
    s.add(key); out.push(m);
  }
  return out;
}

/** 补齐区间：返回 (from, to]，客户端上报 cursor 后服务端据此回补 */
export const gapOf = (clientCursor, serverSeq) => ({from: Math.max(0, clientCursor), to: serverSeq, missing: Math.max(0, serverSeq - Math.max(0, clientCursor))});

/** 指数退避 + 抖动（抖动是为了避免全房间同时重连把 DO 打爆） */
export function backoff(attempt, base, cap, rnd){
  const b = base || 1000, c = cap || 15000, r = rnd || Math.random;
  const raw = Math.min(c, b * Math.pow(2, Math.max(0, attempt)));
  return Math.round(raw * (0.7 + r() * 0.6));   // ±30%
}

/** 令牌桶：容量 capacity、每秒 refill 个。返回 {ok, left} */
export function tokenBucket(state, now, capacity, refillPerSec){
  const cap = capacity == null ? 10 : capacity, rate = refillPerSec == null ? 5 : refillPerSec;
  const last = state.ts || now;
  const gained = ((now - last) / 1000) * rate;
  let tokens = Math.min(cap, (state.tokens == null ? cap : state.tokens) + gained);
  if(tokens < 1){ state.tokens = tokens; state.ts = now; return {ok:false, left:0}; }
  tokens -= 1; state.tokens = tokens; state.ts = now;
  return {ok:true, left:Math.floor(tokens)};
}
