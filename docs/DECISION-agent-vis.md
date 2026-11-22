# 决策：@starsea/agent-vis 能不能直接嵌进对话栏

> 结论先说：**不能当「可视化面板」嵌。** 它是个独立 CLI + 独立服务器 + 独立前端页面，不是组件库。
> 但它有一样东西我们可以**合法地抄走**：事件分类口径（family 分类）。
> 本文只给判断和取舍，不含代码改动。原方案见 `PLAN-trace-v2.md`。

---

## 1. agent-vis 到底是什么

从 npm registry 元数据（`@starsea/agent-vis@0.4.0`，MIT，2026-04-07 首发、04-09 停更）：

```
description : Pipe agent CLI JSONL output to a live web visualizer
bin         : agent-vis → bin/agent-vis.mjs
main        : ./dist/server.js          ← 不是组件入口，是服务器入口
dependencies: express ^5.1.0, open ^10.1.0, @starsea/normalizer
devDeps     : react 19, react-dom, vite 6, tailwindcss 4, lucide-react
keywords    : cli, jsonl, codex, claude, opencode, pipe
fileCount   : 8
```

**它不是一个 UI 库。** 它的使用方式是：

```bash
claude -p "..." --output-format stream-json | npx @starsea/agent-vis claude
```

也就是：**从 stdin 吃 JSONL → 自己起一个 express 服务器（默认 3130 端口）→ 自动打开浏览器看一个独立页面。**

`react` / `vite` / `tailwind` / `lucide-react` **全在 devDependencies 里** —— 意味着前端那套 React 组件在构建期被 vite 打包成静态产物塞进 `dist/`，**不对外导出任何组件**。`fileCount: 8` 也印证了这点：发布物就是 server.js + 一份打包好的静态资源 + bin。

所以：

| 你想的 | 实际 |
|---|---|
| `import { TracePanel } from '@starsea/agent-vis'` | ❌ 不存在这个导出 |
| 嵌进 `workspace.html` 的对话栏 | ❌ 没有可嵌入的组件 |
| 装进 MinePage 让它接管进程 | ⚠️ 要把它当**独立服务**跑，然后 iframe |
| 用它的解析逻辑 | ✅ 可以（`@starsea/normalizer`，但仍是 JSONL 管道口径） |

---

## 2. 你说的「只嵌可视化面板」，实际只有一条路 —— 而这条路的代价很大

如果坚持用，技术上只能这么做：

```
MinePage 后端把事件序列化 → 写成 JSONL → 管道喂给 agent-vis 子进程
                                        → agent-vis 起 :3130
                                        → workspace.html 里 <iframe src="http://127.0.0.1:3130">
```

这条路有 6 个硬问题：

### 2.1 端口与进程

- agent-vis 自己 `app.listen(3130)`，而 MinePage 是**裸 `http.createServer`**（`server.js:4444`），没有 express、没有中间件、没有子路由挂载（我查过）。两套 http 栈无法共用一个端口。
- 生产环境在腾讯云（`111.230.132.13`），nginx 只反代 `127.0.0.1:3000`。**3130 端口对外不可达**，要么再加一条 nginx 反代 + 一条 `location`，要么 MInepage 自己做一个 HTTP 代理转发。都是一次新的运维改动。
- agent-vis 进程崩溃 / 重启，iframe 白屏，MinePage 完全不知道。

### 2.2 认证完全丢失 —— 这条最致命

MinePage 的对话栏是**登录态内**的：`requireLogin(req)` → 只能看自己站点、自己的会话、自己的任务（`server.js:2142` 附近的 cancel 接口就是这么做的）。

而 agent-vis 的 3130 端口**没有任何鉴权**：`GET /api/events` 直接回放全部事件。它设计给「本机开发者调试自己的 CLI」用，默认假设只有你一个人。

放进多用户站点意味着：**任何能访问 3130 的人都能看到所有人的思考内容和文件内容。** 这不是配置问题，是架构假设不匹配。

### 2.3 每个会话一个进程？还是所有人共用一个？

- **共用一个**：事件流混在一起，A 用户能在页面上看到 B 用户的 agent 在干什么。
- **每会话一个**：N 个用户 = N 个端口 + N 个 express 进程。`agent_tasks` 表里现在有多少活跃会话就起多少进程，进程管理、端口分配、回收、孤儿清理全得自己写。

两条都不可接受。

### 2.4 管道方向反了

agent-vis 是 **stdin 管道消费者**（`... | npx agent-vis claude`）。
而 MinePage 的事件是在**进程内**由 `server.js` 的 `pushEvents()` 产生并写进 MySQL 的，前端靠 `GET /api/agent/tasks/:id` 300ms 轮询。

要喂给它，得把「DB 里的事件」再序列化成 JSONL 塞进一个管道。等于**多绕了一圈，还多了一份状态**：MySQL 一份、agent-vis 内存 buffer 一份，两边不同步时没有任何一致性保证。

### 2.5 它认的是「别的 CLI 的事件格式」，不是我们的

