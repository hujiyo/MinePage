"""邮箱验证码的签发与核销。

对应原版 `lib/verification.js`。**这个文件里有一处刻意偏离原版，见 `issue()` 的说明。**

验证码的规则（全部来自原版）：

| 项 | 值 | 来源 |
|---|---|---|
| 位数 | 6 位数字，可能有前导 0 | `Limits.CODE_LENGTH` |
| 有效期 | 10 分钟 | `Limits.CODE_TTL_MINUTES` |
| 重发冷却 | 60 秒，按「邮箱 + 用途」算 | `Limits.CODE_RESEND_COOLDOWN_SECONDS` |
| 最大失败次数 | 5 次，超过作废 | `Limits.CODE_MAX_ATTEMPTS` |
| 清理 | 每次发码前删掉 1 天前的记录 | 硬编码 1 天 |

**注意冷却没有 IP 维度** —— 换个邮箱就能绕过。这是原版的设计，保留。
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from app.core.config import Limits
from app.core.exceptions import TooManyRequests, ValidationError
from app.core.security import hash_email_code, verify_email_code
from app.interfaces.mail_sender import MailSender
from app.models.base import utcnow_iso
from app.repositories.verification_repository import VerificationRepository


class VerificationService:
    """签发与核销邮箱验证码。"""

    #: `purpose` → 邮件主题。新加场景要在这里登记，**不是可选项** ——
    #: 没登记的用途直接抛错，免得悄悄发一封主题为 undefined 的信。
    PURPOSES: dict[str, str] = {
        "register": "MinePage 注册验证码",
        "change": "MinePage 修改密码验证码",
        "reset": "MinePage 找回密码验证码",
    }

    #: 验证码正文模板。`{code}` 与 `{minutes}` 会被替换。
    BODY = "你的验证码是 {code}，{minutes} 分钟内有效。如果不是你本人的操作，请忽略这封邮件。"

    def __init__(self, codes: VerificationRepository, mailer: MailSender) -> None:
        """组装验证码服务。

        Args:
            codes: 验证码仓储。
            mailer: 发信实现（抽象）。生产是 SMTP，开发是打印到控制台 —— 见 `interfaces/`。
        """
        self._codes = codes
        self._mailer = mailer

    # ---------------------------------------------------------------- 签发

    def issue(self, email: str, purpose: str) -> bool:
        """发一个验证码。返回 `dev` 标志（`True` = 没配 SMTP，只打到控制台）。

        Args:
            email: 收件邮箱，**调用方须已转小写**。
            purpose: 必须是 `PURPOSES` 里登记过的。

        Returns:
            `dev` —— 前端据此决定提示文案。`False` 表示真的发出去了。

        Raises:
            ValidationError: `purpose` 未登记。
            TooManyRequests: 距上次发送不足 60 秒（文案带剩余秒数）。
            Exception: 真的发信失败时，异常原样往上抛（调用方回 500）。

        **⚠️ 这里刻意偏离了原版。** 原版是「先写库、再发信」，于是一旦 SMTP 挂掉：

        * 验证码记录已经落库 → **用户必须白等满 60 秒冷却才能重试**
        * 而用户根本没收到码，只会觉得"这网站坏了"

        这条记在 `docs/rewrite/new-findings.md` 的 **N8**。重写时把顺序反过来：
        **先发信成功、再落库**。失败时什么都没留下，用户立刻可以重试。

        代价说清楚：发信成功后落库失败的话，用户手里会有一个库里不存在的码，
        他会看到"验证码不存在或已过期"并可以立刻重试 —— 比白等 60 秒好。
        """
        if purpose not in self.PURPOSES:
            raise ValidationError(f"未知的验证码用途：{purpose}")

        now = datetime.now(UTC)
        self._codes.delete_older_than((now - timedelta(days=1)).isoformat())

        self._assert_not_too_frequent(email, purpose, now)

        code = self._generate_code()
        expires_at = (now + timedelta(minutes=Limits.CODE_TTL_MINUTES)).isoformat()

        # 先发信 —— 发不出去就不留下任何记录，用户不用等冷却（N8 的修法）
        result = self._mailer.send(
            to=email,
            subject=self.PURPOSES[purpose],
            text=self.BODY.format(code=code, minutes=Limits.CODE_TTL_MINUTES),
        )

        self._codes.create(
            email=email,
            purpose=purpose,
            code_hash=hash_email_code(email, code),
            expires_at=expires_at,
            now_iso=utcnow_iso(),
        )
        return result.dev

    def _assert_not_too_frequent(self, email: str, purpose: str, now: datetime) -> None:
        """冷却检查。**按「邮箱 + 用途」判断**，没有 IP 维度（与原版一致）。

        Args:
            email: 邮箱（调用方已转小写）。
            purpose: 用途 —— 冷却键是「邮箱 + 用途」，所以不同用途互不影响。
            now: 当前时间。传进来而不是在里面取，是为了让"距上次多久"可测。

        Raises:
            TooManyRequests: 距上次发送不足 `Limits.CODE_RESEND_COOLDOWN_SECONDS`
                秒（429，文案里带剩余秒数）。
        """
        recent = self._codes.latest(email, purpose)
        if recent is None:
            return
        try:
            created = datetime.fromisoformat(recent.created_at)
        except ValueError:
            return  # 脏数据不值得挡住发送
        elapsed = (now - created).total_seconds()
        if elapsed < Limits.CODE_RESEND_COOLDOWN_SECONDS:
            wait = int(Limits.CODE_RESEND_COOLDOWN_SECONDS - elapsed) + 1
            raise TooManyRequests(f"发送太频繁了，请 {wait} 秒后再试")

    @staticmethod
    def _generate_code() -> str:
        """生成 N 位数字码，**不足位左侧补 0**（所以可能出现 `000123`）。

        用 `secrets` 而不是 `random` —— 后者是可预测的。
        """
        upper = 10**Limits.CODE_LENGTH
        return str(secrets.randbelow(upper)).zfill(Limits.CODE_LENGTH)

    # ---------------------------------------------------------------- 核销

    def consume(self, email: str, purpose: str, code: str) -> None:
        """校验并消费一个验证码。**失败会抛异常**（文案与原版一致）。

        Args:
            email: 邮箱，调用方须已转小写。
            purpose: 用途。
            code: 用户填的 6 位码。

        Raises:
            ValidationError: 码不存在/过期/不对/错太多次。四种情况的文案**各不相同**，
                因为它们对用户意味着不同的事（重新获取 vs 等一下 vs 再仔细看看）。

        实现细节（照抄原版，别改）：

        * 取的是「最近一条**未消费且未过期**」的记录，不是"最近一条" ——
          顺序写反会让过期的旧码挡住新码
        * **先 `attempts + 1` 再比对哈希**，所以失败次数是包含本次的；
          到 `CODE_MAX_ATTEMPTS` 之后**即使填对也拒绝**
        * 成功时写 `consumed_at`，同一行不能被用第二次
        """
        row = self._codes.find_usable(email, purpose, utcnow_iso())
        if row is None:
            raise ValidationError("验证码不存在或已过期，请重新获取")
        if (row.attempts or 0) >= Limits.CODE_MAX_ATTEMPTS:
            raise ValidationError("错太多次了，这个验证码已作废，请重新获取")

        self._codes.bump_attempts(row)

        if not verify_email_code(email, code, row.code_hash):
            raise ValidationError("验证码不对")

        self._codes.mark_consumed(row, utcnow_iso())
