// 「站名 ⇄ 访问地址」的唯一映射点。
//
// 现在是路径式：   https://mysite.com/mypage1
// 若将来改成子域式：https://mypage1.mysite.com
//
// 要换地址形态，只动这个文件，别处不用碰。

/** 站名 → 站内绝对路径，这是「站名 ⇄ 地址」里拼接方向的那一半。
 *  返回值不做 URL 编码，站名必须已经过 names.js 的 checkName（只含 [a-z0-9-]）。
 *  换成子域式地址时改这里，absoluteUrlForSite 会跟着一起变。 */
export function urlForSite(name) {
  return `/${name}`;
}

/** 拼出可以直接发给用户的完整地址（上传成功响应、MCP 工具返回、邮件里的链接都用它）。
 *  origin 由调用方给（server.js 的 originOf(req)），本函数不读请求对象。 */
export function absoluteUrlForSite(origin, name) {
  return origin + urlForSite(name);
}

/**
 * 从请求里解析出站名。
 * 路径式下只有「恰好一段的路径」才可能是站名，其余一律返回 null。
 *
 * 只认 /mypage1 这种单段路径：带子路径、带额外斜杠的都不算；percent 解码失败也返回 null。
 * 目前没有调用方——站点兜底路由在 server.js 里自己写了正则解析站名。
 * 解析规则刻意留在这里，是为了将来换地址形态时和拼接规则改在同一处。
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
