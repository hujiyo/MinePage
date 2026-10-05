# MinePage 后端文档

> 这个目录只做一件事：**把系统现在的样子如实画出来**，好让断掉的链路能被照着修。

## 为什么有这些图

前两位同学是**先写代码、后补规范**的，而且规范一直没补齐。结果是：

- 15 个页面里有 **6 个是「能看但假」的** —— 渲染的是 `public/app.js` 里的演示数据，
  一个请求都不发。**看界面完全看不出来**，只有翻源码或看网络面板才知道。
- 接口一共 72 条，但**前端从没调用过的有 20 条**。
- 前后端各维护了一份词表/清单，已经漂移过（标签 `oss` vs `opensource`）。

这些问题单看任何一个文件都发现不了，**必须在「链路」这个层面上才看得出来**。
所以这里不按文件组织，**按链路组织**。

## 目录

| 文件 | 内容 | 谁维护 |
|---|---|---|
| `README.md` | 本文件：索引与画图规范 | 手写 |
| `01-architecture.md` | **架构图**：分层与组织方式 | 手写 |
| `02-flows.md` | **链路图**：数据流，每条一个图，按阶段画 | 手写 |
| `03-dependencies.md` | **依赖链**：层依赖 / 文件依赖 / 第三方依赖 | **自动生成** |
| `04-admin-loop.md` | **管理权限闭环**：谁能在什么条件下做什么 | 手写 |

`03-dependencies.md` 由 `tools/gen_dep_graph.py` 生成，**不要手改** ——
改了会被 `tests/test_dep_graph.py` 拦下来（那个测试会重跑生成器并比对）。

## 这几份图各自回答什么

分清楚，别指望一份图回答所有问题：

| 问题 | 看哪份 |
|---|---|
| 代码分成哪几层、层与层怎么连 | `01-architecture.md` |
| 一个请求从浏览器到数据库经过哪些环节 | `02-flows.md` |
| 改这个文件会影响谁 / 这个文件依赖谁 | `03-dependencies.md`（有正反两向） |
| 某个管理动作为什么没生效 | `04-admin-loop.md`（带排查对照表） |
| 接口的**字段名**是什么 | `../../docs/rewrite/rewrite-contract.md` |

## 图的约定（画和读都按这个来）

### 架构图（`01`）

一张图回答两个问题：**现在有哪些层**、**层与层之间怎么连**。
节点是「模块 / 目录」，不是函数。

### 链路图（`02`）

**按阶段画，不按函数画。** 每条链路拆成 4 段：

| 段 | 含义 |
|---|---|
| ① 浏览器 | 用户做了什么、哪个页面/脚本接的 |
| ② HTTP 入口 | 命中了哪条路由、过了哪些横切（鉴权、读体） |
| ③ 业务与数据 | 调了哪个 Service、落到哪张表 |
| ④ 响应与落地 | 回了什么、界面怎么变 |

每个节点**两行**：第一行写「这一步干了什么」，第二行写「关联的实现（文件 · 函数）」。
图里**不放代码**，只放定位信息。

### 状态标记（每条链路、每个节点都要标）

| 标记 | 含义 | 颜色 |
|---|---|---|
| ✅ 通 | 前端真的发了请求、后端真的回了 | 绿 `#e8f7ee` / `#2f9e5f` |
| 🔶 演示 | 这一段是假的：前端读演示数据，或后端接口存在但没人调 | 橙 `#fff4e5` / `#d98a1f` |
| ❌ 断 | 链路在这里断了，用户看到的是失效或空白 | 红 `#fdecec` / `#d64545` |
| ⬜ 缺失 | 后端根本没有这个能力 | 灰 `#f1f2f3` / `#9499a0` |

链路图末尾必须写一节 **「断点」**，逐条列出：断在哪、表现是什么、依据在哪。
这是这张图存在的理由 —— **修的时候照这一节改。**

## 文件名映射：Node 版 → Python 版

`02-flows.md` 里的链路是**行为**，行为没变；但实现换了语言。
看到旧名字时按这张表对照：

| Node 版 | Python 版 |
|---|---|
| `server.js` 的页面路由 | `app/api/pages.py` |
| `server.js` 的 API handler | `app/api/{auth,me,sites,discover,admin,social}.py` |
| `server.js` 的鉴权守卫 | `app/core/deps.py`（`require_user` / `require_admin`） |
| `server.js` 的读体 | FastAPI 的 Pydantic 出参模型 / `Body(...)` |
| `lib/sites.js` | `app/repositories/site_repository.py` + `app/services/site_manage_service.py` |
| `lib/users.js` | `app/repositories/user_repository.py` + `app/services/{auth,user}_service.py` |
| `lib/social.js` | `app/repositories/{like,comment,favorite,notification}_repository.py` + `app/services/social_service.py` |
| `lib/verification.js` | `app/repositories/verification_repository.py` + `app/services/verification_service.py` |
| `lib/email.js` | `app/interfaces/mail_sender.py`（抽象 + 控制台/SMTP 两个实现） |
| `lib/db.js` | `app/models/` + `app/core/database.py` |
| `lib/config.js` | `app/core/config.py`（`Settings` 走环境变量、`Limits` 走固定规则） |
| `lib/names.js` / `lib/addressing.js` | `app/services/site_manage_service.py` 的 `check_name` / 地址拼接 |
| `lib/auth.js` | `app/core/security.py` |
| `lib/mcp/*` | ⬜ **还没重写**（见 `02-flows.md` 的 MCP 段） |

## 维护约定

- 改动了**路由表、页面数据源、或某个层的导出**，就要回来更新这里。
- 判断「链路通不通」的唯一方法是**看前端有没有真的 `fetch`**。
  光看页面上写着 `TODO 后端对接：替换为 fetch('/api/x')` 不算 —— 那是待办，不是已接。
  自动检查：`node tests/scripts/link-coverage.mjs http://127.0.0.1:3000`
- 新增链路时照抄现有格式，**别自创结构**。
- **图的过期由测试兜底**：`04-admin-loop.md` 的接口清单由
  `tests/test_admin_loop_doc.py` 校验；`03-dependencies.md` 由
  `tests/test_dep_graph.py` 校验。手写的 `01` / `02` 只能靠自觉 ——
  所以每条链路末尾都写了「依据在哪」，方便核对。
