/* pack_fu.js — 规则包 · 最终物语
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken } from './alias.js';
import { CARD_DOMAIN, CHECK_DOMAIN } from './domains.js';
import { FU_ATTRS, FU_MEMO, FU_TIERS, judgeFu, parseTier } from './fu.js';
import { DH_PACK } from './pack_dh.js';
import { RNG } from './rng.js';
import { RULE_META } from './rules.js';
import { esc } from './util.js';
import { buildTotal, sumKept } from './view.js';

const FU_PACK = {
  family:'fu',
  supportsCheck:false,
  needsCard:false,
  checkHint(){ return '最终物语不用 .rc —— 检定请用 <b>.fu dex ins 10</b>　·　<b>.fu d8 d10 10</b>　·　<b>.fu dex ins</b>（不判难度）'; },
  checkOffNote(ruleKey){
    return '当前规则为「' + esc(RULE_META[ruleKey].name) + '」，检定用<b>两颗属性骰求和</b>而不是 .rc —— 请用 <b>.fu dex ins 10</b>；属性与骰阶清单见 <b>.rc list</b>。';
  },
  cardTemplate(){
    return {title:'尚未绑定角色卡', sections:[
      {h:'复制下面这行、改骰阶后发送即可', rows:[
        {k:'.st set dex d8 ins d10 mig d8 wlp d6', v:'属性顺序：敏捷 洞察 力量 意志（骰阶 d6 / d8 / d10 / d12）'},
        {k:'.st set 敏捷 d8 洞察 d10 力量 d8 意志 d6', v:'同上，中文写法'},
        {k:'.st set 物语点 3 物资点 2', v:'可选：两个备忘值（只记录、骰娘不自动增减）'}
      ]}
    ], foot:['不绑卡也能掷 —— 直接给骰阶：<b>.fu dex ins 10</b>']};
  },
  parseCard(rest){
    const t = rest.trim().split(/\s+/).filter(Boolean);
    const data = {}, errs = [];
    for(let i = 0; i < t.length; i += 2){
      const e = lookupAlias(CARD_DOMAIN.fu, t[i]);
      const val = t[i + 1];
      if(!e){ errs.push('未知属性「' + t[i] + '」（四属性：敏捷 / 洞察 / 力量 / 意志）'); i -= 1; continue; }
      // 备忘字段（物语点 / 物资点）是**整数**，不是骰阶 —— 必须分流，否则 .st set 物语点 3 会被当成骰阶报错
      if(e.kind === 'fumemo'){
        if(!/^\d+$/.test(val == null ? '' : val)){ errs.push('「' + e.display + '」需要非负整数'); i -= 1; continue; }
        const n = parseInt(val, 10);
        if(n > 99){ errs.push('「' + e.display + '」需在 0–99'); continue; }
        data[e.key] = n;
        continue;
      }
      let tier = parseTier(val);
      if(tier == null && /^\d+$/.test(val == null ? '' : val)){
        const n = parseInt(val, 10);
        if(FU_TIERS.indexOf(n) >= 0) tier = n;      // 宽容：写 8 也认，同 d8
      }
      if(tier == null){ errs.push('「' + e.display + '」需要骰阶 d6 / d8 / d10 / d12'); i -= 1; continue; }
      data[e.key] = tier;
    }
    return {data, errs, count:Object.keys(data).length};
  },
  renderCard(card){
    const memo = FU_MEMO.filter(m => typeof card.data[m.key] === 'number');
    const memoHtml = memo.length
      ? '<div class="stline" style="margin-top:6px">' + memo.map(m => esc(m.zh) + ' <b>' + card.data[m.key] + '</b>').join('　·　') +
        '　<span class="ck">（备忘值，骰娘不自动增减 —— 用 <b>.st set 物语点 3</b> 手改）</span></div>'
      : '';
    return '<div class="card">' + FU_ATTRS.map(a => {
      const v = card.data[a.key];
      return '<div class="cell"><span class="ck">' + a.zh + ' ' + a.en.toUpperCase() + '</span> <span class="cv">' +
        (typeof v === 'number' ? 'd' + v : '—') + '</span></div>';
    }).join('') + '</div>' + memoHtml;
  },
  listChecks(ruleKey, card){
    const rows = FU_ATTRS.map(a => ({
      k:a.zh + ' / ' + a.en.toUpperCase(),
      v:'卡上骰阶：' + (card && card.family === 'fu' && typeof card.data[a.key] === 'number' ? 'd' + card.data[a.key] : '—') +
        '　·　<b>.fu ' + a.en + ' ' + a.en + ' 10</b>'
    }));
    return {title:'📜 最终物语 · 四属性（本规则不用 .rc）', sections:[
      {h:'四属性骰阶（d6 / d8 / d10 / d12）', rows},
      {h:'难度参考（DL）', rows:[
        {k:'7',  v:'易'}, {k:'10', v:'普通'}, {k:'13', v:'困难'}, {k:'16', v:'极难'}
      ]}
    ], foot:[
      '★ 最终物语没有属性检定 —— 请用 <b>.fu dex ins 10</b>（两颗属性骰求和 vs DL）',
      'ℹ️ 同一个属性可用两次：<b>.fu dex dex 13</b>　·　不判难度：<b>.fu dex ins</b>',
      'ℹ️ 无卡也能掷，直接给骰阶：<b>.fu d8 d10 10</b>'
    ]};
  },
  verbs:{
    fu(args, ctx){
      const card = ctx.card, ruleKey = ctx.ruleKey;
      const tokens = args.split(/\s+/).filter(Boolean);
      const slots = []; let dl = null, bad = null, modeBad = false, wantDl = false, out = null, mod = 0;
      tokens.forEach(t => {
        if(out) return;
        if(lookupAlias('mode', t)){ modeBad = true; return; }
        const nt = normToken(t);
        // 调整值：+2 / -1（写在指令里，不是卡上的状态 —— 不影响纯函数性质）
        const mm = nt.match(/^([+-])(\d+)$/);
        if(mm){ mod += parseInt(mm[2], 10) * (mm[1] === '-' ? -1 : 1); return; }
        let m = nt.match(/^(?:dl|难度|困难)(\d+)$/);
        if(m){ dl = parseInt(m[1], 10); wantDl = false; return; }
        if(nt === 'dl' || nt === '难度' || nt === '困难'){ wantDl = true; return; }
        if(wantDl && /^\d+$/.test(nt)){ dl = parseInt(nt, 10); wantDl = false; return; }
        const tier = parseTier(t);
        if(tier){ if(slots.length >= 2) bad = t; else slots.push({tier, short:'d' + tier}); return; }
        const at = lookupAlias(CHECK_DOMAIN.fu, t);
        if(at){
          if(slots.length >= 2){ bad = t; return; }
          const v = card ? card.data[at.key] : undefined;
          if(typeof v === 'number') slots.push({tier:v, short:at.en.toUpperCase()});
          else out = {notice:'尚未绑定角色卡（或卡上没有「' + esc(at.zh) + '」的骰阶）—— 用 <b>.st set ' + esc(at.zh) + ' d8</b> 设置，或直接用骰阶 <b>.fu d8 d10 10</b>'};
          return;
        }
        if(/^\d+$/.test(nt)){ dl = parseInt(nt, 10); return; }
        bad = t;
      });
      if(out) return out;
      if(bad) return {notice:'参数看不懂：「' + esc(bad) + '」。格式：.fu <属性1> <属性2> [难度]　例：<b>.fu dex ins 10</b>'};
      if(modeBad) return {notice:'最终物语<b>没有优劣势机制</b> —— 需要重掷请直接再发一次同一条指令（v1 不追踪物语点）'};
      if(slots.length < 2) return {notice:'需要两个骰阶：<b>.fu dex ins 10</b>（属性名或 d8 / d10 都行）'};
      const v1 = RNG.die(slots[0].tier), v2 = RNG.die(slots[1].tier);
      const groups = [
        {n:1, sides:slots[0].tier, sign:1, tries:[[v1]], kept:[v1], keptIdx:0, label:slots[0].short + ' d' + slots[0].tier, chip:slots[0].short},
        {n:1, sides:slots[1].tier, sign:1, tries:[[v2]], kept:[v2], keptIdx:0, label:slots[1].short + ' d' + slots[1].tier, chip:slots[1].short}
      ];
      const comps = [];
      if(mod) comps.push({label:'调整值', v:mod});
      const t = buildTotal(sumKept(groups), comps);
      const verdict = judgeFu(v1, v2, dl, mod);
      const notes = [];
      if(verdict.why) notes.push(verdict.why);
      notes.push('高骰 HR = ' + Math.max(v1, v2) + '（攻击伤害用此值）');
      const title = '检定 ' + slots.map(s => s.short + '(d' + s.tier + ')').join(' + ') +
        (dl != null ? ' vs DL ' + dl : '') + (mod ? (mod > 0 ? ' +' : ' ') + mod : '');
      return {view:{ruleKey, mode:null, groups, comps, diceSum:t.diceSum, add:t.add, total:t.total,
        title, dc:dl, dcLabel:'DL', verdict, natBadge:null, natNote:null, notes}};
    }
  },
  // ★ M3：从骰点事实还原判定（暴击/失手只看骰面，调整值只影响「合计 vs DL」这一处比较）
  replayVerdict(f){
    const g = f.groups || [];
    if(g.length < 2 || !g[0].kept || !g[1].kept) return null;
    const mod = (f.comps || []).reduce((s, c) => s + (c.v || 0), 0);
    return judgeFu(g[0].kept[0], g[1].kept[0], f.dc, mod);
  },
};

// ★ 通用 .r 的"降级接管"：DH / FU 的检定参数不是骰表达式（.r 敏捷 15 / .r dex ins 10），
//   以前会撞上"暂不支持该语法（括号/乘除/骰池）"这种毫不相关的报错。
//   只在通用解析失败时接管，合法骰表达式仍走通用掷骰 —— .r 的既有能力一点没少。
//   放在这里而不是塞进 verbs，是因为 verbs 有"打错规则要提示归属"的语义，两者不能混。
DH_PACK.takeOverR = DH_PACK.verbs.dh;
FU_PACK.takeOverR = FU_PACK.verbs.fu;

// ★ 规则包注册表：M2 三包在这里各加一行，主流程不动

export { FU_PACK };
