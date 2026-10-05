# `app/services` —— 业务层

## 职责

**业务规则 + 事务边界 + 多个 Repository 的编排。**
HTTP 不认识这一层，数据库也不认识这一层。

判断标准：这段代码是不是"**业务上应该 / 不应该**"的规则？

| 例子 | 该去哪层 |
|---|---|
| "站点下线了就不能点赞" | ✅ 这里（业务规则） |
| "取消点赞**不**校验站点状态" | ✅ 这里（**刻意的行为不对称**，见下） |
| "`site_id` 是外键、级联删除" | `repositories`（数据约束） |
| "没登录要回 401" | `api`（HTTP 语义） |

## 依赖方向（硬约束）

```
允许   services → repositories / schemas / core / interfaces
禁止   services → api
```

## 文件

| 文件 | 内容 |
|---|---|
| `social_service.py` | `LikeService` —— **垂直切片的模板，新 Service 照它抄** |

## 三个必须守住的点

### 1. 依赖用**构造注入**，不要在方法里 `new`

```python
def __init__(self, sites: SiteRepository, likes: LikeRepository) -> None:
    self._sites = sites
    self._likes = likes
```

这样测试里能塞一个指向临时库的 Repository，不用起 HTTP 服务。
这也是 Java 里 `@Autowired` 想达到的效果 —— Python 里手动传反而更清楚。

### 2. 事务边界在这里

Repository 只管"加进会话"，**什么时候提交由 Service 决定**。
跨多个 Repository 的操作要用 `with session.begin():` 显式圈定范围，
否则中途失败会留下写了一半的数据。

### 3. 会抛的业务异常**必须写进 docstring 的 `Raises:`**

调用方（和未来的你）需要知道会接到什么。
**这条是自动检查的** —— `tests/test_docstrings.py` 会扫函数体里的
`raise XxxError`，没写 `Raises:` 直接红。

## 「刻意的行为不对称」要写在注释里

`LikeService` 里有一处必须保留的不对称：

> **点赞**要校验站点是否上线（下线站点不能赞）；
> **取消点赞刻意不校验** —— 站点被下线后，已经点过赞的人仍然应该能收回那个赞，
> 否则它永远留在那里。

这类"看起来该对称、但故意不对称"的地方**最容易在重写时丢掉**，
所以注释里必须写明"为什么"，而不只是写"是什么"。

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
