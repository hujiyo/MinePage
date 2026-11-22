# 对话栏「思维链 + 执行过程」重构方案

> 目标：把工作区对话栏的执行过程面板做成 DSH 那种「思维链 + 工具步骤日志 + 已读取文件 + 执行命令 + 重试记录 + 耗时 + 步骤卡片」的形态。
> 底座参考：DSH（DeepSeek Harness，MIT 协议，<https://dshai.org/>）。
> 本文只给方案，不含代码改动。
>
> **附**：`@starsea/agent-vis` 的评估结论见 `DECISION-agent-vis.md` —— 它不能嵌入（独立进程 + 独立端口 + 零鉴权），但其 **family 分类口径**已被并入本文 §5.2 / §6.2 / §6.4。

---

## 0. 先纠正三个前提

动手前必须先把事实摆正，否则方案会建在错的地基上。

### 0.1 项目里没有 `AGENT.md`

实际存在的只有：

| 文件 | 作用 |
|---|---|
| `AGENTS.md`（根目录） | 工具调用规则、工作区提示，**自动加载** |
| `.acl-recovery\AGENT.md.bak` | 旧版「验证规则 / 沟通规则」，**已不在加载路径** |
| `MinePage\docs\AGENT-TEST.md` | agent 手动测试清单 |

所以「按 agentmd 优化」实际约束只有两条：**改完不做运行时验证**（自己只做静态检查）、**需求有歧义先问**。本方案遵守这两条，全部验证动作留给你本人。

### 0.2 现在的执行过程面板是**两套实现**，注释在骗人

`public/studio.js:1204` 写着「只保留这一个 `renderTraceItems()`，两边都调它」。实测：

| 函数 | 位置 | 是否有调用方 |
|---|---|---|
| `renderBody()` | `studio.js:1503` | ✅ 实时轮询走这条 |
| `buildTraceFromTask()` | `studio.js:638` | ✅ 刷新后重建走这条 |
| `groupTraceEvents()` | `studio.js:1248` | ❌ **死代码** |
| `renderTraceItems()` | `studio.js:1315` | ❌ **死代码** |

`groupTraceEvents` / `renderTraceItems` 定义了但**全项目零调用**。所以「实时」和「历史」仍然是两套独立逻辑，这正是你之前遇到的「刷新后对不上」的病根 —— 上轮修复只是补了历史侧，没有真正合并。

### 0.3 真实数据链：思考内容每轮只存一份「最终快照」

看 `server.js:2003`：

```js
const pushEvents = (id, list) => {
  const snapshot = reasoningBuf
    ? [...list, { type: 'reasoning', text: reasoningBuf, at: Date.now(), live: true }]
    : list;
  updateProgress(id, events.length, progress, snapshot).catch(() => {});
};
```

推论（都已在代码里核对过，不是猜测）：

1. **思考内容不是增量，是整轮快照**。每次 `pushEvents` 都把「截至当前的完整 `reasoningBuf`」塞一条进数组，位置在**数组末尾**。
2. `events` 数组本身从不含 reasoning（reasoning 走 `onDelta`，不走 `onEvent`）。所以每次落库只存在**一条** reasoning 行，而且永远在最后。
3. 结果：实时看得到思考在长，但**刷新后，整轮思考被摊成一个几十万字的大块，挂在最后一轮末尾**，跟工具的先后顺序全丢了。
4. `finishTask()`（`task.js:103`）和 `failTask()` 都**不写 `events`**。最后一轮的 `step_end` 和收尾思考，只要最后一次 `pushEvents` 没赶上，就丢了。

### 0.4 两个现存 bug（与本次改造直接相关）

**bug A：事件流被字符串截断，整段丢失**

`task.js:72`：

```js
JSON.stringify(events).slice(0, 400_000),
```

对 JSON **字符串**做 `slice` 会切断结构。`publicTask()`（`task.js:286`）里 `JSON.parse` 失败 → `catch { events = [] }`。于是**一次长对话，整个执行过程面板凭空消失**。这是「过程一刷新就没了」的第二种成因，且比第一种更致命 —— 它不可恢复。

**bug B：`retry` 事件永远是空的**

`nodes.js:204` 有 `onRetry?.(...)`，但 `server.js` 调 `runAgent()` 时**从来没传 `onRetry`**（`server.js:2040-2083` 的参数表里没有）。`runAgent` 也不把它转成 `emit({type:'retry'})`。

