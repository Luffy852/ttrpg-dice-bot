/* ============================================================================
 * export.js —— 导出：NDJSON（全量事实，可回灌） + Markdown 战报（人读）
 * ----------------------------------------------------------------------------
 * 【为什么两种】30 天后消息会被清理 —— 导出是唯一的保全手段（档案已知局限）。
 *   NDJSON = 机器格式，一行一条消息，**可原样回灌**（迁移 / 误删恢复靠它）；
 *   战报 = 人读格式，用于复盘。两者来自同一份 msgs，不做第二套查询。
 *
 * 【★ 战报不许自己写渲染】直接调 engine 的 renderBattleMd —— 它与聊天流共用
 *   detailLines(view)，否则"导出里写的点数"迟早与"当时屏幕上显示的"对不上（原则 4）。
 *
 * 【回灌的前提】payload 只存事实、不含派生值（原则 6），所以回灌后重新推导即可，
 *   不需要把 total / 成功等级一起搬回去 —— 那正是副本漂移的来源。
 * ========================================================================== */
import {renderBattleMd} from '../../../packages/engine/src/render-md.js';

/** 全量 NDJSON：一行一条，字段与库表一致（回灌时直接 INSERT） */
export function toNdjson(msgs){
  return msgs.map(m => JSON.stringify({
    seq:m.seq, id:m.id, ts:m.ts, kind:m.kind, from:m.from, actor:m.actor,
    anon_id:m.anon_id || null, req_id:m.req_id || null, rule_at:m.rule_at || null, payload:m.payload,
  })).join('\n') + (msgs.length ? '\n' : '');
}

/** 解析回灌用；坏行收集到 errs 而不是整批失败（一条脏数据不该让整份战报废掉） */
export function fromNdjson(text){
  const out = [], errs = [];
  String(text || '').split('\n').forEach((line, i) => {
    if(!line.trim()) return;
    try{
      const o = JSON.parse(line);
      if(typeof o.seq !== 'number' || !o.kind || !o.payload) throw new Error('字段缺失');
      out.push(o);
    }catch(e){ errs.push({line:i + 1, why:String(e.message || e)}); }
  });
  return {msgs:out, errs};
}

/** Markdown 战报。meta = {code, rule, exportedAt} */
export function toBattle(msgs, meta){
  return renderBattleMd(msgs.slice().sort((a, b) => a.seq - b.seq), meta || {});
}

export const FORMAT = {NDJSON:'ndjson', MD:'md'};
export function exportAs(msgs, meta, format){
  if(format === FORMAT.MD) return {body:toBattle(msgs, meta), type:'text/markdown; charset=utf-8',
    name:'战报-' + (meta.code || 'room') + '.md'};
  /* ★ 文件名带导出时间：多次导出会拿到多个同名文件，下载目录里全是"房间-593353 (1).ndjson"，
   *   分不清哪份是新的。时间串与战报里的 exportedAt 一致（都走 ymdhm）。 */
  return {body:toNdjson(msgs), type:'application/x-ndjson; charset=utf-8',
    name:'房间-' + (meta.code || 'room') + '-' + String(meta.exportedAt || '').replace(/[^0-9]/g, '') + '.ndjson'};
}
