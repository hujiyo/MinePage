"""业务层。

业务规则、事务边界、多个 Repository 的编排都在这里。**HTTP 不认识这一层，数据库也不认识。**

判断某段代码该不该住在这里：它是不是"业务上应该/不应该"的规则？
比如"站点下线了就不能再点赞"是业务规则 → 这里；
"`site_id` 是外键"是数据约束 → repositories；
"没登录要 401"是 HTTP 语义 → api。
"""

from app.services.social_service import LikeService

__all__ = ["LikeService"]
