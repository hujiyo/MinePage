// 全局配置。可调的东西都集中在这里。

export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 3000);

// ---------------------- 上传上限 ----------------------
// 这一组数字按「极简个人 page」的定位定：单页站一份 HTML + 内联 CSS/JS，
// 真实用户的内容在几 MB 量级。每个数都能从某一层硬限制推导出来，不是拍的：
//
//   多页单文件 10 MB  ← site_files.content 是 MEDIUMBLOB（16 MB 硬顶），不用改列
//   单站 50 MB        ← 每人 100 MB 的一半，留一个站的空间给正常取舍
//   ZIP 55 MB         ← 解压后正好装得进一个 50 MB 的站（压缩包本体还要过 nginx）
//
// 模板库（85 MB 的 mp4、4299 个文件）走 scripts/import-templates.mjs 直连 MySQL 批量写，
// 不经过任何 HTTP 入口 —— 它不该反过来定义用户上传上限（2026-10 就是这么漂成 90 MB/5000 的）。

// 单页站 HTML 上限。请求体是 JSON（多包一层），所以 MAX_BODY_BYTES 要留出逃逸余量。
export const MAX_HTML_BYTES = 5 * 1024 * 1024;

// 多页站单个文件上限（含图片/视频这类二进制资源）
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// 单个站点最多几个文件
export const MAX_FILES_PER_SITE = 200;

// 单站内容总量（单页 HTML + 站内所有文件）
export const MAX_SITE_TOTAL_BYTES = Number(process.env.MAX_SITE_TOTAL_BYTES ?? 50 * 1024 * 1024);

// 每人所有站点的内容总量（单页 HTML + 多页文件，不含卡片封面）。
// 站点配额可以靠硬币加，所以单站上限 × 站点数不封顶；磁盘真正的闸是这一道。
export const MAX_USER_TOTAL_BYTES = Number(process.env.MAX_USER_TOTAL_BYTES ?? 100 * 1024 * 1024);

// zip 直传包体上限：解压后按多页站规则校验（单文件、文件数、单站总量都管），
// 压缩包本体要比 50 MB 稍宽一点，因为已压过的媒体几乎不再缩。
// 部署要求：nginx 的 client_max_body_size 必须 ≥ 64m，16m 会把大包在 nginx 就挡成 HTML 413。
export const MAX_ZIP_BYTES = 55 * 1024 * 1024;

// 卡片自定义封面上限：和编辑页 UI 提示的「≤2MB」对齐
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

// 多文件上传的草稿保留多久（小时）。上传是逐个文件发请求，站点要等全部传完才发布，
// 没传完就放弃的草稿由定时任务按 updated_at 清掉，顺带释放它占的配额与存储额度。
export const DRAFT_TTL_HOURS = Number(process.env.DRAFT_TTL_HOURS ?? 24);

// 系统垃圾文件/目录黑名单：站内路径任何一段（不分大小写）撞上就拒绝入库。
// 点开头的隐藏文件已被 PATH_SEGMENT 挡掉，这里补 Thumbs.db / desktop.ini 这类不带点的。
export const JUNK_SEGMENTS = new Set([
  'thumbs.db',
  'desktop.ini',
  'ehthumbs.db',
  'ehthumbs_vista.db',
  '__macosx',
  'node_modules',
]);

// 请求体上限：单页 HTML 走 JSON（{ name, html }），最坏情况是整篇都是需要转义的
// 字符（引号、反斜杠、控制字符），JSON 编码后能膨胀到原文的两倍甚至六倍。
// 留 2 倍 + 64 KB 余量，保证「HTML 本身没超」的内容不会先被请求体上限挡掉。
export const MAX_BODY_BYTES = MAX_HTML_BYTES * 2 + 64 * 1024;

// 站名 / 用户名长度
export const NAME_MIN = 3;
export const NAME_MAX = 32;

// 用户命名空间前缀：用户的所有站点都挂在 /<前缀>/<用户名>/<站名> 下。
// 这样站名只需要在自己名下唯一，平台路由也不再和用户站名抢根路径。
export const USER_SPACE_PREFIX = process.env.USER_SPACE_PREFIX ?? 'qwq';

// 每人最多能建多少个站点（基础配额；硬币可再换额外名额，见 QUOTA_COINS_PER_SLOT）
export const MAX_SITES_PER_USER = Number(process.env.MAX_SITES_PER_USER ?? 10);

// 草稿站不计入上面的站点配额，但单独设上限，防止无限堆积把库撑爆
export const MAX_DRAFTS_PER_USER = Number(process.env.MAX_DRAFTS_PER_USER ?? 20);

// 工作区对话：单条消息上限、单个站点保留的条数上限
export const SITE_MESSAGE_MAX = 4000;
export const SITE_MESSAGES_KEEP = 200;

