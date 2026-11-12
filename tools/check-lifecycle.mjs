/* ============================================================================
 * check-lifecycle.mjs —— 房间生命周期「四条守恒断言」（T6b · H·7.2 ⑤⑥⑦⑧）
 * ----------------------------------------------------------------------------
 * 【只锁约束、不实现】档案 §0.4 / 附录 G 的九条口径、B1–B3、alarm 形态、五个实现坑
 *   是**功能开发轮的设计前提**。优化补完轮不实现重置 / 提醒改造 / alarm 重构、
 *   不加 `reset_at` 列（§0.5 第 11 条）。所以本脚本验的不是「现状已经符合规格」，
 *   而是「现状没有提前违反，且将来谁实现时一违反就红」—— 每条都有违规探针自证，
 *   不因为「功能还不存在」就变成摆设断言。
 *
 * 【★ 已知现状登记（不是合规，别误读）】
 *   room.js 的 alarm() 提醒段当前确实 `allocSeq + insertMsgs` 落了一条 kind:'sys' 的
 *   messages 行（附录 G·8.5 坑 2）；导入完成 notice 同理，但那是口径 4 的用户动作留痕。
 *   两者都是 S1 现状，改造排期在功能开发轮。本轮**不动 room.js**，故 ⑥ 的扫描对象是
 *   「新增的还原 / 重置路径」，不把上面两段判红；脚本会把现状显式打印出来。
 *
 * 【怎么用】 node tools/check-lifecycle.mjs （已挂进 npm run check）
 * 【改口径时】先改档案 §0.4 / 附录 G，再改下面的 CONTRACT —— 它是口径的可执行副本。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

const roomRaw   = read('apps/worker/src/room.js');
const schemaRaw = read('apps/worker/src/schema.sql');
const coreRaw   = read('apps/worker/src/core.js');
const lifeRaw   = read('apps/worker/src/lifecycle.js');
const stripJs  = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const stripSql = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const room = stripJs(roomRaw), schema = stripSql(schemaRaw), core = stripJs(coreRaw), life = stripJs(lifeRaw);

/* ---------------------------------------------------------------------------
 * CONTRACT：§0.4 / 附录 G 已定口径的**可执行副本**（改口径先改档案再改这里）
 * ------------------------------------------------------------------------- */
