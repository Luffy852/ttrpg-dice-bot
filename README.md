# 在线多房间骰娘 · M3 仓库

> 状态：**已上线运行**（Cloudflare Workers + Durable Object，前端零构建托管）。
> **2026-11-01：真机验收轮的全部改动已部署，等待测试评估。**
> 上一阶段产物（M2 单文件引擎）冻结在 `legacy/`，只作对照，不再改动。
>
> **★ 新读者请先读 `docs/交接文档_v3.md`** —— 它记录了最新一轮真机验收修了什么、哪些口径已拍板、
> 哪些还没验。`CHECKPOINT.md` 是历史演进，本文件是工程结构与铁律。

---

## 0.5 关于文档里的数字

下面第 1 节是**阶段 0 那一轮**的记录，里面的 "676 项" 是**当时**的数字，保留原样不回改。
**当前基线（2026-11-01）是：引擎 722×2 · 协议 216 · schema 28 · Worker 103 · 接口检查 27 ·
静态资源 231 · 变异 22/22 · 快照 19 条**，以 `docs/交接文档_v3.md` 为准。

---

## 1. 这一轮做了什么

| # | 事项 | 证据 |
|---|---|---|
| 1 | **ENGINE 区抽成 `packages/engine`**（21 个 ESM 模块，浏览器与 Worker 同一份） | 双路各跑一遍：**676 项 / 失败 0** |
| 2 | **3 处解环**（否则 ESM 下 TDZ 崩溃） | 模块图**零循环** |
| 3 | **单测活下来**：拼接路 + 真 ESM 路，同一份断言 | 见下 |
| 4 | **变异测试按文件重定位**（22 条一条没删） | **22 / 22 全部抓到** |
| 5 | **新增拆包自检**（5 项，抓"测试全绿但线上炸"的类型） | **全通过** |
| 6 | **`packages/protocol`**：帧 / payload 白名单 / 游标工具 | 31 个导出 |
| 7 | **`apps/worker/src/core.js`**：房间内核（幂等 / 游标 / 防重掷，纯逻辑可注入） | 协议层 **51 项全绿** |
| 8 | **`packages/engine/src/replay.js`**：payload(事实) ⇄ view(派生) 唯一转换口 | 还原出的判定与引擎当时产出**逐字一致** |
| 9 | DO 的 `schema.sql` 落盘 | — |

---

## 2. 怎么跑

```bash
npm test           # 引擎拼接路 + 引擎 ESM 路 + 协议层
npm run test:engine       node tests/test_engine.js        # 拼接路（断言主体零改动）
npm run test:engine:esm   node tests/test_engine_esm.mjs   # 真 ESM 路（同一份断言）
npm run test:protocol     node tests/test_protocol.mjs      # 幂等 / 游标 / 防重掷 / 事实化 / 还原
npm run mutate            node tests/mutate_engine_test.js # 22 条变异，验证断言不是摆设
npm run check             node tools/check-engine-split.js # 拆包自检 5 项
npm run check:all         # 上面全部串起来跑
```

零依赖，不需要 `npm install`（node 18+）。

---

## 3. 为什么是"双路"跑同一份断言

| 路 | 干什么 | 能抓什么 |
|---|---|---|
| **拼接路** `test_engine.js` | 把 `src/*.js` 剥掉 import/export 拼成单一作用域 | 保住"676 项断言一行不用改" |
| **ESM 路** `test_engine_esm.mjs` | 原生 `import`，再把**同一段断言主体**注入求值 | **TDZ / 循环依赖 / 漏 import** —— 拼接路这三类全不报错 |

> 漏 import 的阴险之处：拼接路刚好有那个符号所以不报错，**浏览器里才炸**。
> 所以 `tools/check-engine-split.js` 第 ② 项专门扫"用到别的模块的导出却没 import"。

两路跑的是**同一份断言文本**（ESM 路从 `test_engine.js` 里抠出主体注入），
不会漂移成两套测试 —— 改断言两路同时变。

---

## 4. 3 处解环（拆包真正动手的地方）

| # | 环 | 做法 | 逻辑改动 |
|---|---|---|---|
| ① | 十几个模块都为 `esc` / `fmtMod` 反向依赖 `render.js` | 提成零依赖的 `util.js` | 0 |
| ② | `render.js` 用 `cardMod`、`card.js` 用 `renderCardHtml` | `renderCardHtml` 迁入 `card.js`（卡渲染属卡域） | 0 |
| ③ | 注册表 `packs.js` 顶层引用 `GENERIC_PACK`，包反查注册表即成环 | 注册表**单向** import 五个包；包内需查别的包 → 调用方注入或上移 `cmd.js` | 0 |

> 三处都不改一行逻辑 —— 676 项全绿可证。
> 迁移脚本 `tools/split-engine.mjs` 保留在仓库里："拆包是搬文件不是重写"这句话能被重跑验证。

---

## 5. 目录现状

