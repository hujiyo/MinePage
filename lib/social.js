import { getDb } from './db.js';

/** 当前时间的 ISO 8601 字符串。likes / comments / favorites / follows / messages 的时间列都用它。 */
const nowIso = () => new Date().toISOString();

/** 互动数据层：点赞 / 评论 / 收藏 / 关注 / 浏览量。
 *  只做数据操作，鉴权与参数校验在 server.js 的接口层。
 *
 *  本层的共同约定：
 *  - 前提一律是「调用方已经校验过站点/用户存在、当前用户有权限」，这里不重复校验，也不抛业务错误，
 *    多数函数直接返回受影响行数（0 表示没有可改的行）。
 *  - 时间统一用 ISO 字符串（nowIso），全库比较靠字符串序。
 *  - 前端接线现状：发现流（discover.html）、站点详情、账号页已接上；
 *    view.html / user.html / notifications.html / history.html / favorites.html / messages.html
 *    这 6 个页面仍用演示数据（页面里写着 TODO 后端对接），相关函数的注释里逐个标了。 */

// ---------------------------------------------------------------- 浏览量

/** 站点浏览量 +1（SQL 里原子自增，不做去重）。
 *  调用时机：server.js 只在入口页 index.html 被真正返回时调（多页站与老单页站两条分支各一处），
 *  站内 css / js / 图片等子资源不算；同一个人刷新也照加，爬虫也照加。
 *  副作用：写库。没有「同一访客只算一次」的机制，也没有缓存或批量化。 */
export function incrementViews(siteId) {
  getDb().prepare('UPDATE sites SET views = views + 1 WHERE id = ?').run(siteId);
}

// ---------------------------------------------------------------- 点赞

/** 点赞。一人一站最多一条：靠 likes 的复合主键 + INSERT OR IGNORE，重复点赞静默忽略（不报错，也不刷新时间）。
 *  前提：siteId / userId 都真实存在（外键会拦，且连接上开了 foreign_keys）。
 *  不返回是否真的插入了——调用方想知道状态得自己再查 hasLiked，或者直接看 countLikes。 */
