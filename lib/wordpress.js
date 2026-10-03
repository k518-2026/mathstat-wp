/**
 * WordPress.com のメール投稿
 *
 * 件名がそのまま記事タイトル、本文が記事本文になる。添付した画像はアイキャッチになる。
 * カテゴリや公開状態は本文末尾のショートコード（render.buildArticleHtml）で指定する。
 *
 * 必要な環境変数（GitHub の Secrets）:
 *   WP_POST_EMAIL … 設定 → 執筆 → メール投稿 の秘密のアドレス
 *   SMTP_USER     … 送信元（Gmail なら自分のアドレス）
 *   SMTP_PASSWORD … Gmail はアプリパスワード
 *   SMTP_HOST / SMTP_PORT … 任意。既定は Gmail（smtp.gmail.com:465）
 */
const config = require('../config');
const { requireEnv } = require('./http');

/** テストが差し替えられるように、送信の口を分けてある */
function createTransport() {
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: requireEnv('SMTP_USER'), pass: requireEnv('SMTP_PASSWORD') }
  });
}

/** image は {buffer, filename, contentType} か null */
async function sendPost(subject, html, image) {
  const transport = module.exports.createTransport();
  const mail = {
    from: { name: config.wordpress.senderName, address: requireEnv('SMTP_USER') },
    to: requireEnv('WP_POST_EMAIL'),
    subject,
    text: 'このメールはHTMLで作成されています。',
    html
  };
  if (image) mail.attachments = [{ filename: image.filename, content: image.buffer, contentType: image.contentType }];
  const info = await transport.sendMail(mail);
  return info.messageId || '';
}

module.exports = { sendPost, createTransport };
