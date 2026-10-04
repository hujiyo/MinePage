// 全局配置。可调的东西都集中在这里。

export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 3000);

// 单个 HTML 文件的大小上限
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

// 多文件站点：单个文件上限 & 单站文件数上限
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_SITE = 200;

// 请求体上限 = 文件上限 + JSON 包装的余量
export const MAX_BODY_BYTES = MAX_HTML_BYTES + 64 * 1024;

// 站名长度
export const NAME_MIN = 3;
export const NAME_MAX = 32;

// 数据库文件，相对项目根目录
export const DB_FILE = process.env.DB_FILE ?? 'data/minepage.db';

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

// 平台自己占用的名字，用户不能注册。
// 路由本来就优先匹配平台路径，这里拦住是为了避免「用户以为注册成功了、实际怎么都访问不到」。
export const RESERVED = new Set([
  'api',
  'admin',
  'administrator',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'auth',
  'oauth',
  'account',
  'profile',
  'settings',
  'forgot',
  'password',
  'sites',
  'dashboard',
  'assets',
  'static',
  'public',
  'cdn',
  'media',
  'img',
  'images',
  'css',
  'js',
  'fonts',
  'files',
  'file',
  'u', // 创作者主页前缀 /u/:用户名
  'view', // 站点观看包装页 /view/:站名
  'notifications', // 通知列表页
  'favorites', // 我的收藏页
  'history', // 浏览历史页
  'messages', // 私信页
  'upload',
  'uploads',
  'download',
  'downloads',
  'www',
  'mail',
  'email',
  'smtp',
  'ftp',
  'ns',
  'dns',
  'mx',
  'health',
  'status',
  'metrics',
  'stats',
  'ping',
  'mcp',
  'about',
  'help',
  'support',
  'docs',
  'blog',
  'home',
  'index',
  'root',
  'new',
  'edit',
  'delete',
  'create',
  'search',
  'explore',
  'trending',
  'test',
  'demo',
  'dev',
  'staging',
  'prod',
  'localhost',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'manifest.json',
  '_platform',
  'minepage',
]);
