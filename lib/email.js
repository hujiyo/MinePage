// 发信。配置了 SMTP 就走真实邮件；没配置就退化为开发模式：内容打印到服务器控制台。
import nodemailer from 'nodemailer';
import { SMTP } from './config.js';

let transporter = null;

export function mailConfigured() {
  return Boolean(SMTP.host);
}

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
