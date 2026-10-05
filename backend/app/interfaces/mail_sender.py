"""发信接口的抽象与两个实现。

**这是本项目最容易向老师展示"面向对象"的地方**，因为它同时用到：

* **抽象** —— `MailSender` 是抽象基类，`send()` 是抽象方法，不能直接实例化
* **多态** —— `ConsoleMailSender` / `SmtpMailSender` 两个实现，调用方不关心是哪个
* **依赖倒置** —— `VerificationService` 依赖 `MailSender` 抽象，具体实现由工厂注入

对应原 Node 版的 `lib/email.js`：那里用一个 `if (!mailConfigured())` 分支把两种行为
塞在同一个函数里 —— 能跑，但不是面向对象。这里拆成两个类。
"""

from __future__ import annotations

import smtplib
from abc import ABC, abstractmethod
from email.message import EmailMessage
from typing import NamedTuple

from app.core.config import Settings


class MailResult(NamedTuple):
    """发信结果。

    * `delivered` —— 是否真的投递出去了
    * `dev` —— 是否是开发模式（没配 SMTP，内容只打印到控制台）

    原版返回 `{ delivered, dev }`，接口层靠 `dev` 决定给前端的提示文案
    （"验证码已发送，10 分钟内有效" vs "验证码已生成（未配置 SMTP，请到服务器控制台查看）"）。
    **这个语义要保留** —— 前端读的就是它。
    """

    delivered: bool
    dev: bool


class MailSender(ABC):
    """发信能力的抽象契约。

    注意签名里**没有** `from`、没有 SMTP 参数 —— 那些是实现细节，
    调用方只需要知道"发给谁、什么主题、什么正文"。
    """

    @abstractmethod
    def send(self, *, to: str, subject: str, text: str) -> MailResult:
        """发一封纯文本邮件（没有 HTML 正文、没有附件）。"""


class ConsoleMailSender(MailSender):
    """开发模式：把整封信打印到服务器控制台，不真的发出去。

    这就是"没配 SMTP 也能跑完整注册流程"的原因 —— 验证码打在控制台，
    测试时从日志里抄。生产环境不该用这个实现。
    """

    def send(self, *, to: str, subject: str, text: str) -> MailResult:
        """把整封信打到控制台，返回 `delivered=False, dev=True`。"""
        print(
            "\n┌──────────────────── 邮件（开发模式，未配置 SMTP）────────────────────\n"
            f"   收件人  {to}\n"
            f"   主题    {subject}\n"
            "────────────────────────────── 正文 ──────────────────────────────\n"
            f"{text}\n"
            "└──────────────────────────────────────────────────────────────────┘",
            flush=True,
        )
        return MailResult(delivered=False, dev=True)


class SmtpMailSender(MailSender):
    """真实投递。

    **失败会抛异常**，由调用方处理。原版这里有个已知问题：`issueCode` 先写库再发信、
    且不捕获异常，于是 SMTP 一挂，验证码记录已经落库 → 用户白等满 60 秒冷却才能重试
    （见 `tests/new-findings.md` N8）。重写时要把顺序反过来：**先发信成功，再落库**。
    """

    def __init__(self, config: Settings) -> None:
        """`config` 提供主机、端口、凭据与发件人地址。"""
        self._config = config

    def send(self, *, to: str, subject: str, text: str) -> MailResult:
        """真的投递。**失败会抛异常**，由调用方决定怎么处理。"""
        message = EmailMessage()
        message["From"] = self._config.smtp_sender
        message["To"] = to
        message["Subject"] = subject
        message.set_content(text)

        if self._config.smtp_use_tls:
            with smtplib.SMTP_SSL(self._config.smtp_host, self._config.smtp_port, timeout=15) as smtp:
                if self._config.smtp_user:
                    smtp.login(self._config.smtp_user, self._config.smtp_pass)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(self._config.smtp_host, self._config.smtp_port, timeout=15) as smtp:
                smtp.starttls()
                if self._config.smtp_user:
                    smtp.login(self._config.smtp_user, self._config.smtp_pass)
                smtp.send_message(message)

        return MailResult(delivered=True, dev=False)


def build_mail_sender(config: Settings) -> MailSender:
    """按配置挑一个实现。

    这就是**工厂**：调用方（业务层）拿到的是 `MailSender` 抽象，
    至于是打印还是真发信，它不知道也不需要知道。
    """
    if config.smtp_configured:
        return SmtpMailSender(config)
    return ConsoleMailSender()
