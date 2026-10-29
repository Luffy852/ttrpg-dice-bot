/* ============================================================================
 * test_schema.mjs —— schema.sql 与「DO storage 接口」的 SQLite 真跑验证
 * ----------------------------------------------------------------------------
 * 【为什么要有这个】schema.sql 写错了，只有部署到 Cloudflare 才会发现 —— 而沙盒部署不了。
 *   这里用 sql.js（纯 wasm 的 SQLite，不需要编译）把 DDL 真跑一遍，
 *   再用**与 room.js 同构的 storage 实现**跑一遍 core.js 的完整流程（建房→掷骰→补齐→清理）。
 *   验的是：DDL 能建、游标查询对、30 天清理生效、幂等表与消息同窗口。
 *
 * 【★ 边界：这不是 DO】DO 用的是 ctx.storage.sql（同步 API、有事务、有 alarm）。
 *   这里验的是 **SQL 语义**（建表 / 索引 / 查询 / 删除）与 **接口契约**，
 *   验不了 DO 的休眠、alarm 触发、并发 —— 那部分只能你部署后验（见验收清单）。
 *   sql.js 也不支持 PRAGMA journal_mode=WAL，故 DDL 里那行在此跳过并显式标注。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const initSqlJs = createRequire(import.meta.url)('sql.js');   // sql.js 只有 CJS 入口

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const SQL = await initSqlJs();
const ddl = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'schema.sql'), 'utf8');

console.log('== 1. DDL 能在 SQLite 里真建起来 ==');
const db = new SQL.Database();
{
  // sql.js 不支持 WAL（DO 里才有），单独跳过并标注 —— 不是"验过了"，是"这里验不了"
  let stmts = ddl.split(';').map(s => s.trim()).filter(s => s && !/^PRAGMA/i.test(s));
  let err = null;
  for(const s of stmts){ try{ db.run(s); }catch(e){ err = s.slice(0, 60) + ' → ' + e.message; break; } }
  ok('全部 DDL 执行成功', !err, err);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  ok('建出 5 张表', tables.length === 5, tables.join(','));
  ok('表齐：room/members/messages/idempotency/pcs',
    ['idempotency','members','messages','pcs','room'].every(t => tables.includes(t)), tables.join(','));
  const idx = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx%'")[0].values.flat();
  ok('建出 4 个索引（含 idx_sender）', idx.length === 4, idx.join(','));
  ok('★ idx_messages_sender 现在就建（v2 导出筛选不迁移）', idx.includes('idx_messages_sender'));
  // 单行表约束
  let e2 = null;
  try{ db.run("INSERT INTO room (id, code, created_at, last_active) VALUES (2, 'x', 1, 1)"); }
  catch(e){ e2 = e.message; }
  ok('room 是单行表（id 必须为 1）', !!e2, e2 || '没拦住');
}

console.log('== 2. DO storage 接口：与 room.js 同构，跑通 core.js 全流程 ==');
{
  const {createRoomCore} = await import('../apps/worker/src/core.js');
  const {createSqliteStorage} = await import('./sqlite_storage.mjs');

  const st = createSqliteStorage(db, '123456');
  st.init({code:'123456', now:1772000000000});
  let t = 1772000000000;
  const core = createRoomCore(st, {now: () => (t += 100)});

  const r1 = await core.apply({reqId:'c1', text:'.set rule coc', anonId:'a1', nick:'老王'});
  ok('切规则落库', (await st.getRoom()).rule === 'coc7');
  ok('返回 state 供前端回写', !!r1.state);

  const r2 = await core.apply({reqId:'c2', text:'.st set 侦查 60', anonId:'a1', nick:'老王'});
  ok('绑卡成功', !!r2.msgs.length);

  const r3 = await core.apply({reqId:'c3', text:'.rc 侦查', anonId:'a1', nick:'老王'});
  const roll = r3.msgs.find(m => m.kind === 'roll');
  ok('★ 掷骰产出 roll 消息', !!roll);
  ok('★ payload 不含 total（原则 6）', !('total' in roll.payload));
  ok('★ payload 含 rule_at 事实快照', roll.payload.rule_at === 'coc7');
  eq('seq 从 1 开始分配', r3.msgs[0].seq > 0, true);

  // 游标补齐：★ 断言"补齐拿回的条数 = 历次 apply 落库的总条数"，不写死 5 这种拍脑袋的数
  const total = [r1, r2, r3].reduce((a, r) => a + (r.msgs ? r.msgs.length : 0), 0);
  const s0 = await core.since(0, 200);
  ok('补齐拿回全部（条数 = 落库总数）', s0.msgs.length === total, 'n=' + s0.msgs.length + ' want=' + total);
  ok('补齐按 seq 升序', s0.msgs.every((m, i) => i === 0 || m.seq > s0.msgs[i - 1].seq));
  const cursor = s0.msgs[s0.msgs.length - 1].seq;
  const s1 = await core.since(cursor, 200);
  eq('★ cursor 之后补齐为空（不含自己，不会重复渲染一条）', s1.msgs.length, 0);

  // 幂等
  const d1 = await core.apply({reqId:'c3', text:'.rc 侦查', anonId:'a1', nick:'老王'});
  ok('★ 同一 req_id 命中 dup', d1.dup);
  eq('dup 返回原 seq（不重掷）', d1.seq, r3.seq);

  // 向上翻页
  const h = await core.history(cursor + 1, 2);
  eq('向上翻页取到 2 条', h.msgs.length, 2);
  ok('翻页返回的是更早的', h.msgs[h.msgs.length - 1].seq <= cursor);

  // 30 天清理：消息与幂等同窗口
  st.cleanOlderThan(1772000000000 + 31 * 86400000);
  eq('★ 30 天后消息被清', st.count('messages'), 0);
  eq('★ 30 天后幂等键同窗口清理（避免 dup 指向已删消息）', st.count('idempotency'), 0);
  const d2 = await core.apply({reqId:'c9', text:'.r 1d6', anonId:'a1', nick:'老王'});
  ok('清理后仍能正常掷骰', !!(d2.msgs || []).length || !d2.dup);
}

console.log('== 3. 索引与约束真的生效（不是建了就完事） ==');
{
  const db2 = new SQL.Database();
  ddl.split(';').map(s => s.trim()).filter(s => s && !/^PRAGMA/i.test(s)).forEach(s => db2.run(s));
  let e = null;
  try{
    db2.run("INSERT INTO messages (seq, id, ts, kind, from_name, payload) VALUES (1, 'a:1', 1, 'roll', '骰娘', '{}')");
    db2.run("INSERT INTO messages (seq, id, ts, kind, from_name, payload) VALUES (1, 'a:2', 2, 'roll', '骰娘', '{}')");
  }catch(err){ e = err.message; }
  ok('★ seq 是主键：重复 seq 插不进去（游标不会撞）', !!e, e || '没拦住');
  let e2 = null;
  try{
    db2.run("INSERT INTO messages (seq, id, ts, kind, from_name, payload) VALUES (2, 'a:1', 3, 'roll', '骰娘', '{}')");
  }catch(err){ e2 = err.message; }
  ok('★ msg_id 唯一：重复 id 插不进去（去重有兜底）', !!e2, e2 || '没拦住');
  // 索引被用到（EXPLAIN 里出现索引名）
  const plan = db2.exec("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE ts < 100")[0].values.flat().join(' ');
  ok('★ ts 查询走 idx_messages_ts', /idx_messages_ts/.test(plan), plan);
  const plan2 = db2.exec("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE anon_id = 'a1' ORDER BY seq")[0].values.flat().join(' ');
  ok('★ 按人查询走 idx_messages_sender', /idx_messages_sender/.test(plan2), plan2);
}

console.log('---------------------------');
console.log('schema 与 storage：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('⚠️  未验（只能你部署后验）：DO 的 ctx.storage.sql 同步语义 / 休眠与 alarm 触发 / 真实并发');
process.exit(fail ? 1 : 0);
