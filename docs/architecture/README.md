# 这里的架构图已经搬走了

后端重写成 Python 之后，架构与链路图统一收进了后端自己的文档目录：

| 原文件 | 现在的位置 |
|---|---|
| `01-architecture.md` | [`backend/docs/01-architecture.md`](../../backend/docs/01-architecture.md) |
| `02-flows.md` | [`backend/docs/02-flows.md`](../../backend/docs/02-flows.md) |
| `README.md`（画图规范） | [`backend/docs/README.md`](../../backend/docs/README.md) |

**为什么搬**：图和它描述的代码应该放在一起。后端挪到了 `backend/`，
图留在 `docs/` 就会出现「代码在 A、图在 B」的漂移 ——
改了后端忘了改图，而图不会报错，只会把人引到错的地方。

**内容也更新了**，不只是搬家：

- 架构图（`01`）按 Python 的四层结构重画，原来的 Node 版分层已经是历史
- 链路图（`02`）的「关联的实现」那一行全部换成了 Python 的模块与函数，
  并按**当前**的实现状态重新标了 ✅ / 🔶 / ⬜ 和「断点」一节
- 新增两份：依赖链（`03`，自动生成）与管理权限闭环（`04`）

`docs/` 下剩下的：

- `docs/rewrite/` —— 迁移规格（接口契约与缺陷清单），**重写的图纸，仍需保留**
- `docs/plans/` —— 更早的设计文档
