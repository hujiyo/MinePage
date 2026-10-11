#!/usr/bin/env node
// seed-community.mjs —— 为演示社区灌入 156 个测试用户，并把 467 个模板站分配上线。
//
// 用法（必须在服务器 /opt/minepage 目录树下跑，才能解析到 node_modules/mysql2）：
//   sudo bash -c 'set -a; source /etc/minepage.env; set +a; node /opt/minepage/scripts/seed-community.mjs'
//
// 开关：
//   DRYRUN=1  只读取并打印分配计划，不写库
//   FORCE=1   先把 tp- 模板站摘 owner、下线，并删除全部 @demo.minepage.local 用户，再重新灌
//
// 幂等：默认只补缺。tp- 站若已归属演示用户则跳过；用户按 email 复用。二次运行近似 no-op。
//
// 安全边界：本脚本只操作 name LIKE 'tp-%' 的模板站，以及 email 以 @demo.minepage.local
// 结尾的演示用户，绝不触碰真实用户及其站点。
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';

const DRYRUN = process.env.DRYRUN === '1';
const FORCE = process.env.FORCE === '1';

const EMAIL_SUFFIX = '@demo.minepage.local';
const PASSWORD = 'demo123';

// 每个分类分配的用户数；未列出的分类用 DEFAULT_USERS。
const USER_PLAN = { tpl100: 28, zhiye: 2 };
const DEFAULT_USERS = 7;

// 分类 slug -> 中文名（slug 来自站名 tp-<slug>-<seq>）
const CAT_ZH = {
  tpl100: '通用网页',
  ai: 'AI',
  bs5: 'Bootstrap5',
  geren: '个人主页',
  qiye: '企业官网',
  nongye: '农业',
  yiliao: '医疗健康',
  boke: '博客',
  houtai: '管理后台',
  chongwu: '宠物',
  gongye: '工业',
  jiaoyu: '教育',
  lvyou: '旅游',
  qiche: '汽车',
  youxi: '游戏',
  denglu: '登录页',
  keji: '科技',
  wangdian: '网店电商',
  zhiye: '职业求职',
  yinyue: '音乐',
};

// 站点内容标签，取值必须是应用 SITE_TAGS 里的 key，其余归 other。
const TAG_MAP = { zhiye: 'resume', geren: 'portfolio', boke: 'blog' };

// 每个分类一句中文简介，作为该分类演示用户的 bio。
const BIO = {
  tpl100: '专注通用网页模板，风格简洁、结构清晰。',
  ai: 'AI 与智能应用主题页面，探索算法与模型的表达。',
  bs5: 'Bootstrap 5 响应式布局爱好者，组件与栅格信手拈来。',
  geren: '个人主页与作品集，记录自己的一点一滴。',
  qiye: '企业官网主题，专业、稳重、值得信赖。',
  nongye: '乡土情结，做绿色自然的农业主题页面。',
  yiliao: '医疗健康主题，用页面传递关怀与专业。',
  boke: '写字的人，博客主题页面的长期实践者。',
  houtai: '管理后台与数据面板，偏爱清晰的信息层级。',
  chongwu: '铲屎官一枚，为毛孩子做的温馨页面。',
  gongye: '工业与制造主题，硬朗、可靠、讲究细节。',
  jiaoyu: '教育学习主题，愿知识像灯一样被点亮。',
  lvyou: '在路上的人，旅行主题页面的记录者。',
  qiche: '汽车主题爱好者，速度与机械的美感。',
  youxi: '游戏宅，像素风与电竞主题页面爱好者。',
  denglu: '登录与认证页面，安全与体验并重。',
  keji: '科技主题，喜欢干净利落的未来感设计。',
  wangdian: '电商与网店主题，让商品展示更打动人。',
  zhiye: '求职与职业主题，认真对待每一次机会。',
  yinyue: '音乐主题，用页面表达节奏与旋律。',
};