const CONTRACT = {
  /* ⑤ 墓碑永不清：room 行 + seq + PIN（口径 1 / B1 / §0.5 第 13 条） */
  tombstoneCols: ['code', 'created_at', 'pin_hmac', 'pin_salt', 'seq'],
  forbidInCleanup: [
    {re:/DELETE\s+FROM\s+room\b/i,                     why:'删 room 行'},
    {re:/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?room\b/i,   why:'重建 / 删 room 表'},
    {re:/UPDATE\s+room\s+SET\s+seq\s*=\s*(?:0|1)\b/i, why:'把 seq 压回初始（会撞已导出战报 id）'},
    {re:/(?:pin_hmac|pin_salt)\s*=\s*(?:NULL|''|"")/i, why:'清空 PIN（B1 防护降级）'},
    {re:/\.deleteAll\s*\(/,                            why:'deleteAll 释放号码（坑 4 / 口径 1）'},
  ],
  /* ⑥ 提醒非消息 / B2 零消息：新增的还原路径不得落消息、不得续期、不得占 seq */
  noMessageCalls: ['insertMsgs', 'allocSeq', 'keep_until'],
  /* ⑦ 锚点隔离（坑 5）：last_active 由 alarm 自己每次续写，不能当存活/重置判据 */
  lastActiveAllowed: [
    /^\s*last_active\s+INTEGER/,                          // 表定义
    /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+room\s*\([^)]*\blast_active\b/i,  // 建房时写初始值的列清单
    /UPDATE\s+room\s+SET\s+last_active\s*=\s*\?/,         // 记账写入
  ],
  /* ⑧ 还原规格（B1–B3 / §8.6 / E5）
   * ★ S2 边界修正（用户 2026-11-12 确认）：优化补完轮「不预建两表 / 不加 reset_at 列」的禁令
   *   到功能开发轮为止失效 —— 两表由模块 B 第一包预建，两条锚点列由模块 B 还原路径独立步骤引入。
   *   total_joins 是 B3 跨阶段永久口径（清 members 即归零），任何阶段出现即红，不动。
   * ★ 第二步起：下面所有「若存在」守卫改为「必须存在」—— 路径已实现，不许再退回去。 */
  forbiddenCols:   ['total_joins'],                      // B3 永久：schema 出现该列即红
  anchorCols:      ['reset_at', 'warned_for_reset_at'],  // G·8.3 两条锚点列：两份 DDL 都必须有
  prebuiltTables:  ['combat', 'combat_entry'],           // E5：功能开发轮允许预建
  futureClearTables: ['combat', 'combat_entry'],         // E5：两表都必须进清空辅助表清单
  judgeTables:     ['messages', 'idempotency'],          // C1：计时主体只读这两张
  clearOrder:      ['combat_entry', 'combat'],           // C2：先删条目再删战斗行，避免 cursor 悬空
  resetDefaults: {
    rule: "'generic'", baredice: '0',
    clearFields: ['rule_set_by', 'rule_set_at'],
    clearTable: 'members', noMessage: true,
  },
  /* ⑩ 明确的用户请求路径（L6 / G·8.5）：重新 arm 只能挂在这些地方 */
  userPaths: ['/join', '/ws', 'IN.CMD', '/export', '/import'],
  knownDebt: 'S1 旧现状（alarm 落 kind:sys 提醒 / 无条件 setAlarm / 每日空转）已由还原路径独立步骤改造；本轮起 ⑥ / ⑨ / ⑩ 均为正向断言，不再「盯将来路径、旧现状不判红」',
};

/** 找出「还原 / 重置」函数（将来功能开发轮新增的路径），花括号配平取整个函数体 */
function resetBlocks(src){
  const out = [];
  const re = /(?:^|\n)\s*(?:async\s+)?(?:function\s+)?(\w*(?:reset|restore|还原)\w*)\s*\([^)]*\)\s*\{/gi;
  let m;
  while((m = re.exec(src))){
    const brace = re.lastIndex - 1;
    let depth = 0, j = brace;
    for(; j < src.length; j++){
      if(src[j] === '{') depth++;
      else if(src[j] === '}'){ depth--; if(depth === 0){ j++; break; } }
    }
    out.push({name:m[1], body:src.slice(brace, j)});
  }
  return out;
}
/* 按函数名提取函数体（花括号配平）：C1/C4/C5 要把扫描范围限定在 alarm / planImport 内，
 * 否则 TABLES 里的 DDL 与注释里的表名会把「读辅助表」误判成违规（#46 同型）。
 * 认 class 方法（async alarm(){}）与顶层导出函数（export async function planImport(){}）。 */
function namedBlocks(src, nameRe){
  const out = [];
  const re = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?(' + nameRe + ')\\s*\\([^)]*\\)\\s*\\{', 'g');
  let m;
  while((m = re.exec(src))){
    const brace = re.lastIndex - 1;
    let depth = 0, j = brace;
    for(; j < src.length; j++){
      if(src[j] === '{') depth++;
      else if(src[j] === '}'){ depth--; if(depth === 0){ j++; break; } }
    }
    out.push({name:m[1], body:src.slice(brace, j)});
  }
  return out;
}
const hitCalls = body => CONTRACT.noMessageCalls.filter(k => new RegExp('\\b' + k + '\\b').test(body));

console.log('== ⑤ 墓碑守恒（口径 1 / B1 / §0.5 第 13 条）==');
{
  /* ★ 第二步起清表 SQL 在 lifecycle.js 的 RESET_SQL —— 两份源码一起扫，别让它绕开断言 */
  const hits = CONTRACT.forbidInCleanup.filter(p => p.re.test(room + '\n' + life));
  ok('★ 清理 / 还原路径不碰墓碑（' + CONTRACT.forbidInCleanup.length + ' 条禁止模式）',
    hits.length === 0, hits.map(h => h.why).join(' / '));
  const roomTable = (schema.match(/CREATE TABLE IF NOT EXISTS room\s*\(([\s\S]*?)\);/) || [,''])[1];
  const missing = CONTRACT.tombstoneCols.filter(c => !new RegExp('\\b' + c + '\\b').test(roomTable));
  ok('★ room 表含全部墓碑字段（' + CONTRACT.tombstoneCols.join('/') + '）',
    missing.length === 0, '缺：' + missing.join(','));
  const bad = 'this.sql.exec("DELETE FROM room WHERE id = 1");\n' +
              'this.sql.exec("UPDATE room SET seq = 0");\n' +
              'this.sql.exec("UPDATE room SET pin_hmac = NULL");\n' +
              'this.ctx.storage.deleteAll();';
  const caught = CONTRACT.forbidInCleanup.filter(p => p.re.test(bad));
  ok('★ 探针：墓碑禁止模式能抓到违规样本（自证 ' + caught.length + '/' + CONTRACT.forbidInCleanup.length + '）',
    caught.length >= 4);
}

console.log('== ⑥ 提醒非消息（口径 6 / 坑 2 · 第二步起正向断言）==');
{
  const blocks = resetBlocks(room);
  const bad = blocks.filter(b => hitCalls(b.body).length > 0);
  ok('★ 还原 / 重置路径不得落消息（当前 ' + blocks.length + ' 个还原路径）',
    bad.length === 0, bad.map(b => b.name + ' → ' + hitCalls(b.body).join(',')).join(' / '));
  /* ★ 旧 alarm 那段「allocSeq + insertMsgs 落一条 kind:'sys' 消息」已移除。
     现在 alarm() 只是 runLifecycle() 的 IO 适配，提醒走 warnFrame 瞬时帧（G·8.4 ①）。 */
  const alarmBody = namedBlocks(room, 'alarm').map(b => b.body).join('\n');
  const lifeBody  = namedBlocks(life, 'runLifecycle').map(b => b.body).join('\n');
  const noSys = s => !/insertMsgs|allocSeq/.test(s) && !/kind\s*:\s*['"]sys['"]/.test(s);
  ok('★ alarm() 与 runLifecycle() 零落库提醒（旧 sys 消息已移除）',
    namedBlocks(room, 'alarm').length === 1 && namedBlocks(life, 'runLifecycle').length === 1 &&
    noSys(alarmBody) && noSys(lifeBody));
  ok('★ 探针：把提醒落成 sys 消息即被抓到（自证）',
    !noSys("async alarm(){ const s = await this.storage().allocSeq(1); await this.storage().insertMsgs([{kind:'sys'}]); }"));
  const probe = 'async resetRoom(){\n' +
                '  const s = await this.storage().allocSeq(1);\n' +
                '  await this.storage().insertMsgs([{seq:s, keep_until:null}]);\n}';
  const pb = resetBlocks(probe);
  ok('★ 探针：还原路径落消息 / 占 seq / 写 keep_until 即被抓到（自证）',
    pb.length === 1 && hitCalls(pb[0].body).length === CONTRACT.noMessageCalls.length);
  ok('★ 规格显式登记「旧现状已改造、本轮起正向断言」',
    /已由还原路径独立步骤改造/.test(CONTRACT.knownDebt) && /正向断言/.test(CONTRACT.knownDebt));
  console.log('  ✅ 已改造：' + CONTRACT.knownDebt);
}

console.log('== ⑦ 锚点隔离（坑 5：last_active 不能当存活 / 重置锚点）==');
{
  const isAllowed = l => CONTRACT.lastActiveAllowed.some(p => p.test(l));
  const both = room + '\n' + life;
  const lines = both.split('\n').filter(l => /\blast_active\b/.test(l));
  const bad = lines.filter(l => !isAllowed(l));
  ok('★ last_active 只出现在表定义与记账写入（room.js + lifecycle.js 共 ' + lines.length + ' 处）',
    bad.length === 0, bad.map(l => l.trim().slice(0, 80)).join(' / '));
  ok('★ 重置路径不写 last_active（L3 / G·8.4 ② 绝对不做）',
    !/\blast_active\b/.test(resetBlocks(room).map(b => b.body).join('\n')));
  ok('★ 探针：重置路径写 last_active / 拿它作判定即被抓到（自证）',
    /\blast_active\b/.test('async resetRoom(){ this.sql.exec("UPDATE room SET last_active = ?", now); }'));
  const probe = 'if(now - room.last_active > DAY) return;\n' +
                'const r = this.sql.exec("SELECT last_active FROM room WHERE last_active < ?", now);';
  const pl = probe.split('\n').filter(l => /\blast_active\b/.test(l));
  ok('★ 探针：拿 last_active 作判定 / 读列即被抓到（自证）',
    pl.length >= 2 && pl.every(l => !isAllowed(l)));
}

console.log('== ⑧ 还原规格守恒（B1–B3 / §8.6 / E5）==');
{
  const ddl = schema + '\n' + room;   // 两份 DDL 都扫（schema.sql 是唯一出处，room.js 是运行时副本）
  const colHits = CONTRACT.forbiddenCols.filter(c => new RegExp('\\b' + c + '\\b').test(ddl));
  ok('★ schema 不含 total_joins 列（B3 永久：清 members 即归零）',
    colHits.length === 0, colHits.join(','));
  ok('★ 探针：total_joins 出现即红（自证）',
    CONTRACT.forbiddenCols.some(c => new RegExp('\\b' + c + '\\b').test('ALTER TABLE room ADD COLUMN total_joins INTEGER')));
  /* ★ S2 边界修正：两表从「禁止预建」改为「允许预建 + 必须登记进 E5 清空清单」。
     禁令只服务优化补完轮；模块 B 第一包预建后，真正要守住的是「归零时两张都清」。 */
  const registered = (tables, list) => tables.every(t => list.includes(t));
  ok('★ E5 两表允许预建且已登记进清空辅助表清单',
    CONTRACT.prebuiltTables.length === 2 &&
    registered(CONTRACT.prebuiltTables, CONTRACT.futureClearTables) &&
    CONTRACT.futureClearTables.length === 2);
  ok('★ 探针：漏登记一张表即被抓（自证）',
    registered(CONTRACT.prebuiltTables, CONTRACT.futureClearTables) &&
    !registered(CONTRACT.prebuiltTables, ['combat']));
  /* ★ 第二步：两条锚点列已引入；「alarm 绝不写 reset_at」从「盯将来」升级为正向断言。 */
  ok('★ 两条锚点列已引入（schema.sql 与 room.js 副本都有）',
    CONTRACT.anchorCols.every(c => new RegExp('\\b' + c + '\\b').test(schema) &&
                                  new RegExp('\\b' + c + '\\b').test(room)));
  ok('★ 探针：缺一列即被抓（自证）',
    !CONTRACT.anchorCols.every(c => new RegExp('\\b' + c + '\\b').test('CREATE TABLE room (id INTEGER, reset_at INTEGER)')));
  const alarmBody = namedBlocks(room, 'alarm').map(b => b.body).join('\n');
  const lifeAlarm = namedBlocks(life, 'runLifecycle').map(b => b.body).join('\n');
  ok('★ alarm 与 runLifecycle 绝不写 reset_at（只由用户动作刷新，G·8.3 / 坑 5）',
    !/SET\s+reset_at/i.test(alarmBody) && !/SET\s+reset_at/i.test(lifeAlarm));
  ok('★ 探针：把 UPDATE room SET reset_at 塞进 alarm 即被抓（自证）',
    /SET\s+reset_at/i.test('async alarm(){ this.sql.exec("UPDATE room SET reset_at = ?", now); }'));
  ok('★ reset_at 写入只出现在 refreshAnchor（用户动作：发指令 / 导出 / 导入）',
    /async refreshAnchor\(\)[\s\S]{0,400}UPDATE room SET reset_at/.test(room) &&
    (room.match(/refreshAnchor\(\)/g) || []).length >= 4);
  const d = CONTRACT.resetDefaults;
  ok('★ 规格常量含 B2 / B3 还原项（rule 回默认 / baredice=0 / 清设定者 / 清 members / 零消息）',
    d.rule === "'generic'" && d.baredice === '0' && d.clearFields.length === 2 &&
    d.clearTable === 'members' && d.noMessage === true);
  ok('★ 规格常量登记「两张表都必须进清空辅助表清单」（E5）',
    CONTRACT.futureClearTables.length === 2 &&
    CONTRACT.futureClearTables.includes('combat') && CONTRACT.futureClearTables.includes('combat_entry'));
  /* 正向要求：清表 SQL 的**单一源**是 lifecycle.js 的 RESET_SQL —— 必须写回默认 + 清 members；
     room.js 的 resetRoom() 只执行它，不许另抄一份（坑 #18 的同型分叉）。 */
  const must = [/rule\s*=\s*'generic'/i, /baredice\s*=\s*0/i, /rule_set_by/i, /rule_set_at/i, /DELETE\s+FROM\s+members/i];
  const resetSql = (life.match(/RESET_SQL\s*=\s*\[([\s\S]*?)\];/) || [,''])[1];
  const missingAll = must.filter(p => !p.test(resetSql)).map(p => 'RESET_SQL 缺 ' + p);
  ok('★ RESET_SQL 必须写回默认并清 members（B2 / B3）',
    missingAll.length === 0, missingAll.join(' / '));
  const blocks = resetBlocks(room);
  ok('★ resetRoom 执行 RESET_SQL（不另抄一份清表语句）',
    blocks.length === 1 && /RESET_SQL\.forEach/.test(blocks[0].body));
  ok('★ 还原路径零消息（B2）', blocks.every(b => !/insertMsgs|allocSeq/.test(b.body)));
  const goodSql = "RESET_SQL = [ 'DELETE FROM combat_entry','DELETE FROM combat','DELETE FROM pcs','DELETE FROM members', \"UPDATE room SET rule = 'generic', baredice = 0, rule_set_by = NULL, rule_set_at = NULL WHERE id = 1\" ];";
  const shortSql = goodSql.replace(', rule_set_by = NULL, rule_set_at = NULL', '');
  ok('★ 探针：合规还原 SQL 通过 / 缺项 SQL 被抓（自证）',
    must.every(p => p.test(goodSql)) && must.some(p => !p.test(shortSql)));
}

console.log('== ⑨ C1–C5 先攻表清理守恒（附录 I·3.8.2 · 第二步：路径已实现，全正向断言）==');
{
  const alarms = namedBlocks(room, 'alarm');
  const alarmBody = alarms.map(b => b.body).join('\n');
  const lifes = namedBlocks(life, 'runLifecycle');
  const lifeBody = lifes.map(b => b.body).join('\n');
  const resets = resetBlocks(room);
  const resetBody = resets.map(b => b.body).join('\n');
  const delAux = /\bDELETE\s+FROM\s+(?:combat|combat_entry)\b/i;
  /* 清表 SQL 单一源 + 计时 SQL 区（从 SWEEP 到 RESET_SQL 之前，只许出现计时主体两张表） */
  const resetSql = (life.match(/RESET_SQL\s*=\s*\[([\s\S]*?)\];/) || [,''])[1];
  const sqlZone = life.slice(life.indexOf('SQL_SWEEP_MSGS'), life.indexOf('RESET_SQL'));

  /* ---------- C1 清理判据被污染 ---------- */
  /* 辅助表「只清不读」：抹掉 DELETE 语句里的表名后，任何 FROM combat* 都是把辅助表行数
     当存活 / 归零判据 —— 与 §8.5 坑 5（last_active 被 alarm 自己续写）完全同型。 */
  const readsAux = s => {
    const noDel = s.replace(/\bDELETE\s+FROM\s+(?:combat|combat_entry)\b/gi, 'DELETE FROM __aux__');
    return /\bFROM\s+(?:combat|combat_entry)\b/i.test(noDel);
  };
  ok('★ C1 alarm / runLifecycle / 还原路径都不读辅助表',
    alarms.length === 1 && lifes.length === 1 &&
    !readsAux(alarmBody) && !readsAux(lifeBody) && !readsAux(resetBody),
    'alarm=' + alarms.length + ' lifecycle=' + lifes.length + ' reset=' + resets.length);
  ok('★ C1 计时 SQL 区只读 messages + idempotency（不出现 FROM combat*）',
    !/FROM\s+(?:combat|combat_entry)\b/i.test(sqlZone) &&
    /FROM messages/.test(sqlZone) && /FROM idempotency/.test(sqlZone));
  ok('★ C1 常量登记：计时主体恰为 messages + idempotency',
    CONTRACT.judgeTables.length === 2 && CONTRACT.judgeTables.includes('messages') && CONTRACT.judgeTables.includes('idempotency'));
  ok('★ C1 探针：把 combat_entry 行数塞进判据即抓，纯清表放行（自证）',
    readsAux('async alarm(){ if(SELECT COUNT(*) FROM combat_entry > 0) return; }') &&
    !readsAux('async alarm(){ DELETE FROM combat_entry; DELETE FROM combat; }'));

  /* ---------- C2 漏清一张表 ---------- */
  const clearAt = (s, t) => s.search(new RegExp('DELETE\\s+FROM\\s+' + t + '\\b', 'i'));
  const clearOK = s => {
    const a = clearAt(s, 'combat_entry'), c = clearAt(s, 'combat');
    return a >= 0 && c > a;
  };
  ok('★ C2 RESET_SQL 成对清两表，顺序先 combat_entry 后 combat（resetRoom 执行它）',
    clearOK(resetSql) && resets.length === 1 && /RESET_SQL\.forEach/.test(resetBody));
  /* ★ S2 模块 B 第三步先红后绿补强：只查「出现过 DELETE FROM」会放过
   *   `DELETE FROM combat_entry WHERE 0` 这类恒假条件 —— 表看似清了、条目全残留，
   *   直接违反 B3「还原后等同全新房间」。归零必须是无条件整表清，两语句逐字精确。 */
  const resetStmts = [...resetSql.matchAll(/['"]([^'"]*DELETE[^'"]*)['"]/gi)].map(m => m[1].trim());
  /* RESET_SQL 还含 pcs / members 两条整表清 —— 只挑 combat* 两表做逐字精确比对 */
  const combatStmts = resetStmts.filter(x => /^DELETE FROM (?:combat_entry|combat)\b/i.test(x));
  ok('★ C2 归零清表是两条无 WHERE 的整表 DELETE（堵恒假条件漏清）',
    combatStmts.length === 2 &&
    /^DELETE FROM combat_entry$/i.test(combatStmts[0]) && /^DELETE FROM combat$/i.test(combatStmts[1]),
    JSON.stringify(combatStmts));
  ok('★ C2 清辅助表只出现在 RESET_SQL（计时 SQL 区不得出现）', !delAux.test(sqlZone));
  ok('★ C2 常量登记：清空顺序与定稿一致',
    CONTRACT.clearOrder.length === 2 && CONTRACT.clearOrder[0] === 'combat_entry' && CONTRACT.clearOrder[1] === 'combat');
  const c2good = 'RESET_SQL = [ "DELETE FROM combat_entry", "DELETE FROM combat" ];';
  const c2miss = 'RESET_SQL = [ "DELETE FROM combat" ];';
  const c2swap = 'RESET_SQL = [ "DELETE FROM combat", "DELETE FROM combat_entry" ];';
  ok('★ C2 探针：漏一张 / 顺序反都抓到，合规样本放行（自证）',
    clearOK(c2good) && !clearOK(c2miss) && !clearOK(c2swap));

  /* ---------- C3 重置路径发广播（落库消息） ---------- */
  /* 瞬时帧（this.broadcast({t:...})）允许：不落库、不占 seq、不续活（G·8.4 ②）。
     禁止的是落库消息与占 seq —— 那会把计时主体自续到永不到期。 */
  const noMsg = s => hitCalls(s).length === 0 &&
    !/kind\s*:\s*['"](?:sys|notice)['"]/.test(s);
  ok('★ C3 还原路径零消息 / 零 seq / 零续期 / 零落库广播（瞬时帧允许）',
    resets.length === 1 && resets.every(b => noMsg(b.body)) &&
    !/insertMsgs|allocSeq/.test(lifeBody));
  const resetBranch = lifeBody.slice(lifeBody.indexOf('if(shouldReset'),
    lifeBody.indexOf("run('UPDATE room SET last_active"));
  ok('★ C3 归零分支静默：只 io.reset() + return，不排闹钟 / 不写 last_active / 不落消息',
    resetBranch.length > 0 && /await io\.reset\(\)/.test(resetBranch) &&
    !/rearm|setAlarm|last_active|insertMsgs|allocSeq/.test(resetBranch));
  const c3bad  = 'async resetRoom(){ const s = await this.storage().allocSeq(1); await this.storage().insertMsgs([{kind:"sys"}]); }';
  const c3good = 'async resetRoom(){ this.broadcast({t:OUT.STATE}); RESET_SQL.forEach(s => this.sql.exec(s)); }';
  ok('★ C3 探针：落库消息即抓，瞬时帧放行（自证）',
    !noMsg(c3bad) && noMsg(c3good));

  /* ---------- C4 战斗中掉表 ---------- */
  const rolling = [...sqlZone.matchAll(/DELETE\s+FROM\s+(\w+)/gi)].map(m => m[1].toLowerCase());
  ok('★ C4 滚动 DELETE 只动计时主体两表',
    rolling.length === 2 && rolling.every(t => CONTRACT.judgeTables.includes(t)), rolling.join(','));
  const noResetSql = life.replace(/RESET_SQL\s*=\s*\[[\s\S]*?\];/, '');
  /* ★ S2 模块 B 第三步：清辅助表有且仅有两条合法路径 ——
   *   ① 系统归零（lifecycle.js 的 RESET_SQL，零消息零广播）；
   *   ② 用户指令「结束整场战斗」（room.js combatApply 的 clear op，I·3.2）。
   *   ② 不是 alarm 滚动 DELETE，不会让战斗打到一半掉表；但必须成对且顺序正确（C2）。
   *   这里只排除那一处合规语句，剩下任何 DELETE FROM combat* 仍一律判红。 */
  const userClear = /sql\.exec\('DELETE FROM combat_entry'\);\s*sql\.exec\('DELETE FROM combat'\);/;
  /* 用户指令「.init del 删一个条目」也是合法局部操作（I·3.2），不是 alarm 滚动 DELETE；
   *   它同样落在 combatApply 里，一并排除。剩下任何位置出现 DELETE FROM combat* 仍判红。 */
  const userDeleteOne = /sql\.exec\('DELETE FROM combat_entry WHERE name = \?', n\);/g;
  const roomNoUserPath = room.replace(userClear, '').replace(userDeleteOne, '');
  ok('★ C4 用户指令清空路径成对且顺序正确（I·3.2 / C2）', userClear.test(room));
  ok('★ C4 清辅助表只允许出现在系统归零 / 用户指令清空两处（逐条到期 DELETE 不得级联）',
    !delAux.test(roomNoUserPath + '\n' + noResetSql));
  ok('★ C4 探针：alarm 里顺手清表即被抓，只删 messages 放行（自证）',
    delAux.test('async alarm(){ this.sql.exec("DELETE FROM combat_entry WHERE 1=1"); }') &&
    !delAux.test('async alarm(){ this.sql.exec("DELETE FROM messages WHERE ts < ?", cut); }'));

  /* ---------- C5 导入战报重建状态 ---------- */
  const plans = namedBlocks(core, 'planImport');
  const planBody = plans.map(b => b.body).join('\n');
  ok('★ C5 planImport 只处理 messages：不重放指令、不碰先攻表',
    plans.length === 1 && !/\bcombat(?:_entry)?\b/.test(planBody) &&
    !/handleCommand/.test(planBody) && /mergeOrder/.test(planBody),
    'plans=' + plans.length);
  const c5bad = 'export async function planImport(storage, incoming, nowMs){ await storage.handleCommand(incoming); this.sql.exec("DELETE FROM combat_entry"); }';
  ok('★ C5 探针：导入回放指令 / 写先攻表即被抓（自证）',
    namedBlocks(c5bad, 'planImport').length === 1 &&
    /handleCommand|\bcombat(?:_entry)?\b/.test(namedBlocks(c5bad, 'planImport')[0].body));

  console.log('  ✅ 路径已实现：resetRoom() 静默执行 RESET_SQL（先条目后战斗行）；');
  console.log('    提醒与重置只发瞬时帧（不落库、不占 seq）；C1–C5 已从「盯将来」转为正向断言。');
}

console.log('== ⑩ alarm 新形态（L6 / G·8.5 五坑 · 单实例 / 空容器停排）==');
{
  const ctor = namedBlocks(room, 'constructor');
  ok('★ 构造函数不许无条件 setAlarm（DO 休眠唤醒时它会先于 alarm 执行，干扰已排闹钟）',
    ctor.length === 1 && !/setAlarm\(/.test(ctor[0].body));
  ok('★ 探针：构造函数里排闹钟即被抓（自证）',
    /setAlarm\(/.test('constructor(ctx, env){ this.ctx.storage.setAlarm(Date.now()+1000); }'));
  ok('★ 单实例：getAlarm() 判重 + 只在需要提前时覆盖（setAlarm(at)）',
    /getAlarm\(\)/.test(room) && /cur <= at/.test(room) && /setAlarm\(at\)/.test(room));
  ok('★ 探针：少了 getAlarm 判重即被抓（自证）',
    !/getAlarm\(\)/.test('async rearm(at){ await this.ctx.storage.setAlarm(at); }'));
  ok('★ 空容器不排新闹钟（at=null 直接 return；停 alarm ≠ 销毁容器）',
    /if\(at == null\) return/.test(room) && /at\.length \? Math\.min\(\.\.\.at\) : null/.test(life));
  ok('★ 不调用 deleteAll()（坑 4：调它等于释放号码，与口径 1 冲突）',
    !/\.deleteAll\s*\(/.test(room) && !/\.deleteAll\s*\(/.test(life));
  ok('★ 探针：deleteAll 被抓（自证）', /\.deleteAll\s*\(/.test('this.ctx.storage.deleteAll()'));
  ok('★ 重新 arm 只挂在明确用户请求路径（join / ws 握手 / 发指令 / export / import）',
    CONTRACT.userPaths.every(p => room.includes(p)) &&
    (room.match(/armFromUserAction\(\)/g) || []).length >= 3 &&
    (room.match(/refreshAnchor\(\)/g) || []).length >= 4);
  ok('★ 提醒按 reset_at − 7d、每轮可再触发（shouldWarn 用 warned_for_reset_at，坑 3）',
    /resetAt.*- WARN_MS/.test(life) && /warnedForResetAt !== resetAt/.test(life) &&
    /notified_clean = 0/.test(life));
  ok('★ 探针：旧「now − created_at > 23d 且只置一次」判定已移除（自证）',
    !/WARN_DAYS/.test(room) && !/created_at > WARN/.test(room));
  ok('★ 重置那一刻不排下一轮闹钟（runLifecycle 归零后直接 return）',
    /return \{reset:true, warned, armAt:null\}/.test(life));
}

console.log('---------------------------');
console.log('生命周期守恒：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
