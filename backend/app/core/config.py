"""全局配置。

对应原 Node 版的 `lib/config.js`，分成两类：

* `Settings` —— 走环境变量的（数据库地址、端口、SMTP、管理员种子）
* `Limits` / `SITE_TAGS` / `RESERVED` —— 固定的业务规则，不走环境变量

原版把两者混在一个文件里（都叫 `export const`）。这里分开，是因为它们的
**变更原因不同**：环境变量按部署环境变，业务上限按产品规则变。
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """环境变量驱动的配置。字段名小写，pydantic-settings 自动映射大写的环境变量名。"""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ---- 数据库 ----
    # 开发默认 SQLite：不用装任何数据库服务就能跑起来。
    # 部署改成 postgresql+psycopg://用户:密码@主机:5432/库名 —— 业务代码一行都不用动。
    database_url: str = "sqlite+pysqlite:///./data/minepage.db"

    # ---- HTTP ----
    host: str = "127.0.0.1"
    # 固定 3000：前端 public/ 里全是相对路径（/api/...），后端必须和页面同源
    port: int = 3000

    # 前端静态文件目录。默认指向仓库根的 public/（本仓库结构）。
    # docker 里通过环境变量覆盖成挂载点。
    public_dir: str = "../public"

    # ---- 会话 Cookie ----
    # 全站 HTTPS 之后才设 1；非 HTTPS 环境设 1 会导致浏览器不回传 Cookie、登录不上。
    cookie_secure: bool = False

    # ---- SMTP（留空则退化为开发模式：整封信打印到控制台）----
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_pass: str = ""
    smtp_from: str = ""
    smtp_secure: bool = False

    # ---- 管理员种子账号（只在库里没有管理员时创建）----
    admin_username: str = "admin"
    admin_password: str = "123"
    admin_email: str = "admin@minepage.local"

    @property
    def smtp_configured(self) -> bool:
        """是否配了 SMTP。它是「真发信」与「打印到控制台」的分支条件。"""
        return bool(self.smtp_host)

    @property
    def smtp_use_tls(self) -> bool:
        """是否 TLS 直连。

        规则与原版一致：显式设了 `SMTP_SECURE` 就听它的；没设时端口是 465 就自动开
        （587 走 STARTTLS，保持关闭）。
        """
        return self.smtp_secure or (self.smtp_port == 465)

    @property
    def smtp_sender(self) -> str:
        """发件人地址，回落到登录账号 —— 多数服务商要求两者一致。"""
        return self.smtp_from or self.smtp_user

    @property
    def public_path(self) -> Path:
        """前端静态目录的绝对路径。

        默认值是 `../public`（相对 `backend/`）—— 也就是**仓库根目录下的 `public/`**，
        那 15 个页面和 `app.js` / `style.css` 就住在那里，**换后端时一行都不改**。
        docker 里通过环境变量覆盖成挂载点。

        `main.py` 和 `api/pages.py` 都用它，所以只在这里拼一次。
        """
        return Path(self.public_dir).resolve()


settings = Settings()


class Limits:
    """业务上限与规则（← `lib/config.js` 里不走环境变量的那部分）。

    这些是产品规则，不该按部署环境变，所以写成类常量而不是配置项。
    """

    # 单个 HTML 上限。单页站上传与保存按它卡，超限回 413。
    MAX_HTML_BYTES: int = 2 * 1024 * 1024
    # 多文件站：单个文件上限。只卡单文件，不卡单站累计体积。
    MAX_FILE_BYTES: int = 10 * 1024 * 1024
    # 单站文件数上限。只在「新增文件」时校验，覆盖已有路径不受影响。
    MAX_FILES_PER_SITE: int = 200
    # 普通 JSON 请求体上限 = HTML 上限 + 包装余量
    MAX_BODY_BYTES: int = MAX_HTML_BYTES + 64 * 1024

    # 站名（与用户名共用同一对上下限）
    NAME_MIN: int = 3
    NAME_MAX: int = 32

    # 会话有效期（天）
    SESSION_TTL_DAYS: int = 30
    SESSION_COOKIE: str = "mp_session"

    # 平台静态资源前缀。注意页面里的链接是硬编码同名字面量，改它不改变实际路径。
    ASSET_PREFIX: str = "/_assets/"

    # 密码最短长度。注册 / 改密 / 重置流程校验；管理员种子账号的默认口令不受它约束。
    PASSWORD_MIN: int = 6

    # ---- 邮箱验证码 ----
    CODE_LENGTH: int = 6
    CODE_TTL_MINUTES: int = 10
    # 同一邮箱同一用途两次发送的最小间隔（秒）。没有 IP 维度，换邮箱可绕过。
    CODE_RESEND_COOLDOWN_SECONDS: int = 60
    # 单个验证码最大失败次数，超过作废
    CODE_MAX_ATTEMPTS: int = 5

    # ---- 文本长度 ----
    SITE_TITLE_MAX: int = 80
    SITE_DESC_MAX: int = 300
    BIO_MAX: int = 200
    COMMENT_MAX: int = 500

    # ---- MCP ----
    MCP_TOKEN_PREFIX: str = "mp_mcp_"
    MCP_TOKENS_PER_USER: int = 10
    # 两次落盘 last_used_at 的最小间隔（毫秒），避免每次调用都写库
    MCP_LAST_USED_THROTTLE_MS: int = 60_000
    # MCP 请求体 = 文件内容 base64（膨胀 4/3）后包一层 JSON
    MCP_BODY_BYTES: int = (MAX_FILE_BYTES * 4 + 2) // 3 + 1024 * 1024
    # read_file 能吐回对话里的内容上限，再大就不是「读代码」而是灌上下文
    MCP_READ_MAX_BYTES: int = 256 * 1024


class SiteTags:
    """站点内容标签词表。

    **这是权威的一份** —— 原版前后端各存一份，漂移过（前端 `oss` / 服务端 `opensource`），
    导致「开源项目」筛选永远为空。这里只有一处定义，前端那份由接口下发。
    """

    TAGS: tuple[tuple[str, str], ...] = (
        ("resume", "求职简历"),
        ("portfolio", "作品集"),
        ("social", "社交聚合页"),
        ("blog", "技术博客"),
        ("event", "活动落地页"),
        ("opensource", "开源项目"),
        ("docs", "学习笔记"),
        ("other", "其他"),
    )

    @classmethod
    def is_valid(cls, key: str) -> bool:
        """空串表示「未设置」，也算合法。"""
        return key == "" or any(k == key for k, _ in cls.TAGS)

    @classmethod
    def label_of(cls, key: str) -> str:
        """标签 key → 中文名。未知 key 返回空串（不抛错）。"""
        for k, label in cls.TAGS:
            if k == key:
                return label
        return ""


#: 用户名字符集。与站名同一套规则：**只允许小写字母、数字和连字符**。
#:
#: 为什么不在 `Limits` 里：编译好的正则是个可变对象，放进类属性会被 ruff 的
#: `RUF012` 盯上（"类属性应该是不可变的"）。放模块级既避开这个问题，也更直白 ——
#: 它是**校验用的工具**，不是"可调的配置上限"。
USERNAME_PATTERN = re.compile(r"^[a-z0-9-]+$")

#: 站名规则：**首尾必须是字母或数字**，中间允许连字符。
#: 比 `USERNAME_PATTERN` 更严 —— 用户名允许 `-a`，站名不允许。
#: 对应原版 `lib/names.js` 的 `PATTERN`。
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")

#: 站内路径的**单个路径段**规则：不含 `/`、不含 `\`、不全是点。
#: 完整的路径校验见 `services/site_manage_service.py` 的 `is_valid_site_path()`。
PATH_SEGMENT_PATTERN = re.compile(r"^[^/\\]+$")


# 平台自己占用的名字，用户不能注册。
# 路由本来就优先匹配平台路径，这里拦住是为了避免「用户以为注册成功了、实际访问不到」。
# 只在新注册 / 改站名时校验，不回溯检查库里已有的站名。
RESERVED: frozenset[str] = frozenset(
    {
        "api",
        "admin",
        "administrator",
        "login",
        "logout",
        "signin",
        "signup",
        "register",
        "auth",
        "oauth",
        "account",
        "profile",
        "settings",
        "forgot",
        "password",
        "sites",
        "dashboard",
        "assets",
        "static",
        "public",
        "cdn",
        "media",
        "img",
        "images",
        "css",
        "js",
        "fonts",
        "files",
        "file",
        "u",  # 创作者主页前缀 /u/:用户名
        "view",  # 站点观看包装页 /view/:站名
        "notifications",
        "favorites",
        "history",
        "messages",
        "upload",
        "uploads",
        "download",
        "downloads",
        "www",
        "mail",
        "email",
        "smtp",
        "ftp",
        "ns",
        "dns",
        "mx",
        "health",
        "status",
        "metrics",
        "stats",
        "ping",
        "mcp",
        "about",
        "help",
        "support",
        "docs",
        "blog",
        "home",
        "index",
        "root",
        "new",
        "edit",
        "delete",
        "create",
        "search",
        "explore",
        "trending",
        "test",
        "demo",
        "dev",
        "staging",
        "prod",
        "localhost",
        "favicon.ico",
        "robots.txt",
        "sitemap.xml",
        "manifest.json",
        "_platform",
        "minepage",
    },
)
