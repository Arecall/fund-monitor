/**
 * mailer.cjs — 邮件服务（参考 image-indx email.js 的设计）
 *
 * 三种模式：
 *   1) dev     — 无配置时，console.log 完整邮件，开发联调用
 *   2) resend  — Resend HTTP API（推荐，无需 SMTP 配置）
 *   3) smtp    — nodemailer + SMTP（兼容 QQ/163/Gmail 等）
 *
 * 配置来源（每次 send 都重新读取，admin 修改后无需重启）：
 *   1) settings 表（key: email_mode, resend_api_key, smtp_*, mail_from, app_name）
 *   2) 环境变量（fallback）
 *
 * 密钥字段（resend_api_key / smtp_pass）使用 crypto.cjs 加密后存 DB。
 */

const nodemailer = require('nodemailer');
const https = require('https');
const dbHelper = require('./db.cjs');
const { encrypt, decrypt } = require('./crypto.cjs');

const SETTING_KEYS = [
  'email_mode',          // 'dev' | 'resend' | 'smtp'
  'resend_api_key',
  'mail_from',
  'app_name',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'smtp_pass',
];

/* ─────── 配置读取（每次发送都从 settings 表读最新） ─────── */

async function loadConfig() {
  // 1. 读 settings 表
  let cfg = {};
  try {
    const rows = await dbHelper.all(
      `SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(',')})`,
      SETTING_KEYS
    );
    cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch (e) {
    console.warn('[mailer] settings read failed:', e.message);
  }

  // 2. 缺失字段用 env 兜底
  const mode = cfg.email_mode || process.env.EMAIL_MODE || 'dev';
  const mailFrom = cfg.mail_from || process.env.MAIL_FROM || '基金监控终端 <noreply@example.com>';
  const appName = cfg.app_name || process.env.APP_NAME || '基金监控终端';

  // 解密密钥字段
  const resendKey = decrypt(cfg.resend_api_key || process.env.RESEND_API_KEY || '');
  const smtpPass = decrypt(cfg.smtp_pass || process.env.SMTP_PASS || '');

  return {
    mode,
    mailFrom,
    appName,
    resendKey,
    smtp: {
      host: cfg.smtp_host || process.env.SMTP_HOST || '',
      port: parseInt(cfg.smtp_port || process.env.SMTP_PORT || '465', 10),
      secure: (cfg.smtp_secure || process.env.SMTP_SECURE || 'true') === 'true',
      user: cfg.smtp_user || process.env.SMTP_USER || '',
      pass: smtpPass,
    },
    // 状态报告（给前端展示用，不含密钥）
    status: {
      mode,
      resendConfigured: !!resendKey,
      smtpConfigured: !!(cfg.smtp_host || process.env.SMTP_HOST) && !!(smtpPass || cfg.smtp_user),
      mailFrom,
      appName,
    }
  };
}

/* ─────── 模式探测 ─────── */

function effectiveMode(cfg) {
  // 用户配置的 mode 优先；否则按就绪情况自动选
  if (cfg.mode === 'resend' && cfg.resendKey) return 'resend';
  if (cfg.mode === 'smtp' && cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass) return 'smtp';
  if (cfg.resendKey) return 'resend';           // auto-pick resend if key present
  if (cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass) return 'smtp';
  return 'dev';
}

/* ─────── Resend HTTP API ─────── */

function sendViaResend({ apiKey, from, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ ok: true, messageId: JSON.parse(data).id }); }
          catch { resolve({ ok: true }); }
        } else {
          reject(new Error(`Resend API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────── SMTP ─────── */

let smtpTransporter = null;
let smtpTransporterKey = '';          // 用于检测配置变化后重建

async function getSmtpTransporter(cfg) {
  const key = `${cfg.smtp.host}|${cfg.smtp.port}|${cfg.smtp.user}|${cfg.smtp.secure}`;
  if (smtpTransporter && key === smtpTransporterKey) return smtpTransporter;
  smtpTransporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  smtpTransporterKey = key;
  return smtpTransporter;
}

async function sendViaSmtp({ cfg, from, to, subject, html }) {
  const transporter = await getSmtpTransporter(cfg);
  const info = await transporter.sendMail({ from, to, subject, html });
  let previewUrl;
  if (info.messageId && nodemailer.getTestMessageUrl) {
    previewUrl = nodemailer.getTestMessageUrl(info);
  }
  return { ok: true, messageId: info.messageId, previewUrl };
}

/* ─────── Dev mode 邮件模板 ─────── */

function buildAlertHtml({ appName, fundName, fundCode, direction, changePct, currentPrice, referencePrice, openPrice }) {
  const dirText = direction === 'up' ? '上涨' : '下跌';
  const dirColor = direction === 'up' ? '#ff453a' : '#30d158';
  const dirBg = direction === 'up' ? '#fff1f0' : '#f0fff4';
  const dirBorder = direction === 'up' ? '#ffccc7' : '#b7eb8f';

  // 相对开盘价的累计涨跌
  const op = typeof openPrice === 'number' && Number.isFinite(openPrice) && openPrice > 0 ? openPrice : referencePrice;
  const cumDiff = currentPrice - op;
  const cumPct = op > 0 ? (cumDiff / op) * 100 : 0;

  let cumText = '';
  let cumColor = '#1d1d1f';
  if (cumDiff > 0) {
    cumText = `累计涨 +${cumDiff.toFixed(4)} (+${cumPct.toFixed(2)}%)`;
    cumColor = '#ff453a';
  } else if (cumDiff < 0) {
    cumText = `累计跌 -${Math.abs(cumDiff).toFixed(4)} (-${Math.abs(cumPct).toFixed(2)}%)`;
    cumColor = '#30d158';
  } else {
    cumText = `累计平 0.0000 (0.00%)`;
    cumColor = '#86868b';
  }

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${dirText}提醒</title></head>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f7;padding:24px;margin:0;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;border:1px solid #e5e5e7;padding:28px;">
  <div style="font-size:12px;color:#86868b;margin-bottom:8px;">${appName} · 价格提醒</div>
  <h2 style="font-size:18px;margin:0 0 4px 0;color:#1d1d1f;font-weight:600;">
    ${fundName || fundCode} <span style="font-family:monospace;font-size:12px;color:#86868b;font-weight:400;">${fundCode}</span>
  </h2>
  <div style="margin-top:16px;padding:16px;background:${dirBg};border-radius:12px;border:1px solid ${dirBorder};">
    <div style="font-size:12px;color:#86868b;margin-bottom:4px;">${dirText}幅度</div>
    <div style="font-size:28px;font-weight:700;color:${dirColor};font-feature-settings:'tnum';">
      ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%
    </div>
  </div>
  <table style="width:100%;margin-top:16px;border-collapse:collapse;font-size:13px;">
    <tr><td style="color:#86868b;padding:6px 0;">最新价格</td><td style="text-align:right;font-family:monospace;font-weight:600;color:#1d1d1f;padding:6px 0;">${currentPrice.toFixed(4)}</td></tr>
    <tr><td style="color:#86868b;padding:6px 0;">开盘价格</td><td style="text-align:right;font-family:monospace;color:#1d1d1f;padding:6px 0;">${op.toFixed(4)}</td></tr>
    <tr><td style="color:#86868b;padding:6px 0;">较开盘涨跌</td><td style="text-align:right;font-family:monospace;font-weight:600;color:${cumColor};padding:6px 0;">${cumText}</td></tr>
    <tr><td style="color:#86868b;padding:6px 0;">基准参考价</td><td style="text-align:right;font-family:monospace;color:#86868b;padding:6px 0;">${referencePrice.toFixed(4)}</td></tr>
    <tr><td style="color:#86868b;padding:6px 0;">触发时间</td><td style="text-align:right;font-family:monospace;color:#1d1d1f;padding:6px 0;">${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td></tr>
  </table>
  <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f0f0f0;font-size:11px;color:#86868b;">
    本邮件由 ${appName} 自动发送。如不再需要提醒，请登录系统关闭对应规则。
  </div>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/* ─────── 公共发送入口 ─────── */

async function sendAlertEmail({
  to, fundCode, fundName, direction, changePct, currentPrice, referencePrice, openPrice
}) {
  const cfg = await loadConfig();
  const mode = effectiveMode(cfg);

  const dirText = direction === 'up' ? '上涨' : '下跌';
  const subject = `【${dirText}提醒】${fundName || fundCode} 净值${dirText} ${Math.abs(changePct).toFixed(2)}%`;
  const html = buildAlertHtml({
    appName: cfg.appName,
    fundName: escapeHtml(fundName),
    fundCode,
    direction, changePct, currentPrice, referencePrice, openPrice
  });

  /* ── dev mode: 直接 console.log 完整邮件 ── */
  if (mode === 'dev') {
    console.log('\n========== EMAIL (dev mode) ==========');
    console.log(`To:      ${to}`);
    console.log(`From:    ${cfg.mailFrom}`);
    console.log(`Subject: ${subject}`);
    console.log('------------------------------------------');
    console.log(html);
    console.log('==========================================\n');
    return { ok: true, mode: 'dev', messageId: 'dev-no-send' };
  }

  /* ── resend mode ── */
  if (mode === 'resend') {
    const r = await sendViaResend({
      apiKey: cfg.resendKey,
      from: cfg.mailFrom,
      to, subject, html,
    });
    console.log(`[mailer] sent via resend → ${to} | ${subject} | id=${r.messageId}`);
    return { ok: true, mode: 'resend', messageId: r.messageId };
  }

  /* ── smtp mode ── */
  if (mode === 'smtp') {
    const r = await sendViaSmtp({
      cfg,
      from: cfg.mailFrom,
      to, subject, html,
    });
    console.log(`[mailer] sent via smtp → ${to} | ${subject} | id=${r.messageId}${r.previewUrl ? ' | preview=' + r.previewUrl : ''}`);
    return { ok: true, mode: 'smtp', messageId: r.messageId, previewUrl: r.previewUrl };
  }

  throw new Error('no mailer mode available');
}

/** 给前端用的状态查询（不暴露密钥） */
async function getStatus() {
  const cfg = await loadConfig();
  return {
    ...cfg.status,
    effectiveMode: effectiveMode(cfg),
  };
}

/**
 * 返回已配置的敏感字段（明文）。仅供 admin 主动调用：
 *   GET /api/email/config/reveal
 * 返回字段默认仍是脱敏（保留首尾 4 字符），前端可再 toggle 显示完整。
 */
async function getRevealedSecrets() {
  const cfg = await loadConfig();
  return {
    resend_api_key: cfg.resendKey,
    smtp_pass: cfg.smtp.pass,
    mail_from: cfg.mailFrom,
    app_name: cfg.appName,
  };
}

/** 配置更新（来自 admin UI；密钥字段加密后入库） */
async function saveConfig(updates) {
  const allowed = new Set(SETTING_KEYS);
  const entries = Object.entries(updates).filter(([k]) => allowed.has(k));
  for (const [key, raw] of entries) {
    let value = raw == null ? '' : String(raw);
    // 敏感字段加密
    if (key === 'resend_api_key' || key === 'smtp_pass') {
      if (value && !value.startsWith('enc:v1:')) {
        value = encrypt(value);
      }
    }
    if (value === '') {
      // 清空 → 删除该 key
      await dbHelper.run('DELETE FROM settings WHERE key = ?', [key]);
    } else {
      await dbHelper.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
      );
    }
  }
  // 让 SMTP transporter 在下次使用时重建
  smtpTransporter = null;
  smtpTransporterKey = '';
  return getStatus();
}

module.exports = {
  sendAlertEmail,
  getStatus,
  getRevealedSecrets,
  saveConfig,
  loadConfig,
  effectiveMode,
};