所以 `studio.js` 里的 `is-retry` 分支、`style.css:2810` 的重试样式、`traceHeadText` 里的「重试中（1/2）」—— **全是死代码，永远不显示**。「重试记录」这项需求目前是 0。

### 0.5 当前工具表里**没有「执行命令」**

`lib/agent/tools.js` 只有 5 个工具：`list_files` / `read_file` / `write_file` / `delete_file` / `update_meta`。

**没有 shell、没有 bash、没有 pwsh。** 所以需求里的「执行命令」卡片，**现在没有任何数据能喂它**。这一项要么先留空位（有数据才显示），要么就得先接工具 —— 本方案按「先留位」处理，不扩工具面（安全边界不动）。

---

## 1. DSH 到底能给我们什么

DSH 是 MIT。但它**不是**一个能直接 `npm i` 进 Node 20 + MySQL 项目的库，它是「一套可插拔的 agent 运行时」。所以「用这个底座」有两层含义，先讲清楚我们真正要拿的是什么。

### 1.1 可直接借鉴的：事件模型（这才是核心资产）

我把本机真实 DSH 会话日志解压后统计了事件分布（`C:\Users\29313\.dsh\sessions\...\session.v4.jsonl.zstd`，9943 条，20MB）：

```
 1476 tool/result      1454 tool/call        1462 step/start
 1462 step/end         1449 assistant/message  143 assistant/attempt
  131 llm/retry         130 llm/retry-started    46 turn/start
   46 turn/end          22 compaction/prune       19 workspace/changes
```

真实事件体形状（原样摘录）：

```json
{"type":"turn/start","seq":4,"time":1794282861283,"data":{"turn":1}}
{"type":"step/start","seq":6,"time":1794282861296,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":21,"time":1794282885457,"data":{"turn":1,"step":1,"callId":"call_00_...","name":"glob","arguments":"{\"pattern\":\"**/*.md\"}"}}
{"type":"llm/retry","seq":18,"time":1794282876782,"data":{"retryId":"1f05...","turn":1,"step":1,"retry":1,"maxRetries":5,"delayMs":455.4,"failure":{"message":"Connection error.","code":"TRANSPORT"}}}
{"type":"step/end","seq":27,"time":1794282886201,"data":{"turn":1,"step":1}}
{"type":"turn/end","seq":47,"time":1794282933823,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"...","code":"MALFORMED_RESPONSE"}}}}
```

三个关键设计，比我们现在强：

1. **`turn / step` 两级**。我们现在只有 `step`，`turn` 概念混在 `step` 里。有了 `turn`，「第 N 轮」和「这一轮里的第 K 步」不再混淆。
2. **`tool/call` 和 `tool/result` 分开，都带 `callId`**。我们现在只有 `tool_end`（结果），**没有「开始」**。所以工具正在跑的那 30 秒，界面只能显示「正在思考…」—— 用户以为卡住了。这是体验上最值得抄的一点。
3. **`llm/retry` 是独立事件，带 `failure.code`**。重试有据可查。

### 1.2 值得抄的第二个东西：流式增量的压缩编码

DSH 不把每个 token 存一条，而是这样：

```json
{"type":"reasoning-chunks","index":0,"dt":[51,1,0,134,...],"texts":["Now"," I und",...]}
```

`dt[]` 是相邻 chunk 的时间差（毫秒），`texts[]` 是文本增量。**同样的内容，体积比「每 token 一条带时间戳的 JSON」小一个数量级。**

对照我们现在：每次 flush 写一份**完整快照**，思考 1 万字写 10 次就是 10 万字。这是 O(n²) 的存储浪费，也是触发 bug A 截断的主因。

### 1.3 真正「接 DSH 运行时」是另一件事，代价很高

如果你要的是「MinePage 的 agent 循环换成 DSH 跑」：

