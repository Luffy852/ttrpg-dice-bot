# 开发节奏约定 + 当前检查点（2026-10-29）

## 0. 工作计划的拟定原则（★ 以后默认遵守，不用再强调）

1. **小步快跑，按里程碑交付**：每轮对话只推进**一个节点性里程碑**，做完即复验、即汇报、即停。
   不接受"一次性做完全部阶段" —— 一次大改动里的小错误需要海量全局排查，代价远大于多走几轮。
2. **每个里程碑内部也要可分段**：优先把"不好中断"的完整动作（如拆包）单独成一轮，中途不插入别的工作。
3. **不确定就暂停确认**：需求歧义、部署环境限制不明、或有多种合理做法时，先停下来问再动手 ——
   方向错了返工的成本远高于问一句。
4. **先验证再继续**：每段结束必须有可复现的验证证据（断言数 / 通过率 / 实测输出），
   "我觉得没问题"不算验证。
5. **区分"沙盒已验"与"只有你能验"**：不能验的部分明确标注，不混进"已完成"里。

---

## 1. 当前检查点：**阶段 0 完成（已复验）· 阶段 1 半成品（已固化，未验证）· 暂停待确认**

### 1.1 阶段 0 —— ✅ 完成并通过复验

| # | 交付物 | 验证证据 |
|---|---|---|
| 1 | `packages/engine`：ENGINE 区拆成 **23 个 ESM 模块**（浏览器与 Worker 同一份） | 双路各跑一遍：**676 / 失败 0** |
| 2 | 3 处解环（`util.js` 新增、`renderCardHtml` 迁 `card.js`、注册表单向） | 模块图**零循环** |
| 3 | 单测存活：拼接路 + 真 ESM 路，同一份断言主体 | 两路均 **676 / 0** |
| 4 | 变异测试按文件重定位（22 条一条没删） | **22 / 22 全部抓到** |
| 5 | `tools/check-engine-split.js` 拆包自检 5 项 | **全通过** |
| 6 | `packages/protocol`：帧 / payload 白名单 / 游标工具 | 协议层 **51 / 0** |
| 7 | `apps/worker/src/core.js`：房间内核（幂等 / 游标 / 防重掷，纯逻辑可注入） | 协议层 51 项覆盖 |
| 8 | `packages/engine/src/replay.js`：payload(事实) ⇄ view(派生) 唯一转换口 | 还原出的判定与引擎当时产出**逐字一致** |
| 9 | `packages/engine/src/render-md.js` + `render.js` 的 `detailLines()` 数据层 | **19 条渲染快照逐字节一致**（重构没动版面） |
| 10 | `apps/worker/src/schema.sql`：DO 的 SQLite schema（唯一出处） | 落盘（未在真实 SQLite 跑过，见 1.2） |

**本轮额外修掉的 4 个问题**（都是自检抓出来的，不是我事后想起来的）：
- `hhmm` 在 `cmd.js` 与 `render-md.js` **重名** —— 拼接路会静默覆盖 → 改名
- 自检脚本只认 `export {…}` 块，漏了 `export function X` 形式 → 误报漏 import → 脚本已修
- 引擎侧：COC 的 `replayVerdict` 只回 verdict，把"为什么这个等级"的判定说明丢了 → 改为可回 `{verdict, natNote}`
- 战报在 payload 缺 `n` 时渲染出 `undefinedd6` → 兜底为 `d6`

### 1.2 阶段 1 —— ⚠️ 半成品，**已固化但未验证**

代码已落盘、语法已过、纯逻辑部分已冒烟；**未做端到端验证，不要当成能跑**。

| 文件 | 状态 | 说明 |
|---|---|---|
| `apps/worker/src/core.js` | ✅ **已验证** | 纯逻辑，协议层 51 项断言真跑过 |
| `apps/worker/src/schema.sql` | 🔶 未验证 | DDL 未在真实 SQLite 执行过（沙盒没装 sqlite 驱动，且 DO 的 `ctx.storage.sql` 与本地 SQLite 语义有差异） |
| `apps/worker/src/auth.js` | 🔶 冒烟已过 | PIN 摘要 / 校验 / token 签发 / 篡改被拒 / 房间号生成，实测输出正确；**未被任何断言锁定** |
| `apps/worker/src/export.js` | 🔶 冒烟已过 | NDJSON 导出 + 回灌 + 战报渲染，实测正确；**未被任何断言锁定** |
| `apps/worker/src/room.js`（DO） | ⬜ **沙盒跑不了** | 依赖 `cloudflare:workers`，只能你部署后验 |
| `apps/worker/src/index.js`（路由） | ⬜ 未验证 | 与 room.js 联调 |
| `apps/worker/wrangler.toml` | ⬜ 未验证 | 配置正确性需 `wrangler deploy` 验 |
| `apps/web/index.html` | 🔶 已生成 | 由 `tools/build-web-shell.mjs` 从 M2 **机械生成**（CSS/DOM 一字不改），未冒烟 |
| `apps/web/src/net.js` / `ui.js` / `main.js` | ⬜ 未验证 | 前端三件套，未跑过 |
| `tests/mock_server.mjs` + `tests/dom_smoke.js`（待写） | ⬜ 未开始 | 这是"前端端到端"在沙盒里唯一能验的入口 |
| `.github/workflows/deploy.yml` | ⬜ 未验证 | 需真实 GitHub + Cloudflare 账号 |

