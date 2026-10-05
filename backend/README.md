# MinePage 后端（Python 重写版）

> 这是把原来的 Node/JavaScript 后端**按同一份接口契约重新实现**的版本。
> **前端 `public/` 一行都不用改** —— 它就住在仓库根目录，原样复用。

## 为什么要重写

课程《软件工程》大作业的技术底线①写的是：

> 语言：**Java/Kotlin/Dart/Swift/C#/C++/Python** 均可，**必须纯面向对象编码**。

JavaScript/Node.js **不在白名单里**，而且原后端全仓只有 1 个 `class`（还是个 `extends Error` 的小类），
不满足"纯面向对象"。所以换 Python 重写，并借这次机会把分层补上。

## 分层架构

对着 Java（Spring Boot）的典型分层，逐项对到 Python：

| Java | 职责 | Python 这里 | 用什么 |
|---|---|---|---|
| Controller（接口层） | 收 HTTP、参数校验、转发给 Service | `app/api/` | FastAPI `APIRouter` |
| Service（业务层） | 业务规则、事务边界、编排多个 Repository | `app/services/` | 普通类，**构造注入**依赖 |
| Mapper / DAO（持久层） | SQL 与 CRUD | `app/repositories/` | SQLAlchemy 2.x `Session` |
| Entity（实体层） | 表 ↔ 对象 | `app/models/` | `DeclarativeBase` + `Mapped[]` |
| DTO / VO | 出入参 | `app/schemas/` | Pydantic `BaseModel` |
| `interface` | 抽象契约 | `app/interfaces/` | **`abc.ABC` + `@abstractmethod`** |
| `@Configuration` / Util | 配置、基础设施 | `app/core/` | 类 + 模块 |
| `@Autowired` | 依赖注入 | `app/core/deps.py` | **FastAPI `Depends`** |
| `@Transactional` | 事务 | Service 内 | **`with session.begin():`** |
| Flyway / Liquibase | 建表迁移 | `alembic/` | Alembic |

### 依赖方向（**只能用这个方向，不许反向**）

```
    api/            ← 只做 HTTP，不写业务、不碰数据库
     ↓
   services/        ← 业务规则 + 事务边界
     ↓
  repositories/     ← 只有 SQL / CRUD
     ↓
    models/         ← 只有表结构映射

  core/  interfaces/  横切，各层都能用
```

用 `import-linter` 强制：
`api` **不许**直接 import `repositories` 或 `models`；`models` 不许 import 上面任何一层。
违反就报错（比口头约定可靠 —— 这是从原 Node 版"没有机制拦错"的教训来的）。

## 目录

```
backend/
├── app/
│   ├── main.py              装配：建 app、挂路由、挂异常处理、启动/关闭
│   ├── core/                基础设施层
│   │   ├── config.py        所有上限与规则（← lib/config.js）
│   │   ├── database.py      Engine + Session（← lib/db.js）
│   │   ├── security.py      scrypt 哈希 + 会话 token（← lib/auth.js）
│   │   ├── exceptions.py    业务异常（← 原来散在 handler 里的错误分支）
│   │   └── deps.py          Depends 装配：现会话 / 当前用户 / 各 Service
│   ├── models/              实体层（12 张表）
│   ├── schemas/             DTO 层
│   ├── repositories/        持久层
│   ├── interfaces/          抽象契约（abc.ABC）
│   ├── services/            业务层
│   └── api/                 接口层（56 个接口）
├── tools/                   开发工具
│   └── gen_dep_graph.py     生成 docs/03-dependencies.md（依赖链图）
├── docs/                    ★ 全部图与规范都在这里
│   ├── README.md            索引 + 画图规范（先看这个）
│   ├── 01-architecture.md   架构：分层与组织方式
│   ├── 02-flows.md          链路：13 条数据流，按阶段画
│   ├── 03-dependencies.md   依赖链（**自动生成，别手改**）
│   └── 04-admin-loop.md     管理权限闭环 + 排查对照表
├── alembic/                 建表迁移
├── tests/                   pytest
├── docker-compose.yml       一键启动：app + postgres（课程要求 ⑥）
├── Dockerfile
└── pyproject.toml           依赖 + ruff/mypy/pytest/import-linter 配置
```

### 先看图

`docs/` 下共 **19 张 mermaid 图**，各回答不同的问题，别指望一份图回答所有：

