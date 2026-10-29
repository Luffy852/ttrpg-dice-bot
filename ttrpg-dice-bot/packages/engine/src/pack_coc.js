/* pack_coc.js — 规则包 · COC 7th
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken, suggestAlias } from './alias.js';
import { COC_MEMO, judgeCoc, lookupCocSkill, rollPercent } from './coc.js';
import { CARD_DOMAIN, checkDomainOf } from './domains.js';
import { esc } from './util.js';
import { buildTotal } from './view.js';

const COC_PACK = {
  family:'coc7',
  supportsCheck:true,
  needsCard:true,
  checkHint(){ return '用法：<b>.rc 侦查</b>　·　<b>.rc 侦查 +1</b>（1 奖励骰）　·　<b>.rc 侦查 -2</b>（2 惩罚骰）　·　<b>.rc list</b> 看卡上技能'; },
  checkOffNote(){ return null; },
  noCardNote(){
    return '尚未绑定角色卡 —— 先用 <b>.st set 侦查 60 图书馆 50 心理学 40</b> 绑定（技能名 + 数值，任意增减），' +
           '再 <b>.rc 侦查</b>；或直接用 <b>.r 1d100</b> 裸掷。';
  },
  cardTemplate(){
    return {title:'尚未绑定角色卡', sections:[
      {h:'复制下面这行、改成自己的技能后发送即可', rows:[
        {k:'.st set 侦查 60 图书馆 50 心理学 40 hp 12 san 70', v:'格式：技能名 数值，空格分隔，可任意增减技能'}
      ]},
      {h:'这张卡的两条规则', rows:[
        {k:'技能表是开放的', v:'想加什么就写什么：<b>.st set 开锁 30 手枪 45</b> —— 不在常用表里的名字也照收，原样进卡'},
        {k:'hp / san 是备忘', v:'只作显示，骰娘<b>不会自动增减</b>；变化请自己 <b>.st set san 65</b> 改'}
      ]}
    ], foot:['★ COC 检定 = 掷 1d100 ≤ 技能值；奖惩骰见 <b>.help coc</b>']};
  },
  parseCard(rest){
    const t = rest.trim().split(/\s+/).filter(Boolean);
    const data = {}, errs = [];
    for(let i = 0; i < t.length; i += 2){
      const raw = t[i];
      const e = lookupAlias(CARD_DOMAIN.coc7, raw);
      const key = e ? e.key : raw;                 // 未注册的自定义技能：原样作键（开放列表）
      const val = t[i + 1];
      if(!/^\d+$/.test(val == null ? '' : val)){ errs.push('「' + raw + '」后面需要一个非负整数'); i -= 1; continue; }
      const v = parseInt(val, 10);
      if(COC_MEMO.has(key)){ if(v > 999){ errs.push(key.toUpperCase() + ' 需在 0–999'); continue; } }
      else if(v < 1 || v > 99){ errs.push('「' + key + '」需在 1–99'); continue; }
      data[key] = v;
    }
    return {data, errs, count:Object.keys(data).length};
  },
  renderCard(card){
    const keys = Object.keys(card.data).filter(k => !COC_MEMO.has(k));
    const memo = Object.keys(card.data).filter(k => COC_MEMO.has(k));
    const cells = keys.slice(0, 24).map(k =>
      '<div class="cell"><span class="ck">' + esc(k) + '</span> <span class="cv">' + card.data[k] + '</span></div>').join('');
    const memoHtml = memo.length
      ? '<div class="stline" style="margin-top:6px">' + memo.map(k => esc(k.toUpperCase()) + ' ' + card.data[k]).join('　·　') +
        '　<span class="ck">（备忘值，骰娘不自动增减）</span></div>'
      : '';
    return (cells ? '<div class="card">' + cells + '</div>' : '<div class="stline">（卡上还没有技能）</div>') +
      memoHtml + (keys.length > 24 ? '<div class="stline">… 共 ' + keys.length + ' 项</div>' : '');
  },
  listChecks(ruleKey, card){
    if(card && card.family === 'coc7' && Object.keys(card.data).length){
      const keys = Object.keys(card.data).filter(k => !COC_MEMO.has(k));
      return {title:'📜 你卡上的技能（COC 7th）', sections:[
        {h:'已绑定 ' + keys.length + ' 项 · 直接 .rc 名字即可掷', rows:keys.slice(0, 18).map(k => ({
          k:esc(k), v:'<b>.rc ' + esc(k) + '</b>　·　奖惩骰 <b>.rc ' + esc(k) + ' +1</b>'
        }))}
      ], foot:[
        '技能表是开放的：想加就 <b>.st set 开锁 30</b>，不用管表里有没有',
        '未绑的技能不能直接掷 —— 先 <b>.st set 名字 数值</b>，或 <b>.r 1d100</b> 裸掷'
      ]};
    }
    return {title:'📜 COC 检定 · 本规则怎么用', sections:[
      {h:'还没有卡：先绑一张', rows:[
        {k:'.st set 侦查 60 图书馆 50 心理学 40 hp 12 san 70', v:'技能名 数值，任意增减；绑完再看 .rc list 会列出你自己的技能'}
      ]},
      {h:'常用技能名参考（中英文都认）', rows:[
        {k:'侦查 / 图书馆 / 心理学', v:'spot · library · psychology'},
        {k:'说服 / 威吓 / 潜行',     v:'persuade · intimidate · stealth'},
        {k:'急救 / 医学 / 手枪 / 格斗', v:'firstaid · medicine · handgun · brawl'},
        {k:'幸运 / 灵感 / 意志',      v:'luck · idea · pow　（也常用作检定）'}
      ]}
    ], foot:[
      '★ COC 的技能表是开放列表 —— 上面只是参考，你写什么名字都能进卡',
      'ℹ️ 检定是 1d100 ≤ 技能值；奖惩骰写法 <b>.rc 侦查 +1</b> / <b>.rc 侦查 -2</b>'
    ]};
  },
  runCheck({args, mode, card, ruleKey}){
    const tokens = args.split(/\s+/).filter(Boolean);
    let name = null, bonus = 0, penalty = 0, bad = null;
    tokens.forEach(t => {
      const nt = normToken(t);
      let m = nt.match(/^\+(\d+)$/);
      if(m){ bonus += parseInt(m[1], 10); return; }
      m = nt.match(/^-(\d+)$/);
      if(m){ penalty += parseInt(m[1], 10); return; }
      m = nt.match(/^(?:奖励|奖|bonus|b)(\d*)$/);
      if(m){ bonus += (m[1] ? parseInt(m[1], 10) : 1); return; }
      m = nt.match(/^(?:惩罚|罚|penalty)(\d*)$/);
      if(m){ penalty += (m[1] ? parseInt(m[1], 10) : 1); return; }
      if(name === null) name = t; else bad = t;
    });
    if(bad) return {notice:'参数太多：「' + esc(bad) + '」。格式：.rc <技能名> [+奖励骰] [-惩罚骰]'};
    if(!name) return {notice:'请给出技能名，例如 <b>.rc 侦查</b>；奖惩骰写法 <b>.rc 侦查 +1</b>'};
    const hit = lookupCocSkill(name, card);
    if(!hit){
      const s = suggestAlias(checkDomainOf(ruleKey), name, 2);
      return {notice:'卡上没有「' + esc(name) + '」' + (s.length ? '。你是不是想找：<b>' + s.map(esc).join('</b> / <b>') + '</b>' : '') +
        '<br>用 <b>.st set ' + esc(name) + ' 60</b> 添加，或直接 <b>.r 1d100</b> 裸掷'};
    }
    const skill = card.data[hit.key];
    if(typeof skill !== 'number') return {notice:'卡上还没有「' + esc(hit.key) + '」的数值 —— 用 <b>.st set ' + esc(hit.key) + ' 60</b> 添加，或直接 <b>.r 1d100</b> 裸掷'};
    const net = bonus - penalty;
    const pc = rollPercent(net);
    // 百分骰：一个 group + percent 描述（十位骰列表 / 个位 / 采用哪一颗），渲染层据此特殊排版
    const groups = [{n:1, sides:100, sign:1, tries:[[pc.value]], kept:[pc.value], keptIdx:0,
      label:'百分骰', percent:{tens:pc.tens, ones:pc.ones, pick:pc.pick, kind:pc.kind}}];
    const t = buildTotal(pc.value, []);
    const verdict = judgeCoc(pc.value, skill);
    const notes = [];
    if(pc.tens.length > 1) notes.push((pc.kind === 'bonus' ? '奖励骰' : '惩罚骰') + ' ×' + Math.abs(net) +
      '：十位骰 ' + pc.tens.join(' / ') + '，取' + (pc.kind === 'bonus' ? '最低' : '最高') + ' ' + pc.tens[pc.pick]);
    else if(bonus && penalty) notes.push('奖 ' + bonus + ' 罚 ' + penalty + ' 相抵，不额外投十位骰');
    if(pc.value === 100) notes.push('十位 00 + 个位 0 = 100');
    if(COC_MEMO.has(hit.key)) notes.push('「' + esc(hit.key.toUpperCase()) + '」是备忘字段 —— 骰娘不会自动增减，只按卡上的数值检定');
    let tag = '';
    if(bonus && penalty) tag = ' [奖' + bonus + ' 罚' + penalty + (net === 0 ? ' · 相抵' : (net > 0 ? ' → 净奖励 ' + net : ' → 净惩罚 ' + (-net))) + ']';
    else if(bonus) tag = ' [奖励骰 ×' + bonus + ']';
    else if(penalty) tag = ' [惩罚骰 ×' + penalty + ']';
    return {view:{ruleKey, mode:null, groups, comps:[], diceSum:t.diceSum, add:t.add, total:t.total,
      title:hit.zh + '检定（' + skill + '）' + tag,
      dc:skill, dcLabel:'技能值', verdict, natBadge:null, natNote:verdict.why || null, notes}};
  },
  // ★ M3：payload 只存事实，判定结论现场推导 —— 这里是「从骰点事实还原结论」的唯一入口。
  //   与 runCheck 共用同一个 judgeCoc，判定逻辑仍然只有一份。
  replayVerdict(f){
    if(f.dc == null) return null;
    const v = judgeCoc(f.diceSum, f.dc);
    return {verdict:v, natNote:v.why || null};      // ★ why 是当时显示的判定说明，必须一起还原
  },
};

/* ---------- 匕首心包 ---------- */

export { COC_PACK };
