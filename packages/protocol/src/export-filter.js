/* ============================================================================
 * export-filter.js —— 导出筛选的**参数规范唯一出处**（前端拼 URL / 后端解析共用）
 * ----------------------------------------------------------------------------
 * 【为什么放在 protocol 包】前端在 apps/web/，后端在 apps/worker/src/，两边不许互相
 *   引用（静态资源只托管 apps/web）。参数名、日期边界、昵称截断规则若各写一份，
 *   迟早漂移成"前端发了 from、后端读的是 start" —— 这类 bug 沙盒里全绿、线上静默失效。
 *   packages/protocol 本来就是前后端共用层（frames / payload / cursor），放这里最自然。
 *
 * 【★ 时区口径】项目所有时间展示都用 UTC+8（util.js 的 ymdhm / hhmm / ymdMd）。
 *   所以"2026-11-01"必须是**北京时间**的 11 月 1 日 00:00 ～ 23:59:59.999，
 *   不能按 UTC 算 —— 否则早上 8 点前的消息会被划到前一天（真机反馈 · A 组第 1 条
 *   那个 8 小时偏差，换个地方又会冒出来）。
 *
 * 【筛选键为什么用昵称 from_name，而不是 anon_id】
 *   ① 与屏幕上、战报里看到的一致，用户选的是"老王"不是一串 UUID；
 *   ② 跨房间导入的消息保留原昵称，但它的 anon_id 属于别的房间、不在本房成员表里 ——
 *      按 anon_id 筛会**静默漏掉**这些消息；
 *   ③ 已退出成员 / 骰娘系统消息同样覆盖得到。
 *   代价是同名会合并（本就无账号体系，昵称本就是唯一可见身份）。
 *
 * 【不做的事】不写 SQL、不碰 DOM、不认识存储 —— 纯数据规范，node 里可直接单测。
 * ========================================================================== */

const DAY_MS = 86400000;
const TZ = '+08:00';
/** 昵称最长与进房时一致（16），留一点余量给跨房间带过来的老昵称 */
const SENDER_MAX = 32;
/** 一次最多筛多少人：防止有人手拼一个超长 URL 把 SQL 参数顶爆（上限 100） */
const SENDERS_MAX = 20;

export const FILTER_LIMITS = {SENDER_MAX, SENDERS_MAX};

/** 严格校验 YYYY-MM-DD：Date.parse 会把 2026-02-30 悄悄规范成 3 月 2 日，必须反算比回去 */
export function validDay(s){
  if(typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00' + TZ);
  if(Number.isNaN(t)) return false;
  // t 是 UTC 毫秒；加 8 小时后取 ISO 的日期部分，即"这个时刻在北京是几号"
  return new Date(t + 8 * 3600000).toISOString().slice(0, 10) === s;
}

/** 北京时区某天的 00:00:00.000（epoch ms） */
export function dayStart(s){ return Date.parse(s + 'T00:00:00' + TZ); }
/** 北京时区某天的 23:59:59.999（含整天，不用"次日零点"避免边界歧义） */
export function dayEnd(s){ return dayStart(s) + DAY_MS - 1; }

/**
 * 把任意来源（表单 / URL）的筛选值规范成唯一形态。
 * @returns {{from:string, to:string, senders:string[], error:string|null}}
 *   error='bad_range' 表示起始晚于结束 —— 不静默交换，交调用方提示用户。
 */
export function normalizeFilters(raw){
  const r = raw || {};
  let from = typeof r.from === 'string' ? r.from.trim() : '';
  let to   = typeof r.to   === 'string' ? r.to.trim()   : '';
  if(from && !validDay(from)) from = '';
  if(to   && !validDay(to))   to   = '';

  const seen = new Set(), senders = [];
  const arr = Array.isArray(r.senders) ? r.senders : [];
  for(const x of arr){
    /* ★ 清掉换行/制表：这个值会写进 Markdown 战报头部，留着 \n 就能伪造出一整行说明 */
    const v = String(x == null ? '' : x).trim().replace(/[\r\n\t]+/g, ' ').slice(0, SENDER_MAX);
    if(!v || seen.has(v)) continue;
    seen.add(v); senders.push(v);
    if(senders.length >= SENDERS_MAX) break;
  }
  return {from, to, senders, error:(from && to && from > to) ? 'bad_range' : null};
}

/** 有没有实际筛选条件（留空 = 全部，与 v1 的全量导出逐字节一致） */
export function hasFilters(f){
  const n = normalizeFilters(f);
  return !!(n.from || n.to || n.senders.length);
}

/** URLSearchParams → filters（后端入口）。sender 可重复出现，用 getAll 收全 */
export function parseFilters(sp){
  const get = k => { try{ return sp.get(k) || ''; }catch(e){ return ''; } };
  const all = k => { try{ return sp.getAll(k); }catch(e){ return []; } };
  return normalizeFilters({from:get('from'), to:get('to'), senders:all('sender')});
}

/** filters → URLSearchParams（前端入口）。只追加非空项，空筛选时 URL 与旧版完全相同 */
export function appendFilterParams(sp, f){
  const n = normalizeFilters(f);
  if(n.from) sp.set('from', n.from);
  if(n.to)   sp.set('to', n.to);
  n.senders.forEach(s => sp.append('sender', s));
  return sp;
}

/** 人读摘要：写进 Markdown 战报头，也用于弹窗回显。空筛选返回「全部消息」 */
export function filterSummary(f){
  const n = normalizeFilters(f);
  if(!hasFilters(n)) return '全部消息';
  const bits = [];
  if(n.from && n.to) bits.push(n.from + ' ～ ' + n.to);
  else if(n.from)    bits.push(n.from + ' 起');
  else if(n.to)      bits.push('截至 ' + n.to);
  if(n.senders.length) bits.push('参与者：' + n.senders.join('、'));
  return bits.join('　·　');
}
