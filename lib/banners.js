// 首页轮播位：管理员在 /admin 里配置「第几个位置放哪个用户的哪个页面」。
//
// 只存「指向哪个站点 + 排序 + 是否启用」，展示用的标题/简介默认取站点自己的，
// 想覆盖就填 banner 自己的 title / subtitle（空串表示跟随站点）。
// 站点被删除时 banner 跟着级联消失（外键 ON DELETE CASCADE）。
import { all, get, run } from './db.js';

const nowIso = () => new Date().toISOString();

/** 最多几个轮播位：再多首页也放不下，属于产品上限而不是性能限制。 */
export const MAX_BANNERS = 10;

const BANNER_FIELDS = `
  b.id, b.site_id, b.title, b.subtitle, b.sort_order, b.enabled, b.created_at,
  s.name AS site_name, s.title AS site_title, s.description AS site_description,
  s.status AS site_status, u.username AS owner_username,
  EXISTS(SELECT 1 FROM site_covers cv WHERE cv.site_id = s.id) AS site_has_cover`;

const toBanner = (r) => ({
  id: r.id,
  siteId: r.site_id,
  title: r.title,
  subtitle: r.subtitle,
  sortOrder: r.sort_order,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  site: {
    name: r.site_name,
    title: r.site_title ?? '',
    description: r.site_description ?? '',
    status: r.site_status ?? 'active',
    owner: r.owner_username ?? '',
    hasCover: Boolean(r.site_has_cover),
  },
});

const SELECT_BANNERS = `
  SELECT ${BANNER_FIELDS}
    FROM banners b
    JOIN sites s ON s.id = b.site_id
    LEFT JOIN users u ON u.id = s.owner_id`;

/**
 * 首页展示用：只取启用中、且站点仍在线的那些，按 sort_order 排。
 * 站点被下线（offline）时不该继续占着首页位置。
 */
export async function listPublicBanners() {
  const rows = await all(
    `${SELECT_BANNERS}
      WHERE b.enabled = 1 AND s.status = 'active'
      ORDER BY b.sort_order ASC, b.id ASC
      LIMIT ?`,
    MAX_BANNERS,
  );
  return rows.map(toBanner);
}

/** 后台用：全部（含停用）。 */
export async function listAllBanners() {
  return (await all(`${SELECT_BANNERS} ORDER BY b.sort_order ASC, b.id ASC`)).map(toBanner);
}

export async function countBanners() {
  return (await get('SELECT COUNT(*) AS c FROM banners')).c;
}

export async function findBannerById(id) {
  const row = await get(`${SELECT_BANNERS} WHERE b.id = ?`, id);
  return row ? toBanner(row) : null;
}

/** 新增一个轮播位。超出 MAX_BANNERS 抛 TOO_MANY_BANNERS。 */
export async function createBanner({ siteId, title = '', subtitle = '', sortOrder = 0, enabled = true }) {
  if ((await countBanners()) >= MAX_BANNERS) {
    throw Object.assign(new Error(`轮播位最多 ${MAX_BANNERS} 个`), { code: 'TOO_MANY_BANNERS' });
  }

  const result = await run(
    `INSERT INTO banners (site_id, title, subtitle, sort_order, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    siteId,
    title,
    subtitle,
    sortOrder,
    enabled ? 1 : 0,
    nowIso(),
  );
  return findBannerById(Number(result.lastInsertRowid));
}

/** 改一个轮播位：patch 里没给的字段保持原值。返回改动行数。 */
export async function updateBanner(id, patch) {
  const current = await get('SELECT * FROM banners WHERE id = ?', id);
  if (!current) return 0;

  const next = {
    site_id: patch.siteId ?? current.site_id,
    title: patch.title ?? current.title,
    subtitle: patch.subtitle ?? current.subtitle,
    sort_order: patch.sortOrder ?? current.sort_order,
    enabled: patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0),
  };

  return (
    await run(
      `UPDATE banners SET site_id = ?, title = ?, subtitle = ?, sort_order = ?, enabled = ?
        WHERE id = ?`,
      next.site_id, next.title, next.subtitle, next.sort_order, next.enabled, id,
    )
  ).changes;
}

export async function deleteBanner(id) {
  return (await run('DELETE FROM banners WHERE id = ?', id)).changes;
}