| 问题 | 看哪份 |
|---|---|
| 代码分成哪几层、层与层怎么连 | [`docs/01-architecture.md`](docs/01-architecture.md) |
| 一个请求从浏览器到数据库经过哪些环节 | [`docs/02-flows.md`](docs/02-flows.md) |
| 改这个文件会影响谁 / 这个文件依赖谁 | [`docs/03-dependencies.md`](docs/03-dependencies.md) |
| 某个管理动作为什么没生效 | [`docs/04-admin-loop.md`](docs/04-admin-loop.md) |
| 接口的**字段名**是什么 | [`../docs/rewrite/rewrite-contract.md`](../docs/rewrite/rewrite-contract.md) |

画图规范（4 段式链路、状态标记、断点一节）见 [`docs/README.md`](docs/README.md)。

`docs/03-dependencies.md` 是 `tools/gen_dep_graph.py` **从代码里真实解析 import 生成的**
（不是手画），`tests/test_dep_graph.py` 保证它不会过期。
`docs/04-admin-loop.md` 的接口清单由 `tests/test_admin_loop_doc.py` 校验，**不会跟代码漂移**。

```powershell
cd backend
.\.venv\Scripts\python.exe tools/gen_dep_graph.py      # 改了代码后重新生成
```

**每个层目录下还有自己的 `README.md`**（职责 / 依赖方向 / 文件清单 / 怎么加新文件）——
看某一层之前先看它。

## 接口进度

对照 **`../docs/rewrite/rewrite-contract.md`**（56 条）。**做完一条就来这里勾掉一行** ——
这也是"做完了"的定义里的第 4 条。

| 模块 | 接口数 | 状态 | 落哪个文件 |
|---|---|---|---|
| 健康检查 `/healthz` | 1 | ✅ 完成 | `app/api/health.py` |
| 点赞 / 取消点赞 | 2 | ✅ 完成 | `app/api/social.py` |
| 身份 `/api/auth/*` | 7 | ✅ 完成 | `app/api/auth.py` |
| 当前用户 `/api/me` | 1 | ✅ 完成 | `app/api/me.py` |
| 账号设置 `/api/account/*` | 3 | ✅ 完成 | `app/api/me.py` |
| 站点与文件 `/api/sites/*` | 11 | ✅ 完成 | `app/api/sites.py` |
| 上传 `/api/upload` | 1 | ✅ 完成 | `app/api/sites.py` |
| 发现流 `/api/discover` | 1 | ✅ 完成 | `app/api/discover.py` |
| 管理后台 `/api/admin/*` | 5 | ✅ 完成 | `app/api/admin.py` |
| 收藏 `/api/favorites` | 1 | ⬜ 未开始 | `app/api/social.py` |
| 关注 `/api/users/*` | 5 | ⬜ 未开始 | `app/api/social.py` |
| 私信 `/api/messages*` | 3 | ⬜ 未开始 | `app/api/social.py` |
| 浏览历史 `/api/history*` | 4 | ⬜ 未开始 | `app/api/social.py` |
| 通知 `/api/notifications*` | 2 | ⬜ 未开始 | `app/api/social.py` |
| MCP `/mcp` + `/api/mcp/*` | 5 | ⬜ 未开始 | `app/api/mcp.py` |
| **合计（原契约）** | **56** | **完成 33** | — |
| 页面路由（15 个 HTML + `/:站名`） | — | ✅ 完成 | `app/api/pages.py` |

> `/healthz` 是**新增**的，不在原 56 条契约里 —— 加它是为了让 `docker compose`
> 能判断容器是否可用。所以总路由数是 57，但契约基数是 56。
>
> 上表的分组沿用契约的写法，和**接口数**不总是一一对应：比如
> `/api/sites/:名字/files` 一条路径底下有 3 个方法（列表 / 上传 / 删除），
> 契约算 1 条、实际是 3 条。**权威数字看运行中的 OpenAPI**：
> `curl -s localhost:3000/api/openapi.json | jq '.paths | length'`。
> 截至本轮：**31 个路径**，其中 `/api/*` 全部落地，只剩 MCP 那 2 处前端调用打不到后端。

**已完成**：身份链路（8 条）+ 账号设置（3 条）+ 站点与文件（11 条）+ 上传（1 条）
+ 发现流（1 条）+ **管理后台（5 条）** + 页面路由（16 条 + `/_assets` + 用户站点兜底）。