它的 `keywords` 就写明了：`codex` / `claude` / `opencode`。`@starsea/normalizer` 的作用是把**这几家的 stream-json** 归一化。

而 MinePage 的事件是自造的：`llm_start` / `tool_end` / `step_end` / `reasoning`（`server.js:1976`）。要用它，得先写一个「MinePage → agent-vis 认的格式」的适配层。这个适配层的复杂度和「自己写渲染器」基本相当，**但不解决渲染问题** —— 因为适配完还是塞进一个独立页面。

### 2.6 停更风险

- 首发 2026-04-07，最后一版 2026-04-09（`time` 字段），**两天后就没再动**。
- 3 个版本的维护者，`@starsea/normalizer` 用 `"*"` 通配依赖（`"@starsea/normalizer": "*"`）—— 这在库代码里是明确的反模式：上游任何破坏性变更都会直接被吃掉。
- 0.4.0 的 `dist.fileCount = 8`，`unpackedSize` 262KB。

对一个要长期跑的课设项目来说，把「对话栏核心体验」押在一个两天定型的包上，风险不对等。

---

## 3. 它值钱的地方 —— 不是代码，是分类口径

抛开集成，agent-vis 的 README 里有一段设计是有价值的：

> Real-time event cards with **family-based categorization** (message, tool, reasoning, error, file)
> Family filter pills (Messages, Tools, Reasoning, Errors, Files)

也就是把事件归成 5 个 **family**：消息 / 工具 / 思考 / 错误 / 文件。

这跟我们方案里「不做『已读取文件』事件，而是从 `tool/result` 派生」是一个思路 —— **渲染层要的是「分类视图」，不是「原始事件流」**。它把 `file` 当成一等 family，这一点比我原方案更进一步，值得吸收：

| family | 我们的来源事件 | 用处 |
|---|---|---|
| `message` | `text/delta` 聚合 | 正文 |
| `reasoning` | `reasoning/delta` 聚合 | 思维链 |
| `tool` | `tool/call` + `tool/result` | 工具步骤日志 |
| `error` | `tool/result` ok=false、`llm/retry` failure、`turn/end` error | 失败与重试 |
| `file` | `tool/result` 里 name ∈ {read_file, list_files, write_file, delete_file} | 已读取/已修改文件 |

另外它 `GET /api/state` 那个快照形状（`eventCount` / `stepMode` / `currentStep` / `completedSteps` / `finished`）也很干净，可以直接借来当我们 `deriveTrace()` 的返回结构。

**这两点是它真正的贡献：口径，不是实现。** 而且口径是设计思想，不受版权约束 —— 连 MIT 声明义务都不触发。

---

## 4. 修订后的建议

原方案 `PLAN-trace-v2.md` 保持主体不变，做两处吸收：

1. **§5.2 `deriveTrace()` 的返回结构**改成 family 视图（+ `eventCount` / `currentStep` / `completedSteps` / `finished`）。
2. **§6.2 面板结构**加一行「文件」聚合区（已读取 / 已修改分开统计），比原来的「已读取文件」更完整。

集成方式**维持自研渲染器**，理由收束成三条：

- 事件已经在**同一个进程 + 同一个数据库 + 带登录态**里，再引出进程、端口、无鉴权的第三方页面，是把简单问题复杂化。
- MinePage 没有 express，加 agent-vis 等于同时引入第二套 http 栈。
- 对话栏的样式体系（`wsTrace*`，`style.css:2704-2832`）已经和站点主题变量（`--panel` / `--text` / `--muted` / `--pink`）绑死。iframe 一个 Tailwind 的独立页面进去，视觉上一定割裂。

---

## 5. 如果你还是想「用现成面板」

有一个比 agent-vis 合理得多的选择：**只抄它的前端构建产物思路，不跑它的服务器**。

具体说，如果你后面愿意接受 React/构建链，可以自己 fork 它的 web 部分，用 vite 打成 `studio-trace.js` 一个文件，作为 MinePage 的静态资源在 `workspace.html` 里引入，数据走 MinePage 自己的 `/api/agent/tasks/:id`。这样：

- 复用它的组件（MIT 允许，需保留声明）
- 不引入 express、不占端口、不丢鉴权
- 样式还能通过 CSS 变量覆盖对齐

**但我不建议现在做** —— 那要在 Node 20 裸 http 项目里引入 vite + React 19 + Tailwind 4 的构建链，为了一个折叠面板。成本远超自研（自研 `studio.js` 里已有 80% 的 DOM 代码，补 family 视图即可）。

---

## 6. 一句话总结

> agent-vis 是「CLI 调试器」，不是「前端组件」。它的形态（独立进程、独立端口、零鉴权、stdin 管道）和 MinePage（单进程、带登录、多用户、MySQL 事件表）在**架构假设上正相反**，嵌不进去。
> 但它的事件 **family 分类**（message/tool/reasoning/error/file）和 `api/state` 快照形状值得吸收 —— 我会把这两点并进 `PLAN-trace-v2.md`。
> 原方案结论不变：**自研渲染器，抄口径不抄实现。**
