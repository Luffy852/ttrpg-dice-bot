/* pack_dh.js — 规则包 · 匕首心
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken } from './alias.js';
import { DH_TRAITS, judgeDh } from './dh.js';
import { CARD_DOMAIN, CHECK_DOMAIN } from './domains.js';
import { RNG } from './rng.js';
import { RULE_META } from './rules.js';
import { esc, fmtMod } from './util.js';
import { buildTotal, sumKept } from './view.js';

const DH_PACK = {
  family:'dh',
  supportsCheck:false,
  needsCard:false,
  checkHint(){ return '匕首心不用 .rc —— 动作掷骰请用 <b>.dh 15</b>　·　<b>.dh 敏捷 15</b>　·　<b>.dh 敏捷 15 优势</b>'; },
  checkOffNote(ruleKey){
    return '当前规则为「' + esc(RULE_META[ruleKey].name) + '」，检定用<b>动作掷骰</b>而不是 .rc —— 请用 <b>.dh 15</b>；想看六特性清单可以发 <b>.rc list</b>。';
  },
  cardTemplate(){
    return {title:'尚未绑定角色卡', sections:[
      {h:'复制下面这行、改数字后发送即可', rows:[
        {k:'.st set 敏捷 2 力量 2 灵巧 1 本能 0 风度 1 知识 -1', v:'特性顺序：敏捷 力量 灵巧 本能 风度 知识（调整值 −1 ~ +3；旧译「仪态」也认）'}
      ]}
    ], foot:['不绑卡也能掷 —— <b>.dh 15</b> 按调整值 0 计算；绑了卡可以 <b>.dh 敏捷 15</b> 取特性调整值']};
  },
  parseCard(rest){
    const t = rest.trim().split(/\s+/).filter(Boolean);
    const data = {}, errs = [];
    for(let i = 0; i < t.length; i += 2){
      const e = lookupAlias(CARD_DOMAIN.dh, t[i]);
      const val = t[i + 1];
      if(!e){ errs.push('未知特性「' + t[i] + '」'); i -= 1; continue; }
      if(!/^[+-]?\d+$/.test(val == null ? '' : val)){ errs.push('「' + e.display + '」需要整数'); i -= 1; continue; }
      const v = parseInt(val, 10);
      if(v < -1 || v > 3){ errs.push(e.display + '调整值需在 −1 ~ +3'); continue; }
      data[e.key] = v;
    }
    return {data, errs, count:Object.keys(data).length};
  },
  renderCard(card){
    return '<div class="card">' + DH_TRAITS.map(t => {
      const v = card.data[t.key];
      return '<div class="cell"><span class="ck">' + t.zh + '</span> <span class="cv">' + (typeof v === 'number' ? fmtMod(v) : '—') + '</span> ' +
        '<span class="cm">' + esc(t.en) + '</span></div>';
    }).join('') + '</div>';
  },
  listChecks(ruleKey, card){
    const rows = DH_TRAITS.map(t => ({
      k:t.zh + ' / ' + t.abbr.toUpperCase(),
      v:esc(t.en) + '　·　卡上：' + (card && card.family === 'dh' && typeof card.data[t.key] === 'number' ? fmtMod(card.data[t.key]) : '—') +
        '　·　<b>.dh ' + t.zh + ' 15</b>'
    }));
    return {title:'📜 匕首心 · 六特性（本规则不用 .rc）', sections:[
      {h:'六特性调整值（−1 ~ +3）', rows}
    ], foot:[
      '★ 匕首心没有属性检定 —— 动作掷骰请用 <b>.dh 敏捷 15</b>（特性在前、难度在后；可带优势 / +调整值）',
      'ℹ️ 想换特性调整值：<b>.st set 敏捷 2 力量 2 灵巧 1 本能 0 风度 1 知识 -1</b>'
    ]};
  },
  verbs:{
    dh(args, ctx){
      const card = ctx.card, ruleKey = ctx.ruleKey;
      const tokens = args.split(/\s+/).filter(Boolean);
      let dc = null, mode = null, trait = null, flat = 0, bad = null, wantDc = false;
      tokens.forEach(t => {
        const md = lookupAlias('mode', t);
        if(md){ mode = md.key; return; }
        const nt = normToken(t);
        let m = nt.match(/^(?:dc|难度|dl|困难)(\d+)$/);
        if(m){ dc = parseInt(m[1], 10); wantDc = false; return; }
        if(nt === 'dc' || nt === '难度' || nt === '困难' || nt === 'dl'){ wantDc = true; return; }
        if(wantDc && /^\d+$/.test(nt)){ dc = parseInt(nt, 10); wantDc = false; return; }
        m = nt.match(/^([+-])(\d+)$/);
        if(m){ flat += parseInt(m[2], 10) * (m[1] === '-' ? -1 : 1); return; }
        const tr = lookupAlias(CHECK_DOMAIN.dh, t);
        if(tr){ if(trait) bad = t; else trait = tr; return; }
        if(/^\d+$/.test(nt)){ dc = parseInt(nt, 10); return; }
        bad = t;
      });
      if(bad) return {notice:'参数看不懂：「' + esc(bad) + '」。格式：<b>.dh 敏捷 15</b>（特性 → 难度 → 调整值/优劣势，顺序随意）'};
      const hope = RNG.die(12), fear = RNG.die(12);
      const groups = [
        {n:1, sides:12, sign:1, tries:[[hope]], kept:[hope], keptIdx:0, label:'希望骰 d12', chip:'希望'},
        {n:1, sides:12, sign:1, tries:[[fear]], kept:[fear], keptIdx:0, label:'恐惧骰 d12', chip:'恐惧'}
      ];
      if(mode){
        const d6 = RNG.die(6);
        groups.push({n:1, sides:6, sign:(mode === 'adv' ? 1 : -1), tries:[[d6]], kept:[d6], keptIdx:0,
          label:(mode === 'adv' ? '优势骰 d6' : '劣势骰 d6'), chip:(mode === 'adv' ? '优势' : '劣势')});
      }
      const diceSum = sumKept(groups);
      const comps = [], notes = [];
      let traitMod = 0;
      if(trait){
        const v = card ? card.data[trait.key] : undefined;
        if(typeof v === 'number') traitMod = v;
        else notes.push('尚未绑定角色卡（或卡上没有「' + esc(trait.zh) + '」），其调整值按 <b>0</b> 计算 —— 用 <b>.st set ' + esc(trait.zh) + ' 2</b> 设置');
      }
      const mod = traitMod + flat;
      if(mod) comps.push({label:'调整值' + (trait ? '（' + esc(trait.zh) + '）' : ''), v:mod});
      const t = buildTotal(diceSum, comps);
      const verdict = judgeDh(hope, fear, t.total, dc);
      if(verdict.why) notes.push(verdict.why);
      if(mode) notes.push((mode === 'adv' ? '优势' : '劣势') + '：额外 ' + (mode === 'adv' ? '+1d6' : '−1d6') +
        ' 计入总和；Hope / Fear 判定只看两颗 d12');
      const title = '动作掷骰' + (trait ? '（' + esc(trait.zh) + '）' : '') + (dc != null ? ' vs 难度 ' + dc : '');
      return {view:{ruleKey, mode, groups, comps, diceSum:t.diceSum, add:t.add, total:t.total,
        title, dc, dcLabel:'难度', verdict, natBadge:null, natNote:null, notes}};
    }
  },
  // ★ M3：从骰点事实还原四象限结论（Hope/Fear 只看两颗带 chip 标记的 d12，±d6 不参与）
  replayVerdict(f){
    const g = f.groups || [];
    const hope = (g.find(x => x.chip === '希望') || {}).kept;
    const fear = (g.find(x => x.chip === '恐惧') || {}).kept;
    if(!hope || !fear) return null;
    return judgeDh(hope[0], fear[0], f.total, f.dc);
  },
};

/* ---------- 最终物语包 ---------- */

export { DH_PACK };
