"""社区互动接口。

**这是垂直切片的模板** —— 其它接口模块照这个写法来：

1. 路由函数只做「取依赖 → 调 Service → 返回」
2. 不写业务判断（那在 Service 里）
3. 不碰数据库（那在 Repository 里）
4. 返回 Pydantic 模型，字段名与 `docs/rewrite/rewrite-contract.md` 一致

加一个接口的完整步骤见 `backend/README.md` 的「怎么加一个新接口」。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import get_like_service, require_user
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.social import LikeOut
from app.schemas.user import CurrentUser
from app.services.social_service import LikeService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["social"])

# 注意路径形式：原版路由正则只认小写字母数字和连字符（`([a-z0-9-]+)`），
# 所以这里用 {name} 收，规范化交给 Service。
# —— 原版「站名含大写时多文件接口 404」那个 bug 就是从这个正则来的
#    （见 tests/new-findings.md），重写后用路径参数 + 统一小写处理，不再有这条分叉。


@router.post("/api/sites/{name}/like", response_model=LikeOut)
def like_site(
    name: str,
    user: CurrentUser = Depends(require_user),
    service: LikeService = Depends(get_like_service),
) -> LikeOut:
    """点赞。已下线站点会被拒（451）；重复点赞幂等。

    契约：`POST /api/sites/:名字/like` → `{ok, liked: true, likes: N}`
    """
    return service.like(site_name=name, user_id=user.id)


@router.delete("/api/sites/{name}/like", response_model=LikeOut)
def unlike_site(
    name: str,
    user: CurrentUser = Depends(require_user),
    service: LikeService = Depends(get_like_service),
) -> LikeOut:
    """取消点赞。

    **刻意不校验站点状态** —— 与原版一致：站点下线后仍应允许取消，
    否则那个赞永远留在那里。契约：`{ok, liked: false, likes: N}`
    """
    return service.unlike(site_name=name, user_id=user.id)