// 各分类的演示用户昵称池（同时用作 username 与邮箱前缀）。全部为 [a-z0-9-]。
const NICKS = {
  tpl100: [
    'page-smith', 'clean-canvas', 'swift-layout', 'flat-folio', 'mint-grid',
    'frame-forge', 'ui-garden', 'block-bloom', 'layout-lab', 'wireframe-owl',
    'stencil-street', 'template-tide', 'markup-mint', 'css-craft', 'html-house',
    'div-dock', 'stylesheet-no9', 'font-nest', 'grid-goose', 'blank-basil',
    'wire-weaver', 'pixel-plan', 'sketch-shell', 'scaffold-sage', 'mold-mint',
    'cast-craft', 'form-frame', 'theme-thistle',
  ],
  ai: ['neural-nest', 'prompt-pilot', 'tensor-town', 'byte-brain', 'model-mint', 'deep-dive-dan', 'algo-alley'],
  bs5: ['bootstrap-ben', 'grid-gwen', 'responsive-rae', 'bs-builder', 'utility-ui', 'flexbox-fox', 'card-carousel'],
  geren: ['personal-page', 'about-me-al', 'resume-root', 'self-site', 'solo-studio', 'me-myself-mk', 'own-oasis'],
  qiye: ['brand-build', 'corp-core', 'office-oak', 'firm-forge', 'biz-bay', 'suite-spot', 'company-craft'],
  nongye: ['green-acres', 'farm-fresh', 'harvest-moon', 'rural-root', 'sunny-field', 'golden-grain', 'orchard-life'],
  yiliao: ['care-clinic', 'med-mile', 'health-haven', 'pulse-point', 'doc-dock', 'vital-vine', 'remedy-root'],
  boke: ['ink-well', 'word-wave', 'pen-pier', 'blog-bloom', 'note-nook', 'story-shelf', 'diary-dock'],
  houtai: ['dash-dock', 'admin-owl', 'panel-pine', 'data-desk', 'board-bay', 'chart-crew', 'ops-owl'],
  chongwu: ['paw-pal', 'fur-friend', 'tail-wag', 'pet-paradise', 'meow-manor', 'doggo-den', 'whisker-wing'],
  gongye: ['steel-shop', 'factory-floor', 'machine-mind', 'gear-grove', 'industrial-ivy', 'motor-mill', 'plant-pine'],
  jiaoyu: ['study-lamp', 'class-note', 'campus-path', 'learn-loop', 'course-craft', 'book-bridge', 'tutor-tale'],
  lvyou: ['wander-way', 'map-mile', 'trail-tale', 'sky-ticket', 'trip-tide', 'nomad-note', 'roam-root'],
  qiche: ['turbo-tom', 'gear-head', 'auto-arc', 'motor-mile', 'chrome-crew', 'wheel-work', 'drift-dock'],
  youxi: ['pixel-raider', 'quest-master', 'arcade-fox', 'loot-hunter', 'boss-rush', 'retro-gamer', 'combo-king'],
  denglu: ['gate-keeper', 'key-master', 'login-lab', 'auth-arc', 'door-dock', 'pass-post', 'sign-in-sam'],
  keji: ['tech-tide', 'circuit-sage', 'gadget-grove', 'silicon-sky', 'byte-bay', 'code-cove', 'chip-chat'],
  wangdian: ['cart-craft', 'shop-sail', 'deal-dock', 'market-mint', 'store-street', 'order-orbit', 'retail-root'],
  zhiye: ['resume-rock', 'career-craft'],
  yinyue: ['echo-ember', 'melody-mint', 'sound-shore', 'tune-town', 'rhythm-root', 'chord-craft', 'beat-bay'],
};

const SLUGS = Object.keys(NICKS);

// ---------------------------------------------------------------- 小工具

const rand = (n) => Math.floor(Math.random() * (n + 1));

/** 复刻生产 lib/auth.js 的密码哈希：scrypt$salt$derived(hex) */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/** 把模板原始名清洗成展示标题：去前导序号、去 master/main 尾缀、分隔符转空格、首字母大写。 */
function cleanTemplateName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\d+\s*[-_.]*\s*/, '');
  s = s.replace(/[\s._-]+(master|main|template|demo)$/i, '');
  s = s.replace(/[-_]+/g, ' ').trim();
  return s || 'template';
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ---------------------------------------------------------------- DB