**管理闭环**见 [`docs/04-admin-loop.md`](docs/04-admin-loop.md) —— 那张 mermaid 图是排查用的，
而且有 `tests/test_admin_loop_doc.py` 保证它不跟代码漂移。

**下一步**：站点链路（`/api/sites*` 15 条 + `/api/upload`）—— `index` / `site` / `sites`
三个页面都靠它，做完前端就能真的点起来了。

## 怎么跑

### 首次：建虚拟环境并装依赖

**必须用虚拟环境**，不要装到全局 Python —— 原因有两个：一是全局会和其他项目混版本，
二是这个项目对 `sqlalchemy` / `pydantic` 的大版本敏感，混装之后很难查问题。

**Windows（PowerShell）**：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]" -i https://mirrors.aliyun.com/pypi/simple/
```

**Linux / macOS**：

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]" -i https://mirrors.aliyun.com/pypi/simple/
```

> ⚠️ **不要在 venv 里跑 `pip install --upgrade pip`。** 实测踩过：pip 升级到一半失败，
> 旧包被改名成 `~ip`、新的没装上，venv 里的 pip 直接坏掉 ——
> `ModuleNotFoundError: No module named 'pip._internal.cli'`，什么都装不了了。
> **venv 自带的 pip（25.1.1 起）够用，不需要升级。**

> **为什么每次都要写 `-i` 镜像**：pip 不读项目内的配置文件，要么每条命令带 `-i`，
> 要么改用户级 `%APPDATA%\pip\pip.ini`（会影响所有项目），要么设 `PIP_CONFIG_FILE`。
> 这里选"每条命令带 `-i`" —— 不影响别人的环境，而且命令自己就是文档。
> 阿里云镜像实测 201ms，pypi.org 433ms（2026-10 实测）。

> **别用 `py` 启动器**：本机 `C:\Windows\py.exe` 指向了一个不存在的路径，会报
> `Unable to create process`。直接写 `python` 或用 venv 里的完整路径。

### 日常：跑起来

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 3000
```

打开 `http://127.0.0.1:3000` —— **这个端口同时提供 API 和那 15 个前端页面**，
因为前端 `public/` 里的请求全是相对路径，必须同源。

### 门禁：一条命令跑完

```powershell
cd backend
.\.venv\Scripts\python.exe tools/preflight.py           # 只检查
.\.venv\Scripts\python.exe tools/preflight.py --fix     # 先自动重生依赖图 + 格式化，再检查
```

它依次跑 **6 项**，任何一项失败就**不该提交**：

| # | 检查项 | 失败时怎么办 |
|---|---|---|
| 1 | **依赖图同步** | `python tools/gen_dep_graph.py` 重生 |
| 2 | 契约与单元测试 | 看失败用例；**先判断是"契约该变"还是"改坏了"** |
| 3 | 代码规范 | `ruff check --fix` 能修一部分，剩下的手改 |
| 4 | 代码格式 | `ruff format` |
| 5 | 类型检查 | 手改（mypy strict 不留情） |
| 6 | 分层依赖 | 看 `docs/03-dependencies.md` 的「已知例外」，**不许偷偷放宽 `ALLOWED`** |

> **⚠️ 改了任何 import 或新增/删除文件，就必须重生依赖图。**
> 不只是"接口变了"才要 —— 加个 service、改个 import 都会让图变。
> 忘了也不怕：`tests/test_dep_graph.py` 会红，preflight 第 1 项就拦下来了。

**当前基线（2026-10-05，管理后台落地后）**：

```
pytest          253 passed, 370 skipped
ruff check      All checks passed!
ruff format     77 files already formatted
mypy            Success: no issues found in 59 source files
import-linter   3 kept, 0 broken
依赖图           56 个文件，185 条依赖
```

> `skipped` 从 177 涨到 370 —— 那些是**契约测试的参数化占位**
> （契约里已记录、但还没实现的 20 条接口），实现一条就少一批。
> 看结果时**只关心 passed 和 failed**。

