/* render.js — 7 渲染：聊天流 / 详情 / 战报三处共用同一函数
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { sumArr } from './roll.js';
import { esc, fmtMod } from './util.js';

function hasNatSemantics(ruleKey){ return ruleKey === 'dnd5e' || ruleKey === 'dnd5r'; }
function critOf(sides, v, ruleKey){
  if(!hasNatSemantics(ruleKey)) return '';
  return (sides === 20 && (v === 20 || v === 1)) ? ' crit' : '';
}

function allChips(groups, ruleKey){
  return groups.map(g => groupChips(g, ruleKey)).join('<span class="sep">+</span>');
}
// 百分骰（COC）：十位骰若干 + 共用个位骰 —— 未采用的十位划掉，一眼能核验取了哪一颗
function percentChips(g){
  const p = g.percent, out = ['<span class="plab">十位</span>'];
  p.tens.forEach((t, i) => out.push('<span class="chip' + (i === p.pick ? '' : ' drop') + '">' + t + '</span>'));
  out.push('<span class="plab">个位</span>');
  out.push('<span class="chip">' + p.ones + '</span>');
  return out.join('');
}
function groupChips(g, ruleKey){
  if(g.percent) return percentChips(g);
  // 折叠态同样带语义标签（希望 / 恐惧 / DEX / INS）—— 两颗骰并排时没有标签就分不清谁是谁
  const lab = g.chip ? '<span class="plab">' + esc(g.chip) + '</span>' : '';
  const multi = g.tries.length > 1;
  if(!multi) return lab + g.kept.map(v => '<span class="chip' + critOf(g.sides, v, ruleKey) + '">' + v + '</span>').join('');
  const out = [lab];
  g.tries.forEach((tv, i) => {
    const used = i === g.keptIdx;
    tv.forEach(v => out.push('<span class="chip' + (used ? critOf(g.sides, v, ruleKey) : ' drop') + '">' + v + '</span>'));
    if(i < g.tries.length - 1) out.push('<span class="sep">/</span>');
  });
  return out.join('');
}

// 判定色：ok / no / mid / crit / critfail。★ 结论的"色调"由规则包给定（tone），
// 主渲染不猜 —— 「失败带希望」不是纯失败（橙），「成功带恐惧」也不是纯成功。
function toneOf(vd){
  if(!vd) return '';
  if(vd.tone === 'crit') return 'crit';
  if(vd.tone === 'critfail') return 'critfail';
  if(vd.tone === 'mid') return 'mid';
  if(vd.ok === null) return 'mid';
  return vd.ok ? 'ok' : 'no';
}
/* ---------- ★ 逐骰明细：三处共用的**数据层**（M3 抽出） ----------
 * 【为什么抽】明细要出现在三个地方：聊天流气泡（HTML）、详情面板、导出的战报（Markdown）。
 *   以前明细的拼装写在 renderRoll 里，战报就只能再抄一遍 —— 抄的那份迟早与气泡对不上
 *   （原则 4：同一份渲染不写两遍）。现在：**数据在这里算一次**，两个渲染目标各管外壳。
 * 【边界】本函数只产出「有什么行、每行几颗骰、哪颗被丢弃」，**不含任何标签与转义** ——
 *   HTML 侧负责 esc 与 class，Markdown 侧负责自己的排版。这样两边都不必去字符串里抠数据。
 */