function connectionOptions() {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'minepage',
    charset: 'utf8mb4',
  };
}

async function loadTemplateSites(conn) {
  const [rows] = await conn.query(
    "SELECT id, name, owner_id, title FROM sites WHERE name LIKE 'tp-%' ORDER BY id",
  );
  const groups = new Map();
  let unmatched = 0;
  for (const r of rows) {
    const m = /^tp-([a-z0-9]+)-(\d+)$/.exec(r.name);
    if (!m) {
      unmatched += 1;
      continue;
    }
    const slug = m[1];
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push({ id: r.id, seq: Number(m[2]), rawTitle: r.title, ownerId: r.owner_id });
  }
  return { groups, total: rows.length, unmatched };
}

/** 校验：昵称池数量、分类是否齐全，避免灌出半截数据。 */
function validatePlan(groups) {
  const problems = [];
  for (const slug of SLUGS) {
    const want = USER_PLAN[slug] ?? DEFAULT_USERS;
    const got = NICKS[slug].length;
    if (want !== got) problems.push(`分类 ${slug}: 需要 ${want} 个昵称，实际 ${got} 个`);
    if (!groups.has(slug)) problems.push(`分类 ${slug}: 库里没有对应的 tp-${slug}-* 站点`);
    if (!CAT_ZH[slug]) problems.push(`分类 ${slug}: 缺少中文名`);
    if (!BIO[slug]) problems.push(`分类 ${slug}: 缺少简介`);
  }
  const seen = new Set();
  for (const slug of SLUGS) {
    for (const n of NICKS[slug]) {
      if (seen.has(n)) problems.push(`昵称重复: ${n}`);
      seen.add(n);
    }
  }
  if (problems.length) {
    throw new Error('分配计划校验失败：\n  - ' + problems.join('\n  - '));
  }
  return seen.size;
}