| 项 | 现状 | 接 DSH 后 |
|---|---|---|
| Node | `>=20`（`package.json`） | **`>=24.9`**（`@deepseek-ai/dsh` engines） |
| 存储 | MySQL（`agent_tasks` / checkpoint 表） | 原生 JSONL append-only 日志，要写桥接 |
| 工具上下文 | `ctx = { siteId, userId }` 服务端注入 | 要写自定义 tool plugin，且沙箱模型不同 |
| 会话/配额 | 自有 `agent_threads` + 每日配额 | DSH **没有账号层**，要自己做 |
| 模型配置 | 自己的 `agent_models` 表 + 网关兼容补丁 | 换 `dsh-llm-*` 适配器插件 |
| 稳定度 | 自己的代码自己控 | **developer preview，plugin API 频繁 breaking** |
| 集成方式 | — | `@deepseek-ai/dsh-sdk-app` 的 stdio JSON-RPC，起子进程 |

**结论：不建议这一期动。** 它是「换地基」，不是「装修」。而你现在要的是装修。

---

## 2. 两条路线，选一条

### 路线 A（推荐）：抄事件模型 + 抄渲染范式，不引入运行时依赖

- 把 MinePage 的事件流升级成 **DSH 同构的 v2 schema**（`turn/start`、`step/start`、`tool/call`、`tool/result`、`llm/retry`、`turn/end`）。
- 前端**合并成唯一一个渲染器**，实时/历史同源。
- 存储改成**追加式事件表**，废掉「整包 JSON + 字符串 slice」。
- 不装 DSH 任何包，Node 20 不动，MySQL 不动，工具安全边界不动。
- MIT 合规：只抄**范式与事件名**（设计思想不受版权保护），若照搬具体代码，附 MIT 声明（见 §6）。

**成本**：约 2.5 天。**风险**：低，可灰度（v1 事件继续能读）。

### 路线 B：真的把 DSH 作为 agent 运行时嵌进来

- 走 `@deepseek-ai/dsh-sdk-app` JSON-RPC，起子进程，用 DSH 的 loop / tool plugin / session log。
- 能直接得到 DSH 全部能力（subagent、workflow、schedule、compaction 策略）。
- **代价**：Node 升 24、存储桥接、工具重写、账号/配额自建、跟 developer preview 的 breaking change 长期共舞。

**成本**：约 2 周起，且是持续维护成本。**风险**：高。

> **建议：先做 A。** A 做完之后，事件 schema 已经和 DSH 同构，将来真要切 B，前端一行都不用改 —— 这才是「用 DSH 作底座」最划算的姿势：**拿它的模型，不拿它的包袱**。

下文详述路线 A。

---

## 3. 事件 schema v2

### 3.1 规范

所有事件统一信封（对齐 DSH，仅把 `type` 里的 `/` 保留、数值字段改名更短）：

```json
{ "v":2, "seq":12, "t":1794282885457, "type":"tool/call", "data":{ ... } }
```

- `seq`：任务内单调递增，**从 1 开始**。前端靠它排序，不靠 `at`（`at` 会撞）。
- `t`：毫秒时间戳（绝对值，不做 DSH 那种 `dt` 压缩 —— 我们的量级用不上，先简单）。
- `v`：schema 版本。**v1 老数据必须还能渲染**（见 §4.3）。

### 3.2 事件清单

| type | data 字段 | 谁发 | 用途 |
|---|---|---|---|
| `turn/start` | `turn` | `loop.js` 入口 | 一轮开始 |
| `turn/end` | `turn`, `reason:{kind: 'done'\|'aborted'\|'max-steps'\|'error'}` | `loop.js` 出口 | 一轮结束（含失败） |
| `step/start` | `turn`, `step` | `nodes.js` agent 节点（现在已有 `llm_start`） | 「第 N 轮第 K 步」开始 |
| `reasoning/delta` | `turn`, `step`, `text` | `onDelta(kind='reasoning')` | **增量**，不再存快照 |
| `text/delta` | `turn`, `step`, `text` | `onDelta(kind='text')` | 正文增量（可选落库，用于回放打字机） |
| `tool/call` | `turn`, `step`, `callId`, `name`, `arguments`, `at` | `nodes.js` tools 节点，**执行前** | 「正在读取 index.html…」 |
| `tool/result` | `turn`, `step`, `callId`, `name`, `ok`, `ms`, `path`, `error`, `size` | 执行后 | 完成/失败 + 耗时 |
| `llm/retry` | `turn`, `step`, `retry`, `maxRetries`, `delayMs`, `failure:{code,message}` | `nodes.js` → `runAgent` → `server.js` **（补上断掉的链）** | 重试记录 |
| `step/end` | `turn`, `step`, `ms`, `reason:'tools'\|'done'` | `nodes.js`（现在已有） | 单步耗时 |
| `compaction/*` | `before`, `after` | `compact.js` | 可选，会话压缩留痕 |

