import { getDb } from './db.js';

const nowIso = () => new Date().toISOString();

/** 互动数据层：点赞 / 评论 / 收藏 / 关注 / 浏览量。
 *  只做数据操作，鉴权与参数校验在 server.js 的接口层。 */

// ---------------------------------------------------------------- 浏览量

export function incrementViews(siteId) {
  getDb().prepare('UPDATE sites SET views = views + 1 WHERE id = ?').run(siteId);
}

// ---------------------------------------------------------------- 点赞

export function likeSite(siteId, userId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO likes (site_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(siteId, userId, nowIso());
}

export function unlikeSite(siteId, userId) {
  return getDb()
    .prepare('DELETE FROM likes WHERE site_id = ? AND user_id = ?')
    .run(siteId, userId).changes;
}

export function hasLiked(siteId, userId) {
  if (!userId) return false;
  return Boolean(
    getDb().prepare('SELECT 1 FROM likes WHERE site_id = ? AND user_id = ?').get(siteId, userId),
  );
}

export function countLikes(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM likes WHERE site_id = ?').get(siteId).c;
}

// ---------------------------------------------------------------- 评论

/** 发评论。replyTo 由调用方校验过「存在且属于同一站点」后才传进来。 */
export function addComment({ siteId, userId, replyTo = null, content }) {
  const result = getDb()
    .prepare(
      'INSERT INTO comments (site_id, user_id, reply_to, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(siteId, userId, replyTo, content, nowIso());
  return Number(result.lastInsertRowid);
}

export function getComment(id) {
  return (
    getDb()
      .prepare('SELECT id, site_id, user_id, reply_to, content, created_at FROM comments WHERE id = ?')
      .get(id) ?? null
  );
}

export function countComments(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM comments WHERE site_id = ?').get(siteId).c;
}

/** 评论列表（老→新），带作者展示名：用户名，没设置就用邮箱前缀。 */
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

export function deleteComment(id) {
  return getDb().prepare('DELETE FROM comments WHERE id = ?').run(id).changes;
}

// ---------------------------------------------------------------- 收藏

export function favoriteSite(siteId, userId, folder) {
  getDb()
    .prepare(
      `INSERT INTO favorites (site_id, user_id, folder, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(site_id, user_id) DO UPDATE SET folder = excluded.folder`,
    )
    .run(siteId, userId, folder, nowIso());
}

export function unfavoriteSite(siteId, userId) {
  return getDb()
    .prepare('DELETE FROM favorites WHERE site_id = ? AND user_id = ?')
    .run(siteId, userId).changes;
}

export function hasFavorited(siteId, userId) {
  if (!userId) return false;
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM favorites WHERE site_id = ? AND user_id = ?')
      .get(siteId, userId),
  );
}

export function countFavorites(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM favorites WHERE site_id = ?').get(siteId).c;
}

// ---------------------------------------------------------------- 关注

export function followUser(followerId, followeeId) {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
    )
    .run(followerId, followeeId, nowIso());
}

export function unfollowUser(followerId, followeeId) {
  return getDb()
    .prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .run(followerId, followeeId).changes;
}

export function isFollowing(followerId, followeeId) {
  if (!followerId) return false;
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
      .get(followerId, followeeId),
  );
}

/** 粉丝/关注列表。type='followers' 取粉丝（followee_id=userId），'following' 取其关注的人。
 *  viewerId 用于标记列表中每个人是否被 viewer 关注（前端「+关注/已关注」按钮用）。 */
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

/** 粉丝数 + 关注数。 */
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

/** 一个站点的互动数字。viewerId 传当前登录用户 id（可空），附带「我是否赞过 / 藏过」。 */
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
 *  作者展示名：用户名，没设置就用邮箱前缀。 */
