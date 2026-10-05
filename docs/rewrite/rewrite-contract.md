# 后端重写契约（从前端与现有代码抽出）

> 目的：换语言重写后端时，**让现有 15 个页面一行都不用改**。
> 所以契约不是"应该是什么"，而是"现在是什么"。
> 由同目录的 `api-contract.mjs` 生成（`node docs/rewrite/api-contract.mjs`），改动路由后重新生成。

接口共 **56** 条。

列的含义：

- **鉴权**：`公开` / `公开(读登录态)` / `登录` / `登录+属主` / `管理员` / `密钥` / `公开/登录`（按参数分）
- **请求字段**：从 handler 里 `body.xxx` 抠出来的
- **响应顶层键**：从 `sendJson(res, 2xx, {...})` 抠出来的（**前端读的就是这些**）

> ⚠️ 这里**没有「哪个页面在调」这一列**。试过，不准：带参数的路径在前端是拼出来的
> （`'/api/sites/' + name + '/meta'`），拿路由反查只能做前缀匹配，会把
> 页面根本没用的接口也算进去。需要调用方请看下面第二节（从调用点抠的，可信）。

| 方法 | 路径 | 鉴权 | 请求字段 | 响应顶层键 | 处理函数 |
|---|---|---|---|---|---|
| GET | `/api/me` | 公开(读登录态) | — | unread, unreadMessages, user | `handleMe` |
| GET | `/api/discover` | 公开 | — | total | `handleDiscover` |
| GET | `/api/u/:名字/profile` | 公开(读登录态) | — | user, stats, isFollowing, isOwn, sites, tagLabel | `handleCreatorProfile` |
| GET | `/api/notifications` | 登录 | — | items | `handleNotificationsList` |
| POST | `/api/notifications/seen` | 登录 | — | — | `handleNotificationsSeen` |
| POST | `/api/auth/register` | 公开 | email, password, code | user | `handleRegister` |
| POST | `/api/auth/login` | 公开 | login, password | user | `handleLogin` |
| POST | `/api/auth/logout` | 公开 | — | — | `handleLogout` |
| POST | `/api/auth/send-code` | 公开/登录 | purpose, email | dev | `handleSendCode` |
| POST | `/api/auth/password` | 登录 | currentPassword, code, newPassword, username | — | `handleChangePassword` |
| POST | `/api/auth/forgot-password` | 公开 | email | — | `handleForgotPassword` |
| POST | `/api/auth/reset-password` | 公开 | email, code, password | — | `handleResetPassword` |
| POST | `/api/account/username` | 登录 | username | — | `handleAccountUsername` |
| POST | `/api/account/password` | 登录 | currentPassword, newPassword | — | `handleAccountPassword` |
| POST | `/api/account/bio` | 登录 | bio | — | `handleAccountBio` |
| GET | `/api/sites` | 登录 | — | — | `handleMySites` |
| POST | `/api/upload` | 登录 | name, html | name, size, url | `handleUpload` |
| GET | `/api/sites/:名字` | 登录+属主 | — | site, id, name, status, kind, size, html, title, description, tag, tagLabel, createdAt, updatedAt, tags, fileCount | `handleSiteDetail` |
| PUT | `/api/sites/:名字` | 登录+属主 | html | — | `handleSiteSaveHtml` |
| PUT | `/api/sites/:名字/meta` | 登录+属主 | title, description, tag | tagLabel, title, description, tag | `handleSiteSaveMeta` |
| DELETE | `/api/sites/:名字` | 登录+属主 | — | — | `handleSiteDelete` |
| GET | `/api/sites/:名字/files` | 登录 | — | total, files | `handleSiteFilesList` |
| POST | `/api/sites/:名字/files` | 登录 | — | — | `handleSiteFileUpload` |
| GET | `/api/sites/:名字/files/content` | 登录+属主 | — | path, size, content, binary | `handleSiteFileContent` |
| DELETE | `/api/sites/:名字/files` | 登录+属主 | — | — | `handleSiteFileDelete` |
| GET | `/api/sites/:名字/stats` | 公开(读登录态) | — | stats, site, name, title, description, tag, tagLabel, ownerId, status, author, id, username | `handleSiteStats` |
| POST | `/api/sites/:名字/like` | 登录 | — | liked, likes | `handleSiteLike` |
| DELETE | `/api/sites/:名字/like` | 登录 | — | liked, likes | `handleSiteUnlike` |
| GET | `/api/sites/:名字/comments` | 公开 | replyTo | total, comments | `handleSiteCommentsList` |
| POST | `/api/sites/:名字/comments` | 登录 | content, replyTo | comment, createdAt, author, id, name, username, total, replyTo, content | `handleSiteCommentAdd` |
| DELETE | `/api/sites/:名字/comments/:id` | 登录 | folder | total | `handleSiteCommentDelete` |
| POST | `/api/sites/:名字/favorite` | 登录 | folder | favorited, favorites | `handleSiteFavorite` |
| DELETE | `/api/sites/:名字/favorite` | 登录 | — | favorited, favorites | `handleSiteUnfavorite` |
| POST | `/api/users/:id/follow` | 登录 | — | following, followers | `handleUserFollow` |
| DELETE | `/api/users/:id/follow` | 登录 | — | following, followers | `handleUserUnfollow` |
| GET | `/api/users/:id/social` | 公开(读登录态) | — | followers, following, isFollowing | `handleUserSocial` |
| GET | `/api/users/:id/follow-list` | 公开(读登录态) | — | type | `handleFollowList` |
| GET | `/api/users/search` | 公开 | — | users | `handleUserSearch` |
| GET | `/api/history` | 登录 | — | sites | `handleHistoryList` |
| POST | `/api/history` | 登录 | site | — | `handleHistoryRecord` |
| DELETE | `/api/history` | 登录 | — | — | `handleHistoryClear` |
| DELETE | `/api/history/:名字` | 登录 | — | — | `handleHistoryDelete` |
| GET | `/api/favorites` | 登录 | — | sites | `handleFavoritesList` |
| GET | `/api/messages` | 登录 | — | conversations | `handleConversations` |
| GET | `/api/messages/:id` | 登录 | — | user, id, name, username, bio, messages | `handleMessagesWith` |
| POST | `/api/messages/:id` | 登录 | content | id, at | `handleMessageSend` |
| GET | `/api/admin/users` | 管理员 | status | total, users | `handleAdminUsers` |
| POST | `/api/admin/users/:id/status` | 管理员 | status | id | `handleAdminUserStatus` |
| GET | `/api/admin/sites` | 管理员 | status | total, sites | `handleAdminSites` |
| POST | `/api/admin/sites/:id/status` | 管理员 | status | id | `handleAdminSiteStatus` |
| DELETE | `/api/admin/sites/:id` | 管理员 | — | id | `handleAdminDeleteSite` |
| POST | `/mcp` | 密钥 | — | — | `handleMcpPost` |
| POST | `/mcp/:key` | 密钥 | — | — | `handleMcpPostWithKey` |
| GET | `/api/mcp/tokens` | 登录 | — | tokens | `handleMcpTokenList` |
| POST | `/api/mcp/tokens` | 登录 | label | token | `handleMcpTokenCreate` |
| POST | `/api/mcp/tokens/:id/revoke` | 登录 | — | id | `handleMcpTokenRevoke` |

