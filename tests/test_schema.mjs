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
  /* ★ S2 模块 B 第一包：S1 五张表 + 先攻双表（纯新增，不动老表列） */
  ok('建出 7 张表（S1 五张 + combat / combat_entry）', tables.length === 7, tables.join(','));
  ok('表齐：room/members/messages/idempotency/pcs/combat/combat_entry',
    ['combat','combat_entry','idempotency','members','messages','pcs','room'].every(t => tables.includes(t)), tables.join(','));
  const colsOf = t => db.exec('PRAGMA table_info(' + t + ')')[0].values.map(r => r[1]);
  const cCombat = colsOf('combat'), cEntry = colsOf('combat_entry');
  ok('★ combat 列集合与 I·3.5 定稿一致（6 列）',
    ['id','room_code','round','cursor_entry_id','started_at','started_by'].every(k => cCombat.includes(k)) && cCombat.length === 6,
    cCombat.join(','));
  ok('★ combat_entry 列集合与 I·3.5 定稿一致（9 列）',
    ['id','combat_id','name','owner','card_ref','value','dex_mod','created_at','created_by'].every(k => cEntry.includes(k)) && cEntry.length === 9,
    cEntry.join(','));
  const combatSql = db.exec("SELECT sql FROM sqlite_master WHERE name='combat'")[0].values[0][0];
  const entrySql  = db.exec("SELECT sql FROM sqlite_master WHERE name='combat_entry'")[0].values[0][0];
  ok('★ combat.id 自增主键 / cursor_entry_id 指向条目 id',
    /id\s+INTEGER\s+PRIMARY\s+KEY/i.test(combatSql) && /cursor_entry_id/.test(combatSql));
  ok('★ combat_entry.id 自增主键（排序第三键唯一严格递增，批量同毫秒不飘）',
    /id\s+INTEGER\s+PRIMARY\s+KEY/i.test(entrySql));
  ok('★ 双表无越界字段（HP / 逐骰明细 / expr / 阵营 / 权限 / acted / tie_break）',
    ![...cCombat, ...cEntry].some(k => /^(hp|dice|expr|side|tie_break|acted|acted_this_round|owner_anon_id|visibility)$/i.test(k)));
  const idx = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx%'")[0].values.flat();
  /* ★ 按**名字**断言而不是数个数：数个数的断言每加一个索引就要改一次，
   *   而真正要保证的是"该有的都在"（漏一个索引只会让清理/查询变慢，不报错 —— 更难发现）。 */
  const need = ['idx_messages_ts', 'idx_messages_req', 'idx_messages_sender', 'idx_idem_ts', 'idx_messages_keep'];
  ok('建出全部索引', need.every(n => idx.includes(n)), '缺：' + need.filter(n => !idx.includes(n)).join(','));
  ok('★ idx_messages_sender 现在就建（v2 导出筛选不迁移）', idx.includes('idx_messages_sender'));
  /* ★ 续期要按 keep_until 查，没索引的话清理每次全表扫 —— 房间大起来会拖慢 alarm */
  ok('★ idx_messages_keep 已建（清理的双条件要用）', idx.includes('idx_messages_keep'));
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

/* ==========================================================================
 * 4. C4 / C5 真跑：逐条清理与导入重排都不碰先攻表（附录 I·3.8.2）
 * ★ 用 room.js 里的真实 DELETE 语句与 core.js 的生产 planImport，不抄测试替身（#18）。
 * ★ 边界：当前无还原 / 重置路径，「归零时两表一并清空」由模块 B 独立步骤实现，
 *   本组不假装验过它；这里验的是「战斗进行中，清理 / 导入不掉表」。
 * ========================================================================== */
