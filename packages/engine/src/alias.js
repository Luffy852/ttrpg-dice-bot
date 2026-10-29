/* alias.js — 1.5 统一别名层（分域 + 冲突登记 + 未识别建议）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
function normToken(s){
  if(s == null) return '';
  // NFKC：全角字母/数字/句点 → 半角；再小写、去空格与下划线。保留点号（5.5e ≠ 5e）
  return String(s).normalize('NFKC').trim().toLowerCase().replace(/[\s_]/g, '');
}
const ALIAS = {byDomain:new Map(), conflicts:[]};

function registerAliases(domain, entries){
  let map = ALIAS.byDomain.get(domain);
  if(!map){ map = new Map(); ALIAS.byDomain.set(domain, map); }
  entries.forEach(e => {
    (e.aliases || []).forEach(a => {
      const k = normToken(a);
      if(!k) return;
      const prev = map.get(k);
      if(prev && prev.key !== e.key){
        // 先到先得，冲突登记在案（不静默覆盖，否则后注册的会悄悄抢走前面的键）
        ALIAS.conflicts.push({domain, alias:a, keys:[prev.key, e.key]});
        return;
      }
      map.set(k, e);
    });
  });
}
function lookupAlias(domain, raw){
  const k = normToken(raw);
  if(!k) return null;
  const map = ALIAS.byDomain.get(domain);
  return map ? (map.get(k) || null) : null;
}
// ★ 新增别名前的冲突自查（只报告不注册）。返回 [] 才安全 —— 别名表是静态数据，
//   最大的坑就是新增时撞上已有键（inti / int 那一类）。
function detectConflicts(domain, entries){
  const map = ALIAS.byDomain.get(domain) || new Map();
  const out = [];
  entries.forEach(e => (e.aliases || []).forEach(a => {
    const k = normToken(a);
    const prev = map.get(k);
    if(prev && prev.key !== e.key) out.push({domain, alias:a, keys:[prev.key, e.key]});
  }));
  return out;
}
function sortedChars(s){ return Array.from(s).sort().join(''); }
function editDistance(a, b){
  if(a === b) return 0;
  const A = Array.from(a), B = Array.from(b);
  if(Math.abs(A.length - B.length) > 1) return 99;
  const dp = [];
  for(let i = 0; i <= A.length; i++){ dp.push(new Array(B.length + 1).fill(0)); dp[i][0] = i; }
  for(let j = 0; j <= B.length; j++) dp[0][j] = j;
  for(let i = 1; i <= A.length; i++)
    for(let j = 1; j <= B.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (A[i-1] === B[j-1] ? 0 : 1));
  return dp[A.length][B.length];
}
// 未识别时给建议：字序颠倒优先（察觉/觉察），其次编辑距离 ≤1
function suggestAlias(domain, raw, limit){
  const k = normToken(raw);
  if(!k) return [];
  const map = ALIAS.byDomain.get(domain);
  if(!map) return [];
  const cands = [];
  map.forEach((e, ak) => {
    if(ak === k) return;
    const name = e.display || e.key;
    if(sortedChars(ak) === sortedChars(k)){ cands.push({d:0, name}); return; }  // 字序颠倒：觉察 ↔ 察觉
    // 编辑距离仅对 3 字以上启用：2 字中文改一字往往就是另一个词
    // （"游泳"→"游说" 距离 1 却毫无关系），宁可不建议也不乱指路
    if(ak.length >= 3 || k.length >= 3){
      const d = editDistance(ak, k);
      if(d <= 1) cands.push({d, name});
    }
  });
  cands.sort((x, y) => x.d - y.d);
  const seen = new Set();
  return cands.filter(c => seen.has(c.name) ? false : (seen.add(c.name), true)).slice(0, limit || 2).map(c => c.name);
}

/* ---------- 2. rules.js：规则别名（保留点号，精确 Map 匹配） ---------- */

export { normToken, ALIAS, registerAliases, lookupAlias, detectConflicts, sortedChars, editDistance, suggestAlias };
