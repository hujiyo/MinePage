# 管理权限闭环

> 这张图是**排查用的**：管理动作出问题时，顺着图找是哪一环断了。
>
> **图与代码同步**由 `tests/test_admin_loop_doc.py` 保证 ——
> 接口增删而图没更新，那个测试会失败。所以这张图不会悄悄过期。

## 为什么需要这张图

重写过程中出现过一次真实的问题：**执行侧是完整的，管理侧却完全是空的**。

* 一个被封禁的用户，后端**真的会拦住**（登录 403、已有会话下个请求就失效）
* 但**没有任何接口能让管理员去封别人** —— 只能直接改数据库

所以「权限模块做完了」这句话是**不能只看执行侧**就下的。这张图把两侧画在一起，
任何一侧缺了都看得出来。

---

## 一、闭环全景

```mermaid
flowchart TB
    subgraph actors["参与者"]
        direction LR
        A1["匿名访客"]
        A2["普通用户"]
        A3["管理员"]
    end

    subgraph guard["鉴权闸门 · app/core/deps.py"]
        direction TB
        G1["get_current_user<br/>有会话 <b>且</b> users.status=active"]
        G2["require_admin<br/>登录 <b>且</b> users.is_admin=1"]
        G1 -->|"没登录 401"| X1(["拒绝"])
        G1 --> G2
        G2 -->|"登录了但不是管理员 403"| X2(["拒绝"])
    end

    subgraph api["管理接口 · 5 条，全部经过 require_admin"]
        direction TB
        E1["GET /api/admin/users"]
        E2["POST /api/admin/users/:id/status"]
        E3["GET /api/admin/sites"]
        E4["POST /api/admin/sites/:id/status"]
        E5["DELETE /api/admin/sites/:id"]
    end

    subgraph svc["AdminService · 业务规则"]
        direction TB
        R1["状态归一化：<br/>只认 banned，其余一律 active"]
        R2["拒绝封自己<br/>400 不能封禁自己"]
        R3["状态归一化：<br/>只认 offline，其余一律 active"]
        R4["按<b>主键 id</b> 找站点<br/>找不到 404 没有这个页面"]
    end

    subgraph db["数据库状态"]
        direction LR
        D1[("users.status<br/>active / banned")]
        D2[("sites.status<br/>active / offline")]
        D3[("sites 行 + site_files<br/>外键级联")]
    end

    subgraph eff["执行侧效果 · 每请求现查，不依赖管理接口"]
        direction TB
        F1["被封者登录 → <b>403</b>"]
        F2["被封者已有会话 → 下个请求<b>当未登录</b>（401）"]
        F3["下线站点访问 → <b>451</b>"]
        F4["下线站点点赞/收藏/评论 → <b>451</b>"]
        F5["下线站点看统计/评论列表 → <b>仍然 200</b>"]
        F6["下线站点从发现流<b>消失</b>"]
        F7["删除后访问 → <b>404</b>"]
        F8["删除后 site_files <b>级联清掉</b>"]
    end

    A1 --> G1
    A2 --> G1
    A3 --> G1
    G2 -->|"放行"| api

    E1 -->|"全库总数 + 新的在前 200 条<br/><b>驼峰</b> isAdmin/createdAt<br/>不含 password_hash"| D1
    E3 -->|"含已下线 · <b>蛇形</b> created_at/owner_email<br/>LEFT JOIN 带出作者"| D2

    E2 --> R1 --> R2 -->|"目标 id ≠ 自己"| D1
    E4 --> R3 --> R4 --> D2
    E5 --> R4 --> D3

    D1 -->|"banned"| F1
    D1 -->|"banned"| F2
    D2 -->|"offline"| F3
    D2 -->|"offline"| F4
    D2 -->|"offline"| F5
    D2 -->|"offline"| F6
    D3 -->|"行消失"| F7
    D3 -->|"行消失"| F8

    classDef deny fill:#ffe0e0,stroke:#d33,color:#900
    classDef allow fill:#e0f5e0,stroke:#3a3,color:#060
    classDef state fill:#e8eeff,stroke:#36c,color:#039
    classDef note fill:#fff4d6,stroke:#c90,color:#630
    class X1,X2 deny
    class F1,F2,F3,F4,F7 deny
    class F5,F6,F8 allow
    class D1,D2,D3 state
    class R1,R2,R3,R4 note
```

---

## 二、两个"归一化"是**危险的默认值**

这是整张图里最容易咬人的地方，单独画一遍：

