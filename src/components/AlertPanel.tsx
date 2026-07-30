import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Bell,
  BellOff,
  Plus,
  Trash2,
  Mail,
  Check,
  X,
  AlertTriangle,
  Send,
  History
} from 'lucide-react';
import {
  fetchAlerts,
  fetchAlertHistory,
  createAlert,
  updateAlert,
  deleteAlert,
  sendTestEmail,
  type AlertItem,
  type AlertHistoryItem
} from '../services/api';

const SPRING = {
  panel: { type: 'spring' as const, bounce: 0.05, duration: 0.4 },
  snap:  { type: 'spring' as const, bounce: 0.18, duration: 0.32 },
  toast: { type: 'spring' as const, bounce: 0,    duration: 0.3 },
};

interface AlertPanelProps {
  fundCode: string;
  fundName: string;
  onToast?: (msg: string) => void;
}

export function AlertPanel({ fundCode, fundName, onToast }: AlertPanelProps) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [history, setHistory] = useState<AlertHistoryItem[]>([]);
  const [ethereal, setEthereal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // 列表
  const reload = useCallback(async () => {
    const [a, h] = await Promise.all([fetchAlerts(), fetchAlertHistory(8)]);
    setAlerts(a);
    setHistory(h.history);
    setEthereal(h.ethereal);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const myAlerts = alerts.filter(a => a.fund_code === fundCode);

  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] overflow-hidden">
      {/* ── Header ── */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50/50 dark:hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-[var(--primary-accent)]" />
          <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
            价格提醒
          </h4>
          {myAlerts.length > 0 && (
            <span className="text-[10px] font-bold bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-full">
              {myAlerts.length}
            </span>
          )}
        </div>
        <motion.span
          animate={prefersReducedMotion ? undefined : { rotate: expanded ? 180 : 0 }}
          transition={SPRING.snap}
          className="inline-flex text-slate-400"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="alert-body"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={SPRING.panel}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-[var(--hairline-border)] pt-3 space-y-3">
              {/* Ethereal hint */}
              {ethereal && (
                <div className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                  <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                  <span>当前使用 Ethereal 测试 SMTP，邮件可在 ethereal.email 查看。要发给真实邮箱，请在 server/.env 配置 SMTP_HOST/USER/PASS。</span>
                </div>
              )}

              {/* Create form */}
              <CreateAlertForm
                fundCode={fundCode}
                fundName={fundName}
                onCreated={reload}
                onToast={onToast}
              />

              {/* Existing alerts for this fund */}
              {myAlerts.length > 0 && (
                <div className="space-y-2">
                  {myAlerts.map(a => (
                    <AlertRow
                      key={a.id}
                      alert={a}
                      onChanged={reload}
                      onToast={onToast}
                    />
                  ))}
                </div>
              )}

              {/* History (all funds, latest 5) */}
              {history.length > 0 && (
                <div className="pt-2 border-t border-[var(--hairline-border)]">
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-2">
                    <History size={10} /> 最近发送
                  </div>
                  <div className="space-y-1">
                    {history.slice(0, 5).map(h => (
                      <div
                        key={h.id}
                        className="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-400 py-1 px-2 rounded-md hover:bg-slate-50/50 dark:hover:bg-white/[0.02]"
                      >
                        {h.direction === 'up'
                          ? <ArrowUp size={10} className="text-[var(--color-up)] flex-shrink-0" />
                          : <ArrowDown size={10} className="text-[var(--color-down)] flex-shrink-0" />}
                        <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                          {h.change_pct > 0 ? '+' : ''}{h.change_pct.toFixed(2)}%
                        </span>
                        <span className="truncate flex-1">{h.fund_name || h.fund_code}</span>
                        {h.sent_ok
                          ? <Check size={10} className="text-emerald-500" />
                          : <X size={10} className="text-red-500" />}
                        <span className="text-slate-400 tabular-nums">
                          {new Date(h.sent_at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {loading && (
                <div className="space-y-2">
                  <div className="h-12 bg-slate-100 dark:bg-slate-800/50 rounded-lg animate-pulse" />
                  <div className="h-8 bg-slate-100 dark:bg-slate-800/50 rounded-lg animate-pulse w-2/3" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

function CreateAlertForm({
  fundCode,
  fundName,
  onCreated,
  onToast
}: {
  fundCode: string;
  fundName: string;
  onCreated: () => void;
  onToast?: (msg: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [up, setUp] = useState('');
  const [down, setDown] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const valid = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
                (parseFloat(up) > 0 || parseFloat(down) > 0);

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const r = await createAlert({
        fund_code: fundCode,
        fund_name: fundName,
        email,
        up_threshold: up ? parseFloat(up) : null,
        down_threshold: down ? parseFloat(down) : null,
      });
      onToast?.(r.message || '已创建提醒');
      setEmail(''); setUp(''); setDown('');
      onCreated();
    } catch (e: any) {
      onToast?.('创建失败：' + (e?.message || '未知错误'));
    } finally {
      setSubmitting(false);
    }
  };

  const sendTest = async () => {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      onToast?.('请先填写有效邮箱');
      return;
    }
    try {
      const r = await sendTestEmail(email);
      if (r.previewUrl) {
        onToast?.(`测试邮件已发（Ethereal）：${r.previewUrl.slice(0, 50)}…`);
      } else {
        onToast?.('测试邮件已发送至 ' + email);
      }
    } catch (e: any) {
      onToast?.('发送失败：' + (e?.message || '请检查 SMTP 配置'));
    }
  };

  return (
    <div className="rounded-xl bg-slate-50/60 dark:bg-white/[0.02] border border-[var(--hairline-border)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Mail size={12} className="text-slate-400 flex-shrink-0" />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="接收提醒的邮箱"
          className="apple-input flex-1 px-2.5 py-1.5 text-xs placeholder-slate-400"
        />
        <motion.button
          type="button"
          onClick={sendTest}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.94 }}
          transition={SPRING.snap}
          disabled={!email}
          className="p-1.5 rounded-md text-slate-500 hover:text-[var(--primary-accent)] hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-30 transition-colors"
          title="发送测试邮件"
        >
          <Send size={12} />
        </motion.button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ThresholdInput
          label="上涨 ≥"
          value={up}
          onChange={setUp}
          tone="up"
        />
        <ThresholdInput
          label="下跌 ≥"
          value={down}
          onChange={setDown}
          tone="down"
        />
      </div>

      <motion.button
        type="button"
        onClick={submit}
        disabled={!valid || submitting}
        whileTap={prefersReducedMotion || !valid ? undefined : { scale: 0.97 }}
        transition={SPRING.snap}
        className="w-full py-2 apple-btn-primary text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
      >
        <Plus size={12} strokeWidth={2.5} />
        {submitting ? '创建中…' : '创建提醒'}
      </motion.button>
    </div>
  );
}

function ThresholdInput({
  label, value, onChange, tone
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  tone: 'up' | 'down';
}) {
  const iconColor = tone === 'up' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]';
  return (
    <div className="flex items-center gap-1.5 bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-md px-2 py-1">
      <span className={`text-[10px] font-bold ${iconColor} flex items-center gap-0.5 whitespace-nowrap`}>
        {tone === 'up' ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
        {label}
      </span>
      <input
        type="number"
        step="0.1"
        min="0"
        max="50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="如 3"
        className="flex-1 bg-transparent text-xs font-mono tabular-nums outline-none w-full min-w-0"
      />
      <span className="text-[10px] text-slate-400">%</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

function AlertRow({
  alert,
  onChanged,
  onToast
}: {
  alert: AlertItem;
  onChanged: () => void;
  onToast?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const toggle = async () => {
    setBusy(true);
    try {
      await updateAlert(alert.id, { is_active: !alert.is_active });
      onChanged();
    } catch (e: any) {
      onToast?.('切换失败：' + (e?.message || ''));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除对该基金 (${alert.fund_code}) 的价格提醒？`)) return;
    setBusy(true);
    try {
      await deleteAlert(alert.id);
      onToast?.('已删除提醒');
      onChanged();
    } catch (e: any) {
      onToast?.('删除失败：' + (e?.message || ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${
      alert.is_active
        ? 'bg-blue-50/50 dark:bg-blue-950/20 border-blue-200/60 dark:border-blue-900/40'
        : 'bg-slate-50/30 dark:bg-white/[0.01] border-[var(--hairline-border)] opacity-60'
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {alert.up_threshold != null && (
            <span className="text-[var(--color-up)]">↑ ≥ {alert.up_threshold}%</span>
          )}
          {alert.up_threshold != null && alert.down_threshold != null && <span className="text-slate-300">·</span>}
          {alert.down_threshold != null && (
            <span className="text-[var(--color-down)]">↓ ≥ {alert.down_threshold}%</span>
          )}
        </div>
        <div className="text-[10px] text-slate-500 truncate flex items-center gap-1">
          <Mail size={9} className="flex-shrink-0" />
          <span className="truncate">{alert.email}</span>
          {alert.last_triggered_at && (
            <span className="text-slate-400 ml-1">
              · 上次 {new Date(alert.last_triggered_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>
      <motion.button
        type="button"
        onClick={toggle}
        disabled={busy}
        whileTap={prefersReducedMotion ? undefined : { scale: 0.88 }}
        transition={SPRING.snap}
        className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-white/50 dark:hover:bg-white/5 disabled:opacity-30"
        title={alert.is_active ? '暂停' : '启用'}
      >
        {alert.is_active ? <Bell size={11} /> : <BellOff size={11} />}
      </motion.button>
      <motion.button
        type="button"
        onClick={remove}
        disabled={busy}
        whileTap={prefersReducedMotion ? undefined : { scale: 0.88 }}
        transition={SPRING.snap}
        className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-30"
        title="删除"
      >
        <Trash2 size={11} />
      </motion.button>
    </div>
  );
}

/* ─── Local icons (avoid extra lucide imports) ─── */

function ArrowUp({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m5 12 7-7 7 7M12 19V5"/>
    </svg>
  );
}
function ArrowDown({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 5v14M19 12l-7 7-7-7"/>
    </svg>
  );
}
