# `app/repositories` —— 持久层

## 职责

**只做数据库读写**。不写业务规则、不抛业务异常、不管 HTTP。

判断一段代码该不该在这里，问两个问题：

1. 它**只关心数据怎么存**吗？（是 → 留下；否 → 应该是 `services`）
2. **换个数据库它要改吗？**（要 → 留下来，这正是这层存在的意义）

## 依赖方向（硬约束）

```
允许   repositories → models / core / schemas
禁止   repositories → services / api
```

由 `tests/test_layering.py` + import-linter 双重强制。

## 约定：一个文件一个 Repository 类

文件名 = 类名的蛇形。**这不是审美，是防错**：`__init__.py` 按这个约定导入，
破例就会 ImportError。

> 骨架阶段我确实破过一次例 —— 把 `SessionRepository` 和 `UserRepository`
> 写在同一个文件里，结果 `import` 当场失败。**是导入错误把它拦下来的，
> 不是我自己发现的。**

## 文件

| 文件 | 表 | 备注 |
|---|---|---|
| `base.py` | — | `BaseRepository[ModelT]`：泛型基类，收拢通用 CRUD |
| `user_repository.py` | `users` | 含 `to_public()` —— **所有对外的用户对象都要过它**（过滤 `password_hash`） |
| `session_repository.py` | `sessions` | token 明文存库（与原版一致） |
| `site_repository.py` | `sites` | 含 `file_count()` —— **区分单页/多页站的唯一判据** |
| `site_file_repository.py` | `site_files` | BLOB 多，**判存在性不要读 `content`** |
| `like_repository.py` | `likes` | **垂直切片的模板，新 Repository 照它抄** |

## 通用写法

```python
class XxxRepository(BaseRepository[Xxx]):
    """一句话说这个仓储管什么。"""

    model = Xxx

    def find_by_something(self, key: str) -> Xxx | None:
        """按某字段查。"""
        stmt = select(Xxx).where(Xxx.key == key)
        return self._session.scalars(stmt).first()
```

要点：

- **不自己开会话、不自己 commit** —— 会话由依赖注入给，这样一个请求里的多个
  Repository 共享同一个事务
- 写操作分两类：改实体属性（`site.html = html`）和直接 `delete()` 语句。
  后者要注意 `Result` 类型上取 `rowcount` 需要 `# type: ignore[attr-defined]`（见 `like_repository.py`）
- 判存在性用 `select(func.count())`，**不要 `get()` 整个对象** —— 对 BLOB 表尤其重要
- 会抛 `IntegrityError` 的插入（唯一约束）要用 `with self._session.begin_nested():` 包起来，
  否则失败的 INSERT 会把外层事务一起弄脏

## 怎么加一个方法

照 `like_repository.py` 抄。写完之后：

- 该方法的 **docstring 要写清参数约束**（哪些可以为 `None`、哪些由调用方保证）——
  `tests/test_docstrings.py` 会检查 `Args:` 里的参数名与签名是否一致
- 如果有 `raise`，那不用写（这层不抛业务异常）

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
