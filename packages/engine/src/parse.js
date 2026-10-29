/* parse.js — 3 掷骰表达式解析
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
const LIMITS = { perGroupDice:100, perGroupSides:10000, totalDice:500 };
const ITEM_RE = /([+-])?(?:(\d*)d(\d+)|(\d+))/gi;

function parseExpr(src){
  const s = String(src == null ? '' : src).replace(/\s+/g,'').toLowerCase();
  if(!s) return {ok:false, reason:'syntax'};
  const groups = []; let mod = 0, idx = 0, m;
  ITEM_RE.lastIndex = 0;
  while((m = ITEM_RE.exec(s)) !== null){
    if(m.index !== idx) return {ok:false, reason:'syntax'};   // 出现括号/乘除/k/dl/# 等
    idx = m.index + m[0].length;
    const sign = m[1] === '-' ? -1 : 1;
    if(m[3] !== undefined){
      const n = m[2] === '' ? 1 : parseInt(m[2], 10);
      groups.push({kind:'dice', n, sides:parseInt(m[3], 10), sign});
    } else {
      mod += parseInt(m[4], 10) * sign;
    }
  }
  if(idx !== s.length || groups.length === 0) return {ok:false, reason:'syntax'};
  let totalDice = 0;
  for(const g of groups){
    if(!(g.n >= 1)) return {ok:false, reason:'syntax'};
    if(g.sign < 0) return {ok:false, reason:'syntax'};   // 负骰数无意义（-1d6 会被当成 -1 颗骰）
    if(g.n > LIMITS.perGroupDice)   return {ok:false, reason:'limit'};
    if(g.sides < 1) return {ok:false, reason:'syntax'};
    if(g.sides > LIMITS.perGroupSides) return {ok:false, reason:'limit'};
    totalDice += g.n;
  }
  if(totalDice > LIMITS.totalDice) return {ok:false, reason:'limit'};
  return {ok:true, groups, mod, totalDice};
}

/* ---------- 4. roll.js：掷骰执行（优劣势按规则收敛） ---------- */

export { LIMITS, ITEM_RE, parseExpr };