```
packages/engine/src/      25 个 ESM 模块（含 replay.js / render-md.js，浏览器与 Worker 同一份）
packages/protocol/src/    frames.js / payload.js / cursor.js（前后端共用）
apps/worker/src/
  core.js                 ★ 房间内核（纯逻辑：幂等 / 游标 / 防重掷 / 事实化 / 导入重排）
  schema.sql              ★ DO 的 SQLite schema（唯一出处）
  room.js                 DO：ws 收发 / 广播 / alarm（30 天清理 + 半开连接巡检）
  index.js                HTTP 路由网关（建房间 / join / meta / 导出 / 导入 / ws 转发）
  export.js               NDJSON（可回灌）+ Markdown 战报
apps/web/                 前端零构建：原生 ESM，整个目录托管
  index.html              ★ 由 tools/build-web-shell.mjs 从 legacy 生成，**不要手改**
  src/main.js             进房 / 发指令 / 导入导出接线
  src/net.js              ws：重连退避 / 游标补齐 / 心跳
  src/ui.js               聊天流呈现（沿用 M2 真机验过的 DOM 与 CSS）
  src/batch.js            ★ 批次分发的**唯一实现**（生产与冒烟共用，不许各写一份）
  vendor/                 引擎与协议的浏览器侧副本（由 tools 同步，防漂移）
tools/
  build-web-shell.mjs     从 legacy 生成 index.html（顶栏 / 进房页 / 新增样式都在这里加）
  load-engine.js          拼接路加载器（★ 剥 import 靠正则，export 必须单行）
  check-engine-split.js   拆包自检
  check-worker.mjs        ★ 三份 storage 实现逐方法对齐 + schema 唯一出处
  gen-render-snapshot.mjs 渲染产物逐字节快照
tests/
  test_engine.js / test_engine_esm.mjs / mutate_engine_test.js
  test_protocol.mjs       协议层 216 项
  test_schema.mjs         真 SQLite 跑 schema + DO storage 同构实现
  test_worker.mjs         PIN / token / 导出回灌 / 战报同源
  dom_smoke.js            jsdom 跑 index.html + 内存服务端（端到端）
  memory_storage.mjs / sqlite_storage.mjs   core.js 的两份 storage 替身
legacy/M2_骰娘单机可摸版.html   M2 冻结存档（对照用，不改）
```

---

## 6. 已验证 vs 未验证（★ 别混为一谈）

**已验证（沙盒内真跑真断言，2026-11-01 基线）**

| 测试 | 数字 |
|---|---|
| 引擎（拼接路 / 真 ESM 路） | 722 / 0 ×2 |
| 协议层 | 216 / 0 |
| schema 与 storage（真 SQLite） | 28 / 0 |
| Worker 纯逻辑 | 103 / 0 |
| Worker 接口检查（三份 storage 对齐） | 27 / 0 |
| 静态资源自检 | 231 / 0 |
| 变异测试 | 22 / 22 |
| 渲染快照 | 19 条逐字节一致 |
| 端到端冒烟（jsdom） | 全通过 |

另有**本地真实运行时**（workerd）：能跑 DO 与 ws，本轮多个只有端到端才暴露的 bug
（网关丢 cid / 忘转 token 查询串）都靠它发现。用法见 `docs/交接文档_v3.md` 第 2 节。

**未验证（只能真机验）**
- 30 天清理的实际触发、提前 7 天广播
- **续期的实际生效**（现在只能确认 `keep_until` 写进去了，要等 30 天后看老消息还在不在）
- 500 MB 全局清理
- 8 人同时在线的扇出延迟
- 手机上翻手势（用户因自动加载生效，未真机确认入口出现过）
- 跨房间导入在**真实两个房间**之间跑一遍（已有的是脚本造的数据）

> 这两栏分开写，是为了避免"本地跑通 = 验过了"的错觉（手册增补 6.6 新增盲区第 1 条）。

---

## 7. 下一轮做什么

**2026-11-01 的状态：代码已全部部署，下一步是真机测试评估 + 修反馈。**

新对话的优先级（详见 `docs/交接文档_v3.md` 第 4 节）：

1. **短期可验**：真实两个房间之间跑一次跨房间导入、手机上翻入口、来源标注显示效果
2. **等时间**：30 天清理、续期生效
3. **需拉人**：8 人并发

**动代码前先读交接文档 v3 第 3 节（已拍板的 10 条口径）与第 5 节（6 个"别改回去"）。**
用户明确要求：**有非唯一性方案时先提建议让他定，再写代码实现落盘。**

---

## 8. 沿用中的铁律（M1/M2 定，M3 继续生效）

- `total` 唯一出处 `buildTotal(骰点, 有序组件表)`；**派生值不进 payload**（`replay.js` 现场推导）
- 同一份渲染不写两遍：聊天流 / 详情 / 战报共用 `renderRoll`（战报复用 `detailLines`）
- 主流程不许认识具体规则（§22 源码级断言 + 注册表单向）
- 规则 × 角色卡是**正交维度**：切规则不静默，卡按自己的族渲染
- 加新规则 = 加一个对象，主流程一行不动
