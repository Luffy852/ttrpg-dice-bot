/* rng.js — 1 均匀随机源（拒绝采样，消除取模偏差）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
const RNG = (() => {
  function randBelow(n){
    if(!(n > 1)) return 0;
    const bits = Math.ceil(Math.log2(n));
    const mask = bits >= 32 ? 0xFFFFFFFF : ((1 << bits) - 1);
    const buf = new Uint32Array(1);
    for(;;){
      crypto.getRandomValues(buf);
      const v = buf[0] & mask;          // 取低 bits 位，均匀
      if(v < n) return v;               // 越界重取，保证严格均匀
    }
  }
  return { randBelow, die: sides => randBelow(sides) + 1 };
})();

/* ---------- 1.5 alias.js：统一别名层 ★ 所有"名字 → 规范键"都走这里 ----------
 * 为什么单独抽一层：别名一开始只做在技能上（18 项），属性没有中文别名 →
 * `.rc 力量` 无法识别。根子是「别名散落在各模块里各写各的」，加新域就要再抄一遍。
 * 现在：一个注册表 + 一个归一化 + 一个冲突检测，任何"用户输入的名字"都查它。
 *
 * 覆盖域：verb 动词 / rule 规则 / check 检定目标（属性+技能）/ mode 优劣势
 *        switch 开关值 / prof 熟练标记 / cardkey 角色卡字段
 * 不同域的同名词互不冲突（.st 是动词，st 不是属性），所以按域分桶。
 */

export { RNG };
