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
const stripJs  = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const stripSql = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const room = stripJs(roomRaw), schema = stripSql(schemaRaw), core = stripJs(coreRaw);

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
   *   到功能开发轮为止失效 —— 两表由模块 B 第一包预建，reset_at 由模块 B 还原路径独立步骤引入。
   *   total_joins 是 B3 跨阶段永久口径（清 members 即归零），任何阶段出现即红，不动。 */
  forbiddenCols:   ['total_joins'],                      // B3 永久：schema 出现该列即红
  anchorCols:      ['reset_at'],                         // 功能开发轮独立步骤的锚点列；当前未引入，不判红
  prebuiltTables:  ['combat', 'combat_entry'],           // E5：功能开发轮允许预建
  futureClearTables: ['combat', 'combat_entry'],         // E5：两表都必须进清空辅助表清单
  judgeTables:     ['messages', 'idempotency'],          // C1：计时主体只读这两张
  clearOrder:      ['combat_entry', 'combat'],           // C2：先删条目再删战斗行，避免 cursor 悬空
  resetDefaults: {
    rule: "'generic'", baredice: '0',
    clearFields: ['rule_set_by', 'rule_set_at'],
    clearTable: 'members', noMessage: true,
  },
  knownDebt: 'room.js 的 alarm 提醒段当前 allocSeq + insertMsgs 落 sys 消息（坑 2 / 口径 6），属 S1 现状；功能开发轮还原路径独立步骤改造，本脚本不把它判红',
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
  const hits = CONTRACT.forbidInCleanup.filter(p => p.re.test(room));
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

console.log('== ⑥ 提醒非消息（口径 6 / 坑 2 · 只守新增的还原 / 重置路径）==');
{
  const blocks = resetBlocks(room);
  const bad = blocks.filter(b => hitCalls(b.body).length > 0);
  ok('★ 新增的还原 / 重置路径不得落消息（当前 ' + blocks.length + ' 个还原路径）',
    bad.length === 0, bad.map(b => b.name + ' → ' + hitCalls(b.body).join(',')).join(' / '));
  const probe = 'async resetRoom(){\n' +
                '  const s = await this.storage().allocSeq(1);\n' +
                '  await this.storage().insertMsgs([{seq:s, keep_until:null}]);\n}';
  const pb = resetBlocks(probe);
  ok('★ 探针：还原路径落消息 / 占 seq / 写 keep_until 即被抓到（自证）',
    pb.length === 1 && hitCalls(pb[0].body).length === CONTRACT.noMessageCalls.length);
  ok('★ 规格显式登记 S1 现状，不把「全绿」误读成「现状合规」',
    /insertMsgs/.test(CONTRACT.knownDebt) && /功能开发轮/.test(CONTRACT.knownDebt) && /不把它判红/.test(CONTRACT.knownDebt));
  console.log('  ⚠️ 现状登记（不判红）：' + CONTRACT.knownDebt);
}