```mermaid
flowchart LR
    I1["body.status = 'banned'"] --> O1["users.status = banned ✅"]
    I2["body.status = 'xxx'"] --> O2["users.status = <b>active</b> ⚠️"]
    I3["body.status = 'BANNED'"] --> O3["users.status = <b>active</b> ⚠️"]
    I4["body.status = ''"] --> O4["users.status = <b>active</b> ⚠️"]
    I5["body.status 缺字段"] --> O5["users.status = <b>active</b> ⚠️"]

    I6["body.status = 'offline'"] --> O6["sites.status = offline ✅"]
    I7["body.status = 其它任何值"] --> O7["sites.status = <b>active</b> ⚠️"]

    classDef warn fill:#ffe0e0,stroke:#d33,color:#900
    classDef ok fill:#e0f5e0,stroke:#3a3,color:#060
    class O2,O3,O4,O5,O7 warn
    class O1,O6 ok
```

**含义**：传 `"xxx"` 不会报 400，而是**静默解封** / **静默上线**。
原版就是这样，前端只会传那两个词，所以保持原样 ——
但**将来任何别处要调这个接口，都必须注意这个默认值**。

`tests/test_admin.py` 里有参数化用例把这两个行为**钉住**，
免得以后有人"顺手改成校验"而改掉契约。

---

## 三、出问题时怎么用这张图查

按"症状 → 顺着图往回找"的顺序：

| 症状 | 图上的位置 | 先查什么 |
|---|---|---|
| 管理员打开 `admin.html` 是**空表 + 一句错误** | `guard → api` 这一跳 | 接口是否 401/403？`is_admin` 是否为 1？ |
| 明明封了人，他**还能用** | `db → eff` 这几条边 | `users.status` 真的写成 `banned` 了吗？`get_current_user` 是否**每请求现查**？ |
| 封了人，他**重新登录还能进** | `D1 → F1` | 登录接口有没有查 `status`？ |
| 下线了站点，访问**还是 200** | `D2 → F3` | 站点状态写进去了吗？页面路由有没有读 `status`？ |
| 下线了站点，**还能点赞** | `D2 → F4` | 互动接口有没有查站点状态？<br/>（注意取消点赞**刻意不查**） |
| 删了站点，**文件还在库里** | `D3 → F8` | 外键是不是 `ON DELETE CASCADE`？SQLite 要开 `PRAGMA foreign_keys` |
| 管理员列表里**看不到**某个站点 | `E3` | 它被删了吗？这里的列表**含已下线**，所以下线不该导致消失 |
| 管理后台**归属列全空** | `E3` 的 LEFT JOIN | 用 INNER JOIN 的话**无主站点会整行消失**；用 LEFT JOIN 才是 `None` → 前端显示「（无归属）」 |
| 用户列表里**多了个 `password_hash`** | `E1` | 出参没过 `UserOut` |

---

## 四、接口清单（这张图会被测试校验）

下面这 5 行是**权威清单**，`tests/test_admin_loop_doc.py` 拿它和
运行中的 OpenAPI 对比 —— 对不上就失败。

<!-- ADMIN_ENDPOINTS:BEGIN （测试解析这一段，别改格式） -->
| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | /api/admin/users | 管理员 |
| POST | /api/admin/users/{user_id}/status | 管理员 |
| GET | /api/admin/sites | 管理员 |
| DELETE | /api/admin/sites/{site_id} | 管理员 |
| POST | /api/admin/sites/{site_id}/status | 管理员 |
<!-- ADMIN_ENDPOINTS:END -->

---

## 五、每条边由哪个测试保证

图上的边不是画着好看的 —— 每条都有用例撑着：

| 图上的边 | 测试 |
|---|---|
| 匿名 → 401 / 普通用户 → 403 / 管理员 → 放行 | `test_admin.py::TestAdminGuard`（5 条接口逐一参数化） |
| `E1` 驼峰 + `total` 是全库总数 + 不含 `password_hash` | `TestAdminUsers` |
| `E2 → R1 → R2`（归一化 + 不能封自己 + 404） | `TestAdminUserStatus` |
| `D1 → F1`（被封者登录 403） | `TestBanTakesEffect::test_banned_user_cannot_login` |
| `D1 → F2`（已有会话下个请求掉线） | `TestBanTakesEffect::test_banned_user_loses_existing_session` |
| 解封后能登录（闭环的另一半） | `TestBanTakesEffect::test_unban_restores_login` |
| `E3` 含已下线 + 蛇形键 + LEFT JOIN 的无主站点 | `TestAdminSites` |
| `E4 → R3 → R4` | `TestAdminSiteStatus` |
| `D2 → F3`（451） / `D2 → F6`（发现流消失） / 恢复 | `TestOfflineTakesEffect` |
| `E5`（跨归属删除 + 级联 + 404） | `TestAdminDeleteSite` |
| 两个 `set_status` 不再是死代码 | `TestPreviouslyDeadCode` |

**所以：改了管理接口的行为，要么改测试要么改图** —— 两边对不上，CI 会拦下来。
