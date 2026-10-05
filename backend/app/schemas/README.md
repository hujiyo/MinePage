# `app/schemas` —— DTO 层

## 职责

定义**出入参的形状**。原 Node 版把这些 JSON 在 handler 里手拼
（`sendJson(res, 200, { ok: true, liked: true, likes: ... })`），字段名靠人记；
这里用 Pydantic 模型：

- **字段名写错在启动时就报错**（Pydantic 在类定义时校验）
- 出参自动序列化，不用手写 `res.json()`
- 入参自动做类型与长度校验 —— 等价于 Java 的 `@Valid`，但一个注解都不用写

## 依赖方向

`schemas` 是**横切层**：`api` / `services` / `repositories` 都可以用它。
它自己只依赖 Pydantic（和 `models`，只在需要从实体转换时）。

## 文件

| 文件 | 内容 |
|---|---|
| `common.py` | `ApiOk`（带 `ok: true` 的成功响应）· `ErrorOut`（统一错误体） |
| `social.py` | `LikeOut` · `SiteStatsOut` |
| `user.py` | `CurrentUser` —— **Controller 只该看到这个，不该看到 ORM 实体** |

## 两条硬约束

### 1. 字段名必须与契约一致

**契约在 `../../../docs/rewrite/rewrite-contract.md`**（56 个接口的响应顶层键，
从原 `server.js` 的 `sendJson` 抠出来的）。少一个键，前端就读到 `undefined` 然后白屏。

> 这不是危言耸听：原版 `discoverSites` 就漏了 `fileCount` / `kind`，
> 结果发现流的卡片上那两项永远是空的。

### 2. 成功响应都要带 `ok: true`

前端几乎所有地方都先判 `data.ok` 再往下走。`ApiOk` 就是为这个存在的 ——
**别为了少一个字段而省掉它**。

## 关于 `CurrentUser`

它存在的原因是分层：`app/api` 不许 import `app/models`，
所以 Controller 不能拿 ORM 实体当"当前用户"。`require_user` 负责把实体转成这个 DTO。

**只有 Controller 会用到的字段才放这里**。需要更多字段，说明那段逻辑该挪进 Service。

## 怎么加一个 DTO

```python
class XxxOut(BaseModel):
    """一句话说这个响应给谁用、对应哪个接口。

    契约：`GET /api/xxx` → `{ok, field1, field2}`（见 ../../../docs/rewrite/rewrite-contract.md）
    """

    ok: bool = True
    field1: str
    field2: int = 0
```

写 `Field(description=...)` 说明**含义不显然**的字段（比如"总数"还是"本次新增"）。
名字已经说清的不用加。

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
