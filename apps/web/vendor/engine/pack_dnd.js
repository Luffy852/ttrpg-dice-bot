/* pack_dnd.js — 规则包 · D&D 5e / 5.5e
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken, registerAliases, suggestAlias } from './alias.js';
import { cardMod, parseCardSet, renderCardHtml } from './card.js';
import { DH_TRAITS } from './dh.js';
import { ABIL_KEYS, ABIL_ZH, DND_SKILLS, profFromLv } from './dnd.js';
import { CARD_DOMAIN, checkDomainOf } from './domains.js';
import { FU_ATTRS, lookupCheckTarget } from './fu.js';
import { parseExpr } from './parse.js';
import { rollGroups } from './roll.js';
import { esc, fmtMod } from './util.js';
import { buildTotal, judgeDnd, natMarkOf, natOf, sumKept } from './view.js';

const DND_PACK = {
  family:'dnd',
  supportsCheck:true,
  needsCard:true,
  checkHint(){ return '用法：<b>.rc 力量</b>　·　<b>.rc 巧手 熟练</b>　·　<b>.rc 察觉 15 熟练</b>　·　<b>.rc list</b> 看全部名字'; },
  checkOffNote(){ return null; },
  cardTemplate(){
    return {title:'尚未绑定角色卡', sections:[
      {h:'复制下面这行、改数字后发送即可（中英文都认）', rows:[
        {k:'.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 5 ac 16 hp 24', v:'顺序：力量 敏捷 体质 智力 感知 魅力 等级 + 护甲等级 生命值'},
        {k:'.st set str 16 dex 14 con 15 int 10 wis 12 cha 8 lv 5', v:'同上，英文写法（AC / HP 可省略）'}
      ]}
    ], foot:['等级用于推导熟练加值，可省略',
      /* ★ 必须说清 AC 是**手填**的：玩家习惯"AC = 10 + 敏捷"，
       *   而骰娘没有装备表推不出来 —— 不说的话会有人以为"没显示就是骰娘算错了"。 */
      '护甲等级 AC 需自己填（骰娘没有装备表，无法按盔甲 / 盾牌推算）；生命值 HP 同理，只作备忘，骰娘不会自动增减']};
  },
  parseCard(rest){ return parseCardSet(rest); },
  renderCard(card){ return renderCardHtml(card); },
  cardExtra(card){
    const lv = card.data.lv, prof = profFromLv(lv);
    return '<div class="stline" style="margin-top:6px">' + (prof != null
      ? '熟练加值 <b>' + fmtMod(prof) + '</b>（由等级 ' + lv + ' 推导）　·　用 <b>.rc &lt;技能&gt; 熟练</b> 才计入'
      : '熟练加值 —（未设等级，用 <b>.st set lv 5</b> 设置）') + '</div>';
  },
  // ★ 检定逻辑搬进包里（M2）：主流程只负责"卡片族对不对 + 把 view 发出去"
  runCheck({args, mode, card, ruleKey}){
    const tokens = args.split(/\s+/).filter(Boolean);
    let name = null, dc = null, useProf = false, bad = null, wantDc = false;
    tokens.forEach(t => {
      const nt = normToken(t);
      if(!wantDc && /^\d+$/.test(nt)){ dc = parseInt(nt, 10); return; }
      if(lookupAlias('prof', nt)){ useProf = true; return; }
      const m = nt.match(/^(?:dc|难度|困难)(\d+)$/);
      if(m){ dc = parseInt(m[1], 10); return; }
      if(nt === 'dc' || nt === '难度' || nt === '困难'){ wantDc = true; return; }   // 下一个数字即难度
      if(name === null) name = t; else bad = t;
    });
    if(bad) return {notice:'参数太多：「' + esc(bad) + '」。格式：.rc <属性或技能> [难度] [熟练]'};
    const hit = lookupCheckTarget(name, ruleKey);
    if(!hit){
      const s = suggestAlias(checkDomainOf(ruleKey), name, 2);
      return {notice:'未识别「' + esc(name) + '」' + (s.length ? '。你是不是想找：<b>' + s.map(esc).join('</b> / <b>') + '</b>' : '') +
        '<br>属性与技能都认中文，用 <b>.rc list</b> 看全部'};
    }
    const p = parseExpr('1d20');
    const groups = rollGroups(p.groups, mode, ruleKey);
    const diceSum = sumKept(groups);
    const comps = [];
    const abMod = cardMod(card, hit.ab);
    comps.push({label:(hit.kind === 'skill' ? hit.zh + '（' + ABIL_ZH[hit.ab] + '）' : ABIL_ZH[hit.ab]) + '调整值', v:abMod});
    const prof = profFromLv(card.data.lv);
    if(useProf){
      if(prof == null) return {notice:'尚未设置等级，无法计入熟练加值。请用 <b>.st set lv 5</b> 设置等级，或去掉 p 直接检定。'};
      comps.push({label:'熟练加值', v:prof});
    }
    const t = buildTotal(diceSum, comps);
    const nat = natOf(groups, diceSum);
    const verdict = judgeDnd(t.total, dc, nat, ruleKey);
    const nm = natMarkOf(nat, ruleKey);
    const notes = [];
    if(hit.kind === 'skill' && prof != null && !useProf) notes.push('熟练加值 ' + fmtMod(prof) + ' 未计入，若熟练请用 .rc ' + hit.zh + ' p');
    const title = hit.kind === 'skill'
      ? hit.zh + '检定（' + ABIL_ZH[hit.ab] + (useProf ? ' · 含熟练' : '') + '）'
      : ABIL_ZH[hit.ab] + '检定' + (useProf ? '（含熟练）' : '');
    return {view:{ruleKey, mode, groups, comps, diceSum:t.diceSum, add:t.add, total:t.total,
      title, dc, dcLabel:'DC', verdict, natBadge:(nm && nm.badge) || null, natNote:(nm && nm.note) || null, notes}};
  },
  listChecks(ruleKey){
    const byAb = {};
    DND_SKILLS.forEach(s => { (byAb[s.ab] = byAb[s.ab] || []).push(s.zh); });
    return {title:'📜 D&D 检定可用的名字（中英文都认）', sections:[
      {h:'六属性（直接打中文即可）', rows:ABIL_KEYS.map(k => ({
        k:ABIL_ZH[k] + ' / ' + k.toUpperCase(), v:ABIL_ZH[k] + '检定：1d20 + ' + ABIL_ZH[k] + '调整值'
      }))},
      {h:'18 项技能（按属性分组）', rows:ABIL_KEYS.filter(k => byAb[k]).map(k => ({
        k:ABIL_ZH[k], v:byAb[k].join(' / ')
      }))}
    ], foot:[
      '用法：.rc 力量　·　.rc 巧手 熟练　·　.rc 察觉 15 熟练',
      '⚠️ 威吓简写是 inti，不能写成 int（int 是智力）',
      '⚠️ 感知是 WIS 属性；想掷 Perception 请打「察觉」',
      'ℹ️ 本表由 <b>D&D 规则包</b>提供；切到别的规则后，同一条 .rc list 会给出那套规则的表'
    ]};
  },
  // ★ M3：从骰点事实还原判定（nat 由骰面推出，不由存储推出）
  replayVerdict(f){ return judgeDnd(f.total, f.dc, f.nat, f.ruleKey || 'dnd5e'); },
};
// 卡字段同样注册进各自的域（.st set 用），与检定域共用同一份数据 —— 不手写第二张表
registerAliases(CARD_DOMAIN.dh, DH_TRAITS.map(t => ({key:t.key, display:t.zh, aliases:t.aliases})));
registerAliases(CARD_DOMAIN.fu, FU_ATTRS.map(a => ({key:a.key, display:a.zh, aliases:a.aliases})));

/* ---------- COC 7th 包 ---------- */

export { DND_PACK };
