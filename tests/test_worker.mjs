/* ============================================================================
 * test_worker.mjs —— Worker 侧纯逻辑（PIN / token / 导出）的断言
 * ----------------------------------------------------------------------------
 * 【为什么单独一份】这些逻辑不依赖 Cloudflare API（只依赖 Web Crypto），
 *   所以能在沙盒真验。room.js / index.js 那些依赖 cloudflare:workers 的**验不了**，
 *   不要因为这份全绿就以为部署没问题 —— 见文件末尾的"未验清单"。
 *
 * 【★ 这节锁的是"PIN 固化"带来的三个后果】（档案已定：不可修改、不可找回）
 *   ① 只存摘要，不存明文 ② 错误口令必须被拒，且不泄露哪一位错 ③ token 过期即失效
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Engine from '../packages/engine/src/index.js';
import {hashPin, verifyPin, newSalt, signToken, verifyToken, TOKEN_TTL, newCode, isCode, isPin}
  from '../apps/worker/src/auth.js';
import {toNdjson, fromNdjson, toBattle, exportAs, FORMAT} from '../apps/worker/src/export.js';
import {createRoomCore} from '../apps/worker/src/core.js';
import {createMemoryStorage} from './memory_storage.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const SECRET = 'unit-test-secret';

/* 造一条真实 roll 消息：走引擎 → 事实化 → 落库形态（不手搓 payload） */
function makeRoll(rule, cmd, seq, prep, card){
  let i = 0;
  const keep = Engine.RNG.die;
  Engine.RNG.die = () => ([7, 4][i++] ?? 1);
  try{
    const ctx = {me:'老王', room:Engine.makeRoom(), card:card || null, history:[]};
    ctx.room.rule = rule;
    (prep || []).forEach(t => Engine.handleCommand(t, ctx));
    const m = Engine.handleCommand(cmd, ctx).msgs.filter(x => x.kind === 'roll').pop();
    const {factsFromView} = Engine;
    return {seq, id:'R1A2B3:' + seq, ts:1772000000000 + seq * 1000, kind:'roll', from:'骰娘', actor:'老王',
      anon_id:'a1', req_id:'c' + seq, rule_at:rule, payload:factsFromView(m.view)};
  }finally{ Engine.RNG.die = keep; }
}

console.log('== 1. PIN：只存摘要、错误必拒、不泄露位置 ==');
{
  const salt = newSalt();
  const h = await hashPin('1234', salt, SECRET);
  ok('★ 摘要里不含明文', !h.includes('1234'));
  ok('摘要长度合理（HMAC-SHA256 → base64url 43）', h.length >= 40 && h.length <= 48, 'len=' + h.length);
  ok('正确口令通过', (await verifyPin('1234', salt, h, SECRET)).ok);
  ok('错误口令被拒', !(await verifyPin('1235', salt, h, SECRET)).ok);
  ok('★ 换 salt 后同一口令摘要不同（不同房间不互认）', (await hashPin('1234', newSalt(), SECRET)) !== h);
  ok('★ 换 secret 后摘要不同（secret 泄露才可被伪造）', (await hashPin('1234', salt, 'other')) !== h);
  const noPin = await verifyPin('0000', salt, null, SECRET);
  ok('开放式房间（无摘要）走 no_pin 分支', !noPin.ok && noPin.why === 'no_pin');
  // 校验结果只有 ok，没有"第几位错了"这类字段 —— 4 位只有 10⁴ 组合，不能给提示
  const r = await verifyPin('9999', salt, h, SECRET);
  eq('★ 失败只回 {ok:false}，不泄露任何位置信息', Object.keys(r).join(','), 'ok');
}

console.log('== 2. token：签名不可伪造、过期失效、换房不认 ==');
{
  const now = Math.floor(Date.now() / 1000);
  const t = await signToken({code:'123456', anon_id:'a1', exp:now + TOKEN_TTL}, SECRET);
  const v = await verifyToken(t, SECRET);
  ok('正常 token 通过', v.ok);
  eq('payload 带房间号', v.payload.code, '123456');
  ok('★ 过期 token 被拒', !(await verifyToken(await signToken({code:'1', exp:now - 1}, SECRET), SECRET)).ok);
  ok('★ 改秘钥后旧 token 失效', !(await verifyToken(t, 'another-secret')).ok);
  // ★ 重要区分：token **只防伪造，不防"拿别的房间的 token 来连这个房间"** ——
  //   payload 是 base64url 明文，签名有效 ≠ 房间对得上。所以房间匹配必须由 room.js 单独查
  //   （`v.payload.code !== this.code` 那一行）。这里锁的是：签名有效时仍能读出原 code，
  //   好让 room.js 有东西可比。
  const otherRoom = await signToken({code:'999999', anon_id:'a1', exp:now + 60}, SECRET);
  const vo = await verifyToken(otherRoom, SECRET);
  ok('签名有效的他房 token 验得通过（签名层不拦他房）', vo.ok);
  eq('★ 但 payload 里带原房间号，供 room.js 比对拦截', vo.payload.code, '999999');
  const forged = t.slice(0, t.indexOf('.')) + '.AAAA';
  ok('★ 伪造签名被拒', !(await verifyToken(forged, SECRET)).ok);
  ok('非字符串/无点号 → bad_token', (await verifyToken('abc', SECRET)).why === 'bad_token');
  ok('TTL 覆盖一场跑团（≥4 小时）', TOKEN_TTL >= 4 * 3600, 'ttl=' + TOKEN_TTL);
}

