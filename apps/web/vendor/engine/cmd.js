/* cmd.js — 10 指令分发（★ 主流程不许认识任何具体规则）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { ALIAS, lookupAlias } from './alias.js';
import { cardMismatchNote, cardRuleName } from './card.js';
import { HELP_BODY, helpTop } from './help.js';
import { packOfFamily, rulePack, verbOwner } from './packs.js';
import { parseExpr } from './parse.js';
import { defsHtml, renderDefs } from './render.js';
import { rollGroups } from './roll.js';
import { IMPLEMENTED, RULE_META, normalizeRule, ruleFamily } from './rules.js';
import { esc } from './util.js';
import { buildTotal, natMarkOf, natOf, sumKept } from './view.js';

const VERBS = new Set(['r','h','help','status','stat','set','rule','name','nn','st','rc','ra','rd','dh','fu']);
const LIMIT_MSG = '指令规模过大（单次骰数上限 100 / 面数上限 10000 / 合计 500）';
const SYNTAX_MSG = '暂不支持该语法（括号/乘除/骰池等），可用 .help 查看支持的格式';
const NO_CARD_MSG = '尚未绑定角色卡，可用 <b>.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 5</b> 绑定；或直接用 <b>.r 1d20+3</b> 投掷';

// 中文动词后可以不带空格（.检定巧手 / .骰2d6+3），纯字母动词必须带空格，
// 否则 ".rank" 这类会被误切成 verb=r —— 那会破坏"未命中动词降级为聊天"的规则。
const CJK_VERBS = (() => {
  const list = [];
  const map = ALIAS.byDomain.get('verb');
  if(map) map.forEach((e, alias) => { if(/[㐀-鿿]/.test(alias)) list.push(alias); });
  return list.sort((a, b) => b.length - a.length);   // 长优先：优势检定 先于 检定
})();

function parseCommand(text){
  const s0 = String(text || '').trim();
  if(!s0) return null;
  // 前缀容错：中文句号「。」和全角句点「．」—— 中文输入法下打 "." 极易变成它们
  if('.。/．'.indexOf(s0[0]) < 0) return null;
  const body = String(s0).normalize('NFKC').slice(1).trim();
  if(!body) return null;
  // ① 中文动词最长前缀匹配
  for(const v of CJK_VERBS){
    if(body.slice(0, v.length) === v){
      const e = lookupAlias('verb', v);
      return {verb:e.key, rest:body.slice(v.length).trim()};
    }
  }
  // ② 字母动词：取到第一个空白
  const sp = body.search(/\s/);
  const head = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const e = lookupAlias('verb', head);
  if(!e) return null;                  // 未命中 → 降级为普通聊天，不报错
  return {verb:e.key, rest:(sp < 0 ? '' : body.slice(sp + 1).trim())};
}
// 这条输入算不算"指令"：命中动词，或（裸骰开启时）整条是掷骰表达式。
// 用途：决定用户消息用等宽指令样式（cmd）还是普通聊天样式（chat）。
function isCommandText(text, room){
  if(parseCommand(text)) return true;
  return !!(room && room.baredice && /^[\s\d+\-dD]+$/.test(String(text).trim()) && /\d*d\d/i.test(text));
}

function hhmm(d){
  const p = n => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// 房间状态：M1 在内存里；M3 由 Durable Object 持有，字段不变
function makeRoom(){
  return {rule:'generic', baredice:false, ruleSetBy:null, ruleSetAt:null, seq:0, nextId(){ return ++this.seq; }};
}

function handleCommand(text, ctx){
  const room = ctx.room, me = ctx.me, out = [];
  const mk = o => { const m = Object.assign({id:room.nextId(), ts:new Date()}, o); return m; };
  const say = o => out.push(mk(o));
  const notice = html => say({kind:'notice', from:'骰娘', actor:me, html});
  /* ★★ 两个字段都给：defs（结构化）给服务端落库，html（已渲染）给就地渲染。
   * 【为什么必须带 defs】core.js 的 factsOf 读的是 `msg.defs`（协议 KIND.HTML 白名单只有
   *   defs），前端 toRenderable 也是 `{defs:p.defs, html:defsHtml(p.defs)}`。
   *   只给 html 串的后果：落库时 `msg.defs` 是 undefined → payload 变成 `{}` →
   *   前端渲染出一个**空气泡** —— 表现就是「.st / .help / .status 有回复但内容为空」，
   *   而 .r（roll，走 view）与 .rc 未绑卡（notice，走 html）都正常，极易误判成"只有掷骰能用"。
   *   原则：库里存结构化事实，不存渲染好的串（改样式不必迁移历史数据）。 */
  const defs = d => say({kind:'html', from:'骰娘', actor:me, defs:d, html:renderDefs(d)});
  /* page 用于已经是 HTML 串的内容（角色卡栅格这类富排版，无法用 rows 表达）。
     包成 {raw} 走同一条 defs 通道 —— 否则这条消息同样会变空气泡。 */
  const page = html => say({kind:'html', from:'骰娘', actor:me, defs:{raw:html}, html});

  const cmd = parseCommand(text);
  if(!cmd){
    // 裸骰（默认关）：整条是纯表达式才掷，避免台词里的数字被误掷
    if(room.baredice && /^[\s\d+\-dD]+$/.test(text) && /\d*d\d/i.test(text)){
      const p = parseExpr(text);
      if(p.ok){ doRoll(p, null, null); return {msgs:out, handled:true}; }
    }
    // 不是指令：骰娘不回话。用户原文由传输层（M3 由服务端）记录成一条消息，
    // 这里若再发一条就是同内容出现两次。
    return {msgs:out, handled:false};
  }
  const {verb, rest} = cmd;

  // ---- 通用掷骰 ----
  function doRoll(p, mode, meta){
    const groups = rollGroups(p.groups, mode, room.rule);
    const diceSum = sumKept(groups);
    const comps = [];
    if(p.mod) comps.push({label:'调整值', v:p.mod});
    const t = buildTotal(diceSum, comps);
    const nat = natOf(groups, diceSum);
    const nm = natMarkOf(nat, room.rule);      // ★ nat 是骰点属性，与有没有 DC 无关
    const view = {
      ruleKey:room.rule, mode, groups, comps,
      diceSum:t.diceSum, add:t.add, total:t.total,
      title:(meta && meta.title) ? meta.title : ('掷骰 ' + exprText(p)),
      dc:(meta && meta.dc != null) ? meta.dc : null,
      verdict:(meta && meta.verdict) || null,
      natBadge:(nm && nm.badge) || null,
      natNote:(nm && nm.note) || null,
      notes:(meta && meta.notes) || []
    };
    say({kind:'roll', from:'骰娘', actor:me, view});
  }
  function exprText(p){
    const g = p.groups.map(x => (x.sign < 0 ? '-' : '') + x.n + 'd' + x.sides).join('+');
    const m = p.mod ? (p.mod > 0 ? '+' + p.mod : String(p.mod)) : '';
    return g + m;
  }

  if(verb === 'r'){
    // 末尾模式词：英文与中文都认（.r 1d20+5 优势）
    const mm = rest.match(/^(.*?)[\s]+(\S+)$/);
    let ex = rest, md = null;
    if(mm){
      const me2 = lookupAlias('mode', mm[2]);
      if(me2){ ex = mm[1].trim(); md = me2.key; }
    }
    const p = parseExpr(ex);
    // ★ 通用动词的"降级接管"：DH / FU 的检定参数本来就不是骰表达式（.r 敏捷 15 / .r dex ins 10），
    //   以前走到这里会报"暂不支持该语法（括号/乘除/骰池）"—— 与真实问题毫无关系，纯误导。
    //   风险边界：**只在通用解析真的用不上时才接管** ——
    //     ① 解析失败（.r 15 在通用语法里根本不合法）
    //     ② 参数含空格（骰表达式不带空格：".r d8 d10 10" 若交给通用会被拼成 1d8+1d1010，静默出错）
    //   合法的单体骰表达式（.r 2d6+3）永远走通用掷骰 —— 所以 .r 的既有能力一点没少，
    //   只是把"必然报错"或"必然算错"的那部分换成"交给规则包试一次"。
    //   ③ 但**真语法错误不许被接管**：`.r (1d6+2)*2` / `.r 4d6k3` 含括号、乘除、骰池，
    //      那是用户想写通用表达式却写错了，接管过去只会得到"参数看不懂"，把真实病因盖掉。
    //      —— 这条是踩出来的：首版没做这个判断，`.r (1d6+2)*2` 在 FU 下报的是 FU 的用法提示。
    const broken = /[()*/#]/.test(ex) || /\d*d\d+[a-zA-Z]/.test(ex);   // 骰池：4d6k3 / 4d6kh3 / 4d6dl1
    const pack = rulePack(room.rule);
    // takeOverR 与 verbs 分开：`verbs` 是"规则专属命令头"（打错规则时要提示归属），
    // `takeOverR` 只是"通用 .r 在本规则下的接管"，两者语义不同，不能混在一个表里。
    const fn = pack.takeOverR || null;
    if(fn && !broken && (!p.ok || /\s/.test(ex))){
      const r = fn(rest.trim(), {card:ctx.card, ruleKey:room.rule, me});
      if(!r.notice){
        say({kind:'roll', from:'骰娘', actor:me, view:r.view});
        return {msgs:out, handled:true};
      }
      // 规则包也认不出来 → 报**规则自己的**用法，比通用语法提示有用得多
      notice(r.notice);
      return {msgs:out, handled:true};
    }
    if(!p.ok){
      // 没有可接管的包：纯数字/无 d 的参数不该被说成"括号/乘除/骰池"
      if(ex && !/[d()*/#k]/.test(ex.toLowerCase())){
        notice('「<b>' + esc(ex) + '</b>」不是掷骰表达式 —— 掷骰请写 <b>.r 2d6+3</b>；' +
          (pack.checkHint ? '本规则下检定：' + pack.checkHint() : ''));
      } else notice(p.reason === 'limit' ? LIMIT_MSG : SYNTAX_MSG);
      return {msgs:out, handled:true};
    }
    doRoll(p, md, null);
    return {msgs:out, handled:true};
  }

  if(verb === 'h'){
    const mine = ctx.history.filter(m => m.kind === 'roll' && m.actor === me).slice(-5).reverse();
    if(!mine.length){ notice('（还没有投掷记录）'); return {msgs:out, handled:true}; }
    defs({title:'我最近 ' + mine.length + ' 条投掷', rows:mine.map(m => ({
      k:m.view.title,
      v:'→ ' + m.view.total + (m.view.verdict && m.view.verdict.ok !== null ? '　' + (m.view.verdict.ok ? '✅ 成功' : '❌ 失败') : '')
    })), foot:['点开任意骰点消息可查看逐骰明细']});
    return {msgs:out, handled:true};
  }

  // ---- .help ----
  if(verb === 'help'){
    if(!rest){ defs(helpTop(room.rule)); return {msgs:out, handled:true}; }
    const key = normalizeRule(rest);
    if(!key){ notice('未识别规则「' + esc(rest) + '」，可用：dnd / dnd5r / coc / dh / fu'); return {msgs:out, handled:true}; }
    if(!IMPLEMENTED.has(key)){ notice('「' + RULE_META[key].name + '」规则包暂未开放，可用：dnd / dnd5r / coc / dh / fu / generic'); return {msgs:out, handled:true}; }
    defs(HELP_BODY[key]());
    return {msgs:out, handled:true};
  }

  // ---- .status / .stat ----
  if(verb === 'status' || verb === 'stat'){
    let cardHtml;
    // 卡按**它自己的族**渲染 —— 通用规则下看 D&D 卡，渲染仍必须是 D&D 的（正交维度）
    if(ctx.card) cardHtml = packOfFamily(ctx.card.family).renderCard(ctx.card);
    else cardHtml = '<div class="stline">未绑定 · 用 <b>.st set ...</b> 绑定，或 .st 查看模板</div>';
    const warn = cardMismatchNote(ctx.card, room.rule);
    page(defsHtml({title:'📋 当前状态', rows:[
      {k:'房间规则',   v:RULE_META[room.rule].name + '（' + room.rule + '）'},
      {k:'规则设定者', v:room.ruleSetBy ? (esc(room.ruleSetBy) + ' · ' + esc(room.ruleSetAt)) : '（尚未修改过）'},
      {k:'我的昵称',   v:esc(me)},
      {k:'裸骰识别',   v:(room.baredice ? '开' : '关') + '　（.set baredice on 开启）'},
      {k:'消息留存',   v:'30 天 · 本房间共 ' + ctx.history.length + ' 条'}
    ]}) + '<div class="hs"><div class="hh">我的角色卡' + (ctx.card ? ' · ' + esc(cardRuleName(ctx.card)) : '') + '</div>' +
      cardHtml + (warn ? '<div class="hf">' + warn + '</div>' : '') + '</div>');
    return {msgs:out, handled:true};
  }

  // ---- .set rule / .rule ----
  function setRule(arg){
    const key = normalizeRule(arg);
    if(!key){ notice('未识别规则「' + esc(arg) + '」，可用：dnd / dnd5r / coc / dh / fu'); return; }
    if(!IMPLEMENTED.has(key)){
      notice('「' + RULE_META[key].name + '」规则包暂未开放，当前仍为 ' + RULE_META[room.rule].name + '。');
      return;
    }
    if(key === room.rule){ notice('当前已经是 ' + RULE_META[key].name + '。'); return; }
    const from = RULE_META[room.rule].name, to = RULE_META[key].name;
    const now = new Date();
    room.rule = key; room.ruleSetBy = me; room.ruleSetAt = hhmm(now);
    say({kind:'sys', from:'骰娘', actor:me, title:'⚠️ @全体 规则设定已变更', line1:from + ' → ' + to,
         line2:'由 ' + me + ' 于 ' + hhmm(now) + ' 修改（所有人都可以修改，如需回退请输入 .set rule ' + (key === 'generic' ? 'dnd' : 'generic') + '）'});
    // 规则 × 角色卡 是两个正交维度：切规则时必须提示，不静默（提示文案由同一处产出，三处共用）
    if(ctx.card){
      const warn = cardMismatchNote(ctx.card, key);
      if(!warn) notice('角色卡（' + esc(cardRuleName(ctx.card)) + '）在当前规则下继续可用。');
      else notice(warn);
    }
  }

  if(verb === 'rule'){ if(!rest) { notice('用法：.rule dnd / .rule 5.5e / .rule generic'); } else setRule(rest); return {msgs:out, handled:true}; }
  if(verb === 'set'){
    const sp = rest.indexOf(' ');
    const subE = lookupAlias('setsub', (sp < 0 ? rest : rest.slice(0, sp)));
    const sub = subE ? subE.key : '';
    const arg = sp < 0 ? '' : rest.slice(sp + 1).trim();
    if(sub === 'rule'){ if(!arg){ notice('用法：.set rule dnd / 5.5e / coc / dh / fu / generic（也可写 <b>.设置 规则 龙与地下城</b>）'); } else setRule(arg); return {msgs:out, handled:true}; }
    if(sub === 'baredice'){
      const e = lookupAlias('switch', arg);
      if(e && e.key === 'on'){ room.baredice = true; notice('裸骰识别已<b>开启</b> —— 直接输入 1d20+5 即可掷骰（台词里的数字也可能被误掷，留意）。'); }
      else if(e && e.key === 'off'){ room.baredice = false; notice('裸骰识别已<b>关闭</b> —— 仍需 .r 开头才掷骰。'); }
      else notice('用法：.set baredice on / off（也可写 <b>.设置 裸骰 开</b>）');
      return {msgs:out, handled:true};
    }
    notice('用法：<b>.set rule 龙与地下城</b>　或　<b>.set baredice 开</b>（也可写英文 rule / baredice）');
    return {msgs:out, handled:true};
  }

  // ---- .name / .nn ----
  if(verb === 'name' || verb === 'nn'){
    const n = rest.trim();
    if(!n){ notice('用法：.name 老王（别名 .nn）'); return {msgs:out, handled:true}; }
    const old = me;
    ctx.me = n.slice(0, 16);
    say({kind:'sys', from:'骰娘', actor:ctx.me, title:'🔔 昵称变更', line1:old + ' → ' + ctx.me, line2:'仅在本房间内生效'});
    return {msgs:out, handled:true};
  }

  // ---- .st 角色卡（★ 统一入口：模板 / 解析 / 渲染全部由「卡自己的族」决定）----
  // M2 之前的写法把 D&D 卡硬编码在主流程里；加三套卡后，每套的字段与渲染都不一样，
  // 主流程只该做三件事：判断本规则有没有卡、把 .st set 交给包解析、把卡交给包渲染。
  if(verb === 'st'){
    const a = rest.trim();
    const fam = ruleFamily(room.rule);
    const pack = rulePack(room.rule);
    if(a === '' || a === 'list' || a === 'show' || a === 'view'){
      if(!ctx.card){
        const tpl = pack.cardTemplate();
        if(!tpl){
          defs({title:'通用规则不使用角色卡', sections:[
            {h:'角色卡属于规则，不属于通用', rows:[
              {k:'当前规则', v:'通用 —— 不使用角色卡，直接用 <b>.r</b> 掷骰'},
              {k:'想用角色卡', v:'先 <b>.set rule dnd</b>（或 coc / dh / fu），再 <b>.st set ...</b>'}
            ]}
          ], foot:['★ 规则 × 角色卡是两个维度：切规则时已绑的卡不会消失，只是不参与检定']});
        } else defs(tpl);
        return {msgs:out, handled:true};
      }
      // 有卡：按**卡自己的族**渲染（不是当前规则），族与规则不符时明确提示
      const cpack = packOfFamily(ctx.card.family);
      const warn = cardMismatchNote(ctx.card, room.rule);
      page('<div class="ht">' + esc(me) + ' 的角色卡 · <b>' + esc(cardRuleName(ctx.card)) + '</b>' +
        (ctx.card.data && ctx.card.data.lv ? ' · ' + ctx.card.data.lv + ' 级' : '') + '</div>' +
        cpack.renderCard(ctx.card) +
        (cpack.cardExtra ? cpack.cardExtra(ctx.card) : '') +
        '<div class="hf">' + (warn ? warn : '用 <b>.st clear</b> 解绑') + '</div>');
      return {msgs:out, handled:true};
    }
    if(a === 'clear'){
      if(!ctx.card){ notice('本来就没有绑定角色卡。'); } else { ctx.card = null; notice('已解绑角色卡。'); }
      return {msgs:out, handled:true};
    }
    const mm2 = a.match(/^set\s+(.*)$/i);
    if(mm2){
      if(!fam){ notice('通用规则不使用角色卡 —— 请先 <b>.set rule dnd</b>（或 coc / dh / fu），再绑卡。'); return {msgs:out, handled:true}; }
      const r = pack.parseCard(mm2[1]);
      if(r.errs.length && !r.count){ notice(r.errs.map(esc).join('；')); return {msgs:out, handled:true}; }
      const old = ctx.card ? ctx.card.family : null;
      // 同族则合并（单项修改），换族则换卡 —— 换卡是覆盖，必须说出来，不能静默
      const base = (old === fam && ctx.card) ? ctx.card.data : {};
      const data = Object.assign({}, base, r.data);
      ctx.card = {family:fam, data};
      const cpack = packOfFamily(fam);
      const swapped = old && old !== fam;
      const warn = cardMismatchNote(ctx.card, room.rule);
      page('<div class="ht">' + (swapped ? '已换为 ' : '已绑定 ') + '<b>' + esc(cardRuleName(ctx.card)) + '</b> 角色卡' +
        (swapped ? '（原 ' + esc(cardRuleName({family:old})) + ' 卡已被替换）' : '') + '</div>' +
        cpack.renderCard(ctx.card) +
        (cpack.cardExtra ? cpack.cardExtra(ctx.card) : '') +
        (warn ? '<div class="hf">' + warn + '</div>' : '') +
        (r.errs.length ? '<div class="hf">⚠️ ' + r.errs.map(esc).join('；') + '</div>' : ''));
      return {msgs:out, handled:true};
    }
    notice('用法：<b>.st</b> 查看　·　<b>.st set ...</b> 绑定　·　<b>.st clear</b> 解绑' +
      (fam ? '　（当前规则 ' + esc(RULE_META[room.rule].name) + '，各规则字段不同，<b>.st</b> 会给出模板）' : ''));
    return {msgs:out, handled:true};
  }

  // ---- 规则专属动词（.dh / .fu）：由规则包自己处理 ----
  // ★ 打了别的规则的指令时不能静默 —— 告诉用户这条指令属于哪套规则、怎么切过去
  if(verb === 'dh' || verb === 'fu'){
    const pack = rulePack(room.rule);
    const fn = (pack.verbs && pack.verbs[verb]) || null;
    if(!fn){
      const owner = verbOwner(verb);
      notice('「<b>.' + verb + '</b>」是 <b>' + esc(RULE_META[owner].name) + '</b> 的专属指令，当前规则「' +
        esc(RULE_META[room.rule].name) + '」下不可用 —— 用 <b>.set rule ' + esc(owner) + '</b> 切换，或 <b>.help ' + esc(owner) + '</b> 看用法。');
      return {msgs:out, handled:true};
    }
    const r = fn(rest.trim(), {card:ctx.card, ruleKey:room.rule, me});
    if(r.notice){ notice(r.notice); return {msgs:out, handled:true}; }
    say({kind:'roll', from:'骰娘', actor:me, view:r.view});
    return {msgs:out, handled:true};
  }

  // ---- .rc / .ra / .rd 检定（★ 判定逻辑全在规则包里，主流程只做三件通用事）----
  if(verb === 'rc' || verb === 'ra' || verb === 'rd'){
    const mode = verb === 'ra' ? 'adv' : (verb === 'rd' ? 'dis' : null);
    const a = rest.trim();
    const pack = rulePack(room.rule);
    if(!a){ notice(pack.checkHint()); return {msgs:out, handled:true}; }
    if(/^list$/i.test(a)){
      // ★ .rc list 的内容由规则包提供 —— 主流程不认识任何具体规则的数据
      defs(pack.listChecks(room.rule, ctx.card));
      return {msgs:out, handled:true};
    }
    if(!pack.supportsCheck){
      notice(pack.checkOffNote(room.rule) ||
             ('当前规则为 ' + RULE_META[room.rule].name + '，不支持检定指令。切到 D&D 请用 <b>.set rule dnd</b>，或直接 <b>.r 1d20+3</b>。'));
      return {msgs:out, handled:true};
    }
    // 卡检查也是通用的：需要卡的规则，卡的族必须等于当前规则的族
    if(pack.needsCard && (!ctx.card || ctx.card.family !== ruleFamily(room.rule))){
      notice(pack.noCardNote ? pack.noCardNote(ctx.card) : NO_CARD_MSG);
      return {msgs:out, handled:true};
    }
    const r = pack.runCheck({args:a, mode, card:ctx.card, ruleKey:room.rule, me});
    if(r.notice){ notice(r.notice); return {msgs:out, handled:true}; }
    say({kind:'roll', from:'骰娘', actor:me, view:r.view});
    return {msgs:out, handled:true};
  }

  // 动词命中但参数分支没接住：同样不回话，用户原文由传输层记录
  return {msgs:out, handled:false};
}

export { VERBS, LIMIT_MSG, SYNTAX_MSG, NO_CARD_MSG, CJK_VERBS, parseCommand, isCommandText, hhmm, makeRoom, handleCommand };