**关键变化（相对现在）**：

1. `tool/call` 是**新增**的。没有它，就做不出「正在执行」的实时态。
2. `reasoning` 从**快照**改**增量**。
3. `retry` 从「死代码」变成真的有数据 —— 需要打通 `onRetry → emit`。

### 3.3 「已读取文件」不是事件，是**派生视图**

不要在事件里造一个「已读取文件」类型。它由 `tool/result` 里 `name in (read_file, list_files)` 的条目**聚合**出来：

```
已读取 3 个文件 · index.html 2.1KB · style.css 8.4KB · about.html 1.2KB
```

好处：口径永远和工具调用一致，不会出现「显示读了但实际没读」的漂移。

### 3.4 「执行命令」同理 —— 派生，且现在无数据

派生规则：`tool/result.name` 属于 `bash` / `pwsh` / `run_command` 时，渲染成命令卡片（等宽字体 + 退出码 + 输出前 N 行）。

**但当前工具表没有这类工具**（§0.5）。所以：**代码留位，数据不来就不显示**。不要为了这个需求去开 shell 工具 —— 那会把工作区 agent 的安全边界从「只能碰当前草稿的 5 个文件操作」扩到「能执行任意命令」，是另一个量级的决策，必须单独评审。

---

## 4. 存储改造

### 4.1 现状的问题

`agent_tasks.events MEDIUMTEXT`，每次进度更新**整包重写**，且 `slice(0, 400_000)` 会切坏 JSON（§0.4 bug A）。

### 4.2 改成追加式事件表

新增表（`lib/db.js` 的 `SCHEMA` 里加）：

```sql
CREATE TABLE IF NOT EXISTS agent_task_events (
  task_id VARCHAR(32) NOT NULL,
  seq     INT NOT NULL,
  type    VARCHAR(32) NOT NULL,
  t       BIGINT NOT NULL,            -- 毫秒时间戳
  data    MEDIUMTEXT NOT NULL,        -- 事件体 JSON
  PRIMARY KEY (task_id, seq),
  KEY idx_task_events_type (task_id, type),
  CONSTRAINT fk_task_events FOREIGN KEY (task_id)
    REFERENCES agent_tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB
```

写入：**只 INSERT，从不 UPDATE**（DSH 的 append-only 思想）。这一条同时解决四件事：

- 不再整包重写 → 表不会被写热。
- 没有 `slice` → bug A 根除。
- `seq` 天然有序 → 排序不依赖时间戳。
- 可以按 `seq > ?` 增量拉取 → 为将来 SSE 长连接铺路。

**容量兜底**（防止单任务无限膨胀）：

- 单个 `delta` 事件 ≤ 8KB（超了就切分成多条，不要丢）。
- 单任务事件总数上限 20 000 条，到顶后写入 `events/capped` 标记事件并停止记录**非关键** delta，只保留 `tool/*` 与 `step/*`。
- 绝不截断 JSON。

### 4.3 向后兼容

- `agent_tasks.events` 列**保留不删**，只标记为 v1 遗留。
- 读取时：先查 `agent_task_events`，空则回退解析 `agent_tasks.events`（v1 数组）。
- 归一化在**一个函数**里完成（§5.2），v1 数组 → v2 事件序列，之后再进同一个渲染器。
- 迁移脚本可选：`scripts/migrate-trace-events.mjs`，把 v1 的 `events` 拆成 v2 行（一次性，可断点续跑）。**不做也不影响使用。**

---

## 5. 后端改造

### 5.1 补上断掉的 `onRetry`（bug B）

链路现在是断的：

```
nodes.js:204  onRetry?.(err, attempt, maxRetries, wait)     ← 有
loop.js:120   onRetry 已解构进 runAgent                     ← 有
loop.js:196   onRetry 传给 makeAgentNode                    ← 有
server.js     runAgent({...}) 的实参里没有 onRetry          ← ❌ 断在这
```

而且即使传了，`onRetry` 也只是个回调，**不会变成事件**。需要在 `runAgent` 里包一层：

