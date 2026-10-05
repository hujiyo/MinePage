"""抽象契约层。

这一层的存在**主要是为了课程要求的"纯面向对象编码"**：Python 没有 `interface` 关键字，
但可以用 `abc.ABC` + `@abstractmethod` 表达同样的东西 —— 抽象、多态、依赖倒置都在这里体现。

同时它也有工程价值：业务层依赖**抽象**而不是具体实现，换实现（真发信 → 控制台打印）
不用改业务代码。
"""

from app.interfaces.mail_sender import (
    ConsoleMailSender,
    MailResult,
    MailSender,
    SmtpMailSender,
    build_mail_sender,
)

__all__ = [
    "ConsoleMailSender",
    "MailResult",
    "MailSender",
    "SmtpMailSender",
    "build_mail_sender",
]
