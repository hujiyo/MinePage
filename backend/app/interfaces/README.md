# `app/interfaces` —— 抽象契约层

## 职责

用 `abc.ABC` + `@abstractmethod` 表达"接口"。Python 没有 `interface` 关键字，
这是等价物。

**这一层的存在主要是为了课程要求的「必须纯面向对象编码」** ——
抽象、多态、依赖倒置三个特性都能在这里被指出来。
但它也有真实工程价值：业务层依赖**抽象**而不是具体实现，换实现不用改业务代码。

## 依赖方向

横切层。`services` 可以 import 它；它只依赖 `core`（拿配置）和标准库。

## 文件

| 文件 | 内容 |
|---|---|
| `mail_sender.py` | `MailSender(ABC)` + `ConsoleMailSender` / `SmtpMailSender` 两个实现 + `build_mail_sender()` 工厂 |

## 这是最值得在答辩时拿出来讲的文件

它同时用到三个面向对象特性：

| 特性 | 在哪 |
|---|---|
| **抽象** | `MailSender` 是 ABC，`send()` 是抽象方法，**不能直接实例化** |
| **多态** | `ConsoleMailSender` / `SmtpMailSender` 两个实现，调用方不关心是哪个 |
| **依赖倒置** | 业务层依赖 `MailSender` 抽象，具体实现由工厂按配置注入 |

对照原 Node 版的 `lib/email.js`：那里用一个 `if (!mailConfigured())` 分支
把两种行为塞进同一个函数 —— **能跑，但不是面向对象**。这里拆成两个类。

## 两个实现的区别

| 实现 | 什么时候用 | 返回 |
|---|---|---|
| `ConsoleMailSender` | **没配 `SMTP_HOST`**（开发模式） | 整封信打到控制台，`MailResult(delivered=False, dev=True)` |
| `SmtpMailSender` | 配了 SMTP | 真投递，`MailResult(delivered=True, dev=False)`；**失败会抛异常** |

`dev` 这个标志前端会用（决定提示文案是"验证码已发送"还是
"未配置 SMTP，请到服务器控制台查看"），**不要省掉**。

## 怎么加一个新契约

1. 想清楚"调用方真正需要知道什么" —— 抽象方法签名里**不要出现实现细节**
   （比如 `send()` 里没有 SMTP 主机、端口、`from`）
2. 定义 ABC + 抽象方法
3. 写至少两个实现（只有一个实现的话，抽象就没有意义了）
4. 加一个 `build_xxx()` 工厂按配置挑实现
5. 在 `__init__.py` 里导出

## 已知要修的地方

`SmtpMailSender.send()` 失败会抛异常，而**发验证码的流程目前是"先写库再发信"** ——
SMTP 一挂，验证码记录已经落库，用户白等满 60 秒冷却才能重试
（记录在 `../../../docs/rewrite/new-findings.md` 的 N8）。
重写验证码服务时要把顺序反过来：**先发信成功，再落库**。

## 相关文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/dependencies.md`](../../../docs/dependencies.md) | **想知道"这层依赖谁、谁依赖这层"** —— 从代码真实解析生成的图，不是手画的 |
| [`docs/rewrite/rewrite-contract.md`](../../../docs/rewrite/rewrite-contract.md) | 要写接口、对响应字段名的时候 |
| [`../README.md`](../README.md) | 分层总览、怎么跑、验收标准、注释规范 |
