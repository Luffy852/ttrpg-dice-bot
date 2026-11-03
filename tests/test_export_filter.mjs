/* ============================================================================
 * test_export_filter.mjs —— 导出筛选（v1.1）纯函数单测
 * ----------------------------------------------------------------------------
 * 【验什么】① 北京时区日期边界 ② 参数规范与清洗 ③ SQL 子句与绑定参数
 *   ④ 前端拼 URL / 后端解析**交叉一致**（防"前端发 from、后端读 start"这类漂移）
 *   ⑤ 空筛选时 URL / SQL / 战报都与 v1 逐字一致 ⑥ 昵称不进 SQL 字符串
 * 【为什么不靠 dom_smoke 顺带验】这些是纯数据规则，跑得快、边界能穷举；
 *   DOM 那层只验"表单真的把值交出来了"，两层分工不重叠。
 * ========================================================================== */
import {
  validDay, dayStart, dayEnd, normalizeFilters, hasFilters,
  parseFilters, appendFilterParams, filterSummary, FILTER_LIMITS,
} from '../packages/protocol/src/export-filter.js';
import {buildFilterClause} from '../apps/worker/src/export.js';
import {buildExportQuery, normalizePick, EXPORT_CHOICES} from '../apps/web/src/ask.js';
import {renderBattleMd} from '../packages/engine/src/render-md.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if(c){ pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); }
};
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

console.log('== ① 日期：严格校验 + 北京时区边界 ==');
{
  ok('2026-11-01 合法', validDay('2026-11-01'));
  ok('闰年 2028-02-29 合法', validDay('2028-02-29'));
  ok('2026-02-30 不合法（Date.parse 会悄悄规范成 3 月 2 日）', !validDay('2026-02-30'));
  ok('2027-02-29 不合法', !validDay('2027-02-29'));
  ['', '2026-1-1', '2026/11/01', 'abc', null, 123, '2026-13-01', '2026-00-10'].forEach(x =>
    ok('非法输入被拒：' + JSON.stringify(x), !validDay(x)));
  /* 北京 2026-11-01 00:00 = UTC 2026-10-31 16:00 */
  eq('dayStart 按 UTC+8', dayStart('2026-11-01'), Date.parse('2026-10-31T16:00:00Z'));
  eq('dayEnd 含整天最后 1ms', dayEnd('2026-11-01'), Date.parse('2026-11-01T15:59:59.999Z'));
  eq('dayEnd - dayStart = 一天减 1ms', dayEnd('2026-11-01') - dayStart('2026-11-01'), 86400000 - 1);
  ok('★ 早上 7 点（UTC 前一晚 23 点）仍算 11-01',
    Date.parse('2026-10-31T23:00:00Z') >= dayStart('2026-11-01') &&
    Date.parse('2026-10-31T23:00:00Z') <= dayEnd('2026-11-01'));
  ok('★ 前一天 23:59（北京）不算 11-01',
    Date.parse('2026-10-31T15:59:00Z') < dayStart('2026-11-01'));
}

console.log('== ② normalizeFilters：清洗 / 去重 / 截断 / 范围 ==');
{
  const n = normalizeFilters({from:' 2026-11-01 ', to:'2026-11-03', senders:[' 老王 ', '老王', '', null, '小李']});
  eq('日期去空格', n.from, '2026-11-01');
  eq('昵称去空格 + 去重', JSON.stringify(n.senders), JSON.stringify(['老王', '小李']));
  eq('无 error', n.error, null);
  eq('非法日期被丢弃', normalizeFilters({from:'2026-02-30', to:'x'}).from, '');
  eq('范围写反 → bad_range', normalizeFilters({from:'2026-11-03', to:'2026-11-01'}).error, 'bad_range');
  const inj = normalizeFilters({senders:['老王\n> 伪造一行\t说明']});
  eq('★ 昵称里的换行/制表被清掉（不能往战报头注入新行）', inj.senders[0], '老王 > 伪造一行 说明');
  const many = normalizeFilters({senders:Array.from({length:50}, (_, i) => '人' + i)});
  eq('★ 人数封顶', many.senders.length, FILTER_LIMITS.SENDERS_MAX);
  const long = normalizeFilters({senders:['X'.repeat(200)]});
  eq('★ 单个昵称截断', long.senders[0].length, FILTER_LIMITS.SENDER_MAX);
  ok('空筛选 = 无筛选', !hasFilters({from:'', to:'', senders:[]}));
  ok('只填起始也算筛选', hasFilters({from:'2026-11-01'}));
  eq('空筛选摘要', filterSummary({}), '全部消息');
  ok('摘要含日期与参与者', /2026-11-01/.test(filterSummary({from:'2026-11-01', senders:['老王']})) &&
    /老王/.test(filterSummary({from:'2026-11-01', senders:['老王']})));
}

