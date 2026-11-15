# TRPG · 骰娘在线

一个跑在网页上的多人 TRPG 掷骰房间。开一个 6 位房间号，把链接发给队友，
大家在聊天框里打指令，服务端掷骰后把**同一份带明细的结果**广播给房间内所有人。

**在线地址**：https://dicebot.finewinginnovation.cn
**状态**：**2026-11-15 开发阶段封板、功能冻结**。S1 完整阶段、S2 三模块功能开发、D1 用量根治均已验毕上线；S2-D 全局优化回顾性体检**验毕无修补、代码零改动**；`check:all` 全绿，无进行中工作、无排期中的代码更新包。**2026-11-15 说明性文档同步已在 `main` 与 `preview/dice-bot` 同时进行，两分支仍逐字节一致**。

---

## 能做什么

| | |
|---|---|
| 掷骰 | `.r 2d6+3`、`.r 1d20 adv`；服务端权威掷骰，结果不可篡改 |
| 规则检定 | 通用裸骰 / D&D 5e / 5.5e(2024) / COC 7th / 匕首心 / 最终物语，共六套 |
| 角色卡 | `.st set` 绑卡，`.rc 侦查` / `.dh 敏捷 15` / `.fu dex ins 13` 按卡检定；中文别名全支持 |
| 先攻（DND） | `.ri` 投先攻、`.init` 查看 / 推进 / 结束；双表状态，房间归零时一并清空 |
| 属性生成 | `.coc` / `.dnd` 按组生成属性（1–20 组），不绑房间规则 |
| 专属检定 | `.sc`（COC 理智，自动取卡上 SAN）/ `.ds`（DND 死亡豁免，固定 DC 10 单次结论） |
| 房间 | 6 位数字房间号，可设 4 位 PIN；昵称与角色卡均为房间内作用域 |
| 战报 | 导出 Markdown（给人读）或 NDJSON（可回灌）；导入支持**跨房间合并**、按发生时间重排、重复条目自动跳过 |
| 留存 | 消息默认存 30 天；每次导出 / 导入为当前消息续 30 天（`keep_until`），可跨房间接力 |

举个最小例子：进房 → 打 `.r 1d20+3` → 点开结果气泡，能看到逐骰点数、调整项与合计。

全员同权限，没有主持人 / 房主，也没有暗骰 —— 目的是让跑团小队看到同一份可复核的事实。
**明确不做**：暗骰 / 权限分级、动态资源追踪（HP / SAN）、自定义宏与牌堆、27 点购点等；完整边界见项目档案 §1.3。

---

## 技术选型与架构

```
浏览器（apps/web/，原生 ESM，Cloudflare Workers Static Assets 托管）
   │  HTTPS + WebSocket
   ▼
Cloudflare Worker（apps/worker/src/index.js）
   │  建房间 / join / meta / 导出 / 导入 / ws 转发
   ▼
Durable Object（每房间一个实例，内置 SQLite）
      消息定序与广播 · 幂等防重掷
      · 按日 lifecycle 清理（消息留存 30 天；**清理按日一次**，提醒与到期另有独立排程）
      · 半开连接巡检由 ws 帧驱动，不进 alarm
```

- **服务端权威掷骰**：客户端只发指令文本，随机源 `crypto.getRandomValues` 在服务端；同一 `req_id` 重发只掷一次。
- **一份引擎两处跑**：`packages/engine`（纯 ESM、零 DOM 依赖）在浏览器与 Worker 中是同一份代码，`packages/protocol` 同理。`apps/web/vendor/` 是**部署期**由 `tools/build-web-shell.mjs` 从这两处源同步出来的副本，**不在 Git 里**；改引擎 / 协议源码后由构建脚本重建，不需要手工同步。
- **只存事实、不存派生值**：消息 payload 存骰面与规则快照，合计 / 成功等级 / Hope-Fear 一律由 `replay.js` 现场推导。聊天流、详情、导出战报共用 `renderRoll()`。
- **用量口径（D1）**：alarm 链改为**按日 lifecycle ＋ O(1) 存在性判据**（不再排 60s 自续、不做 alarm 链上的全表聚合读），半开连接巡检由 ws 帧驱动；「挂着窗口没人操作」不会让 `rows_read` 线性上涨。**项目前提是 Cloudflare Workers 免费方案，不升级付费**。
- **身份**：浏览器本地 `cid` → 服务端 `anon_id`；`PIN_SECRET` 只在 Cloudflare 网页端设置，从不写进仓库。
- **时间统一 UTC+8**：服务端跑 UTC，展示与导出都走同一套时间函数。

---

## 部署

走 **GitHub 网页端推送 → Cloudflare Connect to Git 自动部署**（平台是 Cloudflare **Workers**，不是 Pages）：

- **Build command = `node tools/build-web-shell.mjs`**：部署期生成 `apps/web/index.html`，并从 `packages/engine/src/`、`packages/protocol/src/` 同步出 `apps/web/vendor/**`。生成物共 **32 个 / 220,309 B**，**不进 Git**（`.gitignore` 挡着），改引擎 / 协议源码后由构建脚本重建，不需要手工同步。
- Deploy command、Preview command、Root directory **保持默认**；其余由仓库根的 `wrangler.toml` 决定（含 `[previews]` 预览专用 DO 绑定）。
- **顶级配置不要改**：`name` / DO 绑定 / 迁移 tag 一变会另起空的 DO 命名空间，全部房间数据失联。`[previews]` 块只定义预览实例，数据与生产隔离。
- **预览分支 `preview/dice-bot` 长期保留**：每个包直接往这条分支传，在 Worker Previews 验证后再合并 `main` → 生产复验；**不新建、不删除分支**。
- `PIN_SECRET` 只在 Cloudflare 网页端以 Secret 设置，**生产与每个 Preview 各有独立槽位**，**不要轮换**（换了会让所有带 PIN 的房间永久进不去）。
- 合并瞬间活跃 WebSocket 会断开并自动重连，**挑低活跃时段操作**。

---

## 本地自检（可选）

- `npm run check:all` —— 已前置 `build:web`，从干净仓库拉下来也能一把跑全（引擎 / 协议 / schema / Worker / 静态资源 / 契约守恒 / 变异 / 渲染快照）。
- 真跑端到端 `node --experimental-websocket tests/e2e_real.mjs` 需本地起 workerd（真 DO / 真 SQLite / 真 WebSocket）；`npm run test:quota` 是 D1 用量守恒单项。
- `jsdom` / `sql.js` / `esbuild` / `workerd` 是本地全局测试依赖，部署不需要。**现行基线数字**（引擎 836×2、协议 219、生命周期 81、D1 54、真跑 75/0 等）以项目档案 §0.3 为准。

---

## 项目文档

| 文件 | 用途 |
|---|---|
| `docs/项目档案_在线多房间骰娘_v14.md` | **唯一现行档案 / 项目综述**：关键决策、拐点判断依据、边界性限制与后续开发线索 |
| `docs/用户手册.md` | 给不写代码的人：网页端部署与更新节奏、A–J 真机测试清单 |
| `docs/archive/` | 历史只读留痕（v5 / v10 / v12 / v13 及早期过程文档），**不作现行入口** |
| 《工具开发协作手册》H3 /《跨对话协作框架》F3 /《项目档案_模板》T3 | 跨项目通用资产，本地留存，**不进本仓库** |

> 项目已封板，不再新增功能。若未来真的要重启开发，按档案 §0.8 的细度顺序读，从 `main` 拉代码，并先确认方向与边界（§5 是已量化的后续线索，不是待办）。
