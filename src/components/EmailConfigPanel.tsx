import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Tooltip, Switch } from 'antd';
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
  Clock,
  Sparkles,
  ShieldCheck,
  Radio
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
import { EmailPreviewModal } from './EmailPreviewModal';
import { useModalHistory } from '../utils/modalHistory';

const SPRING = {
  sheet: { type: 'spring' as const, damping: 30, stiffness: 320, mass: 0.8 },
  panel: { type: 'spring' as const, bounce: 0.05, duration: 0.4 },
  snap:  { type: 'spring' as const, bounce: 0.16, duration: 0.28 },
};

// 模块级缓存已知的最新模式，实现弹窗秒开与即时就位 (Pre-warmed Cache)
let cachedEmailStatus: EmailStatus | null = null;
let cachedEmailMode: 'dev' | 'resend' | 'smtp' = (() => {
  try {
    return (localStorage.getItem('fund_cached_mail_mode') as any) || 'dev';
  } catch {
    return 'dev';
  }
})();

interface EmailConfigPanelProps {
  isAdmin: boolean;
  currentUser: string;
  onToast?: (msg: string) => void;
  open?: boolean;
  onClose?: () => void;
  trigger?: (open: () => void) => React.ReactNode;
}

export function EmailConfigPanel({
  isAdmin,
  currentUser,
  onToast,
  open: controlledOpen,
  onClose: controlledOnClose,
  trigger
}: EmailConfigPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // 非 admin 完全隐藏入口（admin 才可点击）
  if (!isAdmin) return null;

  const isControlled = typeof controlledOpen === 'boolean';
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const handleClose = () => {
    if (isControlled) {
      controlledOnClose?.();
    } else {
      setInternalOpen(false);
    }
  };
  const handleOpen = () => {
    if (!isControlled) {
      setInternalOpen(true);
    }
  };

  return (
    <>
      {trigger ? (
        trigger(handleOpen)
      ) : isControlled ? null : (
        <Tooltip
          title="邮件服务配置 (Admin)"
          placement="bottom"
          open={isOpen ? false : undefined}
          destroyTooltipOnHide
        >
          <motion.button
            type="button"
            onClick={(e) => {
              (e.currentTarget as HTMLElement)?.blur();
              handleOpen();
            }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.92 }}
            transition={SPRING.snap}
            className="p-1.5 rounded-full hover:bg-white dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all cursor-pointer flex items-center justify-center before:content-[''] before:absolute before:-inset-2"
            aria-label="邮件配置"
          >
            <Mail size={14} />
          </motion.button>
        </Tooltip>
      )}

      <AnimatePresence>
        {isOpen && (
          <ConfigModal
            key="email-config"
            isAdmin={isAdmin}
            currentUser={currentUser}
            onClose={handleClose}
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
  const [status, setStatus] = useState<EmailStatus | null>(cachedEmailStatus);
  const [mode, setMode] = useState<'dev' | 'resend' | 'smtp'>(cachedEmailStatus?.mode as any || cachedEmailMode);
  const [userInteractedTab, setUserInteractedTab] = useState(false);
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
  const [previewOpen, setPreviewOpen] = useState(false);
  // 提醒全局行为：非交易时段停止通知（默认开）
  const [stopAfterClose, setStopAfterClose] = useState(true);

  // 1. 视口响应式探测 (< 768px 走移动端底部抽屉)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 2. 移动端边缘侧滑与物理返回拦截 (PC桌面端环境自动旁路)
  useModalHistory(true, onClose, { id: 'email-config-panel' });

  const prefersReducedMotion = useReducedMotion();

  // 锁定 body 滚动，防止背景滚动
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await fetchEmailStatus();
      cachedEmailStatus = s;
      if (s?.mode) {
        cachedEmailMode = s.mode as any;
        try { localStorage.setItem('fund_cached_mail_mode', s.mode); } catch {}
      }
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
        onToast?.('测试邮件已发送（dev 模式 — 请在控制台查看）');
      } else {
        onToast?.(`已发送 (${r.mode})`);
      }
    } catch (e: any) {
      onToast?.('发送失败：' + (e?.message || ''));
    } finally {
      setTesting(false);
    }
  };

  // 状态指示徽标（绿灯/黄灯/灰灯）
  const renderStatusBadge = () => {
    if (!status) return null;
    const isConfigured = mode === 'dev' ? true : (mode === 'resend' ? status.resendConfigured : status.smtpConfigured);
    const colorClass = isConfigured
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border ${colorClass}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${isConfigured ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
        {status.effectiveMode.toUpperCase()}
      </span>
    );
  };

  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="邮件服务配置"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[60] bg-slate-950/50 flex flex-col justify-end md:justify-center items-center p-0 md:p-6"
      style={{
        backdropFilter: prefersReducedMotion ? undefined : 'blur(12px) saturate(160%)',
        WebkitBackdropFilter: prefersReducedMotion ? undefined : 'blur(12px) saturate(160%)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={
          prefersReducedMotion
            ? { opacity: 0 }
            : isMobile
            ? { y: '100%' }
            : { opacity: 0, scale: 0.95, y: 16 }
        }
        animate={
          isMobile
            ? { y: 0 }
            : { opacity: 1, scale: 1, y: 0 }
        }
        exit={
          prefersReducedMotion
            ? { opacity: 0 }
            : isMobile
            ? { y: '100%' }
            : { opacity: 0, scale: 0.95, y: 16 }
        }
        transition={SPRING.sheet}
        className="w-full max-w-lg bg-[var(--canvas-bg)] dark:bg-[#1a1b20] border-t md:border border-[var(--hairline-border)] rounded-t-[28px] md:rounded-[28px] rounded-b-none md:rounded-b-[28px] flex flex-col shadow-2xl relative max-h-[90dvh] md:max-h-[85vh] overflow-hidden"
      >
        {/* 移动端手势药丸指示条 (Apple Grabber) */}
        <div className="pt-2.5 pb-1 flex justify-center shrink-0 cursor-grab active:cursor-grabbing md:hidden">
          <div className="w-9 h-1 rounded-full bg-slate-300 dark:bg-zinc-700" />
        </div>

        {/* 顶部微内高光 (仅桌面端) */}
        {!isMobile && (
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-500/30 to-transparent pointer-events-none z-20" />
        )}

        {/* 头部吸顶导航栏 */}
        <div className="sticky top-0 z-10 px-5 py-3.5 bg-[var(--canvas-bg)]/90 dark:bg-[#1a1b20]/90 backdrop-blur-xl border-b border-[var(--hairline-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-blue-500/10 text-[var(--primary-accent)] flex items-center justify-center shrink-0">
              <SettingsIcon size={14} />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="apple-display-heading text-sm font-bold m-0 text-slate-900 dark:text-slate-100">
                邮件推送配置
              </h3>
              {renderStatusBadge()}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors cursor-pointer before:content-[''] before:absolute before:-inset-2 relative"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单滚动容器 */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 overscroll-contain">
          {!isAdmin && (
            <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded-xl p-3">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>当前用户为只读权限，仅管理员可更新邮件服务凭证与推送规则。</span>
            </div>
          )}

          {/* 分组一：通道选择与通道凭证 (Transmission Channel) */}
          <div className="bg-white/70 dark:bg-white/[0.03] border border-[var(--hairline-border)] rounded-2xl p-3.5 space-y-3.5 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 flex items-center gap-1">
                <Radio size={11} /> 发送服务通道
              </span>
            </div>

            {/* 模式分段选择器 */}
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100/80 dark:bg-white/5 rounded-xl">
              {(['dev', 'resend', 'smtp'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (isAdmin) {
                      setUserInteractedTab(true);
                      setMode(m);
                    }
                  }}
                  disabled={!isAdmin}
                  className={`relative py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                    mode === m ? 'text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {mode === m && (
                    <motion.span
                      layoutId="mail-mode-pill"
                      transition={userInteractedTab ? SPRING.snap : { duration: 0 }}
                      className="absolute inset-0 rounded-lg bg-[var(--primary-accent)] shadow-xs"
                    />
                  )}
                  <span className="relative z-10 font-mono">
                    {m === 'dev' ? 'Dev 控制台' : m === 'resend' ? 'Resend API' : 'SMTP 协议'}
                  </span>
                </button>
              ))}
            </div>

            <p className="text-[11px] text-slate-400 dark:text-slate-500 m-0 leading-relaxed">
              {mode === 'dev' && '开发模式：邮件内容仅在后端服务端输出，不会产生外部真实网络投递。'}
              {mode === 'resend' && '现代云推送方案：Resend HTTP API 投递，支持每日免费额度，无需开放 465 端口。'}
              {mode === 'smtp' && '传统兼容协议：适用于 QQ 邮箱、网易 163、企业邮箱及各类自建 SMTP 网关。'}
            </p>

            {/* 基础身份字段 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-[var(--hairline-border)]">
              <Field label="应用名称">
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="量化资产监控终端"
                  className="apple-input w-full px-3 py-1.5 text-xs"
                />
              </Field>
              <Field label="发件人标头" hint="如：监控中心 <alert@domain.com>">
                <input
                  type="text"
                  value={mailFrom}
                  onChange={(e) => setMailFrom(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="基金监控 <noreply@domain.com>"
                  className="apple-input w-full px-3 py-1.5 text-xs font-mono"
                />
              </Field>
            </div>

            {/* 对应模式密钥表单 */}
            {mode === 'resend' && (
              <Field label="Resend API Key" hint="在 resend.com/api-keys 获取">
                <div className="relative">
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={resendKey || (showSecrets ? savedResendKey : maskSecret(savedResendKey))}
                    onChange={(e) => setResendKey(e.target.value)}
                    disabled={!isAdmin}
                    placeholder={status?.resendConfigured ? '已安全配置（输入覆盖）' : 're_xxxxxxxxxxxx'}
                    className="apple-input w-full pl-3 pr-9 py-1.5 text-xs font-mono tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                  >
                    {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </Field>
            )}

            {mode === 'smtp' && (
              <div className="space-y-2 pt-1 border-t border-[var(--hairline-border)]">
                <div className="grid grid-cols-3 gap-2">
                  <Field label="SMTP Host" className="col-span-2">
                    <input
                      type="text"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="smtp.qq.com"
                      className="apple-input w-full px-3 py-1.5 text-xs font-mono"
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      type="number"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      disabled={!isAdmin}
                      className="apple-input w-full px-3 py-1.5 text-xs font-mono"
                    />
                  </Field>
                </div>
                <Field label="SMTP 用户名">
                  <input
                    type="email"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="you@domain.com"
                    className="apple-input w-full px-3 py-1.5 text-xs font-mono"
                  />
                </Field>
                <Field label="授权码 / 密码">
                  <div className="relative">
                    <input
                      type={showSecrets ? 'text' : 'password'}
                      value={smtpPass || (showSecrets ? savedSmtpPass : maskSecret(savedSmtpPass))}
                      onChange={(e) => setSmtpPass(e.target.value)}
                      disabled={!isAdmin}
                      placeholder={status?.smtpConfigured ? '已安全配置（输入覆盖）' : 'SMTP 专属授权码'}
                      className="apple-input w-full pl-3 pr-9 py-1.5 text-xs font-mono tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecrets(!showSecrets)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                    >
                      {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </Field>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">开启 SSL / TLS 安全加密</span>
                  <Switch
                    size="small"
                    checked={smtpSecure}
                    onChange={(v) => isAdmin && setSmtpSecure(v)}
                    disabled={!isAdmin}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 分组二：行情时钟与交易风控规则 (Trading Clock & Notification Rules) */}
          <div className="bg-white/70 dark:bg-white/[0.03] border border-[var(--hairline-border)] rounded-2xl p-3.5 space-y-2.5 shadow-2xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Clock size={12} className="text-slate-400" />
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                  非交易时段静音保护
                </span>
              </div>
              <Switch
                size="small"
                checked={stopAfterClose}
                onChange={(checked) => isAdmin && setStopAfterClose(checked)}
                disabled={!isAdmin}
              />
            </div>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 m-0 leading-relaxed">
              严格遵循金融交易所时钟：A 股 9:30-11:30 / 13:00-15:00；港股 9:30-12:00 / 13:00-16:00；美股常规交易时段。午间休市、法定节假日与周末将自动进入免打扰静音，阻断无效推送。
            </p>
          </div>

          {/* 分组三：连通性测试与仿真 (Verification & Simulation) */}
          <div className="bg-white/70 dark:bg-white/[0.03] border border-[var(--hairline-border)] rounded-2xl p-3.5 space-y-3 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 flex items-center gap-1">
                <ShieldCheck size={11} /> 连通性测试与邮件预览
              </span>
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Sparkles size={11} /> 预览排版样式
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="接收测试报告的邮箱..."
                className="apple-input flex-1 px-3 py-1.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={sendTest}
                disabled={testing || !testEmail}
                className="px-3 py-1.5 apple-btn-ghost text-xs font-semibold flex items-center gap-1.5 border border-[var(--hairline-border)] hover:bg-slate-100 dark:hover:bg-white/5 disabled:opacity-40 cursor-pointer shrink-0"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                发送测试
              </button>
            </div>
          </div>
        </div>

        {/* 独立吸底操作甲板 (Sticky Docked Footer) */}
        <div className="sticky bottom-0 z-10 p-4 bg-[var(--canvas-bg)]/95 dark:bg-[#1a1b20]/95 backdrop-blur-md border-t border-[var(--hairline-border)] pb-safe shrink-0">
          <motion.button
            type="button"
            onClick={save}
            disabled={!isAdmin || saving}
            whileTap={prefersReducedMotion || !isAdmin ? undefined : { scale: 0.98 }}
            transition={SPRING.snap}
            className="w-full py-2.5 apple-btn-primary text-xs font-bold tracking-wide flex items-center justify-center gap-1.5 disabled:opacity-40 shadow-sm cursor-pointer"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.5} />}
            {saving ? '保存配置中…' : '保存邮件配置'}
          </motion.button>
        </div>
      </motion.div>

      {/* 邮件排版预览浮层 */}
      <EmailPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        appName={appName}
        mailFrom={mailFrom}
      />
    </motion.div>,
    document.body
  );
}

function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(s.length - 8, 16)) + s.slice(-4);
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
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-bold">{label}</span>
        {hint && <span className="text-[10px] text-slate-400 opacity-80">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