console.log('== 4. C4 / C5 真跑：逐条清理与导入重排都不碰先攻表 ==');
{
  const db3 = new SQL.Database();
  ddl.split(';').map(s => s.trim()).filter(s => s && !/^PRAGMA/i.test(s)).forEach(s => db3.run(s));
  const count3 = t => db3.exec('SELECT COUNT(*) AS c FROM ' + t)[0].values[0][0];
  const now = 1772000000000, DAY = 86400000;
  /* 造一场「战斗进行中」 */
  db3.run(`INSERT INTO combat (id, room_code, round, cursor_entry_id, started_at, started_by)
           VALUES (1, '123456', 1, 2, ${now}, '老王')`);
  db3.run(`INSERT INTO combat_entry (id, combat_id, name, owner, card_ref, value, dex_mod, created_at, created_by)
           VALUES (1, 1, '老王', '老王', NULL, 17, 3, ${now}, '老王')`);
  db3.run(`INSERT INTO combat_entry (id, combat_id, name, owner, card_ref, value, dex_mod, created_at, created_by)
           VALUES (2, 1, '哥布林1', '老王', NULL, 14, 0, ${now}, '老王')`);
  /* 造「部分过期」的消息：一条 31 天前、一条今天 */
  db3.run(`INSERT INTO messages (seq, id, ts, kind, from_name, payload)
           VALUES (1, '123456:1', ?, 'cmd', '老王', '{"text":".ri"}')`, [now - 31 * DAY]);
  db3.run(`INSERT INTO messages (seq, id, ts, kind, from_name, payload)
           VALUES (2, '123456:2', ?, 'cmd', '老王', '{"text":".init"}')`, [now]);
  db3.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r1', 1, ?)`, [now - 31 * DAY]);
  db3.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r2', 2, ?)`, [now]);

  /* ★ C4：从 room.js 源码里取真实清理语句（测试与生产同源，避免抄一份漂移） */
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  const delMsgs = (roomSrc.match(/'(DELETE FROM messages WHERE ts < \?[^']*)'/) || [])[1];
  const delIdem = (roomSrc.match(/'(DELETE FROM idempotency WHERE ts < \?)'/) || [])[1];
  ok('★ C4 取到 room.js 的真实清理语句（不是测试替身）', !!delMsgs && !!delIdem);
  if(delMsgs && delIdem){
    db3.run(delMsgs, [now - 30 * DAY, now]);
    db3.run(delIdem, [now - 30 * DAY]);
  }
  eq('★ C4 战斗中滚动 DELETE 后先攻条目数不变', count3('combat_entry'), 2);
  eq('★ C4 战斗中滚动 DELETE 后战斗行不变', count3('combat'), 1);
  eq('★ C4 过期消息确实被删（断言不是摆设）', count3('messages'), 1);
  eq('★ C4 过期幂等键确实被删', count3('idempotency'), 1);

  /* ★ C5：生产 planImport 产出重排计划，再在真库上按同形态落库 */
  const {planImport} = await import('../apps/worker/src/core.js');
  const {createMemoryStorage} = await import('./memory_storage.mjs');
  const mem = createMemoryStorage('123456');
  await mem.setRoom({seq:2});
  await mem.insertMsgs([{seq:2, id:'123456:2', ts:now, kind:'cmd', from:'老王', payload:{text:'.init'}}]);
  const incoming = [{seq:1, id:'999999:1', ts:now - 1000, kind:'cmd', from:'别人', payload:{text:'.ri'}}];
  const plan = await planImport(mem, incoming, now);
  ok('★ C5 planImport 产出只含 messages 重排字段，不含 combat 写操作',
    Object.keys(plan).every(k => ['add','reseq','seqEnd','idem','skipped','errs'].includes(k)) &&
    !JSON.stringify(plan).includes('combat'), Object.keys(plan).join(','));
  (plan.reseq || []).forEach(([id, seq]) => db3.run('UPDATE messages SET seq = ? WHERE id = ?', [seq, id]));
  (plan.add || []).forEach(m => db3.run(
    'INSERT INTO messages (seq, id, ts, kind, from_name, payload) VALUES (?, ?, ?, ?, ?, ?)',
    [m.seq, m.id, m.ts, m.kind, m.from, JSON.stringify(m.payload)]));
  eq('★ C5 导入落库后先攻条目数不变', count3('combat_entry'), 2);
  eq('★ C5 导入落库后战斗行不变', count3('combat'), 1);
  eq('★ C5 导入确实新增一条消息（断言不是摆设）', count3('messages'), 2);
}

console.log('---------------------------');
console.log('schema 与 storage：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('⚠️  未验（只能你部署后验）：DO 的 ctx.storage.sql 同步语义 / 休眠与 alarm 触发 / 真实并发');
process.exit(fail ? 1 : 0);
