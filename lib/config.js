// 全局配置。可调的东西都集中在这里。

// HTTP 监听地址。默认 127.0.0.1，也就是只监听本机；要对外提供服务用 HOST=0.0.0.0。
export const HOST = process.env.HOST ?? '127.0.0.1';
// HTTP 监听端口。默认 3000。没有取值范围校验，非法值会在 server.listen 时报错。
export const PORT = Number(process.env.PORT ?? 3000);

// 单个 HTML 文件的大小上限
// 默认 2 MB。单页站上传（POST /api/upload）和保存（PUT /api/sites/:name）按它卡，超限回 413。
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

// 多文件站点：单个文件上限 & 单站文件数上限
// 默认 10 MB。只卡单个文件，不卡单站累计体积——200 个文件理论上能堆到 2 GB。
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 默认 200 个。只在「新增文件」时校验，覆盖已有路径不受这个上限影响。
export const MAX_FILES_PER_SITE = 200;

// 请求体上限 = 文件上限 + JSON 包装的余量
// 默认 2 MB + 64 KB，是 server.js 里 readJsonBody / readRawBody 的默认上限；
// 单个站点文件不走这里，走 readFileBody(req, res, MAX_FILE_BYTES)。
export const MAX_BODY_BYTES = MAX_HTML_BYTES + 64 * 1024;

// 站名长度
// 默认 3-32 个字符。用户名（users.js 的 isValidUsername）复用同一对上下限，改这里会同时影响两边。
export const NAME_MIN = 3;
export const NAME_MAX = 32;

// 数据库文件，相对项目根目录
// 默认 data/minepage.db；目录不存在时 getDb() 会自动创建。
export const DB_FILE = process.env.DB_FILE ?? 'data/minepage.db';

// 会话有效期（天）
// 默认 30 天，写死在代码里（没有环境变量可改）；sessions.expires_at 按它计算。
export const SESSION_TTL_DAYS = 30;

// 会话 Cookie 名
export const SESSION_COOKIE = 'mp_session';

// 走 HTTPS 之后设 COOKIE_SECURE=1，Cookie 会带上 Secure
// 默认 false（非 HTTPS 环境也能登录）；只有确认全站 HTTPS 时才该打开，否则浏览器不会回传会话 Cookie。
export const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// 平台自身静态资源的前缀
// 默认 '/_assets/'。注意 server.js 的路由正则和页面里的链接目前是硬编码的同名字面量，改这个常量不会改变实际路径。
export const ASSET_PREFIX = '/_assets/';

// 注册密码最短长度
// 默认 6 位。校验在 server.js 的注册 / 改密 / 重置流程里做；
// users.js 的 createUser / updateUserPassword 不校验，管理员种子账号的默认密码 '123' 也不受它约束。
export const PASSWORD_MIN = 6;

// ---------------------- 邮箱验证码 ----------------------

// 验证码位数与有效期（分钟）
// 默认 6 位数字（随机上界是 10 ** CODE_LENGTH，不足位补 0），在邮件正文里明文出现，库里只存哈希。
export const CODE_LENGTH = 6;
// 默认 10 分钟。过期记录不会被立刻删除，只靠 cleanup() 清掉 1 天前的。
export const CODE_TTL_MINUTES = 10;

// 同一邮箱同一用途两次发送的最小间隔（秒）
// 默认 60 秒。只按「邮箱 + 用途」判断，没有 IP 维度，换个邮箱就能绕过。
export const CODE_RESEND_COOLDOWN_SECONDS = 60;

// 单个验证码最大校验失败次数，超过就作废
// 默认 5 次：第 6 次提交直接拒绝，不再比对哈希。
export const CODE_MAX_ATTEMPTS = 5;

// SMTP 发信配置，全部走环境变量：
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_SECURE
// 不配置 SMTP_HOST 时退化为开发模式：邮件内容打印到服务器控制台。
export const SMTP = {
  // SMTP 主机。留空 = 未配置，邮件退化为打印到控制台（判断见 email.js 的 mailConfigured）。
  host: process.env.SMTP_HOST ?? '',
  // SMTP 端口，默认 465。
  port: Number(process.env.SMTP_PORT ?? 465),
  // 是否 TLS 直连：SMTP_SECURE=1 强制打开；没设 SMTP_SECURE 时端口是 465 就自动打开（587 走 STARTTLS，保持 false）。
  secure: process.env.SMTP_SECURE === '1' || (!process.env.SMTP_SECURE && Number(process.env.SMTP_PORT ?? 465) === 465),
  // 登录用户名。留空时不带 auth 字段建 transporter（本机中继场景）。
  user: process.env.SMTP_USER ?? '',
  // 登录密码。只从环境变量读，不落库、不打日志。
  pass: process.env.SMTP_PASS ?? '',
  // 发件人地址，默认回落到 SMTP_USER。多数服务商要求它和登录账号一致。
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
};

// 站点标题 / 简介长度上限（站点设置）
// 默认 80 / 300，按 JS 字符串长度（UTF-16 码元）算，不是字节数。
export const SITE_TITLE_MAX = 80;
export const SITE_DESC_MAX = 300;

// 个人简介长度上限
// 默认 200；超出时 setBio 抛 BIO_TOO_LONG。
export const BIO_MAX = 200;

// 评论长度上限
// 默认 500。私信正文（server.js 的 handleMessageSend）也复用这个上限。
export const COMMENT_MAX = 500;

// ---------------------- MCP ----------------------

// MCP 密钥前缀。库里只存 sha256，明文只在创建响应里出现一次。
// 默认 'mp_mcp_'：MCP 入口靠这个前缀从 Authorization / ?key= / /mcp/<key> 里认出密钥。
export const MCP_TOKEN_PREFIX = 'mp_mcp_';

// 每个账户最多保留的有效密钥数
// 默认 10 把；创建时超出直接报错，不会自动吊销旧的。
export const MCP_TOKENS_PER_USER = 10;

// 两次落盘 last_used_at 的最小间隔（毫秒），避免每次调用都写库
// 默认 60 秒；间隔内的调用不更新 last_used_at。
export const MCP_LAST_USED_THROTTLE_MS = 60_000;

// MCP 的请求体是 JSON 包装过的文件内容：base64 后膨胀 4/3，再留一点 JSON 余量。
// 默认约 14.3 MB（10 MB × 4/3 再加 1 MB），比普通接口宽得多。
export const MCP_BODY_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024 * 1024;

// read_file 能吐回对话里的内容上限。再大就不是「读代码」而是往上下文里灌体积了。
// 默认 256 KB；超过就不返回文件内容，只回一条体积提示。
export const MCP_READ_MAX_BYTES = 256 * 1024;

// 平台自己占用的名字，用户不能注册。
// 路由本来就优先匹配平台路径，这里拦住是为了避免「用户以为注册成功了、实际怎么都访问不到」。
// 只在新注册 / 改站名时校验，不会回溯检查库里已有的站名——往这里加保留字不影响存量数据。
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