---

## 2. 下一步的两个候选里程碑（等你挑，我再动手）

### 方案 A（推荐）：**阶段 1 的"沙盒可验部分"收口**
把能在沙盒里验的全部验掉、锁进断言，剩下 IO 胶水留给你部署后验：
1. `schema.sql` 在 node 里用 SQLite 真跑一遍（建表 / 插消息 / 游标查询 / 清理）
2. `auth.js` + `export.js` 补断言（PIN 固化、token 过期、NDJSON 回灌）
3. `tests/dom_smoke.js`：jsdom 跑 `apps/web/index.html` + mock server，验**零 JS 错误 + 四套规则的骰点气泡渲染正常**
4. 补 `tools/check-worker.mjs`：DO 的 storage 接口 ↔ `memory_storage.mjs` 逐方法对齐（两边漂移 = 沙盒全绿、线上全错）

**退出条件**：`npm test` 一条命令跑完引擎 + 协议 + 前端冒烟，全绿。

### 方案 B：**先不动代码，你先部署一次空壳**
我出部署指引与自查清单，你把 Worker 骨架部署上去（房间号能建、ws 能连、能发一条 `.r 1d6`），
拿到真实反馈后再回来补。好处是早点暴露 Cloudflare 侧的配置问题（wrangler / DO 绑定 / Static Assets），
坏处是我这边的前端还没验过，出问题不好定位是前端还是部署。

---

## 3. ✅ 你已拍板的两件事

- **占用监测只看本项目**：其他两个小 Worker 忽略，心理预算已锁给骰娘 → 指引第 7 节按此写。
- **下一步**：阶段 1 剩余部件收口 + 模拟测试 → 部署指引 + 测试清单 → **进入实际部署测试**。

---

## 4. 🟢 阶段 1 收口已完成（2026-10-29 同一轮）

新增验证（全部可复现，`npm test` 一条命令跑完）：

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `tests/test_schema.mjs` | schema.sql 在**真 SQLite** 里建表/索引/约束；DO storage 同构实现跑通 core 全流程；30 天清理 | **27 / 0** |
| `tests/test_worker.mjs` | PIN 只存摘要 / 错误不泄露位置 / token 不可伪造与过期 / 房间号 / NDJSON 回灌 / 战报与气泡同源 | **42 / 0** |
| `tests/dom_smoke.js` | jsdom 真跑 `apps/web/index.html` + 内存服务端（调生产 core/engine）：四套规则 + 幂等 + 重连去重 | **全通过** |
| `tools/check-worker.mjs` | 三份 storage 实现逐方法对齐 + schema 唯一出处 + Worker 侧禁踩坑 | **27 / 0** |
| `tools/gen-render-snapshot.mjs` | 渲染产物逐字节快照（重构没动版面） | **19 条一致** |

**变异验证过这些新断言不是摆设**（4 组，故意改坏 → 必须变红）：
删 `existsSeq` → 接口检查红；删索引 → schema 一致红；去掉 msg_id 去重 → 冒烟红；去掉幂等 → 冒烟红。

**本轮修掉的 3 个真问题**：
1. `dom_smoke` 只应用 `r.me` 漏掉广播 —— 自己掷的骰回不到前端（占位气泡永不替换）
2. 战报在 payload 缺字段时渲染出 `undefinedd6`
3. `hhmm` 在两模块重名 —— 拼接路会静默覆盖

## 5. 产出文档（供部署与验收）

- `docs/部署指引.md` —— 针对"以前只传静态 index.html"的差异说明 + 一步步命令 + 三个特有坑
- `docs/测试项目清单.md` —— A~I 九组，**每条标注"沙盒已验 ✅ / 只能实机验 ⬜"**，避免重复劳动

