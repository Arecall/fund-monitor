import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Tooltip } from 'antd';
import {
  Mail,
  X,
  Settings as SettingsIcon,
  Send,
  Check,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Bell
} from 'lucide-react';
import {
  fetchEmailStatus,
  fetchEmailSecrets,
  saveEmailConfig,
  sendTestEmail,
  fetchAlertSettings,
  saveAlertSettings,
  type EmailStatus
} from '../services/api';

const SPRING = {
  panel: { type: 'spring' as const, bounce: 0.05, duration: 0.4 },
  snap:  { type: 'spring' as const, bounce: 0.18, duration: 0.32 },
};

interface EmailConfigPanelProps {
  isAdmin: boolean;
  currentUser: string;
  onToast?: (msg: string) => void;
}

export function EmailConfigPanel({ isAdmin, currentUser, onToast }: EmailConfigPanelProps) {
  const [open, setOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // 非 admin 完全隐藏入口（admin 才可点击）
  if (!isAdmin) return null;

  return (
    <>
      <Tooltip title="邮件服务配置 (Admin)" placement="bottom">
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.92 }}
          transition={SPRING.snap}
          className="p-2 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          aria-label="邮件配置"
        >
          <Mail size={15} />
        </motion.button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <ConfigModal
            key="email-config"
            isAdmin={isAdmin}
            currentUser={currentUser}
            onClose={() => setOpen(false)}
            onToast={onToast}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function ConfigModal({
  isAdmin, currentUser, onClose, onToast
}: {
  isAdmin: boolean;
  currentUser: string;
  onClose: () => void;
  onToast?: (msg: string) => void;
}) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [mode, setMode] = useState<'dev' | 'resend' | 'smtp'>('dev');
  const [mailFrom, setMailFrom] = useState('');
  const [appName, setAppName] = useState('');
  // 已配置密钥（admin 时从后端 reveal 取回）
  const [savedResendKey, setSavedResendKey] = useState<string>('');
  const [savedSmtpPass, setSavedSmtpPass] = useState<string>('');
  // 用户当前正在编辑的输入
  const [resendKey, setResendKey] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  // 提醒全局行为：非交易时段停止通知（默认开）
  const [stopAfterClose, setStopAfterClose] = useState(true);
  const prefersReducedMotion = useReducedMotion();

  // 锁定 body 滚动，防止背景滚动
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await fetchEmailStatus();
      setStatus(s);
      setMode((s.mode as any) || 'dev');
      setMailFrom(s.mailFrom || '');
      setAppName(s.appName || '');
      // 加载提醒全局设置
      try {
        const as = await fetchAlertSettings();
        setStopAfterClose(as.stopAfterMarketClose !== false);
      } catch {
        // ignore — 用默认值
      }
      // admin 主动拉取已保存的密钥（明文）
      if (currentUser.toLowerCase() === 'admin') {
        try {
          const secrets = await fetchEmailSecrets();
          setSavedResendKey(secrets.resend_api_key || '');
          setSavedSmtpPass(secrets.smtp_pass || '');
        } catch {
          // ignore — 非 admin 会 403
        }
      }
    } catch (e) {
      onToast?.('加载邮件配置失败：' + (e as any)?.message);
    }
  }, [onToast, currentUser]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!isAdmin) {
      onToast?.('仅管理员可修改邮件配置');
      return;
    }
    setSaving(true);
    try {
      await saveEmailConfig({
        email_mode: mode,
        mail_from: mailFrom,
        app_name: appName,
        ...(mode === 'resend' && resendKey ? { resend_api_key: resendKey } : {}),
        ...(mode === 'smtp' ? {
          smtp_host: smtpHost,
          smtp_port: smtpPort,
          smtp_secure: smtpSecure ? 'true' : 'false',
          smtp_user: smtpUser,
          ...(smtpPass ? { smtp_pass: smtpPass } : {}),
        } : {}),
      });
      // 同步保存提醒全局设置
      try {
        await saveAlertSettings({ stopAfterMarketClose: stopAfterClose });
      } catch {
        // 即使 alert setting 保存失败也不阻塞 email config 保存结果
      }
      onToast?.('配置已保存');
      setResendKey('');
      setSmtpPass('');
      await load();
    } catch (e: any) {
      onToast?.('保存失败：' + (e?.message || '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      onToast?.('请输入有效测试邮箱');
      return;
    }
    setTesting(true);
    try {
      const r = await sendTestEmail(testEmail);
      if (r.mode === 'dev') {
        onToast?.('测试邮件已发送（dev 模式 — 后端控制台查看）');
      } else if (r.previewUrl) {
        onToast?.(`已发送 (${r.mode})：${r.previewUrl.slice(0, 60)}…`);
      } else {
        onToast?.(`已发送 (${r.mode})`);
      }
    } catch (e: any) {
      onToast?.('发送失败：' + (e?.message || ''));
    } finally {
      setTesting(false);
    }
  };

  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="邮件配置"
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      transition={{ duration: 0.24 }}
      className="fixed inset-0 z-[60] overflow-y-auto bg-slate-950/40"
      style={{
        backdropFilter: prefersReducedMotion ? undefined : 'blur(8px)',
        WebkitBackdropFilter: prefersReducedMotion ? undefined : 'blur(8px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="min-h-full flex items-center justify-center p-4 md:p-8">
        <motion.div
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: 'blur(8px)' }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: 'blur(4px)' }}
          transition={SPRING.panel}
          className="bg-[var(--canvas-bg)] dark:bg-[#1d1d1f] rounded-[28px] max-w-lg w-full border border-[var(--hairline-border)] shadow-2xl relative max-h-[calc(100vh-2rem)] md:max-h-[calc(100vh-4rem)] flex flex-col"
        >
          <div className="sticky top-0 z-10 bg-[var(--canvas-bg)]/95 dark:bg-[#1d1d1f]/95 backdrop-blur-xl border-b border-[var(--hairline-border)] px-5 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <SettingsIcon size={14} className="text-[var(--primary-accent)]" />
              <h3 className="apple-display-heading text-sm font-bold">邮件配置</h3>
              {status && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                  {status.effectiveMode}
                </span>
              )}
            </div>
            <motion.button
              type="button"
              onClick={onClose}
              whileTap={prefersReducedMotion ? undefined : { scale: 0.88 }}
              transition={SPRING.snap}
              className="p-1.5 rounded-full text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10"
              aria-label="关闭"
            >
              <X size={16} />
            </motion.button>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {!isAdmin && (
            <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded-xl px-3 py-2">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>当前用户 <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">{currentUser}</code> 不是 admin（admin 用户名），只能查看配置。</span>
            </div>
          )}

          {/* Mode tabs */}
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">发送模式</div>
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100/60 dark:bg-white/5 rounded-full">
              {(['dev', 'resend', 'smtp'] as const).map(m => (
                <motion.button
                  key={m}
                  type="button"
                  onClick={() => isAdmin && setMode(m)}
                  disabled={!isAdmin}
                  whileTap={prefersReducedMotion || !isAdmin ? undefined : { scale: 0.96 }}
                  transition={SPRING.snap}
                  className={`relative py-1.5 text-[11px] font-semibold rounded-full transition-colors disabled:opacity-50 ${
                    mode === m ? 'text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  {mode === m && (
                    <motion.span
                      layoutId="mail-mode-tab"
                      transition={SPRING.snap}
                      className="absolute inset-0 rounded-full bg-[var(--primary-accent)]"
                    />
                  )}
                  <span className="relative z-10">
                    {m === 'dev' ? 'Dev' : m === 'resend' ? 'Resend' : 'SMTP'}
                  </span>
                </motion.button>
              ))}
            </div>
            <div className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
              {mode === 'dev' && '开发模式 — 邮件仅打印到后端控制台，不会真实送达。'}
              {mode === 'resend' && '推荐方案 — Resend HTTP API，无需 SMTP 端口配置，免费 100 封/天。'}
              {mode === 'smtp' && '兼容 QQ/163/Gmail 等需要 SMTP 的服务。'}
            </div>
          </div>

          {/* Common fields */}
          <Field label="发件人" hint='例如：基金监控终端 <noreply@yourdomain.com>'>
            <input
              type="text"
              value={mailFrom}
              onChange={(e) => setMailFrom(e.target.value)}
              disabled={!isAdmin}
              placeholder="基金监控终端 <noreply@example.com>"
              className="apple-input w-full px-3 py-2 text-xs font-mono"
            />
          </Field>

          <Field label="应用名称">
            <input
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              disabled={!isAdmin}
              placeholder="基金监控终端"
              className="apple-input w-full px-3 py-2 text-xs"
            />
          </Field>

          {/* Resend config */}
          {mode === 'resend' && (
            <Field label="Resend API Key" hint="在 resend.com/api-keys 生成">
              <div className="relative">
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={resendKey || (showSecrets ? savedResendKey : maskSecret(savedResendKey))}
                  onChange={(e) => setResendKey(e.target.value)}
                  disabled={!isAdmin}
                  placeholder={status?.resendConfigured ? (savedResendKey ? '已配置（如需更换请输入新值）' : '已配置但无权限查看') : 're_xxxxxxxxxxxx'}
                  className="apple-input w-full pl-3 pr-9 py-2 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowSecrets(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                  title={showSecrets ? '隐藏密钥' : '显示密钥'}
                >
                  {showSecrets ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              {savedResendKey && (
                <div className="text-[10px] text-slate-400 mt-1 font-mono">
                  已保存：<span className="text-emerald-600 dark:text-emerald-400">{showSecrets ? savedResendKey : maskSecret(savedResendKey)}</span>
                </div>
              )}
            </Field>
          )}

          {/* SMTP config */}
          {mode === 'smtp' && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Host" className="col-span-2">
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="smtp.qq.com"
                    className="apple-input w-full px-3 py-2 text-xs font-mono"
                  />
                </Field>
                <Field label="Port">
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    disabled={!isAdmin}
                    className="apple-input w-full px-3 py-2 text-xs font-mono"
                  />
                </Field>
              </div>
              <Field label="用户名 (邮箱地址)">
                <input
                  type="email"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="you@qq.com"
                  className="apple-input w-full px-3 py-2 text-xs font-mono"
                />
              </Field>
              <Field label="授权码 (非登录密码)">
                <div className="relative">
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={smtpPass || (showSecrets ? savedSmtpPass : maskSecret(savedSmtpPass))}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    disabled={!isAdmin}
                    placeholder={status?.smtpConfigured ? (savedSmtpPass ? '已配置（如需更换请输入新值）' : '已配置但无权限查看') : '16 位授权码'}
                    className="apple-input w-full pl-3 pr-9 py-2 text-xs font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecrets(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                    title={showSecrets ? '隐藏密钥' : '显示密钥'}
                  >
                    {showSecrets ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
                {savedSmtpPass && (
                  <div className="text-[10px] text-slate-400 mt-1 font-mono">
                    已保存：<span className="text-emerald-600 dark:text-emerald-400">{showSecrets ? savedSmtpPass : maskSecret(savedSmtpPass)}</span>
                  </div>
                )}
              </Field>
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                <input
                  type="checkbox"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  disabled={!isAdmin}
                  className="rounded"
                />
                使用 SSL/TLS (端口 465 通常开启)
              </label>
            </>
          )}

          {/* 提醒行为（非交易时段停止通知） */}
          <div className="pt-2 border-t border-[var(--hairline-border)]">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2 flex items-center gap-1">
              <Bell size={10} /> 提醒行为
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={stopAfterClose}
                onChange={(e) => isAdmin && setStopAfterClose(e.target.checked)}
                disabled={!isAdmin}
                className="mt-0.5 rounded"
              />
              <span className="flex-1">
                <span className="font-semibold text-slate-700 dark:text-slate-200">非交易时段停止通知</span>
                <span className="block text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                  开启后，A 股仅在周一-五 9:30-11:30 / 13:00-15:00；港股 9:30-12:00 / 13:00-16:00；美股 9:30-16:00（自动夏冬令时）触发提醒，周末和中午休市时段自动跳过。
                </span>
              </span>
            </label>
          </div>

          {/* Save button */}
          <motion.button
            type="button"
            onClick={save}
            disabled={!isAdmin || saving}
            whileTap={prefersReducedMotion || !isAdmin ? undefined : { scale: 0.97 }}
            transition={SPRING.snap}
            className="w-full py-2 apple-btn-primary text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {saving ? '保存中…' : '保存配置'}
          </motion.button>

          {/* Divider */}
          <div className="border-t border-[var(--hairline-border)]" />

          {/* Test email */}
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">测试发送</div>
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="your@email.com"
                className="apple-input flex-1 px-3 py-2 text-xs font-mono"
              />
              <motion.button
                type="button"
                onClick={sendTest}
                disabled={testing}
                whileTap={prefersReducedMotion ? undefined : { scale: 0.95 }}
                transition={SPRING.snap}
                className="px-3 py-2 apple-btn-ghost text-xs font-semibold flex items-center gap-1.5 border border-[var(--hairline-border)]"
              >
                {testing ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                发送测试
              </motion.button>
            </div>
            <div className="text-[10px] text-slate-400 mt-1.5">
              提示：dev 模式仅打印到后端控制台，可访问 <code className="font-mono">/tmp/output</code> 查看实时输出。
            </div>
          </div>

          {/* Status footer */}
          {status && (
            <div className="text-[10px] text-slate-400 px-3 py-2 bg-slate-50/60 dark:bg-white/[0.02] rounded-lg border border-[var(--hairline-border)]">
              <div>当前生效模式：<span className="font-semibold text-slate-600 dark:text-slate-300">{status.effectiveMode}</span></div>
              <div>Resend 已配置：{status.resendConfigured ? '✓' : '✗'} · SMTP 已配置：{status.smtpConfigured ? '✓' : '✗'}</div>
              <div>收盘后停止通知：{stopAfterClose ? '✓ 已启用' : '✗ 已关闭'}</div>
            </div>
          )}
          </div>
        </motion.div>
      </div>
    </motion.div>,
    document.body
  );
}

/** 脱敏：保留首尾 4 字符，中间用 • 替代。短于 8 直接全遮。 */
function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(s.length - 8, 20)) + s.slice(-4);
}

function Field({
  label, hint, children, className = ''
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-slate-400 mt-1">{hint}</div>}
    </div>
  );
}