```js
onRetry: (err, attempt, maxRetries, waitMs) => {
  emit({ type: 'llm/retry', data: { retry: attempt, maxRetries, delayMs: waitMs,
         failure: { code: err?.code ?? 'UNKNOWN', message: String(err?.message ?? '').slice(0,200) } } });
  onRetry?.(err, attempt, maxRetries, waitMs);
}
```

### 5.2 一个纯函数做归一化

新增 `lib/agent/trace.js`：

```js
/** v1 数组 / v2 行 → 规范事件序列。纯函数，可单测。 */
export function normalizeEvents(raw) { ... }

/** 事件序列 → 视图模型（渲染只吃这个）。 */
export function deriveTrace(events) {
  return {
    // ---- 结构视图（步骤卡片） ----
    turns: [{ turn, steps: [{ step, ms, reasoning, tools: [...], retries: [...] }] }],
    totals: { toolCount, okCount, failCount, retryCount, ms },

    // ---- family 视图（分类渲染 / 筛选） ----
    // 借自 @starsea/agent-vis 的 family 分类口径（message/tool/reasoning/error/file）。
    // 口径是设计思想，不触发 MIT 声明义务；实现没有抄。
    families: {
      message:   [...],   // text/delta 聚合
      reasoning: [...],   // reasoning/delta 聚合
      tool:      [...],   // tool/call + tool/result 配对
      error:     [...],   // tool/result ok=false · llm/retry failure · turn/end error
      file:      [...],   // tool/result 里 name ∈ 文件类工具
    },

    // ---- 派生聚合 ----
    filesRead:    [{ path, size }],   // 「已读取文件」派生
    filesChanged: [{ path, size, ok }], // 「已修改文件」派生（与已读取分开）
    commands: [],                      // 「执行命令」派生（当前恒空，见 §0.5）

    // ---- 运行态快照（借 agent-vis 的 /api/state 形状） ----
    eventCount,
    stepMode: turns.length > 0,
    currentTurn,
    currentStep,
    completedSteps: [],
    finished,

    status: 'done' | 'failed' | 'cancelled' | 'running',
    currentAction: '正在读取 index.html…',
  };
}
```

**`deriveTrace` 是整个改造的核心。** 实时和历史都只调它，从根上消灭「两套实现」这类 bug（§0.2）。它是纯函数 → 可以用 `node --check` 之外的方式验证（给固定输入、断言输出），而且不需要连数据库。

> **`families` 与 `turns` 的分工**：`turns` 管「步骤卡片长什么样」（时间线），`families` 管「按类型筛选 / 分类统计」（筛选胶囊）。两者都从同一份事件派生，不重复存储。

### 5.3 `finishTask` / `failTask` 补写收尾事件

- `finishTask`：写 `turn/end {kind:'done'}`（**在事务里**和状态更新一起）。
- `failTask`：写 `turn/end {kind:'error', error:{...}}` —— 这样失败也能看到「卡在哪一步」。
- 这两处现在都完全不碰事件流（`task.js:103` / `task.js:132`）。

### 5.4 新增接口（可选，第二阶段）

- `GET /api/agent/tasks/:id/events?after=<seq>` —— 增量拉事件，前端轮询用它替代整包拉取。
- `GET /api/agent/tasks/:id/stream` —— SSE 长连接。**本次不做**，留位。

> 注意：现在**全项目没有任何 SSE**（`server.js` 里搜不到 `text/event-stream`）。前端是 `waitTask` 300ms 轮询（`studio.js:1120`）。改成 SSE 是一次独立优化，不要和执行过程重构捆在一起，否则出问题分不清是谁的。

---

## 6. 前端改造

### 6.1 一个渲染器，删掉死代码

`public/studio.js`：

- **删除** `buildTraceFromTask()`（638-783）与 `createTrace()` 里的 `renderBody()`（1503-1583）。
- **保留并重写** `groupTraceEvents` / `renderTraceItems` → 改名 `renderTrace(body, view)`，**唯一实现**。
- `MP.createTrace()` 和「刷新后重建」都走它：只是数据来源不同（一个来自轮询，一个来自历史接口），输入都是 `deriveTrace()` 的产物。

这条做完，`studio.js` 会短 300 行左右，且「实时和历史不一致」这个 bug **类别**消失。

### 6.2 面板结构（对应你列的每一项）