## 6. ✅ 测试收口已完成（依赖恢复后全部复跑）

| 测试 | 结果 |
|---|---|
| 引擎拼接路 / 真 ESM 路 | **676 / 0** ×2 |
| 协议层 | **51 / 0** |
| schema（真 SQLite） | **27 / 0** |
| Worker 纯逻辑 | **42 / 0** |
| 端到端冒烟（jsdom） | **全通过** |
| 拆包自检 / 接口检查 / 规则注册点自检 | **全通过** |
| 变异测试 | **22 / 22** |
| 渲染快照 | **19 条逐字节一致** |

> 此前 `test_schema` 与 `dom_smoke` 因沙盒在重装本地测试依赖（jsdom / sql.js）时中断而跑不了，
> 依赖恢复后已全部复跑通过 —— 是环境问题，不是代码问题。这两个库**只用于本地测试，部署不需要**。

## 7. 🟢 「加新规则的成本」—— 实测结论

**问**：加新规则是不是只加一个规则包就行？
**答（实测，非推断）**：**主流程确实一行不用改**，但要登记 **1 个新文件 + 9 处注册点**。

实证方式：在 `.scratch/probe/` 复制引擎，加第七个规则包「探针」跑通后删除。
- ✅ `cmd.js` diff **为零**（主流程没碰）
- ✅ 新规则的别名、包、族、域全部生效，原六规则不受影响

新增 `tools/check-rule-registry.js`（15 项自检）：漏登记任何一处就红。
**已做变异验证**（4 组故意漏登记 → 全部变红）：漏 IMPLEMENTED / 域退化为单一域 /
漏 RULE_PACKS / 漏 index.js 导出。

## 8. ✅ 域表迁移已完成（你拍板"改掉吧"）

`CHECK_DOMAIN` / `CARD_DOMAIN` + `checkDomainOf` / `cardDomainOf` 从 `dnd.js` 迁到
**新建的 `packages/engine/src/domains.js`**（连带那两屏"为什么要分域"的注释），
8 个引用方（card/coc/dh/fu/pack_coc/pack_dh/pack_dnd/pack_fu）改 import。

**迁移后全量复验**：引擎 676×2 / 协议 51 / schema 27 / worker 42 / 端到端冒烟 /
拆包自检 / 接口检查 27 / 规则注册点 15 —— **全绿**；变异 22/22；快照 19 条一致。

**新做的变异验证（确认迁移没削弱防护）**：把 fu 域退回 dnd 域 → 红；删掉 fu 域 → 红。

**顺带修掉的隐患**：`load-engine.js` 剥 import 的正则要求"分号后即行尾"，
所以 `import {X} from './y.js'; // 注释` 会被漏过去 → 拼接路崩在
"Cannot use import statement outside a module"。已放宽为允许行尾注释。

## 9. 🟢 新增文档

`docs/添加新规则标准指引.md` —— 6 步清单 + 漏登记的后果表 + 常见坑 + 实测证据。
（写完后发现指引里"必选 8 个接口"写错了：`renderCardHtml` 在 `card.js` 不在包里，
已改为 7 个并与自检脚本对齐。）

## 10. ⏸ 当前停在：等你部署（**零基础版文档已备好**）

（该瑕疵已修，见第 8 节。）

**一个可选的小改进等你点头**：加 `tools/scaffold-rule.mjs`（填规则名自动生成包骨架 +
一次性改好 6 处登记）。我没擅自加 —— 属于独立的小里程碑。

用户说明：无编程与命令行经验，需要小白指引。据此补做三件事：

| 文档 | 用途 |
|---|---|
| `docs/第0步_上传什么.md` | 解压后该看到什么 / 必须有与绝不能有（无 `node_modules`）/ GitHub 网页端与 Desktop 两条上传路线，每步带 ✅❌ 验证点 |
| `docs/部署指引_小白版.md` | **全程网页点击，不用命令行**；先讲"这次和以前传 html 有什么不一样"；每步验证点；术语表 |
| `docs/测试项目清单_小白版.md` | 勾选式；每步写"你应该看到什么"；卡住一次只报一条 |

同时为配合图形界面部署做了两处配置调整：
- `wrangler.toml` **移到仓库根**（Cloudflare 的 GitHub 集成默认在根找它），`main`/`assets` 改相对根的路径
- `deploy.yml` 去掉 `workingDirectory` 与 `secrets: PIN_SECRET` —— PIN_SECRET 改在 Cloudflare 网页端设置，不经过 GitHub

源码已打包：`/data/workspace/ttrpg-dice-bot.zip`（88 项，约 240 KB，不含 `node_modules`）
