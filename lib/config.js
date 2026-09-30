// 全局配置。可调的东西都集中在这里。

export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 3000);

// 单个 HTML 文件的大小上限
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

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