<details>
<summary>想单独跑某一项（展开看命令）</summary>

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest                                       # 契约 + 分层 + 注释 + 依赖图
.\.venv\Scripts\python.exe -m ruff check app tests alembic tools           # 规范
.\.venv\Scripts\python.exe -m ruff format --check app tests alembic tools  # 格式
.\.venv\Scripts\python.exe -m mypy app tools                               # 类型（strict）
.\.venv\Scripts\lint-imports.exe                                           # 分层依赖
.\.venv\Scripts\python.exe tools/gen_dep_graph.py                          # 重生依赖图
```

</details>

> **`48 files` 不是笔误**：`ruff` 连 **Markdown 里的 Python 代码块**一起格式化/检查。
> 48 = 40 个 `.py` + 8 个 `README.md`（7 个层目录 + 本文件）。
> 这是好事 —— **写在文档里的示例代码会被一起检查**，不会出现"README 的示例早就和真实代码脱节了"。
> 反过来说：**改 README 里的 Python 示例后，要跑一次 `ruff format`**，否则格式检查会红。

> **那个 177 skipped 是设计如此，不是没跑。** `tests/test_docstrings.py` 会对每个函数
> 参数化出两条检查，而"不抛业务异常的函数"和"没写 `Args:` 的函数"会**主动 skip** ——
> 它们本来就不需要检查。看 pytest 结果时**只关心 passed 和 failed**。

> **注释里的中文在 Windows 控制台可能显示成乱码** —— 那是控制台编码（GBK）的问题，
> 不是文件问题。要看正常输出：`$env:PYTHONIOENCODING='utf-8'`，或用 Windows Terminal。

### 数据库：开发用 SQLite，部署用 PostgreSQL

`DATABASE_URL` 决定：

| 环境 | 值 |
|---|---|
| 开发（默认） | 不设 — `sqlite+pysqlite:///./data/minepage.db` |
| 部署 | `postgresql+psycopg://minepage:密码@db:5432/minepage` |

**逻辑层完全不用改** —— 这就是用 SQLAlchemy 而不是手写 SQL 的价值之一。

> **本项目当前的决定（2026-10）**：本地开发**只用 SQLite**，PostgreSQL 与 Docker
> 都留到上云服务器时再装。所以本地依赖里虽然装了 `psycopg`，但没有任何 PG 服务在跑 ——
> 这是有意的，不是漏装。

## 怎么加一个新接口（**照着这 5 步抄**）

以一个还没实现的功能为例，比如"收藏站点"：

| 步 | 改哪里 | 做什么 |
|---|---|---|
| 1 | `app/models/social.py` | 表已经定义好了（`Favorite`），确认字段对得上就行 |
| 2 | `app/repositories/favorite_repository.py` | 写 SQL：`exists()` / `add()` / `remove()`，**只碰数据库，不写业务判断** |
| 3 | `app/services/social_service.py` | 写业务：站点必须存在、必须 `active`、重复收藏要幂等；**事务边界在这里** |
| 4 | `app/schemas/social.py` | 定义出参 DTO（Pydantic 模型）。**字段名必须和 `docs/rewrite/rewrite-contract.md` 里的一致**，少一个前端就白屏 |
| 5 | `app/api/social.py` | 加一个路由函数，从 `Depends` 拿 Service，转发调用，**不写业务** |

**然后**：在 `tests/` 里加一条用例。前端不改。

### 接口契约在哪

**`docs/rewrite/rewrite-contract.md`**（**进 git**，队友可见）。
56 个接口的：鉴权要求、请求字段、**响应顶层键**、原处理函数名。

**响应字段名是最容易出错的地方** —— 必须逐个对上，否则前端读到 `undefined` 会白屏。
生成/更新它：

```bash
node tests/scripts/api-contract.mjs --out docs/rewrite/rewrite-contract.md    # 在仓库根跑
```

## 与 Node 版的关系

- 前端 `public/` **共用**，一行不改 —— 这是验收标准
- 旧的 `server.js` / `lib/` 留在 git 历史里，过渡期可对照实现细节
- **验收方式**：前端不改 + 原来的接口测试对着新后端跑全绿 + 页面能点

## 关键兼容点（踩过的坑，别改）

