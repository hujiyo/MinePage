// 「站名 ⇄ 访问地址」的唯一映射点。
//
// 用户空间：  https://mysite.com/qwq/<用户名>          → 创作者主页
// 用户站点：  https://mysite.com/qwq/<用户名>/<站名>
// 观看包装页：https://mysite.com/view/<用户名>/<站名>
//
// 站名只在用户名下面唯一，两家各有一个 study 互不影响。
// 要换地址形态（比如将来上子域 <用户名>.mysite.com/qwq/<站名>），只动这个文件。

import { USER_SPACE_PREFIX } from './config.js';

/** 用户空间入口（创作者主页）：/qwq/<用户名> */
export function urlForUser(username) {
  return `/${USER_SPACE_PREFIX}/${username}`;
}

/** 站点入口路径：/qwq/<用户名>/<站名> */
export function urlForSite(username, name) {
  return `${urlForUser(username)}/${name}`;
}

export function absoluteUrlForSite(origin, username, name) {
  return origin + urlForSite(username, name);
}

/** 观看包装页路径：/view/<用户名>/<站名> */
export function urlForView(username, name) {
  return `/view/${username}/${name}`;
}

/**
 * 从请求里解析出「用户空间内的站名」。
 * 形如 /<前缀>/<用户名>/<站名> 且恰好三段时才算站点入口；其余返回 null。
 * 站内文件路径（/qwq/u/s/a/b.css）由路由层用正则另行截取。
 */
export function siteNameFromRequest(req) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://internal').pathname;
  } catch {
    return null;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0] !== USER_SPACE_PREFIX) return null;

  try {
    return { username: decodeURIComponent(segments[1]), name: decodeURIComponent(segments[2]) };
  } catch {
    return null;
  }
}
