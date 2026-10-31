/* ============================================================================
 * render-md.js —— 战报（Markdown）渲染
 * ----------------------------------------------------------------------------
 * 【★ 原则 4 的落点】逐骰明细要出现在三处：聊天流气泡（HTML）、详情面板、导出的战报。
 *   战报**不自己算明细** —— 与 render.js 共用同一个 detailLines(view)（M3 抽出的纯数据层），
 *   只有外壳不同：气泡是 <div class="dline">，战报是 Markdown 列表。
 *   抄一遍明细 = 迟早对不上，而"逐骰明细可核验"是骰娘的立身之本。
 *
 * 【为什么放在 engine 包里】战报在 Worker 侧生成（导出），但渲染逻辑属于引擎：
 *   引擎是浏览器与 Worker 同一份，放这儿两边都不用重复实现。
 *
 * 【不做什么】不产出 HTML、不管时间格式以外的本地化、不做分页 —— 那是 apps/worker/export.js 的事。
 * ========================================================================== */
import {detailLines} from './render.js';
import {fmtMod, hhmm, ymd} from './util.js';
import {viewFromPayload} from './replay.js';
import {defsHtml} from './render.js';

/** 一颗骰：采用的 `7`，被丢弃的 ~~9~~（与 HTML 里 .chip.drop 划掉同一个语义） */
function chipMd(c){ return c.drop ? ('~~' + c.v + '~~') : ('`' + c.v + '`'); }
function chipsMd(cs){ return (cs || []).map(chipMd).join(' '); }

/** 明细行 → Markdown（与 detailHtml 同源，逐字对得上） */
function lineMd(L){
  const tail = (L.tail != null && L.tail !== '') ? (' · ' + L.tail) : '';
  if(L.t === 'try'){
    return (L.idx ? L.idx + ' ' : '') + L.label + ' ' + chipsMd(L.chips) + tail +
           (L.use ? '' : '（未采用）');
  }
  if(L.t === 'tens' || L.t === 'ones') return L.idx + ' ' + chipsMd(L.chips) + tail;
  if(L.t === 'comp') return L.label + ' ' + fmtMod(L.mod);
  if(L.t === 'nat')  return L.text;
  if(L.t === 'dc')   return L.idx + ' ' + L.value;
  if(L.t === 'tot')  return '**合计** ' + L.text;
  return '';
}

/** view → 明细行数组（Markdown）。导出与详情面板都用它 */
export function rollDetailMd(view){
  return detailLines(view).map(lineMd).filter(Boolean);
}

/** 结论徽章 → 纯文本（战报里没有颜色可用，结论必须写进文字） */
function verdictMd(vd){
  if(!vd) return '';
  const mark = vd.crit ? (vd.ok ? '✨ 大成功 · ' : '💀 大失败 · ') : (vd.ok === null ? 'ⓘ ' : (vd.ok ? '✅ ' : '❌ '));
  return mark + vd.text;
}

/** 一条 roll 消息 → Markdown（首行结论 + 缩进明细） */
export function renderRollMd(m){
  const v = m.view;
  const head = '**' + (v.title || '掷骰') + '** → `' + v.total + '`' +
    (v.mode ? ('（' + (v.mode === 'adv' ? '优势' : '劣势') + '）') : '') +
    (v.verdict ? (' · ' + verdictMd(v.verdict)) : '') +
    (v.natBadge ? (' · ' + v.natBadge.icon + ' ' + v.natBadge.text) : '');
  const det = rollDetailMd(v);
  if(!det.length) return head;
  return head + '\n' + det.map(x => '    - ' + x).join('\n') +
    ((v.notes && v.notes.length) ? ('\n' + v.notes.map(n => '    - ⓘ ' + n).join('\n')) : '');
}

/** 任意消息 → Markdown（导出时按 kind 派发；与 renderMsg 是同一套映射的两种外壳） */
export function renderMsgMd(m){
  if(!m) return '';
  if(m.kind === 'roll') return renderRollMd(m);
  if(m.kind === 'sys')    return '> **' + (m.title || '') + '** ' + (m.line1 || '') + (m.line2 ? ('（' + m.line2 + '）') : '');
  if(m.kind === 'notice') return '> ⓘ ' + String(m.html || '').replace(/<[^>]+>/g, '');
  if(m.kind === 'cmd')    return '`' + (m.text || '') + '`';
  if(m.kind === 'chat')   return (m.text || '');
  if(m.kind === 'html')   return '（结构化说明 · 导出用 NDJSON 保留完整内容）';
  return '';
}

/* ★ 战报的时间与气泡、.status 用**同一个** UTC+8 格式化器（util.js）。
 *   以前这里按本地时区、服务端按 UTC —— 同一场跑团导出的战报与当时屏幕上差 8 小时。 */
const hhmmMd = hhmm;
const ymdMd  = ymd;

/** 服务端消息（payload 形态）→ 可渲染的 view 形态 */
export function toRenderable(m){
  const base = {id:m.id, ts:m.ts, kind:m.kind, from:m.from, actor:m.actor};
  const p = m.payload || {};
  if(m.kind === 'roll')   return Object.assign(base, {view:viewFromPayload(p)});
  // html kind 在库里存的是结构化 defs（不存 HTML 串），渲染时再变成气泡 —— 存串会让
  // 「说明内容」与「呈现样式」绑死，改一次样式就得迁移历史数据
  // 外层 .bubble 由 renderMsg 统一包，这里不要再包一层
  if(m.kind === 'html')   return Object.assign(base, {defs:p.defs, html:defsHtml(p.defs || {})});
  if(m.kind === 'notice') return Object.assign(base, {html:p.html});
  if(m.kind === 'sys')    return Object.assign(base, {title:p.title, line1:p.line1, line2:p.line2});
  return Object.assign(base, {text:p.text});
}

/** 整份战报。msgs 必须已按 seq 升序（服务端保证） */
export function renderBattleMd(msgs, meta){
  const m0 = meta || {};
  const head = [
    '# 骰娘战报 · 房间 ' + (m0.code || ''),
    '',
    '> 规则：' + (m0.rule || '-') + '　｜　导出：' + (m0.exportedAt || '') + '　｜　共 ' + msgs.length + ' 条',
    '',
    '> 30 天后房间消息会被清理 —— 这份战报是唯一的保全手段。NDJSON 版可原样回灌。',
    '',
  ];
  const body = [];
  let day = null;
  msgs.forEach(m => {
    const d = ymdMd(m.ts);
    if(d !== day){ day = d; body.push('## ' + d, ''); }
    const r = toRenderable(m);
    /* ★ 骰娘的每条回复都要写明「回应谁」—— 战报是事后复盘，聊天流里靠左右分列能猜，
     *   战报里只剩一行行文字，不写发起人就无法还原"这颗骰是谁掷的"。
     *   与 ui.js 的 replyTag 是同一个事实（m.actor）的两种外壳。 */
    const who = (m.from === '骰娘')
      ? ('**骰娘**' + ((m.actor && m.actor !== '骰娘') ? (' → **' + m.actor + '**') : ''))
      : ('**' + (m.actor || m.from || '?') + '**');
    body.push('* `' + hhmmMd(m.ts) + '` ' + who + ' · ' + renderMsgMd(r));
  });
  return head.concat(body).join('\n') + '\n';
}

export {hhmmMd, ymdMd, lineMd, chipsMd};
