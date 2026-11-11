/* ============================================================================
 * check-frame-route.mjs —— T3a「帧路由唯一实现」自检
 * ----------------------------------------------------------------------------
 * 【守什么】frames.js 的 OUT 每加一个帧，都必须在 frame-route.js 的路由表里注册，
 *   或显式列入豁免清单。功能开发轮要加 INIT 帧 —— 漏接路由不再靠联调发现，
 *   而是这里立刻红（H·7.2 断言①「OUT 帧全覆盖」）。
 * 【怎么红 / 怎么绿】临时给 OUT 加一个测试帧但不注册表 → 红；补注册（或写进豁免
 *   并注明理由）→ 绿。运行时对未知帧仍然静默忽略，老客户端兼容不变。
 * 【为什么连调用方一起扫】坑 #18 的病根是「生产与冒烟各写一份 if 链」，
 *   所以这里同时锁住两处都用同一个 createFrameRouter()、都不再手写分发。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (n, c, extra) => { if(c) console.log('  ✅ ' + n); else { bad++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

console.log('== 帧路由唯一实现（T3a）==');

/* ① OUT 值：从 frames.js 的唯一出处静态抠出（不依赖生成物） */
const framesSrc = fs.readFileSync(path.join(ROOT, 'packages', 'protocol', 'src', 'frames.js'), 'utf8');
const outBlock = (framesSrc.match(/export const OUT\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const pairs = [...outBlock.matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
const outValues = pairs.map(m => m[2]);
ok('★ 从 frames.js 取到 OUT 定义（不是空跑）', outValues.length >= 8, 'count=' + outValues.length);

/* ② 路由表与豁免清单：动态 import 生产那一份（check 已前置 build:web） */
let mod;
try{
  mod = await import(path.join(ROOT, 'apps', 'web', 'src', 'frame-route.js'));
}catch(e){
  console.log('  ❌ 无法加载 frame-route.js（先跑 npm run build:web 重建 vendor）：' + e.message);
  process.exit(1);
}
const {FRAME_ROUTES, ROUTE_EXEMPT, createFrameRouter} = mod;
const routed = Object.keys(FRAME_ROUTES);
const exempt = Array.isArray(ROUTE_EXEMPT) ? ROUTE_EXEMPT : [];
ok('★ 每个 OUT 帧都有路由或显式豁免',
  outValues.filter(v => !routed.includes(v) && !exempt.includes(v)).length === 0,
  outValues.filter(v => !routed.includes(v) && !exempt.includes(v)).join(','));
ok('★ 路由表里没有不存在的帧',
  routed.filter(v => !outValues.includes(v)).length === 0,
  routed.filter(v => !outValues.includes(v)).join(','));
ok('★ 豁免清单里没有不存在的帧',
  exempt.filter(v => !outValues.includes(v)).length === 0,
  exempt.filter(v => !outValues.includes(v)).join(','));
ok('★ 同一帧不会既注册又豁免', routed.filter(v => exempt.includes(v)).length === 0,
  routed.filter(v => exempt.includes(v)).join(','));
const handlers = routed.map(k => FRAME_ROUTES[k]);
ok('★ handler 名不重复', new Set(handlers).size === handlers.length);

/* ③ 两处调用方都真的用了同一函数，且没有再手写 if 链 */
const netSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'net.js'), 'utf8');
const smokeSrc = fs.readFileSync(path.join(ROOT, 'tests', 'dom_smoke.js'), 'utf8');
ok('★ net.js 用 createFrameRouter', /createFrameRouter\(/.test(netSrc));
ok('★ dom_smoke.js 用同一个 createFrameRouter', /createFrameRouter\(/.test(smokeSrc));
ok('★ net.js 不再手写 f.t === OUT 分发', !/f\.t\s*===\s*OUT\./.test(netSrc));
ok('★ dom_smoke.js 不再有手写 route(f) 副本', !/function route\(f\)/.test(smokeSrc));
ok('★ 冒烟仍共用 batch.js（不抄生产逻辑）', /applyBatch\(ui, f\.msgs/.test(smokeSrc));

/* ④ 分发行为：注册帧能到 handler，豁免帧 / 未知帧静默忽略 */
{
  let got = null;
  const r = createFrameRouter({
    state(f){ got = f.room; },
    welcome(){ throw new Error('不该被调用'); },
  });
  r({t:'state', room:{rule:'coc7'}});
  ok('★ 注册帧正确分发到对应 handler', !!got && got.rule === 'coc7', JSON.stringify(got));
  r({t:'pong', ts:1});                       // 豁免帧
  r({t:'brand_new_frame_from_future'});      // 老客户端不认识的新帧
  ok('★ 豁免帧与未知帧静默忽略（老客户端兼容）', !!got && got.rule === 'coc7');
}

console.log('\n帧路由自检：' + (bad ? '❌ ' + bad + ' 项不通过' : '✅ 全通过'));
process.exit(bad ? 1 : 0);