// ---------------------- 硬币 ----------------------
// 注册即送：让新账号立刻能体验投币，不用等到明天
export const COIN_REGISTER_BONUS = Number(process.env.COIN_REGISTER_BONUS ?? 3);

// 每日首次访问发的好运币（按 UTC+8 的自然日算，ref 存 YYYY-MM-DD 防重复）
export const COIN_DAILY = Number(process.env.COIN_DAILY ?? 1);

// 每人每个站点最多投几枚（B 站同款 2 枚）。投出去的币 1:1 进作者余额，不可撤回。
export const MAX_COINS_PER_SITE = Number(process.env.MAX_COINS_PER_SITE ?? 2);

// 换一个额外站点配额要花几枚硬币。配额 = MAX_SITES_PER_USER + 已兑换份数
export const QUOTA_COINS_PER_SLOT = Number(process.env.QUOTA_COINS_PER_SLOT ?? 5);

// ---------------------- MySQL ----------------------
// 存储全在 MySQL：应用启动时自动建表（幂等），库和账号由部署方提前建好。
export const MYSQL_HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
export const MYSQL_PORT = Number(process.env.MYSQL_PORT ?? 3306);
export const MYSQL_USER = process.env.MYSQL_USER ?? 'minepage';
export const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? '';
export const MYSQL_DATABASE = process.env.MYSQL_DATABASE ?? 'minepage';

// 会话有效期（天）
export const SESSION_TTL_DAYS = 30;

// 会话 Cookie 名
export const SESSION_COOKIE = 'mp_session';

// 走 HTTPS 之后设 COOKIE_SECURE=1，Cookie 会带上 Secure
export const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// 平台自身静态资源的前缀
export const ASSET_PREFIX = '/_assets/';

// 注册密码最短长度
export const PASSWORD_MIN = 6;

// ---------------------- 邮箱验证码 ----------------------

// 验证码位数与有效期（分钟）
export const CODE_LENGTH = 6;
export const CODE_TTL_MINUTES = 10;

// 同一邮箱同一用途两次发送的最小间隔（秒）
export const CODE_RESEND_COOLDOWN_SECONDS = 60;

// 单个验证码最大校验失败次数，超过就作废
export const CODE_MAX_ATTEMPTS = 5;

// SMTP 发信配置，全部走环境变量：
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_SECURE
// 不配置 SMTP_HOST 时退化为开发模式：邮件内容打印到服务器控制台。
export const SMTP = {
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: process.env.SMTP_SECURE === '1' || (!process.env.SMTP_SECURE && Number(process.env.SMTP_PORT ?? 465) === 465),
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
};

// 站点标题 / 简介长度上限（站点设置）
export const SITE_TITLE_MAX = 80;
export const SITE_DESC_MAX = 300;

// 个人简介长度上限
export const BIO_MAX = 200;

// 评论长度上限
export const COMMENT_MAX = 500;

// ---------------------- 热门搜索 ----------------------

// 热搜榜回看几天内的搜索记录。窗口越长榜越稳，但也越容易被旧词霸占。
export const HOT_WINDOW_DAYS = Number(process.env.HOT_WINDOW_DAYS ?? 7);

// 榜上最多几个词。
export const HOT_LIMIT = Number(process.env.HOT_LIMIT ?? 10);

// 上榜门槛：至少 N 个不同的人搜过这个词才算「热门」。
// 1 会让任何人自己搜一次就霸榜，也等于把单个用户私下的搜索词公示出去，所以最少是 2。
export const HOT_MIN_SEARCHERS = Math.max(2, Number(process.env.HOT_MIN_SEARCHERS ?? 2));

// 聚合结果缓存多久（毫秒）。一个进程，不需要 Redis。
export const HOT_CACHE_MS = Number(process.env.HOT_CACHE_MS ?? 5 * 60_000);

// ---------------------- MCP ----------------------

// MCP 密钥前缀。库里只存 sha256，明文只在创建响应里出现一次。
export const MCP_TOKEN_PREFIX = 'mp_mcp_';

// 每个账户最多保留的有效密钥数
export const MCP_TOKENS_PER_USER = 10;

// 两次落盘 last_used_at 的最小间隔（毫秒），避免每次调用都写库
export const MCP_LAST_USED_THROTTLE_MS = 60_000;

// MCP 的请求体是 JSON 包装过的文件内容：base64 后膨胀 4/3，再留一点 JSON 余量。
export const MCP_BODY_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024 * 1024;

// read_file 能吐回对话里的内容上限。再大就不是「读代码」而是往上下文里灌体积了。
export const MCP_READ_MAX_BYTES = 256 * 1024;

// 用户名占的是 /<前缀>/<用户名> 这一段，已经不跟任何平台路由抢根路径，
// 所以保留字只剩前缀本身（免得 /qwq/qwq 这种自己套自己的地址让人犯迷糊）。
// 站名在用户名下面，天然不会撞平台路由，不再需要保留字表。
export const RESERVED = new Set([USER_SPACE_PREFIX]);
