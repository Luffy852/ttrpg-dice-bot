# 在线多房间骰娘 · M3 仓库

> 状态：**阶段 0（工程地基）+ 协议内核 已完成并通过验证**；Worker / DO 的 IO 层与前端尚未动。
> 上一阶段产物（M2 单文件引擎）冻结在 `legacy/`，只作对照，不再改动。

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
packages/engine/src/      21 个 ESM 模块 + replay.js（引擎，浏览器与 Worker 同一份）
packages/protocol/src/    frames.js / payload.js / cursor.js（前后端共用）
apps/worker/src/
  core.js                 ★ 房间内核（纯逻辑：幂等 / 游标 / 防重掷 / 事实化）
  schema.sql              ★ DO 的 SQLite schema（唯一出处）
  room.js / index.js …    待做（DO 与 HTTP 路由，只剩 IO 胶水）
apps/web/                 待做（沿用 M2 的 DOM 与 CSS，呈现一版不动）
tools/
  split-engine.mjs        一次性迁移脚本（保留以备复核）
  load-engine.js          拼接路加载器
  check-engine-split.js   拆包自检 5 项
tests/
  test_engine.js / test_engine_esm.mjs / mutate_engine_test.js
  test_protocol.js        协议层 51 项
  memory_storage.js       core.js 的内存替身（同接口，DO 版换成 SQLite）
legacy/M2_骰娘单机可摸版.html   M2 冻结存档（对照用，不改）
```

---

## 6. 已验证 vs 未验证（★ 别混为一谈）

**已验证（沙盒内真跑真断言）**
- 引擎 676 项 ×2 路、变异 22/22、拆包自检 5 项
- 协议：幂等防重掷（重发同 `req_id` 不多掷一颗骰）、seq 单调、重连补齐无重复无遗漏、
  客户端 `msg_id` 去重、超长/限流显式拒、payload 不含 total/verdict（原则 6）、
  **从 payload 还原的判定与引擎当时产出逐字一致**（COC 困难成功 / FU 暴击 / DH 关键成功）
- `core.js` 的全部机制（纯逻辑 + 注入 storage，不需要 Cloudflare）

**未验证（只能由你真机部署后验）**
- Cloudflare Worker / Durable Object 的**真实部署**（沙盒无账号鉴权，部署不了）
- 多设备进房的广播一致性与延迟、真机断网重连、PIN 流程
- 30 天 / 500M 清理的实际触发

> 这两栏分开写，是为了避免"本地跑通 = 验过了"的错觉（手册增补 6.6 新增盲区第 1 条）。

---

## 7. 下一轮做什么

1. `apps/worker/src/room.js`：用 `schema.sql` 实现 `core.js` 的 storage 接口（SQLite）+ ws 广播 + alarm
2. `apps/worker/src/index.js`：HTTP 路由（建房间 / 加入 / meta / 导出）+ 静态资源
3. `apps/web/`：沿用 M2 的 DOM 与 CSS，只换数据来源（ws 而非本地计算），呈现**一版不动**
4. 前端 `dom_smoke.js` 改为跑 `apps/web/index.html` + mock WebSocket
5. 部署指引与自查清单（`wrangler.toml` + GitHub Actions）

---

## 8. 沿用中的铁律（M1/M2 定，M3 继续生效）

- `total` 唯一出处 `buildTotal(骰点, 有序组件表)`；**派生值不进 payload**（`replay.js` 现场推导）
- 同一份渲染不写两遍：聊天流 / 详情 / 战报共用 `renderRoll`（战报复用 `detailLines`）
- 主流程不许认识具体规则（§22 源码级断言 + 注册表单向）
- 规则 × 角色卡是**正交维度**：切规则不静默，卡按自己的族渲染
- 加新规则 = 加一个对象，主流程一行不动