function detailLines(v){
  const out = [];
  (v.groups || []).forEach(g => {
    if(g.percent){
      // COC 百分骰：明细必须能看出「十位取了哪颗、个位是多少、怎么合成 1–100」
      const p = g.percent;
      out.push({t:'tens', idx:'十位', chips:p.tens.map((x, i) => ({v:x, drop:i !== p.pick})),
        tail:(p.tens.length > 1 ? ((p.kind === 'bonus' ? '奖励取低 ' : '惩罚取高 ') + p.tens[p.pick]) : '—')});
      out.push({t:'ones', idx:'个位', chips:[{v:p.ones, drop:false}],
        tail:((p.tens[p.pick] === 0 && p.ones === 0) ? '十位 00 + 个位 0 = 100' : '→ ' + g.kept[0])});
      return;
    }
    const multi = g.tries.length > 1;
    g.tries.forEach((tv, i) => {
      const used = i === g.keptIdx;
      out.push({
        t:'try', use:used, idx:(multi ? '第' + (i + 1) + '次' : ''),
        // ★ 兜底：payload 若缺 n（手写/旧数据），不能渲染出 "undefinedd6" —— 战报是给人读的
        label:(g.label ? g.label : (g.n != null ? (g.n + 'd' + g.sides) : ('d' + g.sides))),
        chips:tv.map(x => ({v:x, drop:!used, crit:(used ? critOf(g.sides, x, v.ruleKey) : '')})),
        tail:(multi ? ((used ? '采用 · 骰点 ' : '骰点 ') + sumArr(tv)) : null)
      });
    });
  });
  (v.comps || []).forEach(c => out.push({t:'comp', idx:'', label:c.label, mod:c.v}));
  if(v.natNote) out.push({t:'nat', idx:'', text:v.natNote});
  if(v.dc != null) out.push({t:'dc', idx:(v.dcLabel || '难度'), value:v.dc});
  // ★ 没有调整项时就不提「调整项」：COC 百分骰、FU 两骰求和都不存在调整值这个概念，
  //   恒为 +0 的一行既占版面又暗示"这里可以调"，是噪音（真机反馈：截图里被圈出来）
  out.push({t:'tot', idx:'合计', text:((v.comps && v.comps.length)
    ? ('骰点 ' + v.diceSum + ' + 调整项 ' + fmtMod(v.add) + ' → ' + v.total)
    : ('骰点 ' + v.diceSum + ' → ' + v.total))});
  return out;
}

/** 明细 → HTML（聊天流与详情面板共用；战报走 render-md.js 的同一份 detailLines） */
function detailHtml(v){
  return detailLines(v).map(L => {
    const chips = L.chips ? ('<span class="chips">' + L.chips.map(c =>
      '<span class="chip' + (c.drop ? ' drop' : (c.crit || '')) + '">' + c.v + '</span>').join('') + '</span>') : '';
    const tail = (L.tail != null) ? ('<span class="tail">' + L.tail + '</span>') : '';
    if(L.t === 'try')   return '<div class="dline' + (L.use ? ' use' : '') + '"><span class="idx">' + L.idx +
      '</span><span>' + esc(L.label) + '</span>' + chips + tail + '</div>';
    if(L.t === 'tens')  return '<div class="dline use"><span class="idx">' + L.idx + '</span>' + chips + tail + '</div>';
    if(L.t === 'ones')  return '<div class="dline"><span class="idx">' + L.idx + '</span>' + chips + tail + '</div>';
    if(L.t === 'comp')  return '<div class="dline comp"><span class="idx">' + esc(L.idx) + '</span><span>' +
      esc(L.label) + ' ' + fmtMod(L.mod) + '</span></div>';
    if(L.t === 'nat')   return '<div class="dline nat"><span class="idx"></span><span>' + esc(L.text) + '</span></div>';
    if(L.t === 'dc')    return '<div class="dline comp"><span class="idx">' + esc(L.idx) + '</span><span>' + L.value + '</span></div>';
    if(L.t === 'tot')   return '<div class="dline tot"><span class="idx">' + L.idx + '</span><span>' + L.text + '</span></div>';
    return '';
  }).join('');
}

