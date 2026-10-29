/* ============================================================================
 * check-engine-split.js —— 拆包后的**每日自检**（5 项）
 * ----------------------------------------------------------------------------
 * 【怎么用】 node tools/check-engine-split.js
 * 【为什么要有这个】单文件时代不存在的风险，拆成 ESM 后全冒出来了：
 *   ① 顶层标识符撞名 —— 拼接路（test_engine.js）会**静默覆盖**，谁后拼谁生效
 *   ② 漏 import —— 拼接路刚好有那个符号所以不报错，**浏览器里才炸**
 *   ③ 循环依赖 —— TDZ 崩溃（"Cannot access X before initialization"）
 *   ④ 引擎里混进 DOM / Node API —— 边界一旦破，Worker 侧就跑不起来
 *   ⑤ 别名注册顺序 —— ESM 下 = import 顺序；单文件时代是"书写顺序"，天然确定
 *                    现在顺序变了会让某个别名被别的包**静默抢走**（先到先得）
 *   这五条都是"测试全绿但线上炸"的类型，必须单独扫。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'packages', 'engine', 'src');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'index.js').sort();
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const src = Object.fromEntries(files.map(f => [f, read(f)]));

let bad = 0;
const ok = (n, c, extra) => { if (c) console.log('  ✅ ' + n); else { bad++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

/* ---------- 工具：剥注释（否则注释里提到的 window 会被误报） ---------- */
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

console.log('== ① 顶层标识符跨文件唯一（拼接路会静默覆盖） ==');
{
  const owner = new Map(); const dup = [];
  for (const f of files) {
    for (const m of strip(src[f]).matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const k = m[1];
      if (owner.has(k)) dup.push(k + '（' + owner.get(k) + ' 与 ' + f + '）');
      else owner.set(k, f);
    }
  }
  ok(files.length + ' 个模块无重名顶层声明', dup.length === 0, dup.join(' / '));
}

