/* ============================================================================
 * test_payload_roundtrip.mjs —— T4a「协议契约守恒」断言
 * ----------------------------------------------------------------------------
 * 【守什么】协议里那几张「契约表」（KIND / FIELDS / GROUP_SHAPE / OUT）不是文档，
 *   是**会被别处 import 的唯一出处**。它们与真正跑起来的链路（NDJSON 导出回灌、
 *   payload 白名单校验、出站帧识别、帧路由豁免）一旦漂移，形状就变成"两边各说各话"：
 *   库里存了字段 A，回灌时按表 B 校验 → 合法数据被拒；或加了个 OUT 帧没人接。
 *   这里把「表 → 链路」逐条钉死，改表不改链路（或反过来）立刻红。
 *
 * 【为什么全用 packages/ 与 apps/worker/ 的源文件、不 import frame-route.js】
 *   T3 后 apps/web/vendor/** 与 index.html 已从 Git 出库，frame-route.js 又 import
 *   了 vendor 副本 —— 动态 import 它会让 `npm test` 在干净仓库（未跑 build:web）直接崩。
 *   所以对帧路由只用**静态文本**读 apps/web/src/frame-route.js 的声明，
 *   零生成物依赖；动态 import 只碰一直在 Git 里的源模块。
 *
 * 【怎么红 / 怎么绿】见 tools/ 里没有、本文件注释末尾的「先红后绿」清单：
 *   A 给 FIELDS 加 kind 但不加 KIND → 红；B 让 toNdjson 丢一个 payload 字段 → 红；
 *   C 从 GROUP_SHAPE 删一个键 → 红；D 把 ROUTE_EXEMPT 清空 → 红。四处恢复即绿。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {KIND, KINDS, FIELDS, GROUP_SHAPE, checkPayload, normalize} from '../packages/protocol/src/payload.js';
import {OUT, isOut, pong} from '../packages/protocol/src/frames.js';
import {toNdjson, fromNdjson} from '../apps/worker/src/export.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; }
  else { fail++; console.log('  ❌ ' + n + (extra === undefined ? '' : ' :: ' + String(extra).slice(0, 160))); }
};
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b),
  'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
const sorted = xs => [...xs].sort();

console.log('== T4a 协议契约守恒 ==');

/* ---------- ① 契约表自身自洽 ---------- */
console.log('-- ① 契约表自身自洽 --');
{
  eq('★ KINDS 与 FIELDS 键集合一致（契约表不能各写一份）', sorted(Object.keys(FIELDS)), sorted(KINDS));
  ok('★ KIND 每个值都出现在 KINDS 里', Object.values(KIND).every(v => KINDS.includes(v)));
  ok('★ KINDS 无重复值', new Set(KINDS).size === KINDS.length);
  ok('★ FIELDS 没有 KINDS 之外的 kind',
    Object.keys(FIELDS).every(k => KINDS.includes(k)), Object.keys(FIELDS).filter(k => !KINDS.includes(k)));
  ok('★ 每个 kind 至少有一个白名单字段', KINDS.every(k => Array.isArray(FIELDS[k]) && FIELDS[k].length > 0));
  ok('★ 各 kind 白名单内无重复字段', KINDS.every(k => new Set(FIELDS[k]).size === FIELDS[k].length));
  eq('★ GROUP_SHAPE 无重复键', new Set(GROUP_SHAPE).size, GROUP_SHAPE.length);
  ok('★ GROUP_SHAPE 含逐骰明细必需的 sides / tries / kept',
    ['sides', 'tries', 'kept'].every(k => GROUP_SHAPE.includes(k)));
}

/* ---------- ② 造一份覆盖全部白名单字段的合法 payload ---------- */
/* 值只求「形状合法」，不求语义：checkPayload 管形状，engine/replay.js 才管含义。
 * 用 ?? null 兜底 —— 契约将来加字段时，这份夹具自动跟上，不会假装没看见。 */
