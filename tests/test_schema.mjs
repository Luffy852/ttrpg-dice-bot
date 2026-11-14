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
/* ★ S2 第二步：生命周期决策与 SQL 的单一源。下面第 4 / 5 节真跑的就是生产那一份
   （runLifecycle 是 room.js alarm() 的唯一决策入口），不在测试里另抄一份顺序。 */
import {runLifecycle, RESET_SQL, SQL_SWEEP_MSGS, SQL_SWEEP_IDEM, SQL_COUNT_CONTENT,
  SQL_MAX_EXPIRY, SQL_MIN_EXPIRY, SQL_HAS_CONTENT, LIFECYCLE_MS,
  shouldWarn, shouldReset, nextAlarmAt,
  expiryOf, idemExpiryOf, KEEP_MS, WARN_MS, SWEEP_MS, resetFrames, warnFrame} from '../apps/worker/src/lifecycle.js';
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
  /* ★ P2：「本房间已于 X 重置」读的是房间字段，不是聊天消息（G·8.4 ②）。 */
  ok('★ room 含 last_reset_at 列（P2 重置后状态呈现的唯一出处）',
    db.exec('PRAGMA table_info(room)')[0].values.map(r => r[1]).includes('last_reset_at'));
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
 * ★ 本组只验「战斗进行中，清理 / 导入不掉表」；「归零时两表一并清空」由第 5 节
 *   runLifecycle 真跑覆盖（模块 B 第二步已实现还原路径）。
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

  /* ★ C4：滚动 DELETE 的单一源是 lifecycle.js 的两个生产常量（第二步起不再从 room.js 正则抠）。 */
  ok('★ C4 取到生命周期单一源的滚动清理语句（不是测试替身）',
    /^DELETE FROM messages\b/.test(SQL_SWEEP_MSGS) && /^DELETE FROM idempotency\b/.test(SQL_SWEEP_IDEM));
  db3.run(SQL_SWEEP_MSGS, [now - 30 * DAY, now]);
  db3.run(SQL_SWEEP_IDEM, [now - 30 * DAY]);
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

/* ==========================================================================
 * 5. 还原路径真跑（模块 B 第二步）
 * ★ 跑的是 room.js alarm() 的**同一个 runLifecycle()** 与同一组 RESET_SQL / SWEEP 常量，
 *   唯一替身是 IO（广播 / 巡检 / 排闹钟），不在测试里抄一遍决策顺序（坑 #18）。
 * ★ 覆盖：009950 旧库迁移、C1（有先攻表但消息全过期 → 正常归零）、C4（战斗中不掉表）、
 *   C2 / C3（成对清两表 / 静默）、B1–B3 墓碑与还原规格、提醒不落库、锚点只由用户动作刷新。
 * ========================================================================== */
