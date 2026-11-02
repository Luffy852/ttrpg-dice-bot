/* ============================================================================
 * e2e_real.mjs —— 真跑端到端（workerd 真实运行时 + 真实 DO + 真实 ws + 真实网关）
 * ----------------------------------------------------------------------------
 * 【为什么还要这一层】dom_smoke 用的是内存 mock server（生产 core.js + 引擎，
 *   但传输层与 DO 都是替身）；单测直接调 DO 又绕开了 index.js 网关。
 *   这一层跑的是**完整链路**：HTTP 路由 → DO → SQLite → ws 广播 → 帧协议，
 *   唯一替身是"客户端"（下面这个 Client 类，它就是浏览器）。
 *
 * 【怎么跑】先把 workerd 起在 8787（见 SETUP.md「本地真实运行时」），然后：
 *   node --experimental-websocket tests/e2e_real.mjs
 *
 * 【它专门盯 J 组】跨房间导入 / 续期 / 上翻 / 昵称 / 来源标注。
 *   J 组里纯前端呈现的部分（顶栏条数文案、气泡小胶囊）由 dom_smoke 覆盖，这里不重复。
 * ========================================================================== */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
/* ★ cid 必须 8–64 位：服务端 `/^[A-Za-z0-9_-]{8,64}$/` 之外的都被当成"没有 cid"（会发新身份） */
const CID_A = 'cid-a-abcdef', CID_K = 'cid-k-abcdef', CID_P = 'cid-p-abcdef';
const CID_B = 'cid-b-abcdef', CID_B2 = 'cid-b2-abcdef', CID_C = 'cid-c-abcdef';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); }
};
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- HTTP ---------- */
async function createRoom(pin) {
  const r = await fetch(BASE + '/api/room', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pin ? { pin } : {}),
  });
  return r.json();
}
async function join(code, nick, cid) {
  const r = await fetch(BASE + '/api/room/' + code + '/join', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nick: nick === undefined ? null : nick, cid: cid || null }),
  });
  return r.json();
}
async function apiExport(code, token, format) {
  const q = '?token=' + encodeURIComponent(token) + (format ? ('&format=' + format) : '');
  const r = await fetch(BASE + '/api/room/' + code + '/export' + q);
  return { status: r.status, text: await r.text() };
}
async function apiImport(code, token, text) {
  const r = await fetch(BASE + '/api/room/' + code + '/import?token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return r.json();
}
async function apiHistory(code, cursor) {
  const r = await fetch(BASE + '/api/room/' + code + '/history?cursor=' + (cursor || 0));
  return r.json();
}

/* ---------- ws 客户端（唯一替身：它就是"浏览器"） ---------- */
class Client {
  constructor(code, token, label) {
    this.code = code; this.token = token; this.label = label || '';
    this.frames = []; this.n = 0; this.reloads = 0;
  }
  async open() {
    const ws = new WebSocket('ws://' + BASE.replace(/^https?:\/\//, '') +
      '/ws/' + this.code + '?token=' + encodeURIComponent(this.token));
    this.ws = ws;
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', e => rej(new Error('ws error ' + (e.message || ''))), { once: true });
    });
    ws.addEventListener('message', ev => {
      const f = JSON.parse(ev.data);
      this.frames.push(f);
      if (f.t === 'reload') this.reloads++;
    });
    ws.send(JSON.stringify({ t: 'hello', token: this.token, v: 1 }));
    await this.waitFor('welcome');
    return this;
  }
  send(text) {
    const req_id = this.label + '-' + (++this.n);
    this.ws.send(JSON.stringify({ t: 'cmd', req_id, text }));
    return req_id;
  }
  chat(text) {
    const req_id = this.label + '-c' + (++this.n);
    this.ws.send(JSON.stringify({ t: 'chat', req_id, text }));
    return req_id;
  }
  sync(cursor, limit) { this.ws.send(JSON.stringify({ t: 'sync', cursor: cursor || 0, limit: limit || 200 })); }
  /** ★ 首屏的正确入口：hello 带 cursor:0 才走 recent()（最近 200 条）；sync(0) 走的是 since(0)=最早 200 条 */
  resync() { this.ws.send(JSON.stringify({ t: 'hello', token: this.token, v: 1, cursor: 0 })); }
  firstBatch() { return this.frames.find(f => f.t === 'batch' && f.why === 'first') || null; }
  page(before_seq, limit) { this.ws.send(JSON.stringify({ t: 'history', before_seq, limit: limit || 200 })); }
  async waitFor(t, ms) {
    const deadline = Date.now() + (ms || 3000);
    while (Date.now() < deadline) {
      const i = this.frames.findIndex(f => f.t === t);
      if (i >= 0) return this.frames[i];
      await sleep(30);
    }
    return null;
  }
  allMsgs() {
    const out = [];
    for (const f of this.frames) if (f.t === 'batch') out.push(...(f.msgs || []));
    return out;
  }
  /** 发一条指令，等到 ack，返回骰娘的最后一条回复（并清掉本次收帧） */
  async cmd(text, ms) {
    this.frames = [];
    this.send(text);
    await this.waitFor('ack', ms || 5000);
    await sleep(200);
    const bot = this.allMsgs().filter(m => m.from === '骰娘');
    const last = bot[bot.length - 1] || null;
    this.frames = [];
    return last;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}
/** 把一条消息渲染成可读文本（走生产渲染，不自己拼字符串） */
async function renderOf(m) {
  const Engine = await import('../packages/engine/src/index.js');
  const P = await import('../packages/protocol/src/payload.js');
  const toRenderable = (await import('../apps/worker/src/room.js').catch(() => ({}))).toRenderable;
  // replay.js 是 payload(事实) → view(派生) 的唯一转换口，生产与测试共用
  const { viewFromFacts } = await import('../packages/engine/src/replay.js');
  const v = viewFromFacts ? viewFromFacts(m.payload, m.kind) : null;
  return v ? Engine.renderMsg(v) : JSON.stringify(m.payload);
}

/* ========================================================================== */
console.log('== 0. 环境 ==');
{
  const d = await (await fetch(BASE + '/api/diag?code=000000')).text();
  ok('workerd 活着', /Worker/.test(d));
  ok('ROOM 绑定存在', /ROOM 绑定\s*: 已绑定/.test(d));
}

console.log('\n== 1. 建房 → 进房 → ws 连通 → 掷骰 ==');
const A = await createRoom();
ok('创建房间 A', /^\d{6}$/.test(A.code), JSON.stringify(A));
const ja = await join(A.code, '阿甲', CID_A);
ok('join 拿到 token', !!ja.token, JSON.stringify(ja));
const ca = new Client(A.code, ja.token, 'a');
await ca.open();
ok('ws welcome 收到', !!ca.frames.find(f => f.t === 'welcome'));
{
  ca.frames = [];
  ca.send('.r 2d6+3');
  await ca.waitFor('ack', 4000);
  await ca.waitFor('batch', 4000);
  const m1 = ca.allMsgs()[0];
  ok('指令原文落库', !!m1 && m1.kind === 'cmd' && /2d6\+3/.test(m1.payload?.text || ''));
}

/* ---------------------------------- J2 ---------------------------------- */
console.log('\n== J2. 昵称（服务端唯一权威） ==');
{
  const j2 = await join(A.code, null, CID_A);        // 同 cid，昵称留空
  eq('J2a 空白登录沿用原昵称', j2.nick, '阿甲');
  await ca.cmd('.name 阿乙');
  const j3 = await join(A.code, null, CID_A);
  eq('J2c 改名后服务端权威昵称已更新', j3.nick, '阿乙');
  const j4 = await join(A.code, '阿丙', CID_A);       // 填了 = 改名
  eq('J2 填写即为改名', j4.nick, '阿丙');
}

/* ---------------------------------- J3 ---------------------------------- */
console.log('\n== J3. 角色卡解绑 / J4. D&D 卡 AC ==');
const K = await createRoom();
{
  const jk = await join(K.code, '阿丁', CID_K);
  const ck = new Client(K.code, jk.token, 'k');
  await ck.open();
  await ck.cmd('.set rule dnd5e');
  await ck.cmd('.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 3 ac 16 hp 24');
  const st1 = await ck.cmd('.st');
  const s1 = JSON.stringify(st1 && st1.payload || {});
  ok('J4a 卡上有 AC / HP', /16/.test(s1) && /24/.test(s1), s1.slice(0, 200));
  const list = await ck.cmd('.rc list');
  ok('J4b .rc list 里没有 AC/HP', !/护甲等级/.test(JSON.stringify(list && list.payload || {})));
  const cleared = await ck.cmd('.st clear');
  const st2 = await ck.cmd('.st');
  const s2 = JSON.stringify(st2 && st2.payload || {});
  ok('J3a .st clear 后是未绑定模板', !/力量/.test(s2) || /尚未绑定/.test(s2), s2.slice(0, 200));
  ok('J3a clear 提示已给出', !!cleared);
  // 关页不丢卡：同 cid 重连后卡还在
  const jk2 = await join(K.code, null, CID_K);
  const ck2 = new Client(K.code, jk2.token, 'k2');
  await ck2.open();
  await ck2.cmd('.st set 力量 18');
  const jk3 = await join(K.code, null, CID_K);
  const ck3 = new Client(K.code, jk3.token, 'k3');
  await ck3.open();
  const st3 = await ck3.cmd('.st');
  ok('J3b 关页重进角色卡还在（同 cid 找回身份）', /18/.test(JSON.stringify(st3 && st3.payload || {})));
  ck.close(); ck2.close(); ck3.close();
}

/* ---------------------------------- J1 ---------------------------------- */
console.log('\n== J1. 历史消息上翻 ==');
const P = await createRoom();
{
  const jp = await join(P.code, '阿戊', CID_P);
  const cp = new Client(P.code, jp.token, 'p');
  await cp.open();
  // 造 210 条老消息（一次导入，避免逐条发指令触发限流）
  const now = Date.now();
  const lines = [];
  for (let i = 1; i <= 210; i++) {
    lines.push(JSON.stringify({
      seq: i, id: '222222:' + i, ts: now - (211 - i) * 1000, kind: 'chat',
      from: '老王', actor: '老王', anon_id: null, req_id: null, rule_at: 'generic',
      payload: { text: '第 ' + i + ' 条' },
    }));
  }
  const imp = await apiImport(P.code, jp.token, lines.join('\n'));
  eq('J1 造数据：210 条导入成功', imp.imported, 210);
  cp.frames = [];
  cp.resync();
  await cp.waitFor('batch', 5000);
  await sleep(300);
  const fb = cp.firstBatch();
  const first = (fb && fb.msgs) || [];
  eq('J1a 首屏是最近的 200 条', first.length, 200);
  ok('J1a 首屏最后一条是最新消息', /第 210 条/.test(JSON.stringify(first[first.length - 1]?.payload || {})));
  const oldest = first[0].seq;
  cp.frames = [];
  cp.page(oldest);
  await cp.waitFor('batch', 5000);
  const page2 = (cp.frames.find(f => f.t === 'batch' && f.why === 'page') || {}).msgs || [];
  const f2 = cp.frames.find(f => f.t === 'batch' && f.why === 'page');
  eq('J1c 上翻取到更早的 10 条', page2.length, 10);
  ok('J1c 上翻到顶后 has_more=false', f2 && f2.has_more === false, JSON.stringify(f2 && { has_more: f2.has_more, oldest: f2.oldest }));
  ok('J1d 上翻内容是更早的（第 1 条起）', /第 1 条/.test(JSON.stringify(page2[0]?.payload || {})));
  const seqs = first.map(m => m.seq);
  ok('J1 首屏 seq 严格递增', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  cp.close();
}

/* ------------------------------ J6 / J7 --------------------------------- */
console.log('\n== J6. 跨房间导入 + 重排 / J7. 续期与接力 ==');
const B = await createRoom();
{
  // A 房：两条指令（cmd + roll）
  await ca.cmd('.r 1d6');
  await ca.cmd('.r 2d6+1');
  await sleep(1100);                        // 让 B 房的消息 ts 明确更晚
  const jb = await join(B.code, '阿己', CID_B);
  const cb = new Client(B.code, jb.token, 'b');
  await cb.open();
  const cb2 = new Client(B.code, (await join(B.code, '阿庚', CID_B2)).token, 'b2');
  await cb2.open();
  await cb.cmd('.r 1d20');                  // B 自己的一条（ts 最晚）

  // A 导出 ndjson，并把 ts 整体前移 1 小时 —— 模拟"老战报"，让重排有确定结论
  const ex = await apiExport(A.code, ja.token, 'ndjson');
  ok('J6a A 房导出 ndjson 成功', ex.status === 200 && ex.text.split('\n').filter(Boolean).length > 0);
  const shifted = ex.text.split('\n').filter(Boolean).map(l => {
    const o = JSON.parse(l); o.ts -= 3600 * 1000; o.req_id = null; return JSON.stringify(o);
  }).join('\n');

  const r1 = await apiImport(B.code, jb.token, shifted);
  ok('J6a 跨房间导入成功', r1.imported > 0, JSON.stringify(r1));
  eq('J6c 来源标注是最初的 A 房', JSON.stringify(r1.from), JSON.stringify([A.code]));

  // 两个客户端都应收到 RELOAD（整房刷新）
  await sleep(500);
  ok('J5d 导入后所有人收到 RELOAD（不只是导入者）', cb.reloads > 0 && cb2.reloads > 0,
    'cb=' + cb.reloads + ' cb2=' + cb2.reloads);

  // 重排后：A 来的消息（时间更早）应排在 B 自己的消息之前
  cb.frames = [];
  cb.resync();
  await cb.waitFor('batch', 5000);
  await sleep(300);
  const all = (cb.firstBatch() || {}).msgs || [];
  const idxA = all.findIndex(m => String(m.id).startsWith(A.code + ':'));
  const idxB = all.findIndex(m => String(m.id).startsWith(B.code + ':'));
  ok('J6b 按绝对时间重排：A 的消息排在 B 现有消息之前', idxA >= 0 && idxB >= 0 && idxA < idxB,
    'idxA=' + idxA + ' idxB=' + idxB);
  ok('J6b 重排后 seq 仍单调递增', all.every((m, i) => i === 0 || m.seq > all[i - 1].seq));

  const r2 = await apiImport(B.code, jb.token, shifted);
  eq('J6d 重复导入不翻倍', r2.imported, 0);
  ok('J6d 重复导入提示跳过', r2.skipped > 0, JSON.stringify(r2));

  const after = await cb.cmd('.r 1d20');
  ok('J6e 导入后继续发指令正常', !!after, JSON.stringify(after && after.kind));

  /* ---- J7 续期与接力 ---- */
  const exA = await apiExport(A.code, ja.token, 'md');
  ok('J7a 战报写明续期', /本次导出已为 \d+ 条消息续期至 \d{4}-\d{2}-\d{2}/.test(exA.text),
    (exA.text.split('\n').slice(0, 6).join(' | ')).slice(0, 200));

  const C = await createRoom();
  const jc = await join(C.code, '阿辛', CID_C);
  const exB = await apiExport(B.code, jb.token, 'ndjson');
  const r3 = await apiImport(C.code, jc.token, exB.text);
  ok('J7c B→C 接力成功', r3.imported > 0, JSON.stringify(r3));
  ok('J7c C 里老消息仍标最初的 A（不是 B）',
    JSON.stringify(r3.from).indexOf(A.code) >= 0, JSON.stringify(r3.from));

  const cc = new Client(C.code, jc.token, 'c');
  await cc.open();
  const status = await cc.cmd('.status');
  const st = JSON.stringify(status && status.payload || {});
  ok('J7b .status 里看得到「已续期至」', /已续期至/.test(st), st.slice(0, 300));

  cb.close(); cb2.close(); cc.close();
}
/* ------------------- J8 前置：导入鉴权 / 网关状态透传 -------------------
 * 【2026-11-02 真机事故】导入战报显示"新增 undefined 条 / 现有 undefined 条"，
 *   却没有任何报错，用户以为战报文件格式不兼容、要重新生成。
 * 【真实根因（两处叠加）】
 *   ① apps/web/src/main.js 的 onImport 请求**没拼 token**（/export 拼了）→ DO 侧
 *      verifyToken 直接 401 {error:'bad_token'}，战报文本根本没走到解析那一步；
 *   ② apps/worker/src/index.js 网关只透传 body、JSON_ 默认 200 → 401 被吞成 200，
 *      前端 api() 看 r.ok=true 不抛错，把错误对象当成功回包渲染。
 * 【为什么沙盒 34 项全绿却没抓到】下面这个 Client 的 apiImport() 一直都带了 token ——
 *   测试替身比生产写得好。所以这一层必须**故意发一个不带 token 的请求**。 */
console.log('\n== J8 前置. 导入鉴权与网关状态透传（真机「新增 undefined 条」根因）==');
{
  const R = await createRoom();
  const j = await join(R.code, '导入测试', 'cid-import-check');
  ok('J8 前置：join 拿到 token', !!j.token, JSON.stringify(j));
  const oneLine = JSON.stringify({
    seq: 1, id: '888888:1', ts: Date.now(), kind: 'chat',
    from: '老王', actor: '老王', payload: { text: '鉴权检查' },
  });

  // ① 不带 token：必须 401，绝不能被网关吞成 200（这就是 J8 卡住的那一屏）
  const noTok = await fetch(BASE + '/api/room/' + R.code + '/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: oneLine }),
  });
  eq('★ 不带 token 的导入返回 401（网关不再吞状态码）', noTok.status, 401);
  const nb = await noTok.json();
  ok('★ 回包是明确的 bad_token，而不是成功回包', nb.error === 'bad_token', JSON.stringify(nb));
  eq('★ 错误回包里没有 imported 字段（前端不会再渲染 undefined）', nb.imported, undefined);

  // ② 带 token 但 body 坏了：DO 侧 400 同样要透传
  const bad = await fetch(BASE + '/api/room/' + R.code + '/import?token=' + encodeURIComponent(j.token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: 'this-is-not-json',
  });
  eq('★ bad_body 也透传 400', bad.status, 400);
  ok('★ bad_body 回包是明确的错误体', (await bad.json()).error === 'bad_body');

  // ③ 正常导入：回包字段必须是数字（前端 onImport 的守卫靠这两个）
  const good = await fetch(BASE + '/api/room/' + R.code + '/import?token=' + encodeURIComponent(j.token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: oneLine }),
  });
  eq('★ 正常导入返回 200', good.status, 200);
  const gb = await good.json();
  eq('★ imported 是数字（不是 undefined）', typeof gb.imported, 'number');
  eq('★ total 是数字（不是 undefined）', typeof gb.total, 'number');
  eq('★ 实际导入 1 条', gb.imported, 1);
  ok('★ 来源房间标注正确', JSON.stringify(gb.from || []).indexOf('888888') >= 0, JSON.stringify(gb.from));

  // ④ 顺着用户手上那份 250 行 ndjson 的形态再导一次（同一份重复导入 → 幂等跳过）
  const again = await fetch(BASE + '/api/room/' + R.code + '/import?token=' + encodeURIComponent(j.token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: oneLine }),
  });
  const ab = await again.json();
  eq('★ 重复导入不翻倍（imported=0）', ab.imported, 0);
  ok('★ 跳过数也是数字', typeof ab.skipped === 'number', JSON.stringify(ab));
}

ca.close();

console.log('\n---------------------------');
console.log('真跑端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
