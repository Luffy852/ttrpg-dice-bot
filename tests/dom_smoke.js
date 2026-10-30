/* ============================================================================
 * dom_smoke.js —— 端到端冒烟：真的把 apps/web/index.html 当网页跑一遍
 * ----------------------------------------------------------------------------
 * 【与 M2 那版的区别】M2 是单机版：引擎在页面里，点了就出结果。
 *   M3 是联网版：页面只发指令，结果由"服务端"广播回来。
 *   所以这里必须有一个**服务端替身** —— 用 tests/mock_server.mjs，
 *   它内部调的是**生产的 core.js + 生产的 engine**（不是另写一套逻辑）。
 *   传输层（WebSocket）换成内存函数调用，其余全是生产代码。
 *
 * 【★ 它验什么】
 *   ① 页面里没有 JS 错误（模块 import 全对、DOM id 全对）
 *   ② 四套规则的指令都能走通"发送 → 服务端 → 广播 → 渲染"
 *   ③ 骰点气泡渲染正常（含语义标签）
 *   ④ ★ 合计行不含「调整项 +0」（M2 真机第四轮的老坑）
 *   ⑤ ★ 同一 req_id 重发不会出第二颗骰（幂等，骰娘最不能错的地方）
 *   ⑥ ★ 断线重连补齐：无重复、无遗漏
 *
 * 【它验不了什么】真实网络、真实 ws 握手、多设备。那部分只能你部署后验。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {JSDOM, VirtualConsole} = createRequire(import.meta.url)('jsdom');   // jsdom 装在沙盒全局，ESM 解析不到 → 走 CJS

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'apps', 'web', 'index.html');

const {createMockServer} = await import('./mock_server.mjs');
const {OUT} = await import('../packages/protocol/src/frames.js');

const src = fs.readFileSync(HTML, 'utf8');
const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errs.push(e.message || String(e)));
vc.on('error', (...a) => errs.push(a.join(' ')));

/* ---------- 一个"内存 WebSocket"：net.js 只用它这几个成员 ---------- */
class FakeWS {
  constructor(net){ this.net = net; this.readyState = 0; }
  send(data){
    const f = JSON.parse(data);
    // 异步回执（模拟网络往返），让 await sleep 有机会推进
    queueMicrotask(() => this.net.__onFrame(f));
  }
  close(){ this.readyState = 3; }
}
function makeWsFactory(net){
  return function(){ const ws = new FakeWS(net); setTimeout(() => { ws.readyState = 1; ws.onopen && ws.onopen(); }, 0); return ws; };
}