console.log('== 3. 房间号：6 位数字 ==');
{
  const seen = new Set();
  for(let i = 0; i < 200; i++) seen.add(newCode());
  ok('★ 全都是 6 位数字', [...seen].every(isCode), [...seen].slice(0, 3).join(','));
  // 10⁶ 空间下 200 次几乎不碰撞（生日悖论 ≈2%），所以不断言"必须有重复"——
  //   ★ 撞号靠"惰性创建式检测"（读 DO 的 created_at）兜底，不靠随机性
  ok('生成值都在 000000–999999 内', [...seen].every(c => Number(c) >= 0 && Number(c) <= 999999));
  ok('isPin 只认 4 位数字', isPin('1234') && !isPin('12345') && !isPin('12a4'));
}

console.log('== 4. 导出：NDJSON 全量可回灌 ==');
{
  const msgs = [
    {seq:1, id:'R1A2B3:1', ts:1772000000000, kind:'cmd', from:'老王', actor:'老王', anon_id:'a1', req_id:'c1', rule_at:'coc7', payload:{text:'.rc 侦查'}},
    makeRoll('coc7', '.rc 侦查', 2, ['.st set 侦查 60'], {family:'coc7', data:{侦查:60}}),
  ];
  const nd = toNdjson(msgs);
  eq('行数 = 消息数', nd.trim().split('\n').length, 2);
  const back = fromNdjson(nd);
  eq('回灌条数一致', back.msgs.length, 2);
  eq('回灌无坏行', back.errs.length, 0);
  eq('★ 回灌后 payload 完全一致（可原样 INSERT）', JSON.stringify(back.msgs[1].payload), JSON.stringify(msgs[1].payload));
  eq('空房间导出空文件', toNdjson([]), '');
  // 坏行不该让整份报废
  const dirty = fromNdjson(nd + '{"seq":"x"}\n\n' + nd.trim().split('\n')[0] + '\n');
  ok('★ 坏行单独收集，其余照常回灌', dirty.msgs.length === 3 && dirty.errs.length === 1,
    'msgs=' + dirty.msgs.length + ' errs=' + dirty.errs.length);
}

console.log('== 5. 导出：战报与聊天流同源（★ 原则 4） ==');
{
  const m = makeRoll('coc7', '.rc 侦查', 1, ['.st set 侦查 60'], {family:'coc7', data:{侦查:60}});
  const md = toBattle([m], {code:'123456', rule:'coc7', exportedAt:'2026-10-29 18:00'});
  ok('战报含房间号', md.includes('123456'));
  ok('战报含标题', md.includes('侦查'));
  ok('★ 战报含合计行（与气泡同源 detailLines）', /合计/.test(md));
  // 同源的硬证据：战报里的点数与 HTML 气泡里的点数一致
  const html = Engine.renderRoll({id:m.id, view:Engine.viewFromPayload(m.payload)});
  const total = Engine.viewFromPayload(m.payload).total;
  ok('★ 战报的 total 与气泡的 total 一致', md.includes('`' + total + '`'), 'total=' + total + '\n' + md);
  ok('★ HTML 气泡也含同一个 total', html.includes('→ ' + total));
  ok('战报提示 30 天清理（导出是唯一保全手段）', md.includes('30 天'));
  /* ★ 多人房间的可追溯性：战报里只剩一行行文字，没有左右分列可依 —— 骰娘的每条回复
   *   必须写明是回应谁的指令，否则复盘时"这颗骰是谁掷的"无从判断
   *   （真机反馈 · 手机端：UncleMush 未绑卡时的 .st 回复、普通 .r 都一样没归属）。 */
  ok('★ 战报写明骰娘这条回复是回应谁', /\*\*骰娘\*\* → \*\*老王\*\*/.test(md), md.split('\n').slice(-1)[0]);
  const out = exportAs([m], {code:'123456'}, FORMAT.MD);
  ok('md 导出的 content-type 正确', out.type.startsWith('text/markdown'));
  ok('ndjson 导出的 content-type 正确', exportAs([m], {code:'1'}, FORMAT.NDJSON).type.includes('ndjson'));
}

