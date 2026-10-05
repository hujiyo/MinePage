# `docs/rewrite` —— 换语言重写的规格与记录

## 为什么有这个目录

后端要从 Node.js 换成 Python（原因是课程技术底线不认 JavaScript，详见
`../../backend/README.md` 开头）。换语言最容易出的事**不是写不出来，而是"写出来但不一致"**——
前端读 `likes` 你返回 `count`，页面就白屏，而且不会有任何报错。

所以重写不是"重想业务"，是**实现一份已经存在的契约**。这个目录放的就是那份契约。

## 里面有什么

| 文件 | 是什么 | 怎么来的 |
|---|---|---|
| **`rewrite-contract.md`** | **56 个接口的契约**：鉴权要求 / 请求字段 / **响应顶层键** / 前端实际调用清单 | 由 `api-contract.mjs` 从 `server.js` 自动抽出，**不要手改** |
| `api-contract.mjs` | 上面那个的生成器 | — |
| `new-findings.md` | 读代码发现的 **21 条缺陷**（6 P0 / 14 P1 / 1 P2） | 人工审阅 |
| `issues.md` | 更早一轮的 **53 条缺陷** | 人工审阅 |

`rewrite-contract.json` 是生成器的中间产物（56 条的结构化版本），也在 git 里 ——
它让"接口数有没有变少"这种检查可以脚本化。

## 怎么重新生成契约

```powershell
# 在仓库根跑
node docs/rewrite/api-contract.mjs --out docs/rewrite/rewrite-contract.md
node docs/rewrite/api-contract.mjs --json docs/rewrite/rewrite-contract.json
```

它读的是仓库根的 `server.js`（旧 Node 版）。**只要 `server.js` 还在，契约就还能重建**——
这是把旧的 `tests/` 保留着的意义之一。

## 怎么用这份契约

**写任何一个接口之前，先来这里查它的响应字段名。**

`rewrite-contract.md` 里那张表有一列叫「响应顶层键」，那是从原 `server.js` 的
`sendJson(res, 2xx, {...})` 里抠出来的 —— **前端读的就是这些键**。

```
| POST | /api/sites/:名字/like | 登录 | — | liked, likes | handleSiteLike |
                                            ^^^^^^^^^^^^
                                            就这两个，不能改成 count / total
```

少一个键，前端读到 `undefined`；名字不一样，前端读到 `undefined`。**两种都不会报错。**

## 缺陷清单怎么用

`new-findings.md` 和 `issues.md` 记录的是**旧 Node 版的问题**。重写时它们有两种用法：

1. **别把同样的坑再挖一遍** —— 比如 N8（发验证码先写库后发信）、
   N9（`updated_at` 刷新不对称）、N12（判存在性却把整个 BLOB 读出来）
2. **当作测试用例的来源** —— 每一条缺陷都可以变成一条"这条不该再发生"的测试

**但要注意**：在旧代码上"先别修"是明确的决定（bug 太多，而且有些接线时会整段重写）。
重写时按新架构自然规避即可，不必逐条对着旧代码改。

## 和 `tests/` 的关系

仓库根的 `tests/` 是**开发工具目录，不进 git**（`.git/info/exclude` 里锚定成 `/tests/`）。

这三份产物**原来只放在 `tests/` 里**，重写时提升到了这个目录 ——
它们现在是**正式版本本身**，不是副本。`tests/` 下原先那三份同名文件已删除，
避免同一个东西在两个地方各有一份、结论还不一样。

`tests/` 里还留着的（仍然是本地工具，不进 git）：

- `scripts/*.mjs` —— E2E / 一致性 / 链路覆盖率等检查脚本
  （`run-all.mjs` 那套 84 条 Node 回归用例的打靶对象是旧 `server.js`，
  前端接上 Python 之后它已经不是验收基线了）
- `tools/node_modules/` —— mermaid-cli / jsdom / puppeteer，随时能重装
- `rendered/` —— 渲染出来的图，随时能重新生成

> **重写之后，"前端不能坏"的验收基线换了目标。**
> 以前是"同一套前端对着 Node 后端跑 84 条用例"，
> 现在是"前端对着 Python 后端跑 E2E"（`e2e-upload-py.mjs` / `e2e-admin-py.mjs` /
> `ui-lightup.mjs` / `verify_upload_chain.py`）。
> 旧 `server.js` 留在仓库里，是为了这套契约**还能重建**，不是因为它还在服役。