const DISCOVER_SORTS = {
  '': 's.updated_at DESC, s.id DESC',
  views: 's.views DESC, s.updated_at DESC',
  likes: 'likes DESC, s.updated_at DESC',
  favorites: 'favorites DESC, s.updated_at DESC',
  comments: 'comments DESC, s.updated_at DESC',
  newest: 's.created_at DESC, s.id DESC',
};

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
              (SELECT COUNT(*) FROM favorites f WHERE f.site_id = s.id)  AS favorites
       FROM sites s
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 100`,
    )
    .all(...params)
    .map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      tag: r.tag,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      favorites: r.favorites,
      updatedAt: r.updated_at,
      author: { id: r.author_id, name: r.author_name, username: r.author_username ?? null },
    }));
}

// ---------------------------------------------------------------- 创作者主页（阶段 3）

const SITE_CARD_FIELDS = `
  s.name, s.title, s.description, s.tag, s.views, s.updated_at,
  (SELECT COUNT(*) FROM likes l WHERE l.site_id = s.id)     AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.site_id = s.id)  AS comments,
  (SELECT COUNT(*) FROM favorites f WHERE f.site_id = s.id) AS favorites`;

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
 *  没设用户名的用户没有主页 URL（返回 null）——简单方案的取舍。 */
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

// 收到的互动事件 UNION：赞 / 评论 / 收藏（落在我的站点上）+ 关注（指向我）。
// 自己给自己的互动不算。动态查询，不建事件表（简单方案）。
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

/** 通知列表：最近的 50 条互动事件，新到旧。 */
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

/** 未读数：上次查看通知之后的新事件数（上限 99，防止无限增长）。 */
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

/** 进入通知页后调用：把已读时间戳推进到当前时刻。 */
export function markNotificationsSeen(userId) {
  getDb()
    .prepare('UPDATE users SET notify_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}

// ---------------------------------------------------------------- 浏览历史 / 收藏夹列表 / 用户搜索 / 私信

// 站点卡片 + 作者信息（历史 / 收藏列表的卡片要显示作者行）
const SITE_CARD_AUTHOR_FIELDS = `
  ${SITE_CARD_FIELDS},
  u.id AS author_id,
  COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS author_name,
  u.username AS author_username`;

const toCardWithAuthor = (r) => ({
  ...toSiteCard(r),
  author: { id: r.author_id, name: r.author_name, username: r.author_username ?? null },
});

/** 记录浏览历史：一人一站一条，重复浏览刷新时间。 */
export function recordView(userId, siteId) {
  getDb()
    .prepare(
      `INSERT INTO view_history (user_id, site_id, viewed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, site_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
    )
    .run(userId, siteId, nowIso());
}

export function removeHistory(userId, siteId) {
  return getDb()
    .prepare('DELETE FROM view_history WHERE user_id = ? AND site_id = ?')
    .run(userId, siteId).changes;
}

export function clearHistory(userId) {
  return getDb().prepare('DELETE FROM view_history WHERE user_id = ?').run(userId).changes;
}

/** 我的浏览历史：卡片形状同 discover 流，外加 viewedAt。 */
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

/** 我的收藏：平铺返回（带收藏夹名与收藏时间），前端按 folder 分组渲染。 */
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

/** 用户搜索：按用户名 / 简介模糊匹配，粉丝多的排前面。 */
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

export function sendMessage(senderId, receiverId, content) {
  const result = getDb()
    .prepare(
      'INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(senderId, receiverId, content, nowIso());
  return Number(result.lastInsertRowid);
}

/** 会话列表：每个聊过的人一条，带最后一句与未读数。 */
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

/** 与某人的消息往来（新→旧取回后反转成旧→新）。 */
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

/** 打开某个会话后调用：把对方发给我的未读消息标为已读。 */
export function markConversationRead(userId, otherId) {
  return getDb()
    .prepare(
      `UPDATE messages SET read_at = ?
       WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL`,
    )
    .run(nowIso(), userId, otherId).changes;
}

/** 未读私信总数（导航条红点用，上限 99）。 */
export function countUnreadMessages(userId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND read_at IS NULL')
    .get(userId);
  return Math.min(row?.c ?? 0, 99);
}
