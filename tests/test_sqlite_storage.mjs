/* ============================================================================
 * test_sqlite_storage.mjs —— sqlite_storage 的「读方法返回值」真跑验证（P1）
 * ----------------------------------------------------------------------------
 * 【为什么单独一个文件】既有 test_schema.mjs 跑的是 core.apply 主流程，
 *   hasIds / brief / reflow / recent 这四条只在「导入战报重排」路径被用到，
 *   主流程碰不到 → run() 无返回值这个缺陷一直全绿（坑 #31：看起来对的数字
 *   要追到真实写入；坑 #42：三份实现方法名都在、却一致地按错口径跑）。
 * 【不抄生产逻辑】断言的基准一律是**直接用 sql.js 从库里查出来的真值**，
 *   而不是把 sqlite_storage 的实现在测试里重写一遍。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createSqliteStorage} from './sqlite_storage.mjs';
const initSqlJs = createRequire(import.meta.url)('sql.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = await initSqlJs();

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const db = new SQL.Database();
const ddl = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'schema.sql'), 'utf8');
for(const s of ddl.split(';').map(x => x.trim()).filter(x => x && !/^PRAGMA/i.test(x))) db.run(s);

const direct = sql => {
  const r = db.exec(sql);
  return r.length ? r[0].values.map(row => Object.fromEntries(row.map((v, i) => [r[0].columns[i], v]))) : [];
};
const st = createSqliteStorage(db, '123456');
const T0 = 1772000000000;
st.init({code:'123456', now:T0});

/* 造 3 条真实消息（直接写库，不经过被测实现） */
const mk = (seq, id, ts, from) =>
  `INSERT INTO messages (seq, id, ts, kind, from_name, payload) VALUES (${seq}, '${id}', ${ts}, 'chat', '${from}', '{"text":"t${seq}"}')`;
db.run(mk(1, '123456:1', T0 + 1000, '老王'));
db.run(mk(2, '123456:2', T0 + 2000, '小李'));
db.run(mk(3, '123456:3', T0 + 3000, '老王'));
db.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r1', 1, ${T0 + 1000})`);
db.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r2', 3, ${T0 + 3000})`);

console.log('== P1 · run() 读语句必须返回行（真库基准） ==');
{
  const truth = direct('SELECT id, seq, ts FROM messages ORDER BY seq');
  const got = await st.brief();
  eq('brief() 返回 3 行且与库内真值逐字段一致', got, truth);
  ok('brief() 是数组（不是 undefined）', Array.isArray(got));

  const ids = await st.hasIds(['123456:1', '123456:3', 'nope']);
  ok('hasIds() 返回 Set', ids instanceof Set);
  eq('hasIds() 只含库里真有的 id', [...ids].sort(), ['123456:1', '123456:3']);

  const recentTruth = direct('SELECT * FROM messages ORDER BY seq DESC LIMIT 2')
    .reverse().map(r => ({seq:r.seq, id:r.id, from:r.from_name, payload:JSON.parse(r.payload)}));
  const rec = await st.recent(2);
  eq('recent(2) 条数 = 2', rec.length, 2);
  eq('recent(2) 升序（reverse 后）', rec.map(m => m.seq), [2, 3]);
  eq('recent(2) 与库内真值一致（from / payload 解析）',
    rec.map(m => ({seq:m.seq, id:m.id, from:m.from, payload:m.payload})), recentTruth);
}

console.log('== P1 · reflow() 的重排 / 新增 / 幂等重映射 ==');
{
  const plan = {
    reseq: [['123456:1', 10], ['123456:3', 30]],
    add: [{seq:20, id:'imp:20', ts:T0 + 2500, kind:'chat', from:'导入',
      actor:null, anon_id:null, req_id:null, rule_at:null, keep_until:null, payload:{text:'来自战报'}}],
    seqEnd: 30,
    idem: [[1, 10], [3, 30]],
  };
  await st.reflow(plan);
  const rows = direct('SELECT id, seq FROM messages ORDER BY seq');
  eq('reflow 后库内 3 条重排 + 1 条新增', rows, [
    {id:'123456:1', seq:10}, {id:'imp:20', seq:20}, {id:'123456:2', seq:2}, {id:'123456:3', seq:30},
  ].sort((a, b) => a.seq - b.seq));
  eq('reflow 写回 room.seq', direct('SELECT seq FROM room WHERE id = 1')[0].seq, 30);
  eq('reflow 重映射 idempotency（保留映射内的）',
    direct('SELECT req_id, seq FROM idempotency ORDER BY req_id'),
    [{req_id:'r1', seq:10}, {req_id:'r2', seq:30}]);
  /* 再跑一次：映射外的幂等记录应被清掉，而不是静默留着指向旧 seq */
  await st.reflow({reseq:[], add:[], seqEnd:30, idem:[[10, 11]]});
  eq('reflow 删掉映射外的幂等记录',
    direct('SELECT req_id, seq FROM idempotency'), [{req_id:'r1', seq:11}]);
}

console.log('== P1 · run() 写语句仍然生效（不是只修了读） ==');
{
  const before = await st.countMsgs();
  await st.insertMsgs([{seq:31, id:'123456:31', ts:T0 + 4000, kind:'chat', from:'老王',
    actor:null, anon_id:null, req_id:null, rule_at:null, payload:{text:'新的一条'}}]);
  eq('insertMsgs 后 countMsgs +1', await st.countMsgs(), before + 1);
  eq('since(30) 拿到刚写那条', (await st.since(30, 10)).map(m => m.id), ['123456:31']);
}

console.log(`\nsqlite_storage 读出方法：通过 ${pass} 项，失败 ${fail} 项`);
if(fail) process.exit(1);