export function likeSite(siteId, userId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO likes (site_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(siteId, userId, nowIso());
}

/** 取消点赞，返回被删条数（0 表示本来就没赞过）。没赞过也不报错。 */
export function unlikeSite(siteId, userId) {
  return getDb()
    .prepare('DELETE FROM likes WHERE site_id = ? AND user_id = ?')
    .run(siteId, userId).changes;
}

/** 这个用户是否赞过这个站点。
 *  userId 是假值（未登录传 null / undefined / 0）时直接返回 false，不查库——所以访客永远看到「未赞」。
 *  返回布尔值。 */
export function hasLiked(siteId, userId) {
  if (!userId) return false;
  return Boolean(
    getDb().prepare('SELECT 1 FROM likes WHERE site_id = ? AND user_id = ?').get(siteId, userId),
  );
}

/** 这个站点的点赞总数。站点不存在时 COUNT 结果也是 0，不抛错。 */
export function countLikes(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM likes WHERE site_id = ?').get(siteId).c;
}

// ---------------------------------------------------------------- 评论

/** 发评论。replyTo 由调用方校验过「存在且属于同一站点」后才传进来。
 *  返回新评论的自增 id（Number 后的 lastInsertRowid），前端用它把刚发的评论挂进回复树。
 *  replyTo 不传表示顶层评论；「回复只能一级」是接口层的规则，库里只保证自引用外键有效。 */
export function addComment({ siteId, userId, replyTo = null, content }) {
  const result = getDb()
    .prepare(
      'INSERT INTO comments (site_id, user_id, reply_to, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(siteId, userId, replyTo, content, nowIso());
  return Number(result.lastInsertRowid);
}

/** 按 id 取一条评论的原始行（snake_case 列名，如 reply_to / site_id），没有返回 null。
 *  删评论前用它做校验：先比 site_id 是否属于这个站点，再比 user_id 或管理员身份。 */
export function getComment(id) {
  return (
    getDb()
      .prepare('SELECT id, site_id, user_id, reply_to, content, created_at FROM comments WHERE id = ?')
      .get(id) ?? null
  );
}

/** 这个站点的评论总数，含所有回复（不区分层级、不减去被删的）。 */
export function countComments(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM comments WHERE site_id = ?').get(siteId).c;
}

/** 评论列表（老→新），带作者展示名：用户名，没设置就用邮箱前缀。
 *  作者是 LEFT JOIN 出来的：author.name 优先用 username，没有就回落到邮箱 @ 之前那段；
 *  author.username 保持 null，前端靠它区分「昵称就叫这个」和「回落出来的名字」。
 *  返回驼峰对象数组：{ id, replyTo, content, createdAt, author: { id, name, username } }。
 *  按 created_at 升序、同一时间再按 id 升序；一次全取，没有分页。
 *  TODO 后端对接：view.html 的评论区还在用演示数据，没有调 GET /api/sites/:name/comments。 */
export function listComments(siteId) {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.reply_to, c.content, c.created_at,
              c.user_id AS author_id, u.username AS author_username, u.email AS author_email
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.site_id = ?
       ORDER BY c.created_at ASC, c.id ASC`,
    )
    .all(siteId);

  return rows.map((r) => ({
    id: r.id,
    replyTo: r.reply_to,
    content: r.content,
    createdAt: r.created_at,
    author: {
      id: r.author_id,
      name: r.author_username ?? String(r.author_email ?? '').split('@')[0],
      username: r.author_username ?? null,
    },
  }));
}

/** 删除一条评论，返回被删条数（0 表示没有这个 id）。
 *  副作用：comments.reply_to 是自引用外键且 ON DELETE CASCADE，删父评论会把它的回复一并删掉。
 *  权限判断（作者本人或管理员）不在这里，由 server.js 的处理器先做。 */
export function deleteComment(id) {
  return getDb().prepare('DELETE FROM comments WHERE id = ?').run(id).changes;
}

// ---------------------------------------------------------------- 收藏

/** 收藏站点。重复调用不报错，用来「收藏后再换个收藏夹」。
 *  一人一站最多一条：撞上主键就 ON CONFLICT DO UPDATE 只改 folder，**不刷新 created_at**（首次收藏时间保持）。
 *  folder 由调用方给：列上的 DEFAULT '默认收藏夹' 永远不会生效（INSERT 显式提供了这一列），传空串也会照存。
 *  server.js 负责兜底成「默认收藏夹」并限制 50 字。
 *  TODO 后端对接：view.html 的收藏按钮与 favorites.html 都还在用演示数据。 */
export function favoriteSite(siteId, userId, folder) {
  getDb()
    .prepare(
      `INSERT INTO favorites (site_id, user_id, folder, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(site_id, user_id) DO UPDATE SET folder = excluded.folder`,
    )
    .run(siteId, userId, folder, nowIso());
}

/** 取消收藏，返回被删条数（0 表示本来就没收藏过）。一人一站只有一条，所以不用指定收藏夹。 */
export function unfavoriteSite(siteId, userId) {
  return getDb()
    .prepare('DELETE FROM favorites WHERE site_id = ? AND user_id = ?')
    .run(siteId, userId).changes;
}

/** 这个用户是否收藏过这个站点（不看收藏夹）。
 *  userId 是假值（未登录）时直接返回 false，不查库。 */
export function hasFavorited(siteId, userId) {
  if (!userId) return false;
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM favorites WHERE site_id = ? AND user_id = ?')
      .get(siteId, userId),
  );
}

/** 这个站点的被收藏总数（跨所有用户和收藏夹）。 */
export function countFavorites(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM favorites WHERE site_id = ?').get(siteId).c;
}

// ---------------------------------------------------------------- 关注

/** 关注某人（有向关系：followerId 关注 followeeId）。
 *  一人对一人最多一条：靠 follows 的复合主键 (follower_id, followee_id) + INSERT OR IGNORE，重复关注静默忽略。
 *  前提：两个 id 都真实存在（外键会拦）；「不能关注自己」「目标用户存在」由 server.js 校验。
 *  注意 follows 表没有 id 列，取消关注也按这对主键删。
 *  副作用：只写 follows 一行——通知不是在这里生成的，而是查询时 UNION 现算。 */
export function followUser(followerId, followeeId) {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
    )
    .run(followerId, followeeId, nowIso());
}

/** 取关，返回被删条数（0 表示本来就没关注）。
 *  server.js 用这个 0 配合「目标用户是否存在」决定要不要回 404，0 本身不是错误。 */
export function unfollowUser(followerId, followeeId) {
  return getDb()
    .prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .run(followerId, followeeId).changes;
}

/** followerId 是否关注了 followeeId。
 *  followerId 是假值（未登录传 null）时直接返回 false，不查库——访客看到的永远是「未关注」。 */
export function isFollowing(followerId, followeeId) {
  if (!followerId) return false;
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
      .get(followerId, followeeId),
  );
}

/** 粉丝/关注列表。type='followers' 取粉丝（followee_id=userId），'following' 取其关注的人。
 *  viewerId 用于标记列表中每个人是否被 viewer 关注（前端「+关注/已关注」按钮用）。
 *
 *  返回原始 snake_case 行（不是驼峰）：id / name / username / bio / followers / isFollowing。
 *  name 是 COALESCE(用户名, 邮箱 @ 前那段)，username 仍为 null 表示没设用户名；不带邮箱原文。
 *  只列 status = 'active' 的用户，按关注关系创建时间倒序，默认最多 200 条、无分页。
 *  实现细节：otherCol / selfCol 是按 type 选的白名单列名插值，不是拼接用户输入；
 *  viewerId 传 null 时用 0 去比，SQLite 里 0 不等于任何真实 user id，等价于「都没关注」。
 *  TODO 后端对接：user.html 的粉丝/关注弹层还在用演示数据，没有调 GET /api/users/:id/follow-list。 */
export function listFollows(userId, type = 'followers', viewerId = null, limit = 200) {
  const db = getDb();
  const otherCol = type === 'following' ? 'followee_id' : 'follower_id';
  const selfCol = type === 'following' ? 'follower_id' : 'followee_id';
  return db
    .prepare(
      `SELECT u.id,
              COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS name,
              u.username,
              u.bio,
              (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = u.id) AS followers,
              EXISTS(
                SELECT 1 FROM follows f3
                WHERE f3.follower_id = ? AND f3.followee_id = u.id
              ) AS isFollowing
         FROM follows f
         JOIN users u ON u.id = f.${otherCol}
        WHERE f.${selfCol} = ? AND u.status = 'active'
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .all(viewerId ?? 0, userId, limit);
}

/** 粉丝数 + 关注数。
 *  返回 { followers, following }，两个 COUNT 子查询总有值，所以 ?? 分支实际走不到。
 *  只数 follows 表的行，不筛选对方 status（被封禁的用户照样算进粉丝数）。 */
export function socialProfile(userId) {
  return (
    getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS followers,
           (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following`,
      )
      .get(userId, userId) ?? { followers: 0, following: 0 }
  );
}

// ---------------------------------------------------------------- 汇总

/** 一个站点的互动数字。viewerId 传当前登录用户 id（可空），附带「我是否赞过 / 藏过」。
 *  返回 { views, likes, comments, favorites, liked, favorited }：前四个数字，后两个布尔。
 *  liked / favorited 内部各再查一次库；viewerId 为 null 时两者都是 false（未登录访客）。
 *  views 读的是 sites.views（站点不存在或该列为空时兜底 0），不是实时统计。
 *  TODO 后端对接：view.html 的互动条还在用演示数据，没有调 GET /api/sites/:name/stats。 */
export function siteStats(siteId, viewerId = null) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         (SELECT views FROM sites WHERE id = ?)               AS views,
         (SELECT COUNT(*) FROM likes WHERE site_id = ?)       AS likes,
         (SELECT COUNT(*) FROM comments WHERE site_id = ?)    AS comments,
         (SELECT COUNT(*) FROM favorites WHERE site_id = ?)   AS favorites`,
    )
    .get(siteId, siteId, siteId, siteId);

  return {
    views: row?.views ?? 0,
    likes: row?.likes ?? 0,
    comments: row?.comments ?? 0,
    favorites: row?.favorites ?? 0,
    liked: hasLiked(siteId, viewerId),
    favorited: hasFavorited(siteId, viewerId),
  };
}

// ---------------------------------------------------------------- 发现流（阶段 2）

/** 社区发现流：已上线站点，默认按更新时间倒序。
 *  q 模糊匹配标题 / 简介 / 站名（LIKE 简单版，不做分词）；
 *  tag 精确匹配内容标签；sort 白名单排序（搜索结果页的排序条用）。
 *  作者展示名：用户名，没设置就用邮箱前缀。
 *
 *  LIMIT 100 写死在 SQL 里，没有分页也没有游标；q 里的 % _ \ 已转义（ESCAPE '\'），
 *  长度由接口层先截到 50 字；tag 也由接口层按 SITE_TAGS 白名单过滤过。
 *  返回驼峰对象数组：name / title / description / tag / views / likes / comments / favorites /
 *  fileCount / kind（fileCount > 0 ? 'multi' : 'single'，卡片形态靠它区分）/ updatedAt /
 *  author: { id, name, username }——作者只回展示名，邮箱原文不外发。
 *  只查 status = 'active' 的站点，作者是 LEFT JOIN，所以 owner_id 为 NULL 的无主站点也会出现在流里。 */
// 排序白名单：key 是接口 ?sort= 的值，value 是唯一允许拼进 ORDER BY 的片段（不是用户输入）。
// 空串是默认排序（按更新时间）；views / likes / favorites / comments 依赖 SELECT 里算出的列或别名。
// 未登记的 sort 值会回落到 ''，所以增删这里的 key 不需要改别处（见下方 discoverSites）。
const DISCOVER_SORTS = {
  '': 's.updated_at DESC, s.id DESC',
  views: 's.views DESC, s.updated_at DESC',
  likes: 'likes DESC, s.updated_at DESC',
  favorites: 'favorites DESC, s.updated_at DESC',
  comments: 'comments DESC, s.updated_at DESC',
  newest: 's.created_at DESC, s.id DESC',
};

/** 发现流查询本体（语义见上方「社区发现流」那段说明）。
 *  排序片段只从 DISCOVER_SORTS 取；where 条件与 params 的 push 顺序必须一一对应（q 会占 3 个参数）。 */
export function discoverSites({ q = '', tag = '', sort = '' } = {}) {
  const where = ["s.status = 'active'"];
  const params = [];

  const kw = String(q).trim();
  if (kw) {
    // LIKE 通配符转义，防止 % / _ 干扰匹配
    const pattern = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(
      "(s.title LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  if (tag) {
    where.push('s.tag = ?');
    params.push(tag);
  }

  // 白名单取排序，杜绝拼接注入
  const orderBy = DISCOVER_SORTS[String(sort)] ?? DISCOVER_SORTS[''];

  return getDb()
    .prepare(
      `SELECT s.name, s.title, s.description, s.tag, s.views, s.updated_at,
              u.id AS author_id,
              COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS author_name,
              u.username AS author_username,
              (SELECT COUNT(*) FROM likes l WHERE l.site_id = s.id)      AS likes,
              (SELECT COUNT(*) FROM comments c WHERE c.site_id = s.id)   AS comments,
              (SELECT COUNT(*) FROM favorites f WHERE f.site_id = s.id)  AS favorites,
              (SELECT COUNT(*) FROM site_files sf WHERE sf.site_id = s.id) AS file_count
       FROM sites s
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 100`,
    )
    .all(...params)
    .map((r) => {
      const fileCount = r.file_count ?? 0;
      return {
        name: r.name,
        title: r.title,
        description: r.description,
        tag: r.tag,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
        favorites: r.favorites,
        // 卡片要区分单页站和多文件站，所以把文件数与形态一起给出去
        fileCount,
        kind: fileCount > 0 ? 'multi' : 'single',
        updatedAt: r.updated_at,
        author: { id: r.author_id, name: r.author_name, username: r.author_username ?? null },
      };
    });
}

// ---------------------------------------------------------------- 创作者主页（阶段 3）

// 站点卡片的字段片段：站点元信息 + 三个互动计数子查询，创作者主页 / 浏览历史 / 收藏列表共用。
// 不含 author 信息（要作者的用下面 SITE_CARD_AUTHOR_FIELDS），也不含 html 与文件内容。
const SITE_CARD_FIELDS = `
  s.name, s.title, s.description, s.tag, s.views, s.updated_at,
  (SELECT COUNT(*) FROM likes l WHERE l.site_id = s.id)     AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.site_id = s.id)  AS comments,
  (SELECT COUNT(*) FROM favorites f WHERE f.site_id = s.id) AS favorites`;

/** 把站点卡片行（snake_case）转成驼峰对象：name / title / description / tag / views /
 *  likes / comments / favorites / updatedAt。注意互动计数的列名本来就是小写单词，不涉及改名。 */
const toSiteCard = (r) => ({
  name: r.name,
  title: r.title,
  description: r.description,
  tag: r.tag,
  views: r.views,
  likes: r.likes,
  comments: r.comments,
  favorites: r.favorites,
  updatedAt: r.updated_at,
});

/** 创作者公开主页：按用户名查 active 用户，附带社交数字与 TA 的公开站点列表。
 *  没设用户名的用户没有主页 URL（返回 null）——简单方案的取舍。
 *
 *  返回 null 只有一种原因：按 username（COLLATE NOCASE）找不到 status = 'active' 的用户；
 *  所以没设用户名的人和被封禁的人都没有主页。
 *  返回结构：{ user: {id, username, bio, createdAt}, stats: {sites, views, followers, following}, sites: [...] }。
 *  其中 stats.sites / stats.views 只统计该用户的 active 站点（views 是浏览量之和，不是互动数）；
 *  sites 是站点卡片数组（不含作者，作者就是主页主人），最多 100 条、按 updated_at 倒序。
 *  TODO 后端对接：user.html 还在用演示数据，没有调 GET /api/u/:name/profile。 */
export function creatorPage(username) {
  const user = getDb()
    .prepare(
      `SELECT id, username, bio, created_at FROM users
       WHERE username = ? COLLATE NOCASE AND status = 'active'`,
    )
    .get(String(username ?? ''));
  if (!user) return null;

  const stats = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sites WHERE owner_id = ? AND status = 'active') AS sites,
         (SELECT COALESCE(SUM(views), 0) FROM sites WHERE owner_id = ? AND status = 'active') AS views`,
    )
    .get(user.id, user.id);
  const social = socialProfile(user.id);

  const sites = getDb()
    .prepare(
      `SELECT ${SITE_CARD_FIELDS}
       FROM sites s
       WHERE s.owner_id = ? AND s.status = 'active'
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 100`,
    )
    .all(user.id)
    .map(toSiteCard);

  return {
    user: {
      id: user.id,
      username: user.username,
      bio: user.bio ?? '',
      createdAt: user.created_at,
    },
    stats: {
      sites: stats.sites,
      views: stats.views,
      followers: social.followers,
      following: social.following,
    },
    sites,
  };
}

// ---------------------------------------------------------------- 通知（阶段 4）

/**
 * 通知列表的 SQL 构造器（通知列表页与未读数都走它）。
 *
 * 收到的互动事件 UNION：赞 / 评论 / 收藏（落在我的站点上）+ 关注（指向我）。
 * 自己给自己的互动不算。动态查询，不建事件表（简单方案）。
 *
 * 固定 7 个占位符，顺序是：like(站点主人, 排除本人) → comment(同) → favorite(同) → follow(关注我)。
 * forCount = true 时不加 ORDER BY / LIMIT，专供 countUnread 套一层 COUNT(*) 用。
 * 输出列固定为：type / at / actor_id / actor_username / actor / site_name / site_title / snippet，
 * 其中 snippet 只有评论有内容，关注类型的站点三列全是 NULL。
 */
const NOTIFICATIONS_SQL = (forCount) => `
  SELECT 'like' AS type, l.created_at AS at,
         u.id AS actor_id, u.username AS actor_username,
         COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS actor,
         s.name AS site_name, s.title AS site_title, NULL AS snippet
    FROM likes l
    JOIN sites s ON s.id = l.site_id
    JOIN users u ON u.id = l.user_id
   WHERE s.owner_id = ? AND l.user_id != ?
  UNION ALL
  SELECT 'comment', c.created_at,
         u.id, u.username,
         COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)),
         s.name, s.title, c.content
    FROM comments c
    JOIN sites s ON s.id = c.site_id
    JOIN users u ON u.id = c.user_id
   WHERE s.owner_id = ? AND c.user_id != ?
  UNION ALL
  SELECT 'favorite', f.created_at,
         u.id, u.username,
         COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)),
         s.name, s.title, NULL
    FROM favorites f
    JOIN sites s ON s.id = f.site_id
    JOIN users u ON u.id = f.user_id
   WHERE s.owner_id = ? AND f.user_id != ?
  UNION ALL
  SELECT 'follow', fo.created_at,
         u.id, u.username,
         COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)),
         NULL, NULL, NULL
    FROM follows fo
    JOIN users u ON u.id = fo.follower_id
   WHERE fo.followee_id = ?${forCount ? '' : '\n   ORDER BY at DESC\n   LIMIT 50'}`;

/** 通知列表：最近的 50 条互动事件，新到旧。
 *  返回驼峰对象数组：{ type: 'like'|'comment'|'favorite'|'follow', actor, actorUsername,
 *  siteName, siteTitle, snippet, at }；关注类型的 siteName / siteTitle / snippet 都是 null。
 *  actor 是展示名（用户名或邮箱前缀），actorUsername 为 null 表示没设用户名。
 *  因为是 UNION 现算，取消点赞 / 删评论后对应的通知会立刻消失，没有历史事件可追溯。
 *  TODO 后端对接：notifications.html 还在用演示数据，没有调 GET /api/notifications。 */
export function listNotifications(userId) {
  // 占位符：like/comment/favorite 各 2 个 + follow 1 个 = 7 个
  const p = [userId, userId, userId, userId, userId, userId, userId];
  return getDb()
    .prepare(NOTIFICATIONS_SQL(false))
    .all(...p)
    .map((r) => ({
      type: r.type,
      actor: r.actor,
      actorUsername: r.actor_username ?? null,
      siteName: r.site_name ?? null,
      siteTitle: r.site_title ?? null,
      snippet: r.snippet ?? null,
      at: r.at,
    }));
}

/** 未读数：上次查看通知之后的新事件数（上限 99，防止无限增长）。
 *  基准是 users.notify_seen_at（从没看过是空串，用 1970-01-01 兜底），与每条事件的 at 做纯字符串比较。
 *  返回 Math.min(计数, 99)：拿到 99 时不知道真实是 99 还是更多，前端按「99+」展示。
 *  已登录用户的导航红点走 /api/me，这条链路是接上的。 */
export function countUnread(userId) {
  const seenAt = getDb()
    .prepare('SELECT notify_seen_at AS t FROM users WHERE id = ?')
    .get(userId)?.t ?? '';

  // 占位符：like/comment/favorite 各 2 个 + follow 1 个 = 7 个，外层 WHERE 再加 1 个
  const params = [userId, userId, userId, userId, userId, userId, userId];
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM (${NOTIFICATIONS_SQL(true)})
       WHERE at > ?`,
    )
    .get(...params, seenAt || '1970-01-01T00:00:00.000Z');
  return Math.min(row?.n ?? 0, 99);
}

