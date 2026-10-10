// 「站名 ⇄ 访问地址」的唯一映射点。
//
// 现在是路径式：   https://mysite.com/mypage1
// 若将来改成子域式：https://mypage1.mysite.com
//
// 要换地址形态，只动这个文件，别处不用碰。

export function urlForSite(name) {
  return `/${name}`;
}

export function absoluteUrlForSite(origin, name) {
  return origin + urlForSite(name);
}

/**
 * 从请求里解析出站名。
 * 路径式下只有「恰好一段的路径」才可能是站名，其余一律返回 null。
 */
export function siteNameFromRequest(req) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://internal').pathname;
  } catch {
    return null;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;

  try {
    return decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
}