async function ensureUser(conn, nick, bio) {
  const email = `${nick}${EMAIL_SUFFIX}`;
  const [found] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
  if (found.length) return found[0].id;

  const hash = hashPassword(PASSWORD);
  const ts = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = attempt === 0 ? nick : `${nick}-${attempt + 1}`;
    try {
      const [res] = await conn.query(
        `INSERT INTO users (email, username, password_hash, is_admin, status, bio, notify_seen_at, created_at)
         VALUES (?, ?, ?, 0, 'active', ?, '', ?)`,
        [email, username, hash, bio, ts],
      );
      return res.insertId;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error(`无法为 ${nick} 创建用户`);
}

async function resetDemo(conn) {
  const [sites] = await conn.query(
    "UPDATE sites SET owner_id = NULL, status = 'offline' WHERE name LIKE 'tp-%'",
  );
  const [users] = await conn.query(
    'DELETE FROM users WHERE email LIKE ?',
    [`%${EMAIL_SUFFIX}`],
  );
  console.log(`[FORCE] 摘除模板站 owner: ${sites.affectedRows} 个；删除演示用户: ${users.affectedRows} 个`);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const conn = await mysql.createConnection(connectionOptions());
  try {
    const { groups, total, unmatched } = await loadTemplateSites(conn);
    console.log(`读取模板站: ${total} 个（其中 ${unmatched} 个站名不符合 tp-<slug>-<seq>，将跳过）`);
    const nickCount = validatePlan(groups);

    // 计划预览
    let plannedSites = 0;
    for (const slug of SLUGS) {
      const list = groups.get(slug);
      const users = USER_PLAN[slug] ?? DEFAULT_USERS;
      plannedSites += list.length;
      const per = list.length / users;
      console.log(
        `  ${slug.padEnd(8)} 用户 ${String(users).padStart(2)} 人 · 站点 ${String(list.length).padStart(3)} 个 · 平均 ${per.toFixed(2)} 站/人 · ${CAT_ZH[slug]}`,
      );
    }
    console.log(`合计: 演示用户 ${nickCount} 人 · 待分配站点 ${plannedSites} 个`);

    if (!DRYRUN && FORCE) await resetDemo(conn);

    // 建用户
    const nickToId = new Map();
    if (DRYRUN) {
      SLUGS.forEach((slug, i) => NICKS[slug].forEach((n, j) => nickToId.set(n, -(i * 100 + j))));
      console.log('[DRYRUN] 跳过建用户');
    } else {
      for (const slug of SLUGS) {
        for (const nick of NICKS[slug]) {
          nickToId.set(nick, await ensureUser(conn, nick, BIO[slug]));
        }
      }
      console.log(`演示用户就绪: ${nickToId.size} 人，密码统一 ${PASSWORD}`);
    }
    const demoIds = new Set(nickToId.values());

    // 逐分类 round-robin 分配
    const perUser = new Map();
    let assigned = 0;
    let skipped = 0;
    for (const slug of SLUGS) {
      const users = NICKS[slug].map((n) => nickToId.get(n));
      const list = [...groups.get(slug)].sort((a, b) => a.seq - b.seq);
      for (let i = 0; i < list.length; i += 1) {
        const site = list[i];
        if (demoIds.has(site.ownerId)) {
          skipped += 1;
          perUser.set(site.ownerId, (perUser.get(site.ownerId) ?? 0) + 1);
          continue;
        }
        const ownerId = users[i % users.length];
        const title = `${titleCase(cleanTemplateName(site.rawTitle))} · ${CAT_ZH[slug]}`;
        const description = `${CAT_ZH[slug]}主题网站模板，含多个页面与静态资源（模板编号 ${String(site.seq).padStart(2, '0')}）。`;
        const tag = TAG_MAP[slug] ?? 'other';
        const views = rand(400);
        const createdMs = Date.now() - rand(30) * 86400000 - rand(24) * 3600000;
        const updatedMs = Math.min(Date.now(), createdMs + rand(3) * 86400000 + rand(24) * 3600000);
        const createdAt = new Date(createdMs).toISOString();
        const updatedAt = new Date(updatedMs).toISOString();

        if (!DRYRUN) {
          await conn.query(
            `UPDATE sites
                SET owner_id = ?, status = 'active', title = ?, description = ?, tag = ?,
                    views = ?, created_at = ?, updated_at = ?
              WHERE id = ?`,
            [ownerId, title, description, tag, views, createdAt, updatedAt, site.id],
          );
        }
        assigned += 1;
        perUser.set(ownerId, (perUser.get(ownerId) ?? 0) + 1);
        if (assigned <= 3) console.log(`  样例: ${site.id} → ${title}（owner=${ownerId}）`);
      }
    }

    const counts = [...perUser.values()];
    const maxPer = counts.length ? Math.max(...counts) : 0;
    const minPer = counts.length ? Math.min(...counts) : 0;

    console.log('------------------------------------------------------------');
    console.log(`${DRYRUN ? '[DRYRUN] 计划' : '完成'}：分配/保留站点 ${assigned} 个，跳过 ${skipped} 个（已归属演示用户）`);
    console.log(`每人站数：${minPer} ~ ${maxPer}，涉及用户 ${counts.length} 人`);

    if (!DRYRUN) {
      const [[u]] = await conn.query(
        'SELECT COUNT(*) AS c FROM users WHERE email LIKE ?',
        [`%${EMAIL_SUFFIX}`],
      );
      const [[s]] = await conn.query(
        "SELECT COUNT(*) AS c FROM sites WHERE name LIKE 'tp-%' AND status = 'active'",
      );
      console.log(`库内校验：演示用户 ${u.c} 人 · 上线模板站 ${s.c} 个`);
    }
    if (DRYRUN) console.log('（DRYRUN 未写库；去掉 DRYRUN=1 即真跑）');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('灌库失败：', err);
  process.exit(1);
});
