# TRPG · 骰娘在线

一个跑在网页上的多人 TRPG 掷骰房间。开一个 6 位房间号，把链接发给队友，
大家在聊天框里打指令，服务端掷骰后把**同一份带明细的结果**广播给房间内所有人。

**在线地址**：https://dicebot.finewinginnovation.cn
**状态**：v1 已完成开发并通过电脑 Chrome / iPhone / 安卓真机验收（2026-11-03）。

---

## 能做什么

| | |
|---|---|
| 掷骰 | `.r 2d6+3`、`.r 1d20 adv`；服务端权威掷骰，结果不可篡改 |
| 规则检定 | D&D 5e / 5.5e(2024)、COC 7th、匕首心、最终物语，另有通用裸骰 |
| 角色卡 | `.st set` 绑卡，`.rc 侦查` / `.dh 敏捷 15` / `.fu dex ins 13` 按卡检定；中文别名全支持 |
| 房间 | 6 位数字房间号，可设 4 位 PIN；昵称与角色卡均为房间内作用域 |
| 战报 | 导出 Markdown（给人读）或 NDJSON（可回灌）；导入支持**跨房间合并**、按发生时间重排、重复条目自动跳过 |
| 留存 | 消息默认存 30 天；每次导出 / 导入为当前消息续 30 天（`keep_until`），可跨房间接力 |

举个最小例子：进房 → 打 `.r 1d20+3` → 点开结果气泡，能看到逐骰点数、调整项与合计。

全员同权限，没有主持人 / 房主，也没有暗骰 —— 目的是让跑团小队看到同一份可复核的事实。

---

## 技术选型与架构

```
浏览器（apps/web/，零构建原生 ESM，Workers Static Assets 托管）
   │  HTTPS + WebSocket
   ▼
Cloudflare Worker（apps/worker/src/index.js）
   │  建房间 / join / meta / 导出 / 导入 / ws 转发
   ▼
Durable Object（每房间一个实例，内置 SQLite）
      消息定序与广播 · 幂等防重掷 · 30 天 alarm 清理
```

- **服务端权威掷骰**：客户端只发指令文本，随机源 `crypto.getRandomValues` 在服务端；同一 `req_id` 重发只掷一次。
- **一份引擎两处跑**：`packages/engine`（纯 ESM、零 DOM 依赖）在浏览器与 Worker 中是同一份代码，靠 `apps/web/vendor/` 同步；`packages/protocol` 同理。
- **只存事实、不存派生值**：消息 payload 存骰面与规则快照，合计 / 成功等级 / Hope-Fear 一律由 `replay.js` 现场推导。聊天流、详情、导出战报共用 `renderRoll()`。
- **身份**：浏览器本地 `cid` → 服务端 `anon_id`；`PIN_SECRET` 在 Cloudflare 网页端设置。
- **时间统一 UTC+8**：服务端跑 UTC，展示与导出都走同一套时间函数。

部署走 **GitHub 网页端推送 → Cloudflare Connect to Git 自动部署**，构建命令与根目录留空，由仓库根的 `wrangler.toml` 决定一切。