## 前端实际在调什么（从 `fetch(...)` 的 URL 字面量抠的，可信）

带参数的请求前端是拼字符串，所以抠出来的是**前缀**。
比如 `fetch('/api/sites/' + name + '/meta')` 抠出 `/api/sites/`。

| 页面 | 调用的 URL 字面量 |
|---|---|
| `admin.html` | `/api/admin/users/` · `/api/admin/sites/` · `/api/me` · `/api/admin/users` · `/api/admin/sites` |
| `app.js` | `/api/auth/logout` · `/api/me` · `/api/auth/login` · `/api/auth/send-code` · `/api/auth/register` |
| `settings.html` | `/api/auth/send-code` · `/api/auth/password` · `/api/mcp/tokens` · `/api/mcp/tokens/${id}/revoke` · `/api/me` |
| `account.html` | `/api/me` · `/api/account/username` · `/api/account/bio` · `/api/account/password` |
| `forgot.html` | `/api/auth/forgot-password` · `/api/auth/reset-password` |
| `index.html` | `/api/upload` · `/api/sites/` |
| `sites.html` | `/api/sites/` · `/api/sites` |
| `discover.html` | `/api/discover?` |
| `site.html` | `/api/sites/` |

**没有任何 API 调用的页面**（＝纯演示页，重写后端时不影响它们）：

- `favorites.html`
- `history.html`
- `login.html`
- `messages.html`
- `notifications.html`
- `user.html`
- `view.html`

## 处理函数清单（重写时逐个对照）

共 56 个接口处理函数。