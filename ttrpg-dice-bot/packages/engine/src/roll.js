/* roll.js — 4 掷骰执行（优劣势按规则收敛）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { RNG } from './rng.js';

function rollOnce(g){ const a = []; for(let i = 0; i < g.n; i++) a.push(RNG.die(g.sides)); return a; }
function sumArr(a){ return a.reduce((x, y) => x + y, 0); }

// mode: 'adv' | 'dis' | null
function rollGroups(groups, mode, ruleKey){
  const dnd = (ruleKey === 'dnd5e' || ruleKey === 'dnd5r');
  const out = groups.map(g => ({n:g.n, sides:g.sides, sign:g.sign, tries:[], kept:[], keptIdx:0}));
  if(!mode){
    out.forEach(g => { g.tries = [rollOnce(g)]; g.kept = g.tries[0]; g.keptIdx = 0; });
    return out;
  }
  if(dnd){
    // D&D：优劣势只作用于 d20 项，其余骰正常投一次
    out.forEach(g => {
      if(g.sides === 20){ g.tries = [rollOnce(g), rollOnce(g)]; }
      else { g.tries = [rollOnce(g)]; }
    });
    out.forEach(g => {
      if(g.tries.length === 2){
        const hi = sumArr(g.tries[0]) >= sumArr(g.tries[1]) ? 0 : 1;
        const lo = 1 - hi;
        g.keptIdx = mode === 'adv' ? hi : lo;
      } else g.keptIdx = 0;
      g.kept = g.tries[g.keptIdx];
    });
    return out;
  }
  // 通用 / COC / DH / FU：整条指令连投两次，按整条总和取高 / 低
  const t1 = out.map(rollOnce), t2 = out.map(rollOnce);
  const s1 = t1.reduce((a, r) => a + sumArr(r), 0), s2 = t2.reduce((a, r) => a + sumArr(r), 0);
  const pick = mode === 'adv' ? (s1 >= s2 ? 0 : 1) : (s1 <= s2 ? 0 : 1);
  out.forEach((g, i) => { g.tries = [t1[i], t2[i]]; g.keptIdx = pick; g.kept = g.tries[pick]; });
  return out;
}

/* ---------- 5. dnd.js：属性 / 技能表 / 熟练加值 ---------- */

export { rollOnce, sumArr, rollGroups };
