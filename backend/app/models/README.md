# `app/models` —— 实体层（12 张表）

## 职责

表结构到类的映射。原 Node 版把建表写成一整段 SQL 字符串（`lib/db.js` 的 `SCHEMA`），
代码里到处拿裸行对象；这里换成 SQLAlchemy 的声明式类。

**换来的是"字段名写错在启动时就报错"** —— 原版 `lib/social.js` 里那句
`ORDER BY f.id`（`follows` 表根本没有 `id` 列）只会在真请求时暴露成 500。

## 依赖方向（硬约束）

```
允许   models → （什么都不依赖，除 SQLAlchemy）
禁止   models → repositories / services / api
```

实体不知道业务，也不知道怎么存。**由 `tests/test_layering.py` 强制。**

## 文件

| 文件 | 表 |
|---|---|
| `base.py` | `Base`（DeclarativeBase）+ `utcnow_iso()` / `iso_in_days()` 两个时间工具 |
| `user.py` | `users` · `sessions` · `email_codes` |
| `site.py` | `sites` · `site_files` |
| `social.py` | `likes` · `comments` · `favorites` · `follows` · `view_history` |
| `message.py` | `messages` · `mcp_tokens` |
| `__init__.py` | **必须把所有模型 import 进来**（见下） |

## 三条硬约束（改了会出静默故障）

1. **`__init__.py` 必须 import 所有模型。**
   Alembic 的自动迁移靠 `Base.metadata` 收集表定义，少 import 一张表，
   自动生成的迁移就会**静默漏掉它** —— 不报错，只是线上少一张表。
   `tests/test_layering.py::test_模型都注册进了metadata` 就是防这个的（断言表数 == 12）。

2. **时间列一律 `String`（ISO 8601），不要改成 `DateTime`。**
   全库的时间比较都靠字符串序（`expires_at > 当前时间`），换类型会改变排序与相等语义。

3. **主键统一 `Integer, primary_key=True, autoincrement=True`。**
   这样 SQLite 上是 `INTEGER PRIMARY KEY AUTOINCREMENT`，PostgreSQL 上是 `SERIAL`，
   两个库行为一致。

## 已踩过的坑

| 坑 | 说明 |
|---|---|
| `sites.html` 语义重载 | 它既是单页站的真实内容，又是多页站的空串占位符（列是 NOT NULL，占位躲不掉）。**判断单页/多页只能看 `site_files` 有没有行**（`SiteRepository.file_count`），不要看 `html` 是否为空 |
| 大小写不敏感唯一性 | 原版用 SQLite 的 `COLLATE NOCASE`，**PostgreSQL 没有它**。本项目的做法是「写入与查询前统一转小写」+ 普通 `UNIQUE`，不依赖 `citext` 扩展 |
| 复合主键没有 `id` 列 | `likes` / `favorites` / `follows` / `view_history` 四张表是复合主键，**没有 `id`**。想按"插入顺序"排序就得用 `created_at`，用 `id` 会直接报错 |

## 怎么加一张表

1. 挑一个合适的文件（按领域，别一个表一个文件）
2. 写好 `Mapped[...]` 类型和 `__table_args__`（唯一约束 + 索引）
3. **在 `__init__.py` 里 import 并加进 `__all__`**
4. `alembic revision --autogenerate -m "..."` 生成迁移
5. 跑 `test_模型都注册进了metadata`，表数对不上就是漏了

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