console.log('== ⑦ 锚点隔离（坑 5：last_active 不能当存活 / 重置锚点）==');
{
  const isAllowed = l => CONTRACT.lastActiveAllowed.some(p => p.test(l));
  const lines = room.split('\n').filter(l => /\blast_active\b/.test(l));
  const bad = lines.filter(l => !isAllowed(l));
  ok('★ last_active 只出现在表定义与记账写入（共 ' + lines.length + ' 处）',
    bad.length === 0, bad.map(l => l.trim().slice(0, 80)).join(' / '));
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
  ok('★ 锚点列 reset_at 归属功能开发轮独立步骤（当前未引入，不判红）',
    CONTRACT.anchorCols.includes('reset_at') && !/\breset_at\b/.test(ddl));
  const d = CONTRACT.resetDefaults;
  ok('★ 规格常量含 B2 / B3 还原项（rule 回默认 / baredice=0 / 清设定者 / 清 members / 零消息）',
    d.rule === "'generic'" && d.baredice === '0' && d.clearFields.length === 2 &&
    d.clearTable === 'members' && d.noMessage === true);
  ok('★ 规格常量登记「两张表都必须进清空辅助表清单」（E5）',
    CONTRACT.futureClearTables.length === 2 &&
    CONTRACT.futureClearTables.includes('combat') && CONTRACT.futureClearTables.includes('combat_entry'));
  /* 正向要求：还原路径（若存在）必须写回默认 + 清 members，且不得落消息（B2 零消息） */
  const must = [/rule\s*=\s*'generic'/i, /baredice\s*=\s*0/i, /rule_set_by/i, /rule_set_at/i, /DELETE\s+FROM\s+members/i];
  const blocks = resetBlocks(room);
  const missingAll = blocks.flatMap(b => must.filter(p => !p.test(b.body)).map(p => b.name + ' 缺 ' + p));
  ok('★ 还原路径（若存在）必须写回默认并清 members（当前 ' + blocks.length + ' 个）',
    missingAll.length === 0, missingAll.join(' / '));
  ok('★ 还原路径零消息（B2）', blocks.every(b => !/insertMsgs|allocSeq/.test(b.body)));
  const good = "async resetRoom(){ this.sql.exec(\"UPDATE room SET rule = 'generic', baredice = 0, rule_set_by = NULL, rule_set_at = NULL\"); this.sql.exec('DELETE FROM members'); }";
  const short = "async resetRoom(){ this.sql.exec(\"UPDATE room SET rule = 'generic'\"); this.sql.exec('DELETE FROM members'); }";
  const gb = resetBlocks(good), sb = resetBlocks(short);
  ok('★ 探针：合规还原路径通过 / 缺项还原路径被抓（自证）',
    gb.length === 1 && must.every(p => p.test(gb[0].body)) &&
    sb.length === 1 && must.some(p => !p.test(sb[0].body)));
}

