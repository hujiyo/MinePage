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
这里的三份产物是从它那儿挑出来、**为了进 git 给队友和老师看**的副本。

`tests/` 里还留着的东西（仍然是本地工具，不进 git）：

- `scripts/run-all.mjs` + 84 条 Node 回归用例 —— **前端"不能坏"的验收基线**
- `tools/node_modules/` —— mermaid-cli / jsdom / puppeteer，随时能重装
- `rendered/` —— 渲染出来的图，随时能重新生成

**那套 Node 回归先留到 Python 后端把前端接上再清理** —— 现在删了就没法证明"前端一行不改"。
