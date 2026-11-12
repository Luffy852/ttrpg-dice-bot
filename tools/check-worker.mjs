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
/* ★ S2 模块 B：先攻的 storage 调用在独立模块 initiative.js 里，必须一起进对齐闸门 ——
 * 只扫 core.js 的话新增的 combatSnapshot / combatApply 漏一份实现也全绿（线上才炸）。 */
const initSrc = read('apps/worker/src/initiative.js');
const used = new Set([
  ...coreSrc.matchAll(/\b(?:await\s+)?storage\.(\w+)\s*\(/g),
  ...initSrc.matchAll(/\b(?:await\s+)?storage\.(\w+)\s*\(/g),
].map(m => m[1]));
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

/* ★ S2 模块 B：先攻状态层的守恒（I·3.6 排序键 / 4A 接缝 / C2 清空顺序） */
console.log('== ①b 先攻状态层守恒 ==');
{
  const room = read('apps/worker/src/room.js');
  const sq = read('tests/sqlite_storage.mjs');
  const mem = read('tests/memory_storage.mjs');
  const ini = read('apps/worker/src/initiative.js');
  const ORDER = /ORDER BY value DESC, dex_mod DESC, id ASC/;
  ok('★ 先攻排序键 · SQL 两路一致', ORDER.test(room) && ORDER.test(sq),
    'room=' + ORDER.test(room) + ' sqlite=' + ORDER.test(sq));
  ok('★ 先攻排序键 · 内存路等价',
    /b\.value\s*-\s*a\.value/.test(mem) && /b\.dex_mod\s*-\s*a\.dex_mod/.test(mem) && /a\.id\s*-\s*b\.id/.test(mem));
  ok('★ 先攻逻辑层不直接写 SQL（持久化只在三份 storage）',
    !/INSERT INTO|DELETE FROM|UPDATE combat/.test(ini));
  const clearBody = (room.match(/op\.op === 'clear'[\s\S]{0,400}/) || [''])[0];
  /* ★ 带引号精确匹配：'DELETE FROM combat' 是 'DELETE FROM combat_entry' 的前缀，
   *   不带引号会把两条都命中同一位置，顺序断言永远红（假阳性）。 */
  const iEntry = clearBody.indexOf("'DELETE FROM combat_entry'");
  const iCombat = clearBody.indexOf("'DELETE FROM combat'");
  ok('★ 用户清空路径顺序先 combat_entry 后 combat（C2）',
    iEntry >= 0 && iCombat >= 0 && iEntry < iCombat, 'entry=' + iEntry + ' combat=' + iCombat);
  ok('★ 系统归零清表不经过先攻指令层（C3）',
    !/RESET_SQL|resetRoom/.test(ini));
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
  /* ★ T1：列级一致性。旧检查只比表名与索引名，实测抓不到「room.js 的 TABLES
   *   已补 notified_clean、schema.sql 还是旧定义」这类列漂移。
   *   括号内可能出现 CHECK (id = 1) 的嵌套，非贪婪正则会截断，必须逐字符扫深度。 */
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const splitTop = s => {
    let depth = 0, out = [], cur = '';
    for(const ch of s){
      if(ch === '(') depth++;
      else if(ch === ')') depth--;
      if(ch === ',' && depth === 0){ out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const colsOf = s => {
    const src = stripComments(s), map = {}, re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
    let m;
    while((m = re.exec(src))){
      let i = re.lastIndex, depth = 1, body = '';
      while(i < src.length && depth > 0){
        const ch = src[i];
        if(ch === '(') depth++;
        else if(ch === ')') depth--;
        if(depth > 0) body += ch;
        i++;
      }
      map[m[1]] = splitTop(body).map(p => (p.trim().match(/^(\w+)/) || [])[1])
        .filter(c => c && !/^(PRIMARY|CHECK|UNIQUE|CONSTRAINT|FOREIGN|KEY)$/i.test(c)).sort();
    }
    return map;
  };
  const c1 = colsOf(ddl), c2 = colsOf(room);
  Object.keys(c1).forEach(t => {
    ok('★ 列集合一致 · ' + t, JSON.stringify(c1[t]) === JSON.stringify(c2[t] || []),
      'schema=' + (c1[t] || []).join(',') + ' room=' + (c2[t] || []).join(','));
  });
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
  /* ★ T1：两个无鉴权诊断端点必须移除。一次 GET 就能枚举房间号 / 成员数 / 规则，
   *   wsdiag 还能用 PIN_SECRET 自签 5 分钟 token 替访客发起握手。
   *   用精确匹配，避免只因注释里提到路径就误判。 */
  const gateway = read('apps/worker/src/index.js');
  ok('★ /api/diag 分支已移除', !/url\.pathname\s*===\s*'\/api\/diag'/.test(gateway));
  ok('★ /api/wsdiag 分支已移除', !/url\.pathname\s*===\s*'\/api\/wsdiag'/.test(gateway));
}

console.log('== ④ .h 的 recentRolls 口径（线上事故 · 房间 593353）==');
/* 【为什么 ① 抓不到】① 只对齐「方法名集合」；三份实现当时方法名都在，
 *   却**一致地**按 `anon_id = 玩家id` 查。roll 由骰娘发出、落库时 anon_id 恒为 null，
 *   所以生产 + 两个测试替身一起错，check:all 全绿而真机 .h 恒空。
 *   这里把「按什么字段查」也钉死：必须按 actor，且 core 调用处传 nick。 */
{
  const stripCmt = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
  const impls = {
    'room.js（生产·DO）': read('apps/worker/src/room.js'),
    'sqlite_storage.mjs（验 SQL）': read('tests/sqlite_storage.mjs'),
    'memory_storage.mjs（验协议）': read('tests/memory_storage.mjs'),
  };
  for(const [name, src] of Object.entries(impls)){
    const i = src.indexOf('recentRolls(');
    const body = stripCmt(i < 0 ? '' : src.slice(i, i + 360));
    ok('★ ' + name + ' 的 recentRolls 按 actor 过滤',
      /actor\s*=\s*\?/.test(body) || /m\.actor\s*===\s*actor/.test(body), body.slice(0, 120));
    ok('★ ' + name + ' 没有残留按 anon_id 过滤', !/anon_id/.test(body), body.slice(0, 120));
  }
  ok('★ core.js 调 recentRolls 传 nick（不是 anonId）',
    /storage\.recentRolls\(nick,\s*IDLE_ROLLS\)/.test(coreSrc));
}

console.log('== ⑤ T6 · schema 单一源 + 三段式迁移模板 ==');
/* ② 只比「表名 / 索引名 / 列集合」，语句本身换列、索引挪位置它抓不到。
 *   这里把 schema.sql 当唯一源：由它生成规范化语句，room.js 的 TABLES / INDEXES
 *   必须逐条等价；再把 009950 事故换来的「表 → 补列 → 索引」锁成可执行断言。
 *   ★ 不改 ④ 节：recentRolls 的 actor 口径锁是线上事故换来的，别覆盖。 */
{
  const ddl = read('apps/worker/src/schema.sql');
  const room = read('apps/worker/src/room.js');
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const norm = t => strip(t).replace(/\s+/g, ' ').trim().replace(/;$/, '').trim()
    .replace(/\s*([(),])\s*/g, '$1');
  /* 由 schema.sql 生成期望语句（唯一源）：分号是语句边界 */
  const gen = kw => {
    const s = strip(ddl), re = new RegExp(kw + '\\s+', 'g'), out = [];
    let m;
    while((m = re.exec(s))){
      const j = s.indexOf(';', m.index);
      if(j < 0) continue;
      out.push(norm(s.slice(m.index, j)));
      re.lastIndex = j + 1;
    }
    return out;
  };
  /* 取 room.js 里的运行时语句（模板字符串，无分号） */
  const take = name => {
    const m = room.match(new RegExp('export const ' + name + ' = \\[([\\s\\S]*?)\\n\\];'));
    return m ? [...m[1].matchAll(/`([^`]*)`/g)].map(x => norm(x[1])) : [];
  };
  const key = s => (s.match(/(?:TABLE|INDEX)\s+IF NOT EXISTS\s+(\w+)/) || [])[1];
  const byKey = arr => Object.fromEntries(arr.map(s => [key(s), s]));
  const pairs = (a, b) => {
    const A = byKey(a), B = byKey(b);
    const names = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
    const bad = names.filter(n => A[n] !== B[n]);
    return {n:names.length, bad:bad.length, extra:bad.join(',')};
  };
  const t = pairs(gen('CREATE TABLE IF NOT EXISTS'), take('TABLES'));
  ok('★ 单一源 · 表语句逐条等价（' + t.n + ' 条）', t.bad === 0, '不一致：' + t.extra);
  const i = pairs(gen('CREATE INDEX IF NOT EXISTS'), take('INDEXES'));
  ok('★ 单一源 · 索引语句逐条等价（' + i.n + ' 条）', i.bad === 0, '不一致：' + i.extra);
  /* 三段式护栏（H·7.2 ④）：索引混进建表数组 = 009950 事故 */
  const tablesBlock = (room.match(/export const TABLES = \[([\s\S]*?)\n\];/) || [,''])[1];
  ok('★ 迁移三段式 · CREATE INDEX 不得出现在 TABLES 数组', !/CREATE INDEX/i.test(tablesBlock));
  ok('★ 迁移三段式 · TABLES 不含任何索引名',
    Object.keys(byKey(take('INDEXES'))).every(n => !tablesBlock.includes(n)));
  const pT = room.indexOf('TABLES.forEach'), pA = room.indexOf('ALTER TABLE members'), pI = room.indexOf('INDEXES.forEach');
  ok('★ 迁移三段式 · 构造顺序 TABLES → ALTER → INDEXES', pT >= 0 && pA > pT && pI > pA,
    'T=' + pT + ' A=' + pA + ' I=' + pI);
  const alters = [...room.matchAll(/ALTER TABLE \w+ ADD COLUMN/g)].length;
  const guarded = [...room.matchAll(/try\{\s*this\.sql\.exec\('ALTER TABLE \w+ ADD COLUMN/g)].length;
  ok('★ 迁移三段式 · 每条 ALTER 都 try/catch 幂等（' + guarded + '/' + alters + '）',
    alters > 0 && guarded === alters);
  /* A 决策口径锁：别把 v1「导出筛选要用」的旧说明改回来误导后人 */
  ok('★ A 决策 · idx_messages_sender 说明已订正',
    !/导出筛选（v2）要用/.test(ddl) && /当前\*\*没有任何产品查询\*\*按 anon_id 过滤/.test(ddl));
}

console.log('---------------------------');
console.log('Worker 接口检查：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