console.log('== ③ backend：buildFilterClause（SELECT/UPDATE 共用同一段）==');
{
  const c0 = buildFilterClause(normalizeFilters({}));
  eq('空筛选 → 空 clause', c0.clause, '');
  eq('空筛选 → 无参数', c0.args.length, 0);

  const c1 = buildFilterClause(normalizeFilters({from:'2026-11-01', to:'2026-11-03', senders:['老王', '小李']}));
  eq('★ 三个条件齐全', c1.clause, ' AND ts >= ? AND ts <= ? AND from_name IN (?,?)');
  eq('★ 参数个数 = 占位符个数', c1.args.length, 4);
  eq('起始参数是北京 00:00', c1.args[0], dayStart('2026-11-01'));
  eq('结束参数是北京 23:59:59.999', c1.args[1], dayEnd('2026-11-03'));
  eq('昵称参数顺序与 IN 一致', JSON.stringify(c1.args.slice(2)), JSON.stringify(['老王', '小李']));

  /* ★ 注入尝试：昵称里带引号，只能作为参数，绝不能拼进 SQL 文本 */
  const evil = "老王' OR 1=1 --";
  const c2 = buildFilterClause(normalizeFilters({senders:[evil]}));
  ok('★ 恶意昵称没有出现在 SQL 文本里', !/OR 1=1/.test(c2.clause), c2.clause);
  eq('★ 恶意昵称仍作为绑定参数', c2.args[0], evil);
  ok('★ clause 只含占位符', c2.clause === ' AND from_name IN (?)');
}

console.log('== ④ 前端 URL ↔ 后端解析：交叉一致（防两端漂移）==');
{
  eq('空筛选 URL 与 v1 逐字相同',
    buildExportQuery({code:'593353', token:'t ok', format:'md', filters:{}}),
    '/api/room/593353/export?format=md&token=t+ok');
  eq('ndjson 默认', buildExportQuery({code:'1', token:'x', format:'weird', filters:{}}).indexOf('format=ndjson') > 0, true);

  const filters = {from:'2026-11-01', to:'2026-11-03', senders:['老王', '小李']};
  const url = buildExportQuery({code:'593353', token:'a&b', format:'ndjson', filters});
  ok('URL 含 from', /from=2026-11-01/.test(url), url);
  ok('URL 含 to', /to=2026-11-03/.test(url), url);
  ok('URL 含两个 sender', (url.match(/sender=/g) || []).length === 2, url);
  ok('★ token 被编码（& 不会截断参数）', /token=a%26b/.test(url), url);
  const sp = new URLSearchParams(url.split('?')[1]);
  const back = parseFilters(sp);
  eq('★ 后端解析回来的 from 一致', back.from, filters.from);
  eq('★ 后端解析回来的 to 一致', back.to, filters.to);
  eq('★ 后端解析回来的 senders 一致', JSON.stringify(back.senders), JSON.stringify(filters.senders));
  eq('★ 后端解析无 error', back.error, null);

  /* 反向：后端 parseFilters 读到的，前端 appendFilterParams 再拼回去应一致 */
  const sp2 = new URLSearchParams('format=md&from=2026-11-01&sender=%E8%80%81%E7%8E%8B');
  const f2 = parseFilters(sp2);
  const out = new URLSearchParams();
  appendFilterParams(out, f2);
  eq('反向一致', out.toString(), 'from=2026-11-01&sender=%E8%80%81%E7%8E%8B');
}

console.log('== ⑤ normalizePick：取消语义 / 格式归一 ==');
{
  eq('★ raw=null（取消）→ null', normalizePick(null), null);
  const p = normalizePick({value:'ndjson', from:'2026-11-01', senders:['老王']});
  eq('格式', p.format, 'ndjson');
  eq('filters.from', p.filters.from, '2026-11-01');
  eq('error', p.error, null);
  eq('未知格式回落 ndjson', normalizePick({value:'???'}).format, 'ndjson');
  ok('范围写反的 pick 带 error', !!normalizePick({value:'md', from:'2026-11-03', to:'2026-11-01'}).error);
  eq('EXPORT_CHOICES 仍是两项且值正确',
    EXPORT_CHOICES.map(c => c.value).join(','), 'md,ndjson');
}

console.log('== ⑥ 战报头：无筛选逐字节不变，有筛选才加范围行 ==');
{
  /* 用一条最小消息（kind=chat）即可，只比头部文本 */
  const msgs = [{seq:1, id:'593353:1', ts:dayStart('2026-11-01') + 3600000,
    kind:'chat', from:'老王', actor:null, payload:{text:'测试一句话'}}];
  const meta = {code:'593353', rule:'generic', exportedAt:'2026-11-03 12:00', renewed:1,
    keepUntil:Date.now() + 30 * 86400000};
  const plain = renderBattleMd(msgs, meta);
  const filtered = renderBattleMd(msgs, Object.assign({}, meta, {filterText:'2026-11-01 · 参与者：老王'}));
  ok('无筛选时不含「导出范围」', !/导出范围/.test(plain));
  ok('★ 有筛选时含「导出范围」', /导出范围：2026-11-01/.test(filtered));
  ok('★ 有筛选时写明只给这批续期', /只给本次导出的这些消息续期/.test(filtered));
  eq('★ 除新增那两行外，正文逐字一致',
    filtered.replace('> 导出范围：2026-11-01 · 参与者：老王　｜　只给本次导出的这些消息续期 30 天\n\n', ''), plain);
}

console.log('---------------------------');
console.log('导出筛选单测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
