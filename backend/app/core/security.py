"""密码哈希、会话令牌、Cookie。

对应原 Node 版的 `lib/auth.js`。**格式必须与它完全一致**，否则：

* 库里现有账号的密码全部失效（哈希参数不同就比不出来）
* 浏览器带着旧 Cookie 过来时解析不了

具体对齐点见下面每个类/函数的注释。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import urllib.parse

# scrypt 参数。**这三个值加上 dklen 就是兼容性的全部**：
# Node 的 crypto.scryptSync(password, salt, 64) 用默认参数 N=16384, r=8, p=1，
# Python 的 hashlib.scrypt 没有默认值，必须显式传同样的一组，否则算出的哈希对不上。
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
KEY_LENGTH = 64
# scrypt 内存需求约 128*N*r = 16 MB，给足上限免得被 OpenSSL 的默认阈值卡住
SCRYPT_MAXMEM = 128 * 1024 * 1024


class PasswordHasher:
    """scrypt 哈希，格式 `scrypt$<salt>$<hash>`，明文永不落库。

    陷阱：salt 是 **16 字节随机数的 hex 字符串**，而且原版把这串 hex 当
    **UTF-8 字节**直接喂给 scrypt（不是把它 hex 解码成 16 字节）。这里保持一致 ——
    改成解码会让现有哈希全部失效。
    """

    SCHEME = "scrypt"

    def hash(self, password: str) -> str:
        """生成哈希。每次调用都重新随机 salt，所以同一个密码两次结果不同。"""
        salt = secrets.token_hex(16)
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("ascii"),
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=KEY_LENGTH,
            maxmem=SCRYPT_MAXMEM,
        )
        return f"{self.SCHEME}${salt}${derived.hex()}"

    def verify(self, password: str, stored: str | None) -> bool:
        """恒定时间比对，避免通过响应耗时猜密码。

        脏数据（空值、格式不对）直接返回 False 而不是抛错 —— 库里有历史数据，
        不该让一条坏记录把登录接口打成 500。

        Args:
            password: 用户提交的明文。
            stored: 库里的哈希，形如 `scrypt$<salt>$<hash>`。
                **允许是 `None` 或格式不对的脏数据** —— 那种情况返回 False，不抛错。
        """
        parts = str(stored or "").split("$")
        if len(parts) != 3:
            return False
        scheme, salt, expected_hex = parts
        if scheme != self.SCHEME or not salt or not expected_hex:
            return False

        try:
            expected = bytes.fromhex(expected_hex)
        except ValueError:
            return False

        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("ascii"),
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=KEY_LENGTH,
            maxmem=SCRYPT_MAXMEM,
        )
        if len(actual) != len(expected):
            return False
        return hmac.compare_digest(actual, expected)


class SessionTokenFactory:
    """会话 token：32 字节随机数的 hex（64 个字符）。

    它同时是 `sessions` 表主键和 `mp_session` Cookie 的值，**明文存库不做哈希**
    （和密码不同 —— session token 是短期且可随时删除的，哈希它没有收益）。
    """

    @staticmethod
    def create() -> str:
        """生成 64 个字符的 hex 会话 token。"""
        return secrets.token_hex(32)


class CookieCodec:
    """Cookie 的解析与拼装。属性组合与原版一致，别改 —— 前端和浏览器行为依赖它。"""

    @staticmethod
    def parse(header: str | None) -> dict[str, str]:
        """Cookie 请求头 → 字典。解码失败保留原值、不抛错；同名后者覆盖前者。"""
        out: dict[str, str] = {}
        if not header:
            return out
        for part in str(header).split(";"):
            index = part.find("=")
            if index == -1:
                continue
            key = part[:index].strip()
            if not key:
                continue
            raw = part[index + 1 :].strip()
            try:
                out[key] = urllib.parse.unquote(raw)
            except Exception:  # noqa: BLE001 - 解码失败不该让请求失败
                out[key] = raw
        return out

    @staticmethod
    def build(name: str, value: str, *, max_age: int | None = None, secure: bool = False) -> str:
        """拼一个 Set-Cookie 值。

        固定带 `Path=/; HttpOnly; SameSite=Lax`，没有 Domain。
        `max_age` 不传就不带 `Max-Age`（浏览器会话级 Cookie）；传 0 用来让浏览器删掉它，
        退出登录走的就是这条。

        注意：**没有 CSRF token**，防跨站写操作完全依赖 `SameSite=Lax`。

        Args:
            name: Cookie 名（会话用 `Limits.SESSION_COOKIE`）。
            value: Cookie 值，会被 URL 编码。
            max_age: 秒数。**不传**＝不带 `Max-Age`（浏览器会话级 Cookie）；
                传 **0** ＝让浏览器立刻删掉它（退出登录走这条）。
            secure: 是否加 `Secure` 属性。**只在全站 HTTPS 时传 True** ——
                非 HTTPS 环境加了它，浏览器不会回传 Cookie，表现为"登录不上"。
        """
        parts = [
            f"{name}={urllib.parse.quote(value, safe='')}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if max_age is not None:
            parts.append(f"Max-Age={max_age}")
        if secure:
            parts.append("Secure")
        return "; ".join(parts)


def looks_like_email(value: str | None) -> bool:
    """粗判是不是邮箱（只查「有没有 @ 和点」）。

    不代表邮箱真实存在或已注册，用于决定注册 / 找回流程走哪条分支。
    """
    import re

    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(value or "").strip()))


def hash_email_code(email: str, code: str) -> str:
    """邮箱验证码的哈希：`sha256('邮箱:验证码')` 的 hex。

    **把邮箱混进来当盐** —— 所以同一串验证码在不同邮箱下哈希不同，
    拿到哈希也反推不出别的邮箱的码。库里只存这个值，明文只出现在邮件正文里。

    注意：6 位数字的搜索空间只有 100 万，**这个哈希挡不住拿到库文件的人暴力枚举**。
    它挡的是"读到库的一行日志"这种浅层泄露。真要更强，得给码本身也加随机盐 ——
    但那就没法"同一邮箱同一用途只留一条"了（见 `lib/verification.js` 的清理逻辑）。
    """
    return hashlib.sha256(f"{email}:{code}".encode()).hexdigest()


def verify_email_code(email: str, code: str, stored_hash: str) -> bool:
    """恒定时间比对验证码哈希。

    用 `compare_digest` 而不是 `==`，避免通过响应耗时猜数字。
    """
    return hmac.compare_digest(hash_email_code(email, code), stored_hash)


# 三个无状态工具，做成模块级单例即可（没有需要注入的依赖）
password_hasher = PasswordHasher()
session_tokens = SessionTokenFactory()
cookie_codec = CookieCodec()