console.log('== 6. 四套规则的战报都能出（不是只有 COC 能跑） ==');
{
  const cases = [
    ['generic', '.r 2d6+3', null],
    ['dnd5e', '.rc 巧手 p', {family:'dnd', data:{str:16, dex:14, con:15, int:10, wis:12, cha:8, lv:5}}],
    ['dh', '.dh 敏捷 15', {family:'dh', data:{敏捷:2, 力量:2, 灵巧:1, 本能:0, 风度:1, 知识:-1}}],
    ['fu', '.fu dex ins 10', {family:'fu', data:{dex:8, ins:10, mig:8, wlp:6}}],
  ];
  for(const [rule, cmd, card] of cases){
    const m = makeRoll(rule, cmd, 1, null, card);
    const md = toBattle([m], {code:'123456', rule, exportedAt:'2026-10-29'});
    ok('战报可出：' + rule, md.includes('**合计**'), md.slice(0, 120));
    const v = Engine.viewFromPayload(m.payload);
    ok('还原与当时一致：' + rule, typeof v.total === 'number' && !Number.isNaN(v.total), 'total=' + v.total);
  }
}

console.log('== 7. ★★ 用户消息必须留存（指令与闲聊同权，成功指令也不例外） ==');
/* 【为什么单列一节】档案「呈现基线」与 M2 的 LocalSource.send() 都写明：
 *   用户自己发的**每一条**都要进消息记录 —— 打错了能看见、能回溯、导出战报才完整。
 *   M2 的做法是 send() 里**无条件先 emit** 用户消息（cmd / chat），再 emit 引擎结果。
 *   M3 搬进 core.js 时变成了「只在引擎没输出时才记」，于是**所有成功的指令**（.r / .st /
 *   .set rule …）用户原文都被丢掉了 —— 而这恰恰是骰点类指令（占 60–80%）的全部。
 *   旧测试没抓到，是因为第 4 / 5 节里的 cmd 消息是**手搓的字面量**，从没真跑过 apply()。
 *   这一节全部走真实调用：createRoomCore + apply。 */
{
  let t = 1772000000000;
  const st = createMemoryStorage('123456');
  const core = createRoomCore(st, {now: () => (t += 1000)});
  const send = (id, text) => core.apply({reqId:id, text, anonId:'a1', nick:'老王'});

  /* 每一例：[指令, 期望的用户消息 kind, 期望的骰娘回复 kind（null=没有回复）] */
  const cases = [
    ['大家好',        'chat', null],      // 闲聊：只有用户消息
    ['.zzz 乱敲的',   'chat', null],      // 没命中动词 → 按聊天记（isCommandText 只认已知动词）
    ['.r 2d6+3',     'cmd',  'roll'],    // ★ 成功掷骰：用户原文 + 骰点，两条都要有
    ['.set rule coc','cmd',  'sys'],     // ★ 改规则：用户原文 + 全房广播
  ];
  for(const [text, userKind, botKind] of cases){
    const r = await send('q-' + text, text);
    const kinds = r.msgs.map(m => m.kind);
    const u = r.msgs.find(m => m.kind === userKind);
    ok('★ 落库了用户消息：' + text, !!u, 'kinds=' + kinds.join(','));
    if(u){
      eq('　原文逐字保留：' + text, u.payload.text, text);
      eq('　from 是本人（不是骰娘）', u.from, '老王');
      eq('　带 anon_id', u.anon_id, 'a1');
      eq('　带 req_id（可与回复配对）', u.req_id, 'q-' + text);
    }
    if(botKind){
      const b = r.msgs.find(m => m.kind === botKind);
      ok('　骰娘回复也在：' + text, !!b, 'kinds=' + kinds.join(','));
      if(u && b) ok('　★ 顺序：用户消息在前、回复在后', u.seq < b.seq, u.seq + ' < ' + b.seq);
    }
  }

  // ★ 落库 = 能补齐 = 能导出：用户消息必须真的进了 storage，而不是只在返回值里
  const all = await st.since(0, 100);        // memory_storage.since 直接返回数组
  const texts = all.map(m => (m.payload && m.payload.text) || '').filter(Boolean);
  ok('★ storage 里能查到用户原文（重连补齐 / 导出战报都靠它）',
    texts.includes('.r 2d6+3') && texts.includes('大家好'), texts.join(' | '));
  ok('★ 用户消息与骰娘回复条数成对（每条输入至少 1 条）',
    all.filter(m => m.kind === 'cmd' || m.kind === 'chat').length >= 3,
    'cmd+chat=' + all.filter(m => m.kind === 'cmd' || m.kind === 'chat').length);
}