const GROUP_VALUE = {
  sides: 6, n: 1, sign: 1, tries: [3], kept: [3], keptIdx: [0],
  label: '', chip: '', percent: null,
};
const fullGroup = Object.fromEntries(GROUP_SHAPE.map(k => [k, GROUP_VALUE[k] ?? null]));
const FIELD_VALUE = {
  text: 'hi', title: 't', rule_at: 'generic', mode: 'normal', expr: '1d6',
  target: null, groups: [fullGroup], comps: [], dc: null, card_at: null, notes: '',
  defs: {foo: 'bar'}, html: '<b>x</b>', line1: 'a', line2: 'b',
};
const mkPayload = kind => Object.fromEntries(FIELDS[kind].map(k => [k, FIELD_VALUE[k] ?? null]));
const mkMsg = (seq, kind, payload) => ({
  seq, id: '123456:' + seq, ts: 1700000000000 + seq, kind,
  from: {name: '老王'}, actor: null, anon_id: 'a1', req_id: 'r' + seq,
  rule_at: 'generic', payload,
});

/* ---------- ③ 字段集合守恒：表 → payload → NDJSON → 回灌 → 白名单 ---------- */
console.log('-- ② 字段集合守恒（toNdjson → fromNdjson → checkPayload）--');
{
  const origs = KINDS.map((kind, i) => ({kind, msg: mkMsg(i + 1, kind, mkPayload(kind))}));
  for (const {kind, msg} of origs) {
    ok('★ ' + kind + ' 构造的 payload 本身合法', checkPayload(kind, msg.payload) === null,
      checkPayload(kind, msg.payload));
  }
  const nd = toNdjson(origs.map(x => x.msg));
  const {msgs: back, errs} = fromNdjson(nd);
  eq('★ NDJSON 回灌无坏行', errs.length, 0);
  eq('★ 回灌条数守恒', back.length, origs.length);
  for (let i = 0; i < origs.length; i++) {
    const {kind, msg} = origs[i], b = back[i];
    if (!b) { ok('★ ' + kind + ' 回灌得到该条', false); continue; }
    eq('★ ' + kind + ' 外层字段集合守恒', sorted(Object.keys(b)), sorted(Object.keys(msg)));
    eq('★ ' + kind + ' kind 守恒', b.kind, kind);
    eq('★ ' + kind + ' payload 字段集合守恒', sorted(Object.keys(b.payload)), sorted(FIELDS[kind]));
    eq('★ ' + kind + ' payload 逐字段值守恒', b.payload, msg.payload);
    ok('★ ' + kind + ' 回灌后仍过白名单', checkPayload(b.kind, b.payload) === null,
      checkPayload(b.kind, b.payload));
    eq('★ ' + kind + ' normalize 按 FIELDS 不丢字段', normalize(kind, b.payload), b.payload);
  }
  /* 坏行收集：一条脏数据不该让整份战报废掉（export.js 的既定行为） */
  const dirty = fromNdjson(nd + '{"bad":1}\n');
  eq('★ 坏行不污染好行', dirty.msgs.length, origs.length);
  eq('★ 坏行被单独收集', dirty.errs.length, 1);
}

/* ---------- ④ GROUP_SHAPE 是 group 形状的唯一出处 ---------- */
console.log('-- ③ GROUP_SHAPE 是骰组形状的唯一出处 --');
{
  ok('★ GROUP_SHAPE 全键可组成合法 group', checkPayload(KIND.ROLL, {groups: [fullGroup]}) === null,
    checkPayload(KIND.ROLL, {groups: [fullGroup]}));
  const bogus = {...fullGroup, not_in_shape: 1};
  ok('★ group 多一个非白名单键会被 checkPayload 拒',
    /group 字段不在白名单/.test(checkPayload(KIND.ROLL, {groups: [bogus]}) || ''),
    checkPayload(KIND.ROLL, {groups: [bogus]}));
  const noTries = {...fullGroup}; delete noTries.tries;
  ok('★ 缺逐骰明细 tries 会被拒',
    /tries 缺失/.test(checkPayload(KIND.ROLL, {groups: [noTries]}) || ''));
  eq('★ 造出的 group 键集合 == GROUP_SHAPE', sorted(Object.keys(fullGroup)), sorted(GROUP_SHAPE));
}