const dom = new JSDOM(src, {
  runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:vc, url:'https://dice.example/?code=123456',
  beforeParse(w){
    // ★ window.crypto 是只读 getter，只能 defineProperty 覆盖（jsdom 没实现 randomUUID）
    const cryptoShim = {
      getRandomValues: a => { for(let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; },
      randomUUID: () => 'anon-test',
      subtle: null,
    };
    Object.defineProperty(w, 'crypto', {value:cryptoShim, configurable:true});
    w.__SERVER__ = createMockServer('123456');
    w.__WSFACTORY__ = makeWsFactory;
    w.fetch = async () => ({ok:true, status:200, json:async () => ({token:'tok-test', anon_id:'a1'})});
  }
});
const w = dom.window, d = w.document;
w.WebSocket = function(){ return w.__WSFACTORY__(w.__net__)(); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ★ ui.js / net.js 用的是浏览器全局（document / localStorage / WebSocket）。
   它们是在 node 里以 ESM 加载的，所以要把 jsdom 的全局挂到 node 的 globalThis 上 ——
   否则"生产代码在沙盒里跑"就变成了"为沙盒改写生产代码"，那就不叫验了。 */
function installGlobals(){
  globalThis.window = w;
  globalThis.document = d;
  globalThis.localStorage = w.localStorage;
  globalThis.sessionStorage = w.sessionStorage;
  globalThis.location = w.location;
  globalThis.history = w.history;
  Object.defineProperty(globalThis, 'crypto', {value:w.crypto, configurable:true});
  globalThis.WebSocket = function(){ return w.__WSFACTORY__(w.__net__)(); };
  // ★ 不要覆盖 setTimeout/setInterval —— jsdom 的 window.setTimeout 内部会回头调全局的那个，
  //   覆盖成 w.setTimeout 会无限递归（实测爆栈）。定时器用 node 原生的即可。
}
installGlobals();

/* ---------- 把 net.js / ui.js / main.js 装进页面 ---------- */
async function boot(){
  // 顺序等价于 main.js 的 module graph；用动态 import 直接跑生产代码
  const {createNet} = await import('../apps/web/src/net.js');
  const {createUI} = await import('../apps/web/src/ui.js');
  const server = w.__SERVER__;
  const me = server.join('老王');

  // 把 net.js 的 WebSocket 构造替换成内存连接，并把帧路由接到 mock server
  w.__net__ = {
    __onFrame: async f => {
      const r = await server.frame(f, me);
      // ★ 真实服务端会把广播发给房间里**所有**连接，包括自己 —— 只应用 r.me 会漏掉
      //   自己掷的那颗骰（占位气泡永远等不到替换）。这里必须与 room.js 的行为一致。
      (r.me || []).concat(r.all || []).forEach(x => route(x));
    },
  };
  function route(f){
    const n = net;
    if(f.t === OUT.WELCOME){ ui.setRoom(f.room); ui.setMe(f.you.nick); ui.setMembers(f.members); }
    else if(f.t === OUT.BATCH){ f.msgs.forEach(m => ui.append(m)); }
    else if(f.t === OUT.STATE){ ui.setRoom(f.room); }
    else if(f.t === OUT.PRESENCE){ ui.setMembers(f.members); }
    else if(f.t === OUT.REJECT){ ui.failPending(f.req_id, f.code); }
    else if(f.t === OUT.DUP){ /* 不重掷；真实消息由 batch 到达 */ }
  }

  const ui = createUI({
    code:'123456',
    onSubmit(text){ const reqId = net.send(text); ui.appendPending(reqId, text); },
    onExport(){},
  });
  const net = createNet({code:'123456', token:'tok-test', nick:'老王', on:{}});
  w.__net__ = Object.assign(w.__net__, {send:net.send});
  // createNet 内部会 new WebSocket(url) —— 已被替换为内存连接
  net.connect();
  await sleep(20);
  return {ui, net, server};
}

function type(ui, net, text){
  const reqId = net.send(text);
  ui.appendPending(reqId, text);
  return reqId;
}

(async () => {
  const {ui, net, server} = await boot();

  const cmds = [
    '.set rule coc', '.st set 侦查 60 图书馆 50 hp 12 san 70', '.rc 侦查', '.rc 侦查 +1', '.rc list',
    '.set rule dh', '.st set 敏捷 2 力量 2 灵巧 1 本能 0 风度 1 知识 -1', '.dh 敏捷 15', '.dh 15',
    '.set rule fu', '.st set dex d8 ins d10 mig d8 wlp d6 物语点 3 物资点 2', '.fu dex ins 10', '.fu dex ins 13 +2',
    '.set rule dnd', '.st set str 16 dex 14 lv 5', '.rc 巧手 15 p', '.st', '.h',
    '.set rule generic', '.r 2d6+3', '.help'
  ];
  for(const c of cmds){ type(ui, net, c); await sleep(8); }

  // ★ 幂等：重发同一条指令 —— 走与上面同一条回流路径（不能直接调 server.frame 就完事，
  //   那样那条 roll 永远回不到前端，会误报成"漏消息"）
  const reqId = 'manual-dup-test';
  await w.__net__.__onFrame({t:'cmd', req_id:reqId, text:'.r 1d6'});
  await w.__net__.__onFrame({t:'cmd', req_id:reqId, text:'.r 1d6'});
  await sleep(10);

  // 点开几个骰点气泡（折叠 → 展开）
  d.querySelectorAll('.bubble.dice').forEach((b, i) => { if(i < 8) b.classList.toggle('open'); });

  const rolls  = d.querySelectorAll('.bubble.dice').length;
  const sys    = d.querySelectorAll('.sys').length;
  const notice = d.querySelectorAll('.notice').length;
  const tots   = Array.from(d.querySelectorAll('.dline.tot')).map(x => x.textContent.replace(/\s+/g, ' ').trim());
  const zero   = tots.filter(t => /调整项 \+0/.test(t));
  const pendingLeft = d.querySelectorAll('.msg.pending').length;
  const all = server.storage._all();

  console.log('文件：apps/web/index.html');
  console.log('消息', d.querySelectorAll('#stream > *').length, '｜骰点气泡', rolls, '｜系统消息', sys, '｜提示', notice);
  console.log('规则胶囊：', d.getElementById('p-rule').textContent.trim(), '｜计数', d.getElementById('p-cnt').textContent.trim());
  console.log('服务端落库：', all.length, '条 ｜游标', (await server.storage.getRoom()).seq);
  console.log('合计行样本：', tots.slice(0, 2).join(' ｜ '));

  let bad = 0;
  const ok = (n, c, extra) => { if(c) console.log('  ✅ ' + n); else { bad++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
  // ★ 不拍脑袋写"≥10"：断言"页面渲染出的骰点数 = 服务端落库里的 roll 数"——
  //   少一个就说明有消息没回到前端，这才是要抓的错
  const serverRolls = all.filter(m => m.kind === 'roll').length;
  ok('★ 骰点气泡数 = 服务端 roll 数（一条没漏）', rolls === serverRolls, 'dom=' + rolls + ' server=' + serverRolls);
  ok('系统消息 ≥ 1（切规则有广播）', sys >= 1, 'sys=' + sys);
  ok('★ 合计行不含「调整项 +0」', zero.length === 0, zero.slice(0, 2).join(' | '));
  ok('★ 占位气泡都被真实消息替换（幂等生效）', pendingLeft === 0, 'pending=' + pendingLeft);
  /* ★ 重发同一 req_id：该 req_id 下现在有**两条**是正确行为 ——
   *   ① 用户原文（cmd）② 骰娘的骰点（roll）。要锁的是"**骰点只有一条**"，
   *   即重发没有掷第二次；原文也只有一条（没被记两遍）。
   *   （旧断言写"该 req_id 总共只有 1 条"，那是"用户原文不落库"时代的口径，已过时。） */
  const dup = all.filter(m => m.req_id === 'manual-dup-test');
  ok('★ 重发没重掷（该 req_id 只有 1 条骰点）',
    dup.filter(m => m.kind === 'roll').length === 1,
    'rolls=' + dup.filter(m => m.kind === 'roll').length);
  ok('★ 重发也没把用户原文记两遍（该 req_id 只有 1 条 cmd）',
    dup.filter(m => m.kind === 'cmd').length === 1,
    'cmd=' + dup.filter(m => m.kind === 'cmd').length);
  ok('★ 语义标签在渲染产物里（百分骰十位/个位）', /class="plab"/.test(d.body.innerHTML));
  ok('★ 消息按 seq 严格递增落库', all.every((m, i) => i === 0 || m.seq > all[i - 1].seq));
  ok('★ 页面无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' / '));

  /* 断线重连补齐：★ 连着补两次 —— 第一次把断线期间的消息补回来（条数应增加），
     第二次什么都该补不到（条数不变）。只补一次、断言"条数不变"，测的是"恰好没漏"，不是幂等。 */
  const syncAll = async () => {
    const r = await server.frame({t:'sync', cursor:0, limit:200}, {anonId:'a1', nick:'老王'});
    (r.me || []).forEach(f => { if(f.t === OUT.BATCH) f.msgs.forEach(m => ui.append(m)); });
    await sleep(5);
    return d.querySelectorAll('#stream > *').length;
  };
  const n1 = await syncAll();
  const n2 = await syncAll();
  ok('★ 补齐第二次不产生重复（msg_id 去重）', n2 === n1, 'n1=' + n1 + ' n2=' + n2);
  ok('★ 补齐后不遗漏（页面条数 ≥ 服务端消息数）', n2 >= all.length, 'dom=' + n2 + ' server=' + all.length);

  console.log(bad ? ('\n❌ 端到端冒烟：' + bad + ' 项不通过') : '\n✅ 端到端冒烟全通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('❌ 冒烟崩溃：', e); process.exit(1); });