function renderRoll(m){
  const v = m.view;
  const badge = !v.verdict ? '' :
    '<span class="badge ' + toneOf(v.verdict) + '">' +
       (v.verdict.crit ? (v.verdict.ok ? '✨ ' : '💀 ')
        : (v.verdict.ok === null ? 'ⓘ ' : (v.verdict.ok ? '✅ ' : '❌ '))) + esc(v.verdict.text) + '</span>';
  // nat 徽章：只在"结论没覆盖它"时出现（5.5e 有 DC 时 verdict 已写大成功/大失败，不重复）
  const nb = (!v.natBadge || (v.verdict && v.verdict.crit)) ? '' :
    '<span class="badge ' + v.natBadge.cls + '">' + v.natBadge.icon + ' ' + esc(v.natBadge.text) + '</span>';
  const parts = [];
  parts.push('<div class="row1">');
  parts.push('<span class="caret">▶</span>');
  parts.push('<span class="ttl">' + esc(v.title) + '</span>');
  if(v.mode) parts.push('<span class="mode">' + (v.mode === 'adv' ? '优势' : '劣势') + '</span>');
  parts.push('<span class="chips">' + allChips(v.groups, v.ruleKey) + '</span>');
  parts.push('<span class="sum">→ ' + v.total + '</span>');
  parts.push(badge);
  parts.push(nb);
  parts.push('</div>');

  parts.push('<div class="detail">' + detailHtml(v) + '</div>');
  if(v.notes && v.notes.length) parts.push('<div class="note">' + v.notes.map(n => 'ⓘ ' + n).join('<br>') + '</div>');
  return '<div class="bubble dice rule-' + v.ruleKey + '" data-mid="' + m.id + '">' + parts.join('') + '</div>';
}

function renderSys(m){
  return '<div class="sys"><div class="h">' + esc(m.title) + '</div>' +
    '<div class="b1">' + esc(m.line1) + '</div>' +
    '<div class="b2">' + esc(m.line2) + '</div></div>';
}
function renderNotice(m){ return '<div class="notice">ⓘ ' + m.html + '</div>'; }
function renderPre(text){ return '<div class="bubble"><pre>' + esc(text) + '</pre></div>'; }
function renderHtml(html){ return '<div class="bubble">' + html + '</div>'; }

// 指令 / 说明 分栏渲染。v 允许含有限标签（调用方对动态内容自行 esc）
function defsHtml(d){
  let h = '';
  if(d.title) h += '<div class="ht">' + esc(d.title) + '</div>';
  (d.sections || [{rows:d.rows}]).forEach(s => {
    if(s.h) h += '<div class="hs"><div class="hh">' + esc(s.h) + '</div>';
    else h += '<div class="hs">';
    (s.rows || []).forEach(r => {
      h += '<div class="hrow"><span class="hk">' + r.k + '</span><span class="hv">' + r.v + '</span></div>';
    });
    h += '</div>';
  });
  if(d.foot && d.foot.length) h += '<div class="hf">' + d.foot.join('<br>') + '</div>';
  return h;
}
function renderDefs(d){ return '<div class="bubble">' + defsHtml(d) + '</div>'; }
// 角色卡：栅格而非等宽文本，窄屏自动降为 2 列，不会换行错位
function renderChat(m){ return '<div class="bubble">' + esc(m.text) + '</div>'; }
function renderMsg(m){
  if(m.kind === 'sys') return renderSys(m);
  if(m.kind === 'notice') return renderNotice(m);
  if(m.kind === 'pre') return renderPre(m.text);
  if(m.kind === 'html') return renderHtml(m.html);
  if(m.kind === 'cmd') return '<div class="bubble cmd">' + esc(m.text) + '</div>';
  if(m.kind === 'roll') return renderRoll(m);
  return renderChat(m);
}

/* ---------- 8. help.js：帮助文本（结构化，非纯文本 —— 窄屏下分栏渲染） ----------
 * 结构：{title, sections:[{h, rows:[{k,v}]}], foot:[]}
 * 为何不存纯文本：纯等宽文本在窄屏换行后，指令与说明会粘成一坨（用户实测反馈）。
 * 结构化后由 renderDefs 分栏，窄屏时 k 独占一行带底色，语义边界清晰。
 */

export { detailLines, detailHtml, hasNatSemantics, critOf, allChips, percentChips, groupChips, toneOf, renderRoll, renderSys, renderNotice, renderPre, renderHtml, defsHtml, renderDefs, renderChat, renderMsg };