/** 进入通知页后调用：把已读时间戳推进到当前时刻。
 *  副作用：写 users.notify_seen_at，之后 countUnread 归零。
 *  粒度是「整体看过」而不是逐条已读——没有已读/未读标记列，也不记录看过哪几条。
 *  TODO 后端对接：通知页还是演示数据，打开页面时不会调 POST /api/notifications/seen。 */
export function markNotificationsSeen(userId) {
  getDb()
    .prepare('UPDATE users SET notify_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}

// ---------------------------------------------------------------- 浏览历史 / 收藏夹列表 / 用户搜索 / 私信

// 站点卡片 + 作者信息（历史 / 收藏列表的卡片要显示作者行）
// 作者名同样按 COALESCE(用户名, 邮箱前缀) 回落，author_username 为 null 表示没设用户名。
const SITE_CARD_AUTHOR_FIELDS = `
  ${SITE_CARD_FIELDS},
  u.id AS author_id,
  COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS author_name,
  u.username AS author_username`;

/** 在站点卡片上补一列 author: { id, name, username }，浏览历史与收藏列表共用。 */
const toCardWithAuthor = (r) => ({
  ...toSiteCard(r),
  author: { id: r.author_id, name: r.author_name, username: r.author_username ?? null },
});

/** 记录浏览历史：一人一站一条，重复浏览刷新时间。
 *  靠 (user_id, site_id) 主键做 ON CONFLICT DO UPDATE，所以只更新时间、不累加次数。
 *  只给登录用户记（server.js 的 POST /api/history 要登录）；前提是调用方已按站名查到站点 id。
 *  TODO 后端对接：view.html 打开时不会调 POST /api/history。 */
export function recordView(userId, siteId) {
  getDb()
    .prepare(
      `INSERT INTO view_history (user_id, site_id, viewed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, site_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
    )
    .run(userId, siteId, nowIso());
}

/** 删掉我的某一条浏览历史，返回被删条数（0 表示本来就没有）。只影响这个用户，站点本身不受影响。 */
export function removeHistory(userId, siteId) {
  return getDb()
    .prepare('DELETE FROM view_history WHERE user_id = ? AND site_id = ?')
    .run(userId, siteId).changes;
}

/** 清空我的全部浏览历史，返回被删条数。只删自己的行；不删站点，也不清浏览量计数。 */
export function clearHistory(userId) {
  return getDb().prepare('DELETE FROM view_history WHERE user_id = ?').run(userId).changes;
}

/** 我的浏览历史：卡片形状同 discover 流，外加 viewedAt。
 *  字段是站点卡片 + author + viewedAt（注意是 viewedAt，不是 updatedAt）。
 *  只列 status = 'active' 的站点：被下线的站点从历史列表里自动消失，但 view_history 里的行还在。
 *  按 viewed_at 倒序，默认最多 100 条、无分页。
 *  TODO 后端对接：history.html 还在用演示数据，没有调 GET /api/history。 */
export function listHistory(userId, limit = 100) {
  return getDb()
    .prepare(
      `SELECT ${SITE_CARD_AUTHOR_FIELDS}, h.viewed_at AS viewed_at
       FROM view_history h
       JOIN sites s ON s.id = h.site_id
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE h.user_id = ? AND s.status = 'active'
       ORDER BY h.viewed_at DESC
       LIMIT ?`,
    )
    .all(userId, limit)
    .map((r) => ({ ...toCardWithAuthor(r), viewedAt: r.viewed_at }));
}

/** 我的收藏：平铺返回（带收藏夹名与收藏时间），前端按 folder 分组渲染。
 *  每条是站点卡片 + author + folder + favoritedAt（收藏时间，不是站点更新时间），不做服务端聚合。
 *  只列 status = 'active' 的站点；按收藏时间倒序，默认最多 100 条、无分页。
 *  收藏夹只有 favorites.folder 这一列文本，没有实体表，也没有重命名 / 删除收藏夹的入口。
 *  TODO 后端对接：favorites.html 还在用演示数据，没有调 GET /api/favorites。 */
export function listFavorites(userId, limit = 100) {
  return getDb()
    .prepare(
      `SELECT ${SITE_CARD_AUTHOR_FIELDS}, f.folder AS folder, f.created_at AS favorited_at
       FROM favorites f
       JOIN sites s ON s.id = f.site_id
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE f.user_id = ? AND s.status = 'active'
       ORDER BY f.created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit)
    .map((r) => ({ ...toCardWithAuthor(r), folder: r.folder, favoritedAt: r.favorited_at }));
}

/** 用户搜索：按用户名 / 简介模糊匹配，粉丝多的排前面。
 *  q 为空或只有空格直接返回空数组，不查库；LIKE 的 % _ \ 已转义。
 *  只搜 username 与 bio（不搜邮箱），只列 status = 'active' 的用户。
 *  返回驼峰对象：{ id, name, username, bio, sites, followers }，name 是展示名（用户名或邮箱前缀）。
 *  按粉丝数倒序、同数按 id 升序，默认 20 条。 */
export function searchUsers(q, limit = 20) {
  const kw = String(q).trim();
  if (!kw) return [];

  const pattern = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
  return getDb()
    .prepare(
      `SELECT u.id,
              COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS name,
              u.username, u.bio,
              (SELECT COUNT(*) FROM sites s WHERE s.owner_id = u.id AND s.status = 'active') AS site_count,
              (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers
       FROM users u
       WHERE u.status = 'active'
         AND (u.username LIKE ? ESCAPE '\\' OR u.bio LIKE ? ESCAPE '\\')
       ORDER BY followers DESC, u.id ASC
       LIMIT ?`,
    )
    .all(pattern, pattern, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username ?? null,
      bio: r.bio ?? '',
      sites: r.site_count,
      followers: r.followers,
    }));
}

