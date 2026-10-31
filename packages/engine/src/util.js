/* util.js — 纯字符串工具（★解环①：零依赖，切断各模块 → render 的反向依赖）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtMod(v){ return (v >= 0 ? '+' + v : String(v)); }

/* ---------- ★ 全链路统一 UTC+8（2026-10-31 真机反馈 · A 组） ----------
 * 【症状】.status 里「规则设定者 · 08:12」与同一条消息气泡右上角「16:12」差 8 小时。
 * 【根因】两个时间来自**不同的时钟**：
 *   ① 服务端（Cloudflare Worker）跑在 UTC，引擎用 new Date().getHours() 得到的是 UTC 小时
 *   ② 前端 ui.js 用浏览器本地时区渲染 ts，用户在 UTC+8 看到本地时间
 *   同一个事实被两套时区各渲染一遍 —— 服务端渲染的时间串还会被**烤进消息落库**
 *   （.status / 规则变更广播的内容是服务端生成的），事后改前端也救不回来。
 * 【决策】统一按 Asia/Shanghai（UTC+8）显示（用户已定）。三处渲染全走这里：
 *   cmd.js 的规则设定时间 · render-md.js 的战报 · apps/web/src/ui.js 的气泡时间戳。
 * 【为什么不用 toLocaleString】Worker 与浏览器的 ICU 数据不一致，
 *   'zh-CN' 或 timeZone 参数在两端可能得到不同结果 —— 直接对 epoch 做固定偏移最稳。 */
const TZ_SHIFT_MS = 8 * 3600 * 1000;      // UTC+8 固定偏移（不含夏令时，中国本来也没有）
/** epoch（毫秒或 Date）→ 'HH:MM'（UTC+8） */
function hhmm(d){
  const t = new Date((d instanceof Date ? d.getTime() : Number(d)) + TZ_SHIFT_MS);
  const p = n => (n < 10 ? '0' : '') + n;
  return p(t.getUTCHours()) + ':' + p(t.getUTCMinutes());
}
/** epoch → 'YYYY-MM-DD'（UTC+8） */
function ymd(d){
  const t = new Date((d instanceof Date ? d.getTime() : Number(d)) + TZ_SHIFT_MS);
  const p = n => (n < 10 ? '0' : '') + n;
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

/** ★ epoch → 'YYYY-MM-DD HH:MM'（UTC+8）—— 导出时间戳专用
 * 【为什么必须走这里】导出时间戳原来用 `new Date().toISOString()`，那是 **UTC**。
 *   于是同一份战报：消息时间是 UTC+8、底部"导出：xxx"是 UTC，同一份文件里两个时区
 *   （真机反馈 · 第 6 条）。三处渲染统一走 util 的 +8 偏移，这里补第四个。 */
function ymdhm(d){
  return ymd(d) + ' ' + hhmm(d);
}

export { esc, fmtMod, hhmm, ymd, ymdhm };
