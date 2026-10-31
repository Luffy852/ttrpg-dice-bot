/* ============================================================================
 * frames.js —— ws 帧定义（前后端共用同一份，改这里两边一起变）
 * ----------------------------------------------------------------------------
 * 【为什么单独一个包】前后端各写一份校验 = 必然漂移。帧名拼错、字段改名，
 *   只有联调时才发现，而联调是最贵的调试场景。这里一份定义，两边 import。
 * 【三条硬规矩】
 *   ① 帧一律 {t: 类型, ...字段}，t 是判别式，不做"形状推断"
 *   ② 入站帧先过 assertIn()，非法帧直接 reject，不进业务逻辑
 *   ③ 版本号在 hello / welcome 里带，不符即 version_mismatch（前端随 Worker 一起部署）
 * ========================================================================== */

export const PROTOCOL_VERSION = 1;

export const IN = {HELLO:'hello', CMD:'cmd', CHAT:'chat', SYNC:'sync', HISTORY:'history', PING:'ping'};
/* ★ RELOAD：整房顺序变了（导入战报后按绝对时间重排），让所有人重新拉一遍首屏。
 * 【为什么必须显式加一帧】靠客户端自己定期重连太慢，而 seq 一旦重排，
 *   所有人的 cursor 与本地 msg_id 全部失效 —— 不重载就会看到"消息重复 / 顺序错乱 / 越补越乱"。
 * 【为什么老客户端安全】旧版不认识这个 t，会落进 else 分支被忽略 —— 不会崩。 */
export const OUT = {WELCOME:'welcome', BATCH:'batch', ACK:'ack', DUP:'dup', REJECT:'reject', STATE:'state', PRESENCE:'presence', PONG:'pong', ERROR:'error', RELOAD:'reload'};

export const ERR = {
  VERSION_MISMATCH:'version_mismatch', BAD_TOKEN:'bad_token', RATE_LIMITED:'rate_limited',
  TOO_LONG:'too_long', EMPTY:'empty', INTERNAL:'internal', BAD_FRAME:'bad_frame',
};

/* ---------- 入站帧校验：类型 + 必需字段 ---------- */
const RULES = {
  [IN.HELLO]:   {token:'string'},
  [IN.CMD]:     {req_id:'string', text:'string'},
  [IN.CHAT]:    {req_id:'string', text:'string'},
  [IN.SYNC]:    {cursor:'number'},
  [IN.HISTORY]: {before_seq:'number'},
  [IN.PING]:    {},
};

/** @returns {string|null} 错误码；null = 合法 */
export function checkIn(f){
  if(!f || typeof f !== 'object') return ERR.BAD_FRAME;
  if(!(f.t in RULES)) return ERR.BAD_FRAME;
  for(const k in RULES[f.t]){
    const v = f[k];
    if(typeof v !== RULES[f.t][k]) return ERR.BAD_FRAME;
    if(RULES[f.t][k] === 'string' && !v) return ERR.BAD_FRAME;
  }
  if(f.t === IN.HELLO && f.v !== undefined && f.v !== PROTOCOL_VERSION) return ERR.VERSION_MISMATCH;
  return null;
}

/* ---------- 出站帧构造：名字集中在上面，字段名也只在这里出现一次 ---------- */
/* ★ members 之外多带两个数（2026-10-31 真机反馈 · A 组第 3 条）：
 *   原先把「累计接入人次」（members 表行数）当在线人数显示，一屋子人反复刷新就一路涨到 13。
 *   - online    当前在线 = **活跃 ws 连接数**（断线即减，最可靠）
 *   - total     累计接入人次 = members 表行数（历史累积，永不减少）
 *   两个都要显示：前者是"现在几个人在"，后者是"这个房间总共来过多少人次"。 */
export const presence = (members, online, total) =>
  ({t:OUT.PRESENCE, members, online:online == null ? 0 : online, total:total == null ? members.length : total});
export const welcome = (you, room, serverTime, members, online, total) =>
  ({t:OUT.WELCOME, v:PROTOCOL_VERSION, you, room, server_time:serverTime,
    members, online:online == null ? 0 : online, total:total == null ? members.length : total});
export const batch   = (msgs, cursor, hasMore) => ({t:OUT.BATCH, msgs, cursor, has_more:!!hasMore});
export const ack     = (reqId, seq) => ({t:OUT.ACK, req_id:reqId, seq});
export const dup     = (reqId, seq, deleted) => ({t:OUT.DUP, req_id:reqId, seq, deleted:!!deleted});
export const reject  = (reqId, code, detail) => ({t:OUT.REJECT, req_id:reqId, code, detail:detail || ''});
export const state   = room => ({t:OUT.STATE, room});
export const pong    = ts => ({t:OUT.PONG, ts});
export const error   = (code, detail) => ({t:OUT.ERROR, code, detail:detail || ''});

export const isOut = f => f && Object.values(OUT).includes(f.t);