// ---------------------------------------------------------------- 私信

/** 发一条私信，返回新消息的自增 id。
 *  不校验收发双方是否为同一个人、是否存在、是否被封禁（外键与 server.js 的处理器负责）；
 *  read_at 留空表示未读，收件人的 countUnreadMessages 与 listConversations 会立刻反映出来。
 *  副作用：写库，只能插入、不能编辑或撤回。 */
export function sendMessage(senderId, receiverId, content) {
  const result = getDb()
    .prepare(
      'INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(senderId, receiverId, content, nowIso());
  return Number(result.lastInsertRowid);
}

/** 会话列表：每个聊过的人一条，带最后一句与未读数。
 *  子查询按 partner_id 分组取 MAX(id) 当「最后一条」（按 id 而不是 created_at，避免同一毫秒的时间戳歧义），
 *  再 JOIN 回 messages 取内容、JOIN users 取对方资料。
 *  返回驼峰对象数组：{ user: {id, name, username, bio}, lastMessage: {content, at, fromMe}, unread }；
 *  fromMe 是比较最后一条的 sender_id 与当前 userId 得出的；unread 只数「对方发给我且未读」的条数（不封顶）。
 *  按最后一条消息时间倒序，不限条数、无分页；只要聊过一次就一直在列表里。
 *  TODO 后端对接：messages.html 还在用演示数据，没有调 GET /api/messages。 */
export function listConversations(userId) {
  return getDb()
    .prepare(
      `SELECT u.id, u.username, u.email, u.bio,
              m.content AS last_content, m.created_at AS last_at, m.sender_id AS last_sender,
              (SELECT COUNT(*) FROM messages x
                WHERE x.sender_id = u.id AND x.receiver_id = ? AND x.read_at IS NULL) AS unread
       FROM (
         SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS partner_id,
                MAX(id) AS max_id
         FROM messages
         WHERE sender_id = ? OR receiver_id = ?
         GROUP BY partner_id
       ) t
       JOIN messages m ON m.id = t.max_id
       JOIN users u ON u.id = t.partner_id
       ORDER BY m.created_at DESC`,
    )
    .all(userId, userId, userId, userId)
    .map((r) => ({
      user: {
        id: r.id,
        name: r.username ?? String(r.email ?? '').split('@')[0],
        username: r.username ?? null,
        bio: r.bio ?? '',
      },
      lastMessage: { content: r.last_content, at: r.last_at, fromMe: r.last_sender === userId },
      unread: r.unread,
    }));
}

/** 与某人的消息往来（新→旧取回后反转成旧→新）。
 *  SQL 按 id 倒序取最多 limit 条，再 reverse，所以 limit 截掉的是更早的历史，最新的永远在。
 *  返回驼峰对象：{ id, fromMe, content, at, readAt }；readAt 为 null 表示收件人还没看。
 *  它不改 read_at——标已读由调用方接着调 markConversationRead（server.js 就是先取内容再标已读）。 */
export function listMessagesWith(userId, otherId, limit = 200) {
  return getDb()
    .prepare(
      `SELECT id, sender_id, receiver_id, content, created_at, read_at
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(userId, otherId, otherId, userId, limit)
    .map((r) => ({
      id: r.id,
      fromMe: r.sender_id === userId,
      content: r.content,
      at: r.created_at,
      readAt: r.read_at,
    }))
    .reverse();
}

/** 打开某个会话后调用：把对方发给我的未读消息标为已读。
 *  只标「sender 是 otherId、receiver 是我、read_at 为空」的行，返回被标条数。
 *  参数方向别写反：userId 是收件人（我），otherId 是发送者（对方）——写反不报错，但会标错方向。
 *  server.js 在返回消息列表之后调用它，保证本次响应里还带着未读标记。 */
export function markConversationRead(userId, otherId) {
  return getDb()
    .prepare(
      `UPDATE messages SET read_at = ?
       WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL`,
    )
    .run(nowIso(), userId, otherId).changes;
}

/** 未读私信总数（导航条红点用，上限 99）。
 *  返回 Math.min(总数, 99)，所以拿到 99 时不知道真实值；已登录用户的导航走 /api/me，这条链路是接上的。 */
export function countUnreadMessages(userId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND read_at IS NULL')
    .get(userId);
  return Math.min(row?.c ?? 0, 99);
}
