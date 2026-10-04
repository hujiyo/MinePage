// 发信。配置了 SMTP 就走真实邮件；没配置就退化为开发模式：内容打印到服务器控制台。
import nodemailer from 'nodemailer';
import { SMTP } from './config.js';

let transporter = null;

/** SMTP 是否配置过（只看 SMTP_HOST 有没有值）。
 *  它是 sendMail 选择「真实投递」还是「打印到控制台」的分支条件，调用方也可以用它判断邮件功能是否可用。 */
export function mailConfigured() {
  return Boolean(SMTP.host);
}

/** 惰性创建并缓存 nodemailer transporter。
 *  模块级单例：进程内只建一次；改了 SMTP_* 环境变量必须重启进程才生效。
 *  只有 mailConfigured() 为真时才会走到这里；SMTP.user 为空时不带 auth 字段（本机中继场景）。 */
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.secure,
      auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
    });
  }
  return transporter;
}

/** 发一封纯文本邮件（没有 HTML 正文、没有附件）。
 *  未配置 SMTP 时退化为开发模式：收件人 / 主题 / 正文打印到服务器控制台，返回 { delivered: false, dev: true }。
 *  配了 SMTP 时走真实投递，成功返回 { delivered: true }；投递失败会抛错，由调用方处理
 *  （当前唯一调用方 verification.js 的 issueCode 没有捕获，异常会冒到 server.js 顶层变成 500）。
 *  返回值里没有 messageId，调用方只能靠 delivered / dev 判断是否真的发出去了。 */
export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) {
    console.log(`
┌──────────────────── 邮件（开发模式，未配置 SMTP）────────────────────
   收件人  ${to}
   主题    ${subject}
────────────────────────────── 正文 ──────────────────────────────
${text}
└──────────────────────────────────────────────────────────────────┘`);
    return { delivered: false, dev: true };
  }

  await getTransporter().sendMail({ from: SMTP.from || SMTP.user, to, subject, text });
  return { delivered: true };
}