console.log('== 5. 还原路径真跑（runLifecycle 单一源 · 旧库迁移 / C1–C4 / B1–B3）==');
{
  const DAY = 86400000, now = 1772000000000;
  const splitDdl = s => s.split(';').map(x => x.trim()).filter(x => x && !/^PRAGMA/i.test(x));
  /* sql.js → runLifecycle 的 {q, run}：q 返回行对象数组（与 workerd 的 toArray() 同形状） */
  const driver = db => ({
    q: (s, ...p) => {
      const r = db.exec(s, p.length ? p : undefined);
      if(!r.length) return [];
      return r[0].values.map(row => Object.fromEntries(r[0].columns.map((c, i) => [c, row[i]])));
    },
    run: (s, ...p) => { db.run(s, p.length ? p : undefined); },
  });
  const one = (db, s) => {
    const r = db.exec(s);
    return r.length ? Object.fromEntries(r[0].columns.map((c, i) => [c, r[0].values[0][i]])) : {};
  };
  const cnt = (db, t) => db.exec('SELECT COUNT(*) AS c FROM ' + t)[0].values[0][0];
  /* IO 替身：reset() 执行**生产的 RESET_SQL** 并发生**产的 resetFrames**，不另写一份 */
  const ioStub = (db, frames) => ({
    broadcast: f => frames.push(f),
    reset: () => {
      RESET_SQL.forEach(s => db.run(s));
      /* ★ P2 真跑：归零必须把 last_reset_at 写成非空（不是只写 reset_at=NULL）。 */
      const lr = db.exec('SELECT last_reset_at FROM room WHERE id = 1')[0].values[0][0];
      ok('★ P2 归零写入 last_reset_at（真库，非空）', lr != null && Number(lr) > 0, 'got=' + lr);
      resetFrames({code:'123456', online:0, lastResetAt:lr}).forEach(f => frames.push(f));
      return true;
    },
    sweepIdle: () => {},
    onlineCount: () => 0,
    rearm: at => { frames.push({__arm:at}); },
  });

  /* ---------- 5.1 旧库（只有 5 张表、room 无两条锚点列）→ 新代码唤醒 ---------- */
  {
    const old = new SQL.Database();
    const oldDdl = ddl
      .replace(/\s*reset_at\s+INTEGER,[^\n]*/, '')
      .replace(/\s*warned_for_reset_at\s+INTEGER,[^\n]*/, '')
      .replace(/\s*last_reset_at\s+INTEGER,[^\n]*/, '')
      .replace(/-- S2 模块 B[\s\S]*?(?=-- 说明：无 visibility)/, '');
    splitDdl(oldDdl).forEach(s => old.run(s));
    old.run(`INSERT INTO room (id, code, created_at, last_active, rule, baredice, rule_set_by, rule_set_at,
      pin_hmac, pin_salt, seq, notified_clean, ver) VALUES (1,'123456',?,?,'coc7',1,'老王',?,'HMAC','SALT',7,1,1)`,
      [now - 40 * DAY, now, now - 10 * DAY]);
    old.run(`INSERT INTO members (anon_id, cid, nick, joined_at, last_seen, msg_count)
      VALUES ('a1','cid-a-abcdef','老王',1,1,3)`);
    old.run(`INSERT INTO messages (seq,id,ts,kind,from_name,payload)
      VALUES (7,'123456:7',?,'chat','老王','{"text":"老消息"}')`, [now]);
    old.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('old-req',7,?)`, [now]);
    old.run(`INSERT INTO pcs (anon_id, family, version, data, updated_at) VALUES ('a1','coc7',1,'{}',?)`, [now]);
    /* 现行构造函数三段式：TABLES → ALTER 补列 → INDEXES */
    const stmts = splitDdl(ddl);
    stmts.filter(s => /CREATE TABLE IF NOT EXISTS/i.test(s)).forEach(s => old.run(s));
    try{ old.run('ALTER TABLE room ADD COLUMN reset_at INTEGER'); }catch(e){ /* 列已存在 */ }
    try{ old.run('ALTER TABLE room ADD COLUMN warned_for_reset_at INTEGER'); }catch(e){ /* 列已存在 */ }
    stmts.filter(s => /CREATE INDEX IF NOT EXISTS/i.test(s)).forEach(s => { try{ old.run(s); }catch(e){} });

    const cols = old.exec('PRAGMA table_info(room)')[0].values.map(r => r[1]);
    ok('★ 5.1 旧库唤醒后长出两张空表 + 两条锚点列（009950 三段式）',
      cnt(old, 'combat') === 0 && cnt(old, 'combat_entry') === 0 &&
      cols.includes('reset_at') && cols.includes('warned_for_reset_at'));
    const r0 = one(old, 'SELECT * FROM room WHERE id = 1');
    ok('★ 5.1 老数据完好（昵称 / 老消息 / PIN / seq / created_at 墓碑）',
      one(old, "SELECT nick FROM members WHERE anon_id = 'a1'").nick === '老王' &&
      /老消息/.test(String(one(old, 'SELECT payload FROM messages WHERE seq = 7').payload)) &&
      r0.pin_hmac === 'HMAC' && r0.seq === 7 && r0.created_at === now - 40 * DAY);
    ok('★ 5.1 旧库锚点列补成 NULL（空房间，不凭空续命）',
      r0.reset_at == null && r0.warned_for_reset_at == null);
    const f1 = [];
    const r1 = await runLifecycle(driver(old), ioStub(old, f1), now);
    ok('★ 5.1 旧 schema 房间跑一次 alarm 不中断（输入项 A T1 验收项）',
      r1 && r1.reset === false && r1.armAt != null);
  }

  /* ---------- 5.2 提醒 / C4 战斗中不掉表 / 归零还原（C1–C3 / B1–B3） ---------- */
  {
    const d = new SQL.Database();
    splitDdl(ddl).forEach(s => d.run(s));
    d.run(`INSERT INTO room (id, code, created_at, last_active, rule, baredice, rule_set_by, rule_set_at,
      pin_hmac, pin_salt, seq, notified_clean, reset_at, warned_for_reset_at, ver)
      VALUES (1,'123456',?,?,'coc7',1,'老王',?,'HMAC','SALT',42,1,?,NULL,1)`,
      [now - 40 * DAY, now, now - 10 * DAY, now + 3 * DAY]);
    d.run(`INSERT INTO members (anon_id, cid, nick, joined_at, last_seen, msg_count)
      VALUES ('a1','cid-a-abcdef','老王',1,1,3),('a2','cid-b-abcdef','小李',1,1,0)`);
    d.run(`INSERT INTO pcs (anon_id, family, version, data, updated_at) VALUES ('a1','coc7',1,'{}',?)`, [now]);
    d.run(`INSERT INTO combat (id, room_code, round, cursor_entry_id, started_at, started_by)
      VALUES (1,'123456',1,2,?,'老王')`, [now]);
    d.run(`INSERT INTO combat_entry (id, combat_id, name, value, dex_mod, created_at, created_by)
      VALUES (1,1,'老王',17,3,?,'老王'),(2,1,'哥布林1',14,0,?,'老王')`, [now, now]);
    d.run(`INSERT INTO messages (seq,id,ts,kind,from_name,payload) VALUES
      (40,'123456:40',?,'chat','老王','{"text":"过期"}'),
      (41,'123456:41',?,'cmd','老王','{"text":".ri"}')`, [now - 31 * DAY, now]);
    d.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r-old',40,?),('r-new',41,?)`,
      [now - 31 * DAY, now]);

    /* 第一次 alarm：提前 7 天提醒（瞬时帧）+ 滚动 DELETE（C4：战斗进行中不掉表） */
    const f2 = [];
    const r2 = await runLifecycle(driver(d), ioStub(d, f2), now);
    ok('★ 5.2 提醒按 reset_at − 7d 触发、每轮只发一次（坑 3）',
      r2.warned === true && r2.reset === false &&
      f2.filter(f => f && f.t === 'state' && f.room && f.room.warn === true).length === 1);
    ok('★ 5.2 提醒是瞬时帧：不落消息、不占 seq、无 BATCH 带 msgs（口径 6 / 坑 2）',
      !f2.some(f => f && (f.t === 'batch' || f.msgs)) &&
      cnt(d, 'messages') === 1 && one(d, 'SELECT seq FROM room WHERE id = 1').seq === 42);
    eq('★ 5.2 C4 战斗中滚动 DELETE 后先攻条目数不变', cnt(d, 'combat_entry'), 2);
    eq('★ 5.2 C4 战斗中滚动 DELETE 后战斗行不变', cnt(d, 'combat'), 1);
    eq('★ 5.2 过期消息确实被删（断言不是摆设）', cnt(d, 'messages'), 1);
    eq('★ 5.2 过期幂等键确实被删', cnt(d, 'idempotency'), 1);
    const rw = one(d, 'SELECT reset_at, warned_for_reset_at FROM room WHERE id = 1');
    ok('★ 5.2 alarm 绝不写 reset_at（只由用户动作刷新，G·8.3 / 坑 5）',
      rw.reset_at === now + 3 * DAY && rw.warned_for_reset_at === now + 3 * DAY);

    /* 第二次 alarm：把剩余两条也改成过期 → 「由非空变空」→ 同一次 alarm 静默归零 */
    d.run('UPDATE messages SET ts = ?, keep_until = NULL', [now - 31 * DAY]);
    d.run('UPDATE idempotency SET ts = ?', [now - 31 * DAY]);
    const f3 = [];
    const r3 = await runLifecycle(driver(d), ioStub(d, f3), now);
    ok('★ 5.2 C1 有先攻表但计时主体全过期 → 正常归零（辅助表行数不进判据）',
      r3.reset === true && r3.armAt === null);
    eq('★ 5.2 C2 归零后 combat_entry 为 0', cnt(d, 'combat_entry'), 0);
    eq('★ 5.2 C2 归零后 combat 为 0', cnt(d, 'combat'), 0);
    eq('★ 5.2 计时主体清空（messages / idempotency 均为 0）', cnt(d, 'messages') + cnt(d, 'idempotency'), 0);
    eq('★ 5.2 B3 清 members / pcs（累计人次归零，不加 total_joins 列）', cnt(d, 'members') + cnt(d, 'pcs'), 0);
    const rr = one(d, 'SELECT * FROM room WHERE id = 1');
    ok('★ 5.2 B2 写回默认 + 锚点置空（零消息、零续活）',
      rr.rule === 'generic' && rr.baredice === 0 && rr.rule_set_by == null &&
      rr.rule_set_at == null && rr.notified_clean === 0 &&
      rr.reset_at == null && rr.warned_for_reset_at == null);
    ok('★ 5.2 B1 墓碑不动（room 行 / code / created_at / seq / PIN）',
      rr.code === '123456' && rr.created_at === now - 40 * DAY && rr.seq === 42 &&
      rr.pin_hmac === 'HMAC' && rr.pin_salt === 'SALT');
    ok('★ 5.2 C3 重置静默：只有 3 个瞬时帧，零消息 / 零 seq / 零落库广播 / 不排闹钟',
      f3.length === 3 && f3.every(f => ['reload','state','presence'].includes(f.t)) &&
      !f3.some(f => f && (f.t === 'batch' || f.msgs || f.__arm)) &&
      one(d, 'SELECT seq FROM room WHERE id = 1').seq === 42);
    ok('★ 5.2 同轮不重复提醒（warned_for_reset_at 已对应本轮 reset_at）', r3.warned === false);
  }

  /* ---------- 5.3 纯决策与锚点 SQL（每条都能单独先红后绿） ---------- */
  {
    eq('★ 5.3 expiryOf：无续期 = ts + 30d', expiryOf(now, null), now + KEEP_MS);
    eq('★ 5.3 expiryOf：有续期 = keep_until', expiryOf(now, now + 5 * DAY), now + 5 * DAY);
    eq('★ 5.3 idemExpiryOf：幂等键恒为 ts + 30d', idemExpiryOf(now), now + KEEP_MS);
    ok('★ 5.3 shouldWarn：窗口内触发 / 已警告不重发 / 锚点后推可再触发',
      shouldWarn({now, resetAt:now + 3 * DAY, warnedForResetAt:null}) &&
      !shouldWarn({now, resetAt:now + 3 * DAY, warnedForResetAt:now + 3 * DAY}) &&
      shouldWarn({now, resetAt:now + 3 * DAY, warnedForResetAt:now + DAY}));
    ok('★ 5.3 shouldWarn：锚点为空 / 已过 / 未进 7 天窗口都不提醒',
      !shouldWarn({now, resetAt:null, warnedForResetAt:null}) &&
      !shouldWarn({now, resetAt:now - DAY, warnedForResetAt:null}) &&
      !shouldWarn({now, resetAt:now + 10 * DAY, warnedForResetAt:null}));
    ok('★ 5.3 shouldReset：只认「由非空变空」，空房间不重复还原',
      shouldReset({hadContent:true, remaining:0}) &&
      !shouldReset({hadContent:true, remaining:1}) &&
      !shouldReset({hadContent:false, remaining:0}));
    /* ★ D1（2026-11-14 用量根治）：在线不再触发 60s 巡检闹钟；生命周期按日排。
     *  四条断言不删、只换守的东西（旧「有人巡 1 分钟」已作废）。 */
    ok('★ 5.3 nextAlarmAt（D1）：空容器不排 / 在线也不排短周期 / 有内容按日',
      nextAlarmAt({now, online:0, nextExpiry:null, resetAt:null, hasContent:false}) === null &&
      nextAlarmAt({now, online:3, nextExpiry:null, resetAt:null, hasContent:false}) === null &&
      nextAlarmAt({now, online:3, nextExpiry:now + 2 * DAY, resetAt:now + 3 * DAY, hasContent:true}) === now + LIFECYCLE_MS);
    eq('★ 5.3 nextAlarmAt（D1）：无在线但有内容 → 同样按日（不再精确排下一条到期）',
      nextAlarmAt({now, online:0, nextExpiry:now + 2 * DAY, resetAt:null, hasContent:true}), now + LIFECYCLE_MS);
    eq('★ 5.3 nextAlarmAt（D1）：无内容但 reset_at 未到 → 只排 reset_at 那一跳',
      nextAlarmAt({now, online:0, nextExpiry:null, resetAt:now + 3 * DAY, hasContent:false}), now + 3 * DAY);
    /* reset_at / 下一条到期 SQL 真跑：idempotency 也是计时主体 */
    const d2 = new SQL.Database();
    splitDdl(ddl).forEach(s => d2.run(s));
    d2.run(`INSERT INTO messages (seq,id,ts,kind,from_name,keep_until,payload) VALUES
      (1,'123456:1',?,'chat','老王',?,'{}'),(2,'123456:2',?,'cmd','老王',NULL,'{}')`,
      [now, now + 10 * DAY, now - 20 * DAY]);
    d2.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r',1,?)`, [now + 5 * DAY]);
    d2.run(`INSERT INTO combat (id, room_code, round, started_at) VALUES (1,'123456',1,?)`, [now]);
    d2.run(`INSERT INTO combat_entry (id, combat_id, name, value, created_at) VALUES (1,1,'老王',17,?)`, [now]);
    eq('★ 5.3 SQL_MAX_EXPIRY 取计时主体最大到期（含 idempotency 的 ts+30d）',
      driver(d2).q(SQL_MAX_EXPIRY)[0].e, now + 35 * DAY);
    eq('★ 5.3 SQL_MIN_EXPIRY 取下一条到期', driver(d2).q(SQL_MIN_EXPIRY)[0].e, now + 10 * DAY);
    eq('★ 5.3 C1 SQL_COUNT_CONTENT 不读辅助表（塞了先攻两表结果仍是 3）',
      driver(d2).q(SQL_COUNT_CONTENT)[0].c, 3);
    eq('★ 5.3 D1 SQL_HAS_CONTENT：O(1) 存在性判据（有内容 = 1，不读辅助表）',
      driver(d2).q(SQL_HAS_CONTENT)[0].c, 1);
    const d3 = new SQL.Database();
    splitDdl(ddl).forEach(s => d3.run(s));
    eq('★ 5.3 D1 SQL_HAS_CONTENT：空库 = 0（用户动作路径不再 COUNT(*) 全表）',
      driver(d3).q(SQL_HAS_CONTENT)[0].c, 0);
  }
}

console.log('---------------------------');
console.log('schema 与 storage：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('⚠️  未验（只能你部署后验）：DO 的 ctx.storage.sql 同步语义 / 休眠与 alarm 触发 / 真实并发');
process.exit(fail ? 1 : 0);