| 点 | 必须保持一致的原因 |
|---|---|
| **密码哈希格式** `scrypt$<salt>$<hash>` | salt 是 **16 字节随机数的 hex 字符串**，且 Node 把它当 **UTF-8 字节**用；派生参数 `N=16384, r=8, p=1, dklen=64`。改了现有账号的密码就全部失效 |
| **Cookie 名** `mp_session` + 属性 `Path=/; HttpOnly; SameSite=Lax` | 前端与浏览器行为依赖它；退出登录靠 `Max-Age=0` |
| **所有时间列是 ISO 8601 字符串** | 原版就这样，比较靠字符串序；换 `TIMESTAMP` 会改变排序与相等语义 |
| **用户站点必须带沙箱 CSP** | `Content-Security-Policy: sandbox ...`，**绝不能加 `allow-same-origin`**，否则脚本能逃出沙箱拿到平台登录态 |
| **`/_assets/` 与页面路由都要由本服务提供** | 前端全用相对路径，必须同源 |

---

## 注释规范

> **这套规范只管 `backend/`。** 不往回改 `server.js` / `lib/` / `public/`
> —— 那边用它们各自原来的习惯（`lib/*.js` 是 64 连字符分隔线，`public/app.js`
> 是三行块注释），**不要统一**，混合比统一更小的代价。

### 1. 文件开头：必须有模块 docstring，说三件事

**这个文件是什么** · **对应原 Node 版的哪个文件** · **有什么坑或硬约束**。

```python
"""会话的数据访问。

会话 token **明文存库不做哈希** —— 与原版一致：它是短期且可随时删除的，
哈希它没有收益，反而让「按 token 查」变成全表扫。
"""
```

**为什么不是"XX 模块"一句话就够**：读代码的人最需要知道的是「这个文件管什么、
边界在哪」，以及「有没有反直觉的地方」。一句话交代不完就写两句 ——
**写"坑"比写"是什么"值钱得多**。

### 2. 类：一句话说职责，再补关键行为

### 3. 函数：功能必须写；输入输出**按需**写

**不是每个函数都要凑齐 `Args:` / `Returns:`** —— 类型注解已经写明了类型，
硬凑出 `Returns: None.` 这种是纯噪音。规则如下：

| 什么时候写 | 判断标准 |
|---|---|
| **功能** | **每个函数都必须有**，第一行说清做什么 |
| `Args:` | 参数**有约束**（取值范围、长度上限、可否为空）或**名字看不出含义**时 |
| `Returns:` | 返回值**不明显**时（比如返回 `bool`，但"真"代表什么不显然） |
| `Raises:` | 会抛业务异常时 —— **Service 层尤其必须**，调用方要知道会接到什么 |

**反面例子（不要这样写）**：

```python
def set_bio(self, user: User, bio: str) -> None:
    """改个人简介。

    Args:
        user: 用户对象。
        bio: 简介。

    Returns:
        None.
    """
```

类型注解已经说了「user 是 User、bio 是 str、返回 None」，这三段全是复述。

**正面例子**：

```python
def set_bio(self, user: User, bio: str) -> None:
    """改个人简介。长度上限（`Limits.BIO_MAX`）由业务层校验，这里不检查。"""
```

```python
def like(self, *, site_name: str, user_id: int) -> LikeOut:
    """点赞。

    Args:
        site_name: 站名，**大小写不敏感**（内部统一转小写后查）。
        user_id: 点赞者。调用方必须保证已登录。

    Returns:
        点赞后的状态与总数（`liked` 恒为 True）。

    Raises:
        NotFound: 站点不存在。
        SiteOffline: 站点被管理员下线（451）。
    """
```

### 4. 行内注释：解释「为什么」，不解释「是什么」

```python
# ✗ 没用：代码本身就说清了
cursor.execute("PRAGMA foreign_keys = ON")

# ✓ 有用：说了不照做会出什么事，而且是不会报错的那种
# SQLite 默认**不执行**外键约束，而库里的级联删除全靠它。
# 忘了这条的后果是"删了站点，文件还留在库里"，而且不会报错。
cursor.execute("PRAGMA foreign_keys = ON")
```

### 5. 机器能查的交给机器

`ruff` 的 `D` 规则集开着：**缺模块/类/函数 docstring 会直接报错**，不用靠人记。
（`D415`（句末标点）被显式豁免，因为文档是中文、结尾写「。」，ruff 只认 `.`）

---

## 验收标准（每次改动都按这个走）

工具就是这个目录里的那套。**没有例外，不许"下次再补"** —— 原 Node 版的问题
全都出在"没有机制拦错"上，这套标准就是补那个机制。