```
┌──────────────────────────────────────────────────────────┐
│ ▸ 已完成 · 5 步 · 改了 2 处 · 12.4s              [折叠]  │  ← 头部摘要 + 总耗时
├──────────────────────────────────────────────────────────┤
│ [全部] [消息] [工具] [思考] [错误] [文件]                 │  ← family 筛选胶囊
├──────────────────────────────────────────────────────────┤
│ 第 1 轮 · 2.1s                                            │  ← 步骤卡片
│   💭 思考过程（1 284 字）                          [展开] │  ← 思维链（内层折叠）
│   ⚙ 读了 index.html                              42ms    │  ← 工具步骤日志
│   ⚙ 读了 style.css                               18ms    │
│   ⌗ 已读取 2 个文件 · 共 10.5KB                           │  ← 文件聚合（派生）
│                                                           │
│ 第 2 轮 · 8.3s                                            │
│   ↻ 重试模型请求（1/2）· TRANSPORT · 455ms 后重试  ← 新增 │  ← 重试记录（真的有了）
│   ⚙ 改了 index.html                              606ms   │
│   ✕ 改了 about.html（失败）                               │
│      路径不合法：不能以 / 开头                             │  ← 错误详情
│   ⌗ 已修改 2 个文件 · 成功 1 / 失败 1                     │  ← 文件聚合（与读取分开）
│   ⌗ 执行命令 · 暂无（当前未接入 shell 工具）              │  ← 留位，或整行不渲染
└──────────────────────────────────────────────────────────┘
```

> **family 筛选胶囊**来自 agent-vis 的启发：点「工具」只留工具行，点「错误」只留失败与重试，点「文件」只留读写聚合。对长对话（20 轮以上）非常实用 —— 现在只能从头滚。
> 折叠态下胶囊**不显示**，只在展开后出现，避免抢视觉。


### 6.3 交互细节

| 交互 | 行为 |
|---|---|
| 默认态 | **折叠**，只露头部一行 + 计时（已有，保持） |
| 跑动中 | 头部显示**具体动作**：`正在读取 index.html…`（靠新增的 `tool/call`，而不是只能显示「正在思考…」） |
| 点击头部 | 展开/折叠整块（已有） |
| 点击「思考过程」 | 内层展开全文（已有） |
| 思考流式中 | **直接展开显示**，不要等结束才给（现在 `opt.live` 参数定义了但没用上，见 `studio.js:1313` 注释） |
| 展开后自动滚底 | 有，仅当用户没有手动上滚（避免抢滚动） |
| 失败项 | 整行红色 + 错误详情第二行（已有样式 `is-fail` / `wsTraceErr`） |
| family 胶囊 | 点一下只显示该类事件，再点「全部」恢复；选中态要有底色（`--panel`），别只变字色 |

### 6.4 样式

`style.css:2704-2832` 的 `wsTrace*` 体系**基本够用**，只需补：

- `.wsTraceStepHead`（步骤卡片头：第 N 轮 + 该轮耗时）
- `.wsTraceFiles`（已读取 / 已修改文件聚合 chip）
- `.wsTraceCmd`（命令卡片，等宽字体；`monospace` + `background: var(--panel)`）
- `.wsTraceFilters`（family 筛选胶囊行，横向可滚，`overflow-x: auto`）
- 现有 `.is-retry`（`style.css:2810`）终于会有数据了

> 全部沿用站点既有 CSS 变量（`--panel` / `--panel2` / `--border` / `--text` / `--muted` / `--muted2` / `--danger` / `--pink`），**不引入任何新配色**。这也是为什么不能 iframe 一个 Tailwind 页面进来（见 `DECISION-agent-vis.md` §2）。

### 6.5 中文动词表要补全

`studio.js:1208` 的 `TOOL_VERB` 只有 5 个：

```js
const TOOL_VERB = { list_files:'看了看文件列表', read_file:'读了', write_file:'改了', delete_file:'删了', update_meta:'改了页面信息' };
```

要改成**带参数**的映射（读文件显示路径、删文件显示路径、`update_meta` 显示改了哪个字段），并对未知工具名兜底成「调用了 `xxx`」而不是直接吐英文原名。

---

## 7. 分阶段落地

