/* ============================================================================
 * payload.js —— 落库载荷的**白名单校验**（前后端共用）
 * ----------------------------------------------------------------------------
 * 【为什么不直接存整个 view】view 里有 total / 成功等级 / Hope-Fear 归属这些
 *   **派生值**。存副本 = 原则 6 的病：事实改了副本不改，两边迟早不一致，
 *   而且"哪份是真的"没人说得清。所以 payload 只存事实，派生值现场推导。
 * 【这条白名单是干什么的】白名单 = 拒绝未知字段。
 *   半损坏的数据比报错更可怕：它会被渲染出来，看起来像真的。
 * 【注意】本文件只管"形状"，不管"含义"—— 事实的含义由 engine/replay.js 解释。
 * ========================================================================== */

export const KIND = {CMD:'cmd', CHAT:'chat', ROLL:'roll', HTML:'html', NOTICE:'notice', SYS:'sys'};
export const KINDS = Object.values(KIND);

/* ---------- 白名单：每个 kind 允许哪些字段 ---------- */
export const FIELDS = {
  [KIND.CMD]:    ['text'],
  [KIND.CHAT]:   ['text'],
  [KIND.ROLL]:   ['title','rule_at','mode','expr','target','groups','comps','dc','card_at','notes'],
  [KIND.HTML]:   ['defs'],
  [KIND.NOTICE]: ['html'],
  [KIND.SYS]:    ['title','line1','line2'],
};

/** 骰组的事实形状：只存"掷了什么、留了哪颗"，不存"合计多少" */
export const GROUP_SHAPE = ['sides','n','sign','tries','kept','keptIdx','label','chip','percent'];
// percent（COC 百分骰：十位骰列表 / 个位 / 取哪颗）是**逐骰明细**，不能丢 ——
// 没有它就看不出奖励骰取的是哪颗十位，明细就变成了不可核验的结论。

export const LIMITS = {TEXT:400, PAYLOAD:8 * 1024};

/** @returns {string|null} null = 合法；否则返回原因 */
export function checkPayload(kind, p){
  if(!KINDS.includes(kind)) return '未知 kind: ' + kind;
  if(!p || typeof p !== 'object') return 'payload 不是对象';
  const allow = FIELDS[kind];
  for(const k of Object.keys(p)){
    if(!allow.includes(k)) return '字段不在白名单: ' + kind + '.' + k;
  }
  if(kind === KIND.ROLL){
    if(!Array.isArray(p.groups) || !p.groups.length) return 'roll 必须有 groups';
    for(const g of p.groups){
      if(!g || typeof g.sides !== 'number') return 'group.sides 缺失';
      if(!Array.isArray(g.tries)) return 'group.tries 缺失（逐骰明细不可丢）';
      if(!Array.isArray(g.kept)) return 'group.kept 缺失';
      for(const k of Object.keys(g)) if(!GROUP_SHAPE.includes(k)) return 'group 字段不在白名单: ' + k;
      // ★ 逐骰明细是立身之本：kept 必须真的来自 tries，否则这颗骰是编的
      for(let i = 0; i < g.kept.length; i++) if(typeof g.kept[i] !== 'number') return 'group.kept 含非数字';
    }
    if(p.comps && !Array.isArray(p.comps)) return 'comps 必须是数组';
  }
  if((kind === KIND.CMD || kind === KIND.CHAT) && typeof p.text !== 'string') return 'text 缺失';
  const size = JSON.stringify(p).length;
  if(size > LIMITS.PAYLOAD) return 'payload 超 ' + LIMITS.PAYLOAD + ' B：' + size;
  return null;
}

/** 归一化：丢掉 undefined / 空对象，避免把 undefined 写进 SQLite 变成字符串 "undefined" */
export function normalize(kind, p){
  const out = {};
  for(const k of FIELDS[kind] || []) if(p[k] !== undefined) out[k] = p[k];
  return out;
}

/** 文本上限：超了要显式拒，绝不静默截断（截断后的指令会掷出一个用户没点的结果） */
export function checkText(text){
  if(typeof text !== 'string' || !text.trim()) return 'empty';
  if(text.length > LIMITS.TEXT) return 'too_long';
  return null;
}