### 门禁：五条命令全绿

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest                                 # 契约 + 分层 + 兼容性
.\.venv\Scripts\python.exe -m ruff check app tests alembic           # 规范
.\.venv\Scripts\python.exe -m ruff format --check app tests alembic  # 格式
.\.venv\Scripts\python.exe -m mypy app                               # 类型（strict）
.\.venv\Scripts\lint-imports.exe                                     # 分层依赖
```

**当前基线（2026-10-05，管理后台落地后）**：`253 passed` · `All checks passed` ·
`77 files already formatted` · `Success: no issues found in 59 source files` · `3 kept, 0 broken`。

**基线只能往上走**：加了功能，`pytest` 条数必须增加；
**不许减少、不许用 `xfail`/`skip` 蒙混**。数字对不上就说明这次改动动了不该动的东西。

### 按改动类型的额外要求

| 改了什么 | 必须额外做到 |
|---|---|
| **改了任何 import / 新增或删除文件** | **重生依赖图**：`python tools/gen_dep_graph.py`。这不是"建议" —— `tests/test_dep_graph.py` 会红 |
| **新增接口** | ① 从 `docs/rewrite/rewrite-contract.md` 抄**响应字段名**，一个都不许改 ② **先写测试**（正例 + 至少一个错误分支）③ 再写实现 |
| **改已有接口行为** | 先记下 pytest 基线 → 改 → 契约测试若红，**先判断是"契约本来就该变"还是"改坏了"**；前者要同步更新 `rewrite-contract.md` 并在提交信息里说明 |
| **改 `app/models/`** | ① `alembic revision --autogenerate` 生成迁移 ② `test_模型都注册进了metadata` 仍绿（表数必须还是 12）③ 动了列名要回头查 `repositories/` 里的 SQL |
| **改 `app/core/security.py`** | **必须**跑 `TestCompatWithNodeVersion` —— 密码哈希或 Cookie 格式一变，**库里现有账号全部失效** |
| **改 `app/core/deps.py`** | 跑全部接口测试：它管鉴权，改错了是全站性的 |
| **改前端 `public/`** | 跑仓库根 `node tests/scripts/run-all.mjs --quiet`（84 条，基线 82 过 / 2 已知失败）|
| **加依赖** | 同步写进 `pyproject.toml` 并重跑五条命令。**不许 `pip install` 完不写进 pyproject** |

### "做完了"的定义（DoD）

一个接口算做完，**四条全中**：

1. 响应字段名与 `rewrite-contract.md` 逐一对应
2. **有测试，且至少覆盖一个错误分支**（401 / 404 / 451 / 413 之类）
3. 五条命令全绿
4. 本 README 的接口进度表里那一行被勾掉

> **没做到第 2 条的不算完成。** "只测正例"正是原 Node 版出问题的方式 ——
> `lib/social.js` 里那句 `ORDER BY f.id`（`follows` 表没有 `id` 列）如果有测试，
> 早就暴露了，不会等到读代码才发现。

---

## 本机环境：两个必须知道的坑

### 1. 临时目录必须显式指定（`--basetemp`）

**现象**：跑完 `pip install` 或 `pytest`，`backend/` 下多出一堆垃圾目录 ——
`pip-unpack-*`、`pip-build-env-*`、`pytest-of-<用户>/pytest-N/<测试名>/`
（实测 69 个 pip 目录 / 315 个文件 / 40 MB，pytest 那边 33 个目录）。

**根因**（已查明，不是权限没给对）：

```
TEMP       = C:\Users\Administrator\AppData\Local\Temp   ← 环境变量没问题
os.open(O_CREAT|O_EXCL) 在那个目录 → PermissionError 13   ← 从工作区启动的进程被拒
gettempdir = <当前工作目录>                                ← Python 于是回退到 CWD
```

**从工作区里启动的进程写不了 `%TEMP%`**，Python 的 `tempfile` 判定不可用后
**静默回退到 CWD**。所以 `pyproject.toml` 里那条 `addopts = "--basetemp=.pytest-tmp"`
**不是可选项，别删**。pip 那边没有对应开关，靠 `.gitignore` 的 `pip-*/` 兜着。

### 2. Defender / 索引器会短暂锁住刚写的可执行文件

**现象**：`DLL load failed while importing xxx: 另一个程序正在使用此文件`，
或 `lint-imports.exe 无法运行`。触发者通常是 `SearchIndexer` 在扫新装的文件。

**处理**：**等几秒重试即可**，不要以为装坏了、更不要重装。
