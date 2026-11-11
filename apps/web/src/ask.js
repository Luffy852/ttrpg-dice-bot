/* ============================================================================
 * ask.js —— 「导出选格式 + 设筛选范围」的**唯一实现**（生产 main.js 与冒烟共用同一份）
 * ----------------------------------------------------------------------------
 * 【为什么单独一个文件】上一版用 `confirm('确定=md，取消=ndjson')`，
 *   把「取消」当成了一个选项 —— 用户点上取消，实际上导出了一份 ndjson。
 *   **弹窗里的取消必须是取消**，这是交互底线，不该由调用方各自保证。
 *   另外 main.js 里的逻辑 dom_smoke 验不到（它手装 net/ui/batch，不跑 main.js），
 *   抽出来，测试才能跑**生产这份**—— 否则又会变成"测试替身抄生产逻辑"。
 *
 * 【★ v1.1 加了筛选】日期范围 + 参与者昵称。参数规范（参数名 / 日期边界 / 昵称清洗）
 *   不在这里写第二遍，统一走 packages/protocol 的 export-filter.js —— 前后端共用一份，
 *   否则"前端发 from、后端读 start"这类漂移沙盒里全绿、线上静默失效。
 * ========================================================================== */
import {appendFilterParams, normalizeFilters, filterSummary} from '../vendor/protocol/export-filter.js';

/** 两个格式选项。★ 说明必须说清"能干什么、不能干什么"：
 *  只有 NDJSON 能再用「导入战报」灌回房间，战报是给人读的，导不回来。 */
export const EXPORT_CHOICES = [
  {value:'md',     label:'Markdown 战报', desc:'给人读：复盘、贴群、留档（无法导回房间）'},
  {value:'ndjson', label:'NDJSON',        desc:'给机器读：可再用「导入战报」灌回房间'},
];

/** 骰娘 / 系统消息也是一个可筛的"参与者"（from_name = '骰娘'）
 *  ★ T4：只在本文件内用（导出弹窗的参与者列表），不再对外导出。 */
const BOT_SENDER = '骰娘';

/**
 * 纯函数：把一次导出拼成 URL。
 * 【★ 空筛选时查询串与 v1 完全相同】只有 format + token —— 老行为一个字没动，
 *   所以不设任何筛选的用户，导出结果与升级前逐字节一致。
 * @returns {string} '/api/room/123456/export?format=…&token=…&from=…&sender=…'
 */
export function buildExportQuery({code, token, format, filters}){
  const sp = new URLSearchParams();
  sp.set('format', format === 'md' ? 'md' : 'ndjson');
  sp.set('token', String(token || ''));
  appendFilterParams(sp, filters || {});
  return '/api/room/' + encodeURIComponent(String(code || '')) + '/export?' + sp.toString();
}

/**
 * 纯函数：把弹窗表单的原始值规范成一次导出选择。
 * @returns {{format:string, filters:object, summary:string, error:string|null}|null}
 *   raw=null 表示用户取消 —— 调用方必须什么都不做。
 */
export function normalizePick(raw){
  if(!raw) return null;
  const filters = normalizeFilters(raw);
  return {format:raw.value === 'md' ? 'md' : 'ndjson', filters,
    summary:filterSummary(filters), error:filters.error};
}

/**
 * 弹窗让用户选格式 + 设筛选范围；取消返回 null（调用方必须什么都不做）。
 * @param {{askExport:Function, members?:Function}} ui
 */
export async function pickExportFormat(ui){
  const members = (typeof ui.members === 'function') ? (ui.members() || []) : [];
  const raw = await ui.askExport({
    title:'导出战报',
    sub:'两种格式的<b>内容完全一致</b>（同一份消息渲染），区别只在用途：' +
        '<br>可先设范围，<b>留空 = 导出全部消息</b>。',
    choices:EXPORT_CHOICES,
    members,
    botLabel:BOT_SENDER + ' / 系统',
  });
  return normalizePick(raw);
}
