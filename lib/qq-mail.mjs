export function qqMailConfigured(env = process.env) {
  return Boolean(env.QQ_MAIL_USER?.trim() && env.QQ_MAIL_APP_PASSWORD?.trim());
}

export async function sendQQMail({ to, subject, text, html }, env = process.env) {
  if (!qqMailConfigured(env)) throw new Error('QQ 邮箱 SMTP 尚未配置。');
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; }
  catch { throw new Error('QQ 邮件发送依赖尚未安装；请在项目目录运行 npm install。'); }
  const port = Number(env.QQ_MAIL_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: env.QQ_MAIL_HOST || 'smtp.qq.com',
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.QQ_MAIL_USER.trim(), pass: env.QQ_MAIL_APP_PASSWORD.trim() },
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
  });
  try {
    return await transporter.sendMail({
      from: { name: '知行 · 人体运动学学习伴侣', address: env.QQ_MAIL_USER.trim() },
      to,
      subject,
      text,
      html,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  } finally { transporter.close(); }
}