| 阶段 | 内容 | 改动文件 | 预估 |
|---|---|---|---|
| **P0** | 修 bug A（去掉字符串 `slice`）、补 `onRetry` 链路、`finishTask`/`failTask` 写收尾事件 | `task.js`、`server.js`、`loop.js` | 0.5 天 |
| **P1** | 新增 `lib/agent/trace.js`（`normalizeEvents` / `deriveTrace`）；`tool/call` 事件；reasoning 改增量 | `trace.js`(新)、`nodes.js`、`server.js` | 0.5 天 |
| **P2** | `agent_task_events` 表 + 追加写入 + 读取回退 v1 | `db.js`、`task.js`、`server.js` | 0.5 天 |
| **P3** | 前端合并成单一渲染器，删死代码，补步骤卡片/已读取文件/重试/命令留位 | `studio.js`、`style.css` | 1 天 |
| **P4**（可选） | 增量事件接口 + SSE | `server.js`、`studio.js` | 1 天 |
| **P5**（可选，独立评审） | 迁移脚本把 v1 事件转 v2 | `scripts/` | 0.5 天 |

**P0 + P1 就能看到明显效果**（重试有了、思考顺序对了、失败有上下文），建议先做这两步，验证观感后再决定 P2 的存储改造。

---

## 8. 风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| 改 schema 导致老对话过程面板空白 | 高 | v1 回退解析（§4.3），上线前用历史任务 ID 手测三条老会话 |
| reasoning 改增量后，前端累加出错 | 中 | `deriveTrace` 纯函数，给固定事件序列断言输出 |
| `tool/call` 事件让写库频率翻倍 | 中 | 只 INSERT 小行；`tool/call` 不带 arguments 全文（截 500 字） |
| 删死代码时误删在用的 `renderBody` | 中 | 按 §0.2 的表逐个确认调用方后再删；先加日志确认实时路径走哪个 |
| 事件表无限增长 | 中 | 单任务 20 000 条上限；会话删除时随 `ON DELETE CASCADE` 清理 |
| 「执行命令」为留位而开 shell 工具 | 高 | **明确不开**。该项只做 UI 派生，无数据不渲染 |
| MIT 合规 | 低 | 见 §9 |

---

## 9. MIT 合规怎么做

DSH 是 MIT。MIT 的义务只有一条：**分发时保留版权声明和许可声明**。

- 只抄**设计范式与事件命名**（`turn/step`、`tool/call`、`llm/retry`）→ 这是设计思想，不受版权保护，**无义务**。
- 若照搬 DSH 前端渲染器/解码器的**具体代码** → 必须保留声明。做法：
  - 新建 `MinePage/THIRD_PARTY_NOTICES.md`，贴 DSH 的 MIT 全文 + 版权行。
  - 在抄来的文件头部注释里写明：`Adapted from DeepSeek Harness (MIT), https://github.com/deepseek-ai/deepseek-harness`。
- 本项目自身是课设，不涉及分发，但**写清楚来源是最低成本的专业习惯**，也便于答辩时说明「底座是开源 MIT，我做了哪些改造」。

---

## 10. 验收标准（你自己点，我不代跑）

按 `docs/AGENT-TEST.md` 的方式操作，重点看四条：

1. **实时态**：发「把 index.html 的 h1 改一下」，折叠头应在工具执行期间显示 `正在读取 index.html…`，而不是一直「正在思考…」。
2. **重试态**：断网 3 秒再恢复（或把 baseURL 指向一个会 500 的地址），应出现 `↻ 重试模型请求（1/2）· <code> · xxx ms 后重试`。
3. **刷新一致性**：跑完一条多轮对话，展开面板 → 记下轮次/工具行/思考字数 → F5 → **三项必须完全一致**，且思考内容仍挂在它原本那一轮下，不是整体堆到最后一轮。
4. **长对话不丢**：连续跑 5 轮以上（触发大量事件），刷新后执行过程面板**仍然存在**（这条就是在验 bug A 已根除）。

---

## 11. 一句话总结

> 不接 DSH 运行时，**接它的脑子**：把事件流改成 DSH 同构的 `turn/step + tool/call + tool/result + llm/retry`，存储改追加式，前端砍成唯一一个渲染器。代价 2.5 天、Node 20 和 MySQL 都不动、安全边界不动；换来「思维链顺序正确、重试可见、实时有具体动作、刷新不丢」四件事，并且顺手干掉两个潜伏的 bug（字符串截断、死代码双实现）。
