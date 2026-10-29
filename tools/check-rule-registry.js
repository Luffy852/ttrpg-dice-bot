/* ============================================================================
 * check-rule-registry.js —— 规则注册点自检：**加新规则时，漏一处就红**
 * ----------------------------------------------------------------------------
 * 【为什么要有这个】
 *   "加新规则 = 加一个对象"这句话**只对了一半**：主流程确实一行不用改
 *   （实测过：加了第七个规则包，`cmd.js` 的 diff 为零），但引擎里有 9 处注册点
 *   必须登记，漏任何一处都不报错，只会**静默半残**：
 *     漏 RULE_META    → 顶栏/.status 里规则名显示 undefined
 *     漏 IMPLEMENTED  → 切规则时提示"尚未实现"
 *     漏 rule 别名    → `.set rule 新规则` 认不出来
 *     漏 CHECK_DOMAIN → 检定目标查不到（同名词在不同规则下互相抢键）
 *     漏 CARD_DOMAIN  → 角色卡字段认不出来
 *     漏 RULE_PACKS   → 直接取不到包
 *     漏 FAMILY_PACKS → 角色卡按它自己的族渲染时取不到包
 *     漏 index.js     → 浏览器/Worker 里根本没有这个模块
 *   这些都不会让 676 项断言变红（断言只测已有规则），所以必须靠扫描来兜住。
 *
 * 【怎么用】 node tools/check-rule-registry.js
 * 【加新规则时】照它报的缺项补齐即可；全绿才算登记完整。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'packages', 'engine', 'src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js'));

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

const rulesSrc = read('rules.js');
const packsSrc = read('packs.js');
const domSrc   = read('domains.js');
const indexSrc = read('index.js');

/* ① 规则的"全集"来自 RULE_META —— 它是唯一权威名单 */
const metaBlock = (rulesSrc.match(/RULE_META\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
const ruleKeys = [...metaBlock.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1]);
ok('取到 RULE_META 名单', ruleKeys.length > 0, ruleKeys.join(','));
console.log('（规则全集 ' + ruleKeys.length + ' 个：' + ruleKeys.join(' ') + '）');

/* ② IMPLEMENTED */
const implBlock = (rulesSrc.match(/IMPLEMENTED\s*=\s*new Set\(\[([^\]]*)\]/) || [])[1] || '';
const impl = [...implBlock.matchAll(/'([^']+)'/g)].map(m => m[1]);
ok('★ IMPLEMENTED 覆盖全部规则', ruleKeys.every(k => impl.includes(k)),
  '缺：' + ruleKeys.filter(k => !impl.includes(k)).join(','));

/* ③ rule 别名（含中文） */
const aliasBlock = (rulesSrc.match(/registerAliases\('rule',\s*\[([\s\S]*?)\n\]\);/) || [])[1] || '';
const aliasKeys = [...aliasBlock.matchAll(/\{key:'(\w+)'/g)].map(m => m[1]);
ok('★ 每个规则都有别名条目', ruleKeys.every(k => aliasKeys.includes(k)),
  '缺：' + ruleKeys.filter(k => !aliasKeys.includes(k)).join(','));

/* ④ RULE_PACKS（规则键 → 包） */
const rp = (packsSrc.match(/RULE_PACKS\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const rpKeys = [...rp.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
ok('★ RULE_PACKS 覆盖全部规则', ruleKeys.every(k => rpKeys.includes(k)),
  '缺：' + ruleKeys.filter(k => !rpKeys.includes(k)).join(','));

/* ⑤ FAMILY_PACKS（族 → 包）：generic 没有卡族，除外 */
const fp = (packsSrc.match(/FAMILY_PACKS\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const fpKeys = [...fp.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
const famOf = k => (k === 'dnd5e' || k === 'dnd5r') ? 'dnd' : (k === 'generic' ? null : k);
const needFam = [...new Set(ruleKeys.map(famOf).filter(Boolean))];   // ★ dnd5e/dnd5r 同族，要去重
ok('★ FAMILY_PACKS 覆盖全部卡族', needFam.every(f => fpKeys.includes(f)),
  '缺：' + needFam.filter(f => !fpKeys.includes(f)).join(','));

/* ⑥ CHECK_DOMAIN / CARD_DOMAIN —— domains.js（M3 已从 dnd.js 迁出） */
const cd = (domSrc.match(/CHECK_DOMAIN\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const cdKeys = [...cd.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
ok('★ CHECK_DOMAIN 覆盖全部卡族', needFam.every(f => cdKeys.includes(f)),
  '缺：' + needFam.filter(f => !cdKeys.includes(f)).join(','));
const cdVals = [...cd.matchAll(/:?'([^']+)'/g)].map(m => m[1]);
ok('★ CHECK_DOMAIN 各域互不相同（不许退回单一域）', new Set(cdVals).size === cdVals.length && cdVals.length === needFam.length,
  cdVals.join(',') + '（族数 ' + needFam.length + '）');
const kd = (domSrc.match(/CARD_DOMAIN\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const kdKeys = [...kd.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
ok('★ CARD_DOMAIN 覆盖全部卡族', needFam.every(f => kdKeys.includes(f)),
  '缺：' + needFam.filter(f => !kdKeys.includes(f)).join(','));

/* ⑦ index.js 导出每个 pack_*.js */
const packFiles = files.filter(f => /^pack_\w+\.js$/.test(f));
const notExported = packFiles.filter(f => !indexSrc.includes("'./" + f + "'"));
ok('★ index.js 导出了全部规则包', notExported.length === 0, '缺：' + notExported.join(','));

/* ⑧ 每个包都必须实现规则包接口（缺方法会在用到时才炸） */
{
  // ★ runCheck 是**条件必选**：supportsCheck:false 的包（通用/匕首心/最终物语）本来就不走 .rc，
  //   强制要求会逼它们写空实现 —— 空实现比没有更糟（看着支持，其实什么都不做）
  const base = ['family','checkHint','listChecks','checkOffNote','cardTemplate','parseCard','renderCard'];
  const pkgs = {};
  for(const f of packFiles){
    const s = read(f);
    // 两种写法都要认：`export const X = {`（新包）与 `const X = {` + `export { X }`（搬来的包）
    const name = (s.match(/export const (\w+)\s*=\s*\{/) || s.match(/const (\w+_PACK)\s*=\s*\{/) || [])[1];
    if(!name){ ok(f + ' 找不到导出的包对象', false); continue; }
    pkgs[name] = s;
    const need = /supportsCheck\s*:\s*true/.test(s) ? base.concat('runCheck') : base;
    const miss = need.filter(m => !new RegExp('\\b' + m + '\\b').test(s));
    ok('★ ' + f + ' 实现了包接口', miss.length === 0, '缺：' + miss.join(','));
  }
}

/* ⑨ 帮助页：每个已实现规则应有 `.help <规则>` 子页 */
{
  const help = read('help.js');
  const noHelp = ruleKeys.filter(k => k !== 'generic' && !new RegExp("['\"]?" + k + "['\"]?\\s*:").test(help));
  ok('★ 每个规则都有帮助子页', noHelp.length === 0, '缺：' + noHelp.join(','));
}

console.log('---------------------------');
console.log('规则注册点自检：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail === 0){
  console.log('');
  console.log('📋 加新规则的完整清单（照着改，改完跑本脚本，全绿才算登记完整）：');
  console.log('   1) 新建 packages/engine/src/pack_<规则>.js（实现 9 个接口方法）');
  console.log('   2) packs.js：import 该包 + RULE_PACKS 加一行 + FAMILY_PACKS 加一行');
  console.log('   3) rules.js：RULE_META 加一项 + IMPLEMENTED 加一项 + registerAliases(\'rule\') 加别名');
  console.log('   4) domains.js：CHECK_DOMAIN 加一项 + CARD_DOMAIN 加一项');
  console.log('   5) index.js：export * from \'./pack_<规则>.js\'');
  console.log('   6) help.js：加该规则的帮助子页');
  console.log('   ✅ 主流程 cmd.js 不需要改（已实测：加第七规则时它的 diff 为零）');
  console.log('');
  console.log('✅ 架构已理顺：CHECK_DOMAIN / CARD_DOMAIN 在 domains.js（不再需要改 dnd.js）。');
}
process.exit(fail ? 1 : 0);
