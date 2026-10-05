# `app/api` —— 接口层（对应 Java 的 Controller）

## 职责

收 HTTP、解析入参、调 Service、把结果交给框架序列化。**这四件事之外什么都不做。**

## 依赖方向（硬约束）

```
允许   api → services / schemas / core
禁止   api → repositories    ← Controller 不许自己写 SQL
禁止   api → models          ← Controller 不许看见 ORM 实体
```

由两处**同时**强制（`pyproject.toml` 的 import-linter + `tests/test_layering.py` 的 AST 检查）。

> **为什么禁止 import `models`**：ORM 实体绑在 Repository 的 Session 上，还带着
> `password_hash`。Controller 需要的只是"当前用户是谁"，那用 `schemas/user.py`
> 的 `CurrentUser` DTO 就够了。
> —— 这条不是我凭感觉定的：写骨架时我确实在 `social.py` 里 import 了 `User`，
> 是分层检查把它拦下来的。

## 文件

| 文件 | 内容 |
|---|---|
| `router.py` | 路由汇总。**新模块写完必须在这里挂上** —— 漏挂的表现是 404，且不会有任何报错 |
| `health.py` | `/healthz`（顺带真查一次库，否则"服务活着但连不上库"探不出来） |
| `social.py` | 点赞 / 取消点赞 —— **垂直切片的模板，新接口照它抄** |

## 怎么加一个接口

完整五步见根 `README.md`，这里只列容易忘的：

1. 路由函数**只做转发**，一个 `if` 都不该有 —— 业务判断全在 Service
2. `response_model` 用 `schemas/` 的 DTO，**字段名从 `../../../docs/rewrite/rewrite-contract.md` 抄**，少一个前端就白屏
3. 要登录 → `Depends(require_user)`；要管理员 → `Depends(require_admin)`
4. 写完在 `router.py` 挂上，并在根 README 的接口进度表里勾掉那一行

## 还没实现的模块

`auth` / `me` / `sites` / `discover` / `admin` / `mcp` / `pages` ——
`router.py` 底部有注释列了它们各自负责哪些接口，照着补。

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