console.log('== ⑨ C1–C5 先攻表清理守恒（附录 I·3.8.2 · S2 模块 B 第一包装守卫）==');
{
  const alarms = namedBlocks(room, 'alarm');
  const alarmBody = alarms.map(b => b.body).join('\n');
  const resets = resetBlocks(room);
  const resetBody = resets.map(b => b.body).join('\n');
  const delAux = /\bDELETE\s+FROM\s+(?:combat|combat_entry)\b/i;

  /* ---------- C1 清理判据被污染 ---------- */
  /* 辅助表「只清不读」：抹掉 DELETE 语句里的表名后，任何 FROM combat* 都是把辅助表行数
     当存活 / 归零判据 —— 与 §8.5 坑 5（last_active 被 alarm 自己续写）完全同型。 */
  const readsAux = s => {
    const noDel = s.replace(/\bDELETE\s+FROM\s+(?:combat|combat_entry)\b/gi, 'DELETE FROM __aux__');
    return /\bFROM\s+(?:combat|combat_entry)\b/i.test(noDel);
  };
  ok('★ C1 计时判据只读 messages / idempotency（alarm 与还原路径都不读辅助表）',
    alarms.length > 0 && !readsAux(alarmBody) && !readsAux(resetBody),
    'alarm=' + alarms.length + ' reset=' + resets.length);
  ok('★ C1 常量登记：计时主体恰为 messages + idempotency',
    CONTRACT.judgeTables.length === 2 && CONTRACT.judgeTables.includes('messages') && CONTRACT.judgeTables.includes('idempotency'));
  ok('★ C1 探针：把 combat_entry 行数塞进判据即抓，纯清表放行（自证）',
    readsAux('async alarm(){ if(SELECT COUNT(*) FROM combat_entry > 0) return; }') &&
    !readsAux('async alarm(){ DELETE FROM combat_entry; DELETE FROM combat; }'));

  /* ---------- C2 漏清一张表 ---------- */
  const clearAt = (b, t) => b.body.search(new RegExp('DELETE\\s+FROM\\s+' + t + '\\b', 'i'));
  const clearOK = b => {
    const a = clearAt(b, 'combat_entry'), c = clearAt(b, 'combat');
    return a >= 0 && c > a;
  };
  ok('★ C2 还原路径（若存在）必须成对清两表，顺序先 combat_entry 后 combat（当前 ' + resets.length + ' 个）',
    resets.every(clearOK), resets.filter(b => !clearOK(b)).map(b => b.name).join(','));
  ok('★ C2 常量登记：清空顺序与定稿一致',
    CONTRACT.clearOrder.length === 2 && CONTRACT.clearOrder[0] === 'combat_entry' && CONTRACT.clearOrder[1] === 'combat');
  const c2good = 'async resetRoom(){ this.sql.exec("DELETE FROM combat_entry"); this.sql.exec("DELETE FROM combat"); }';
  const c2miss = 'async resetRoom(){ this.sql.exec("DELETE FROM combat"); }';
  const c2swap = 'async resetRoom(){ this.sql.exec("DELETE FROM combat"); this.sql.exec("DELETE FROM combat_entry"); }';
  ok('★ C2 探针：漏一张 / 顺序反都抓到，合规样本放行（自证）',
    resetBlocks(c2good).length === 1 && clearOK(resetBlocks(c2good)[0]) &&
    resetBlocks(c2miss).length === 1 && !clearOK(resetBlocks(c2miss)[0]) &&
    resetBlocks(c2swap).length === 1 && !clearOK(resetBlocks(c2swap)[0]));

  /* ---------- C3 重置路径发广播（落库消息） ---------- */
  /* 瞬时帧（this.broadcast({t:...})）允许：不落库、不占 seq、不续活（G·8.4 ②）。
     禁止的是落库消息与占 seq —— 那会把计时主体自续到永不到期。 */
  const noMsg = b => hitCalls(b.body).length === 0 &&
    !/kind\s*:\s*['"](?:sys|notice)['"]/.test(b.body);
  ok('★ C3 还原路径零消息 / 零 seq / 零续期 / 零落库广播（当前 ' + resets.length + ' 个）',
    resets.every(noMsg), resets.filter(b => !noMsg(b)).map(b => b.name).join(','));
  const c3bad  = 'async resetRoom(){ const s = await this.storage().allocSeq(1); await this.storage().insertMsgs([{kind:"sys"}]); }';
  const c3good = 'async resetRoom(){ this.broadcast({t:OUT.STATE}); this.sql.exec("DELETE FROM combat_entry"); }';
  ok('★ C3 探针：落库消息即抓，瞬时帧放行（自证）',
    resetBlocks(c3bad).length === 1 && !noMsg(resetBlocks(c3bad)[0]) &&
    resetBlocks(c3good).length === 1 && noMsg(resetBlocks(c3good)[0]));

  /* ---------- C4 战斗中掉表 ---------- */
  const rolling = [...alarmBody.matchAll(/DELETE\s+FROM\s+(\w+)/gi)].map(m => m[1].toLowerCase());
  ok('★ C4 alarm 的滚动 DELETE 只动计时主体两表',
    rolling.length > 0 && rolling.every(t => CONTRACT.judgeTables.includes(t)), rolling.join(','));
  let rest = room;
  resets.forEach(b => { rest = rest.replace(b.body, ' '.repeat(b.body.length)); });
  ok('★ C4 清辅助表只允许出现在还原路径（逐条到期 DELETE 不得级联）', !delAux.test(rest));
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

  console.log('  ⚠️ 现状登记（不判红）：当前无还原 / 重置路径，C2 / C3 为「盯将来路径」守卫；');
  console.log('    模块 B 还原路径独立步骤实现后自动生效（清表函数名须含 reset / restore / 还原；');
  console.log('    瞬时帧允许、落库消息禁止；两表必须成对清且先条目后战斗行）。');
}

console.log('---------------------------');
console.log('生命周期守恒：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
