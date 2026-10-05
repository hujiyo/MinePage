# `app/core` —— 基础设施层

## 职责

所有层都要用的公共底座：**配置、数据库连接、密码与会话、业务异常、依赖装配**。
对应 Java 里的 `@Configuration` + `Util` + `@ControllerAdvice` 那一摊。

**它不实现业务**。判断某段代码该不该放这里的标准：它跟"这是个页面托管平台"这件事无关吗？
是 → 这里；否 → `services/`。

## 依赖方向

`core` 是**横切层**：所有层都可以 import 它，但它**只许依赖 `models` 和标准库/第三方库**。

具体地：`core` 不 import `services` / `repositories` / `api` / `schemas`。
唯一看起来像例外的是 `deps.py`（它 import 了 repositories 和 services）——
那是因为 `deps.py` 是**依赖注入的装配点**，它的工作就是"把各层接起来"。
它是整个后端唯一有这特权的地方。

## 文件

| 文件 | 内容 | 对应原 Node 版 |
|---|---|---|
| `config.py` | 全部上限、规则、标签词表、保留字。分 `Settings`（走环境变量）和 `Limits`（固定业务规则） | `lib/config.js` |
| `database.py` | `Database` 类：Engine + Session 工厂 + 连接池 | `lib/db.js` |
| `security.py` | scrypt 密码哈希、会话 token、Cookie 拼装解析 | `lib/auth.js` |
| `exceptions.py` | 业务异常族（`AppError` + 8 个子类），对应 Java 的 `@ControllerAdvice` 那套 | 原来散在各 handler 的错误分支 |
| `deps.py` | FastAPI `Depends` 装配：现会话 / 当前用户 / `require_user` / `require_admin` / 各 Service 工厂 | 无（新增，原版没有这层） |

## 最容易改坏的两个文件

| 文件 | 为什么危险 |
|---|---|
| `security.py` | **密码哈希格式或 Cookie 属性一变，库里现有账号全部失效**。改完必须跑 `TestCompatWithNodeVersion`（它拿原 Node 代码生成的哈希来验 Python 侧） |
| `deps.py` | 它管鉴权。改错了不是某个接口出问题，是**全站性的 401/403 到处漏**。改完必须跑全部接口测试 |

## 怎么加东西

- **新的业务上限** → `Limits` 里加常量（**不要**写进 `Settings`，它不按环境变）
- **新的业务异常** → `exceptions.py` 里继承 `AppError`，设好 `status_code`
  （注意 `N818`（"异常名要带 Error 后缀"）在 `pyproject.toml` 里是**刻意豁免**的 ——
  `NotFound` / `Forbidden` 比 `NotFoundError` 更贴合 HTTP 语义）
- **新的依赖注入函数** → `deps.py` 末尾的 Service 工厂区，照 `get_like_service` 写

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