/* ---------- ⑤ OUT / isOut / pong / 帧路由豁免 ---------- */
console.log('-- ④ 出站帧契约与 pong 豁免 --');
{
  const outValues = Object.values(OUT);
  eq('★ OUT 值无重复', new Set(outValues).size, outValues.length);
  for (const t of outValues) ok('★ isOut 识别 ' + t, isOut({t}) === true);
  ok('★ isOut 拒绝未知帧', !isOut({t: '__not_an_out_frame__'}));
  ok('★ isOut 拒绝空帧', !isOut(null));

  const pf = pong(1);
  eq('★ pong 的 t 是 OUT.PONG', pf.t, OUT.PONG);
  ok('★ pong 是合法出站帧', isOut(pf) === true);

  /* 静态读声明：不 import frame-route.js（它依赖 vendor 生成物，T3 后已出库）。
   * 与 tools/check-frame-route.mjs 互补：那边动态 import 做全表覆盖（check 前置 build:web），
   * 这边只锁「pong 必须豁免」，且 npm test 单独跑也成立。 */
  const frSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'frame-route.js'), 'utf8');
  const exemptBlock = (frSrc.match(/export const ROUTE_EXEMPT\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const routesBlock = (frSrc.match(/export const FRAME_ROUTES\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
  ok('★ ROUTE_EXEMPT 含 OUT.PONG（心跳回包不落 UI）', /OUT\.PONG/.test(exemptBlock), exemptBlock.trim());
  ok('★ FRAME_ROUTES 没有误接管 pong', !/\[OUT\.PONG\]\s*:/.test(routesBlock));
  const exemptNames = [...exemptBlock.matchAll(/OUT\.(\w+)/g)].map(m => m[1]);
  ok('★ 豁免清单里每个名字都是真实 OUT 键（防拼错）',
    exemptNames.length > 0 && exemptNames.every(n => n in OUT), exemptNames.join(','));
  ok('★ 豁免清单无重复项', new Set(exemptNames).size === exemptNames.length);
}

console.log('\n协议契约守恒：' + (fail ? '❌ ' + fail + ' 项不通过' : '✅ 全通过') +
  '（通过 ' + pass + ' 项）');
process.exit(fail ? 1 : 0);

/* ============================================================================
 * 【先红后绿清单】（本文件自身不修改任何源文件，四组都在临时副本上做）
 *  A 契约表 ↔ 枚举：给 payload.js 的 FIELDS 加 `test_only:['x']` 但 KIND 不加
 *      → ①「KINDS 与 FIELDS 键集合一致」「FIELDS 没有 KINDS 之外的 kind」红；
 *        把 `TEST:'test_only'` 补进 KIND 且 KINDS = Object.values(KIND) 自动跟上 → 绿。
 *  B 链路守恒：把 export.js 的 toNdjson 里 `payload:m.payload` 改成
 *      `payload:Object.fromEntries(Object.entries(m.payload||{}).filter(([k])=>k!=='notes'))`
 *      → ②「roll payload 字段集合守恒」「逐字段值守恒」红；改回 → 绿。
 *  C 骰组形状：把 checkPayload 里的 `GROUP_SHAPE.includes(k)` 换成硬编码旧数组
 *      （模拟「另抄一份白名单」）→ ③「全键可组成合法 group」红；改回 → 绿。
 *  D pong 豁免：把 frame-route.js 的 ROUTE_EXEMPT 改成 `[]` → ④ 豁免断言红；改回 → 绿。
 * ========================================================================== */
