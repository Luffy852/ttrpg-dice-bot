/* util.js — 纯字符串工具（★解环①：零依赖，切断各模块 → render 的反向依赖）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtMod(v){ return (v >= 0 ? '+' + v : String(v)); }

export { esc, fmtMod };