console.log('== ② import 都能解析到实际导出（漏 import 在拼接路不报错） ==');
{
  const exp = {};
  for (const f of files) {
    const body = strip(src[f]);
    // ★ 两种导出形式都要收：`export {a, b}` 与 `export function/const a`（replay.js 是后者，
    //   只认前者会把它导出的名字当成"没导出"，进而误报别人漏 import）
    const blk = body.match(/export\s*\{([^}]*)\}/);
    const set = new Set(blk ? blk[1].split(',').map(s => s.trim()).filter(Boolean) : []);
    for (const m of body.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
    exp[f] = set;
  }
  const miss = [];
  for (const f of files) {
    for (const m of src[f].matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.js'/g)) {
      for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const tgt = m[2] + '.js';
        if (!exp[tgt] || !exp[tgt].has(name)) miss.push(f + ' → ' + tgt + '.' + name);
      }
    }
  }
  ok('全部 import 可解析', miss.length === 0, miss.join(' / '));
  // 反向：本文件用到但既没 import 也没在本文件定义的符号（漏 import 的另一半）
  // 只查「别的模块导出的名字」被用到却没 import —— 查普通大写词会把字符串里的 COC/NFKC 全误报
  const allExports = new Map();
  for (const f of files) for (const n of exp[f]) allExports.set(n, f);
  const undef = [];
  for (const f of files) {
    const body = strip(src[f]);
    const imported = new Set([...src[f].matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap(m => m[1].split(',').map(s => s.trim())));
    const local = new Set([...body.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
    for (const [name, owner] of allExports) {
      if (owner === f || local.has(name) || imported.has(name)) continue;
      if (new RegExp('\\b' + name + '\\b').test(body)) undef.push(f + ' 用到 ' + owner + ' 的 ' + name + ' 但没 import');
    }
  }
  ok('无"用到别的模块的导出却没 import"（拼接路掩盖，浏览器才炸）', undef.length === 0, [...new Set(undef)].slice(0, 8).join(' / '));
}

console.log('== ③ 模块图无环 + 注册表单向 ==');
{
  const graph = {};
  for (const f of files) graph[f] = [...src[f].matchAll(/from\s*'\.\/(\w+)\.js'/g)].map(m => m[1] + '.js');
  const color = {}; const cycles = [];
  const dfs = (n, st) => {
    color[n] = 1; st.push(n);
    for (const m of graph[n] || []) {
      if (color[m] === 1) cycles.push([...st.slice(st.indexOf(m)), m].join(' → '));
      else if (!color[m]) dfs(m, st);
    }
    st.pop(); color[n] = 2;
  };
  for (const n of files) if (!color[n]) dfs(n, []);
  ok('无循环依赖', cycles.length === 0, cycles.join(' / '));
  const back = files.filter(f => f.startsWith('pack_') && /from '\.\/packs\.js'/.test(src[f]));
  ok('★ 规则包不反查注册表（packs.js 单向 import 五个包）', back.length === 0, back.join(' / '));
}

console.log('== ④ 引擎零 DOM / 零 Node API（浏览器与 Worker 同一份的前提） ==');
{
  const FORBID = /\b(document|window|localStorage|sessionStorage|navigator|alert|fetch|XMLHttpRequest|process|require|__dirname|Buffer|setTimeout|setInterval)\s*[.[(]?/g;
  const hits = [];
  for (const f of files) {
    const body = strip(src[f]);
    for (const m of body.matchAll(FORBID)) {
      // Date 允许（引擎产出 ts），但上面列表里没有 Date，安全
      hits.push(f + ' → ' + m[1]);
    }
  }
  ok(files.length + ' 个模块零 DOM / 零 Node API', hits.length === 0, [...new Set(hits)].join(' / '));
  // 允许的例外：rng.js 用 crypto（浏览器与 Worker 都有）
  const cryptoUsers = files.filter(f => /crypto\./.test(strip(src[f])));
  ok('随机源只用 crypto（不退化成 Math.random）', cryptoUsers.length >= 1 && !/\bMath\.random\b/.test(files.map(f => strip(src[f])).join('\n')),
     'crypto 出现在：' + cryptoUsers.join(','));
}

console.log('== ⑤ 别名注册顺序快照（ESM 下顺序 = import 顺序） ==');
{
  const {loadEngine} = require('./load-engine.js');
  const {Engine} = loadEngine();
  ok('★ ALIAS.conflicts 为空（无别名被静默抢走）', Engine.ALIAS.conflicts.length === 0, JSON.stringify(Engine.ALIAS.conflicts));
  ok('index.js 的 export 顺序与 loadEngine 一致', JSON.stringify(require('./load-engine.js').ORDER) === JSON.stringify(
       fs.readFileSync(path.join(SRC, 'index.js'), 'utf8').match(/export \* from '\.\/(\w+)\.js';/g).map(s => s.match(/'.\/(\w+)\.js'/)[1])));
  // 关键别名归属：这些一旦被抢，用户手里的旧指令就悄悄变了意思
  // 判据用 ab（归属属性）而不是 key —— key 是技能自己的名字，ab 才是"它到底是谁"
  const keys = [
    ['check:dnd', 'int',  'int'],   // 智力，不能被威吓抢走
    ['check:dnd', 'inti', 'cha'],   // 威吓 → 魅力
    ['check:dnd', '巧手', 'dex'],
    ['check:dnd', '察觉', 'wis'],
  ];
  // DH 的特性项是 trait 不是 skill，没有 ab 字段 —— 用 key 判
  const keysByKey = [
    ['check:dh',  '仪态', 'pre'],   // 旧译仍可用（presence 主显示已改「风度」）
    ['check:dh',  '风度', 'pre'],
    ['check:fu',  '敏捷', 'dex'],
    ['check:coc7','侦查', '侦查'],   // COC 技能表是开放的，key 就是中文名本身
  ];
  const wrong = [];
  for (const [dom, alias, ab] of keys) {
    const e = Engine.lookupAlias(dom, alias);
    if (!e || e.ab !== ab) wrong.push(dom + '/' + alias + ' → ' + (e ? (e.key + '.ab=' + e.ab) : 'null') + '（want ab=' + ab + '）');
  }
  for (const [dom, alias, key] of keysByKey) {
    const e = Engine.lookupAlias(dom, alias);
    if (!e || e.key !== key) wrong.push(dom + '/' + alias + ' → ' + (e ? e.key : 'null') + '（want ' + key + '）');
  }
  for (const [alias, key] of [['5.5e','dnd5r'], ['5e','dnd5e'], ['coc','coc7'], ['匕首心','dh'], ['最终物语','fu']]) {
    const e = Engine.lookupAlias('rule', alias);
    if (!e || e.key !== key) wrong.push('rule/' + alias + ' → ' + (e ? e.key : 'null') + '（want ' + key + '）');
  }
  ok('关键别名归属正确（int=智力 / inti=威吓 / 5.5e=dnd5r / 仪态=pre…）', wrong.length === 0, wrong.join(' / '));
}

console.log('\n拆包自检：' + (bad ? '❌ ' + bad + ' 项不通过' : '✅ 全通过'));
process.exit(bad ? 1 : 0);
