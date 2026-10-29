/* ============================================================================
 * check-worker.mjs —— Worker 侧的接口对齐检查（**静态扫描，不跑 Cloudflare**）
 * ----------------------------------------------------------------------------
 * 【为什么要有这个】M3 最容易出的一种错：**沙盒全绿、线上全错**。
 *   根因是三份实现会漂移：
 *     apps/worker/src/room.js 的 storage()   ← 生产
 *     tests/sqlite_storage.mjs               ← 验 SQL 语义
 *     tests/memory_storage.mjs               ← 验协议逻辑
 *   只要 core.js 需要的某个方法在其中一份里漏了/改了名，沙盒里跑的是另一份，永远不会红。
 *   这里把"三份实现的接口"逐方法对齐，漏一个就红。
 *
 * 【另外两项】
 *   ② room.js 的 SCHEMA 与 schema.sql 必须一致（唯一出处原则：不能只在其中一处改）
 *   ③ Worker 侧不许出现 Node API / 客户端时间当权威时间
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

/* core.js 实际调用的 storage 方法（从源码里扫，不手写清单 —— 手写清单自己也会漂） */
const coreSrc = read('apps/worker/src/core.js');
const used = new Set([...coreSrc.matchAll(/\b(?:await\s+)?storage\.(\w+)\s*\(/g)].map(m => m[1]));
// recentRolls 等通过 buildCtx 调用，同样算
console.log('== ① 三份 storage 实现逐方法对齐 ==');
console.log('（core.js 用到 ' + used.size + ' 个方法：' + [...used].sort().join(' ') + '）');
{
  const files = {
    'room.js（生产·DO）': read('apps/worker/src/room.js'),
    'sqlite_storage.mjs（验 SQL）': read('tests/sqlite_storage.mjs'),
    'memory_storage.mjs（验协议）': read('tests/memory_storage.mjs'),
  };
  for(const [name, src] of Object.entries(files)){
    const missing = [...used].filter(m => !new RegExp('(^|[^\\w.])' + m + '\\s*\\(').test(src));
    ok('★ ' + name + ' 实现了全部方法', missing.length === 0, '缺：' + missing.join(', '));
  }
  // 反向：实现里多了 core 不用的方法不算错，但三份之间的方法集合应当一致
  const namesOf = src => new Set([...src.matchAll(/\n\s{4}(?:async\s+)?(\w+)\s*\(/g)].map(m => m[1]));
  const a = namesOf(files['sqlite_storage.mjs（验 SQL）']);
  const b = namesOf(files['memory_storage.mjs（验协议）']);
  const onlyA = [...a].filter(x => used.has(x) && !b.has(x));
  const onlyB = [...b].filter(x => used.has(x) && !a.has(x));
  ok('★ 两份测试实现的公共方法集合一致', onlyA.length === 0 && onlyB.length === 0,
    'sqlite 独有=' + onlyA.join(',') + ' / memory 独有=' + onlyB.join(','));
}

console.log('== ② schema.sql 是唯一出处：room.js 的 SCHEMA 不能与它不一致 ==');
{
  const ddl = read('apps/worker/src/schema.sql');
  const room = read('apps/worker/src/room.js');
  const tablesOf = s => [...s.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]).sort();
  const idxOf = s => [...s.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]).sort();
  const t1 = tablesOf(ddl), t2 = tablesOf(room);
  ok('★ 表集合一致', JSON.stringify(t1) === JSON.stringify(t2), 'schema=' + t1.join(',') + ' room=' + t2.join(','));
  const i1 = idxOf(ddl), i2 = idxOf(room);
  ok('★ 索引集合一致', JSON.stringify(i1) === JSON.stringify(i2), 'schema=' + i1.join(',') + ' room=' + i2.join(','));
  ok('schema.sql 里写了"唯一出处"的说明（改的人会被提醒）', /唯一出处/.test(ddl));
  ok('room.js 里提示了两处必须同步', /唯一出处|不能只在其中一处改/.test(room));
  // 关键列：游标与幂等不能少
  ['seq', 'req_id', 'rule_at', 'payload', 'ts'].forEach(c => {
    ok('messages 含关键列 ' + c, new RegExp('\\b' + c + '\\b').test(ddl));
  });
}

console.log('== ③ Worker 侧不许踩的坑 ==');
{
  const srcs = ['apps/worker/src/core.js', 'apps/worker/src/room.js', 'apps/worker/src/index.js',
                'apps/worker/src/auth.js', 'apps/worker/src/export.js'];
  const dirs = {room:['document','window','localStorage'], io:['require(','__dirname','fs.readFileSync']};
  for(const f of srcs){
    const s = read(f);
    const dom = dirs.room.filter(d => new RegExp('\\b' + d + '\\b').test(s));
    ok(f + ' 无浏览器 API', dom.length === 0, dom.join(','));
    const node = dirs.io.filter(d => s.includes(d));
    ok(f + ' 无 Node 专有 API', node.length === 0, node.join(','));
  }
  // ★ 客户端时间当权威时间：core 里 now() 必须由外部注入，不能自己 Date.now() 造 ts
  ok('★ core.js 的时间由外部注入（now 可替换）', /opts\s*&&\s*opts\.now|opts\.now/.test(coreSrc));
  const applyBody = coreSrc.slice(coreSrc.indexOf('async function apply'));
  ok('★ apply() 里不直接 new Date() 造消息时间', !/new Date\(\)/.test(applyBody.slice(0, applyBody.indexOf('const msgs'))));
  // PIN 不进前端、不进日志
  const front = read('apps/web/src/main.js');
  ok('★ 前端不含 PIN_SECRET / 秘钥字面量', !/PIN_SECRET|secret/i.test(front.replace(/secret-?key/i, '')));
  ok('★ 前端不存 PIN（只存 token）', !/localStorage\.setItem\([^)]*pin/i.test(front));
}

console.log('---------------------------');
console.log('Worker 接口检查：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
