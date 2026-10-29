/* ============================================================================
 * test_engine_esm.mjs —— 用**真 ESM** 跑同一份断言（tests/test_engine.js 的主体）
 * ----------------------------------------------------------------------------
 * 【怎么用】 node tests/test_engine_esm.mjs
 * 【为什么要有这一路】拼接路（test_engine.js）把模块拼进同一作用域，
 *   会**掩盖三类只在真实模块语义下才暴露的问题**：
 *     ① TDZ —— const 求值顺序错（"Cannot access X before initialization"）
 *     ② 循环依赖 —— 拆包踩出来的，拼接路根本不报错
 *     ③ 漏 import —— 拼接路刚好有那个符号，浏览器里才炸
 *   这三类都是 M3 拆包的新增风险，所以必须有一路真的 import。
 *
 * 【怎么做到"同一份断言"】把 test_engine.js 从 `let pass = 0` 起的整段主体抠出来，
 *   用 new Function 注入 Engine / HTML_SRC / FOUND 求值 —— 断言文本零改动。
 *   若有人改了断言，两路会同时变，不会漂移成两套测试。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import * as Engine from '../packages/engine/src/index.js';

const ROOT = path.join(import.meta.dirname, '..');
const TEST = path.join(ROOT, 'tests', 'test_engine.js');

const all = fs.readFileSync(TEST, 'utf8');
const i = all.lastIndexOf('\nlet pass = 0, fail = 0;') + 1;
if (i < 0) { console.error('❌ test_engine.js 里找不到断言主体起点（let pass = 0）'); process.exit(1); }
const body = all.slice(i);

// HTML_SRC：架构类断言扫引擎源码，呈现类断言（CSS）扫 legacy html —— 与拼接路口径一致。
// 顺序必须按 index.js 的 export 顺序（= 别名注册顺序），不能按字母序。
const SRC = path.join(ROOT, 'packages', 'engine', 'src');
const ORDER = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8')
  .match(/export \* from '\.\/(\w+)\.js';/g).map(s => s.match(/'.\/(\w+)\.js'/)[1]);
const IMPORT_RE = /^\s*import\s[^;]*;\s*$/;
const EXPORT_BLOCK_RE = /^\s*export\s*\{[^}]*\}\s*;\s*$/;
const EXPORT_DECL_RE = /^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/;
let HTML_SRC = ORDER.map(n => '\n/* ==== ' + n + '.js ==== */\n' +
  fs.readFileSync(path.join(SRC, n + '.js'), 'utf8').split('\n')
    .map(l => IMPORT_RE.test(l) || EXPORT_BLOCK_RE.test(l) ? null : l.replace(EXPORT_DECL_RE, '$1'))
    .filter(l => l !== null).join('\n')).join('\n');
const legacy = path.join(ROOT, 'legacy', 'M2_骰娘单机可摸版.html');
if (fs.existsSync(legacy)) HTML_SRC += '\n' + fs.readFileSync(legacy, 'utf8');

const FOUND = {path:'packages/engine/src/index.js', name:'packages/engine (ESM)', stale:false};

console.log('·  引擎来源：packages/engine（真 ESM，node 原生 import）\n');
new Function('Engine', 'HTML_SRC', 'FOUND', body)(Engine, HTML_SRC, FOUND);