console.log('== 8. ★ html kind 必须带 defs（否则落库后是空气泡）==');
/* 【为什么单列一节】协议 KIND.HTML 的白名单只有 `defs`，core.js 的 factsOf 读 `msg.defs`，
 *   前端 toRenderable 也是 `defsHtml(p.defs)`。而引擎原先只给 `html`（渲染好的串）——
 *   于是 `.st / .help / .status / .st set / .rc list` 落库后 payload 变成 `{}`，
 *   前端渲染出**空气泡**：用户看到"有回复但内容是空的"，极易误判成"只有 .r 能用"。
 *   （roll 走 view、notice 走 html、sys 走 title，都不受影响 —— 所以这个 bug 只在 html kind 上。）
 *   这一节锁的是"引擎产出"与"协议字段"之间的接口不漂移。 */
{
  const cmds = ['.st', '.help', '.status', '.rc list', '.st set 侦查 60'];
  let t = 1772000000000;
  const st = createMemoryStorage('654321');
  const core = createRoomCore(st, {now: () => (t += 1000)});
  for(const c of cmds){
    // ① 引擎侧：html kind 必须带 defs（结构化），不能只带 html 串
    const ctx = {me:'老王', room:Engine.makeRoom(), card:null, history:[]};
    ctx.room.rule = 'coc7';
    const outs = Engine.handleCommand(c, ctx).msgs.filter(m => m.kind === 'html');
    for(const m of outs){
      ok('★ 引擎 html 消息带 defs：' + c, !!m.defs && typeof m.defs === 'object',
        '字段=' + Object.keys(m).join(','));
      ok('　defs 能渲染出内容（不是空气泡）：' + c,
        Engine.defsHtml(m.defs || {}).length > 20, 'len=' + Engine.defsHtml(m.defs || {}).length);
    }
    // ② 落库侧：走真实 apply，payload.defs 不能是空对象
    const r = await core.apply({reqId:'h-' + c, text:c, anonId:'a1', nick:'老王'});
    for(const m of r.msgs.filter(x => x.kind === 'html')){
      ok('★ 落库 payload.defs 非空：' + c, !!m.payload.defs && Object.keys(m.payload.defs).length > 0,
        'payload=' + JSON.stringify(m.payload));
    }
  }
}

console.log('== 9. ★ 在线人数：room.js（DO）不能用裸 length（真机反馈 · A 组第 3 条）==');
/* 【为什么是静态扫描而不是真跑】room.js 依赖 cloudflare:workers，沙盒跑不了 DO。
 *   但"在线数只增不减"这个坑**必须**有东西守 —— 它是源码写法决定的，扫源码就够。
 * 【实测依据】workerd 真跑过：对端断开后 webSocketClose 里 getWebSockets() 仍包含那条
 *   已关闭的连接 → 裸 length 让 online 只增不减。用 readyState === 1 过滤后确认为 1（正确）。 */
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  ok('★ 在线数按 readyState 过滤（不是 getWebSockets().length）',
    /readyState\s*===\s*1/.test(roomSrc), '没找到 readyState 过滤');
  // 三处取在线数的地方都必须走 onlineCount()，不能有一处漏网用裸 length
  // ★ 先剥注释：room.js 的注释里正写着"不要写 getWebSockets().length"——不剥会误报
  const codeOnly = roomSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const naked = codeOnly.match(/getWebSockets\(\)(?!\.filter)\.length/g) || [];
  ok('★ 没有残留的裸 getWebSockets().length', naked.length === 0, '残留 ' + naked.length + ' 处');
  ok('★ presence / welcome 都带 online 与 total 两个数',
    /online:this\.onlineCount\(\)/.test(roomSrc) && /total:mem\.length/.test(roomSrc));
  // core 侧：online 由 DO 注入，纯逻辑拿不到时必须留 null（不谎报 0）
  const coreSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'core.js'), 'utf8');
  ok('★ core 的 online 来自注入（未注入 → null，不是 0）',
    /onlineOf \? onlineOf\(\) : null/.test(coreSrc) && /memberCountOf \? memberCountOf\(\) : null/.test(coreSrc));
  ok('★ 条数用注入的 msgCount（现存量 COUNT，不是 room.seq）',
    /storage\.countMsgs\(\)/.test(coreSrc) && !/msgCount\s*[:=]\s*room\.seq/.test(coreSrc));
}

console.log('---------------------------');
console.log('Worker 纯逻辑：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('⚠️  未验（只能你部署后验）：room.js 的 DO 行为 / index.js 路由 / wrangler 配置 / 真实 ws');
process.exit(fail ? 1 : 0);
