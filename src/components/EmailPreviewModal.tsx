import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  X,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Clock,
  Sparkles,
  Smartphone,
  Laptop
} from 'lucide-react';
import { useModalHistory } from '../utils/modalHistory';

interface EmailPreviewModalProps {
  open: boolean;
  onClose: () => void;
  appName: string;
  mailFrom: string;
}

type ScenarioType = 'stock_up' | 'fund_down';

const SPRING_PANEL = { type: 'spring' as const, stiffness: 320, damping: 28, mass: 0.9 };
const SPRING_TAB = { type: 'spring' as const, stiffness: 480, damping: 32, mass: 0.8 };

export function EmailPreviewModal({
  open,
  onClose,
  appName,
  mailFrom
}: EmailPreviewModalProps) {
  const [scenario, setScenario] = useState<ScenarioType>('stock_up');
  const [deviceFrame, setDeviceFrame] = useState<'desktop' | 'mobile'>('desktop');
  const prefersReducedMotion = useReducedMotion();

  // 接入 Android 物理返回 / 边缘侧滑手势
  useModalHistory(open, onClose, { id: 'email-preview-modal' });

  // 保证实时展示用户输入的应用名与发件人，具备即时响应性
  const displayAppName = (appName && appName.trim()) || '全球量化基金平台';
  const displayMailFrom = (mailFrom && mailFrom.trim()) || `${displayAppName} <noreply@example.com>`;

  // 标的场景推演数据
  const currentScenario = useMemo(() => {
    if (scenario === 'stock_up') {
      return {
        kind: 'stock',
        name: '平安银行',
        code: '000001',
        market: 'A股',
        direction: 'up',
        dirText: '上涨',
        changePct: 3.25,
        currentPrice: '11.8500',
        referencePrice: '11.4700',
        openPrice: '11.5000',
        curLabel: '最新撮合成交价',
        refLabel: '昨日收盘价',
        changeTitle: '当日涨跌幅',
        color: 'text-[#ff453a] dark:text-[#ff6961]',
        badgeBg: 'bg-[#fff1f0] dark:bg-[#321414]',
        badgeBorder: 'border-[#ffccc7] dark:border-[#5c2223]',
        disclaimer: '行情提示：行情数据可能存在交易所网络时延，最终撮合结果以券商实际成交回报为准。市场有风险，投资需谨慎。'
      };
    }
    return {
      kind: 'fund',
      name: '华夏成长混合A',
      code: '000001',
      market: '场外公募',
      direction: 'down',
      dirText: '下跌',
      changePct: -2.10,
      currentPrice: '1.2450',
      referencePrice: '1.2717',
      openPrice: null,
      curLabel: '盘中实时估算净值',
      refLabel: '昨日单位净值',
      changeTitle: '当日估算涨跌幅',
      color: 'text-[#30d158] dark:text-[#34c759]',
      badgeBg: 'bg-[#f0fff4] dark:bg-[#122e1b]',
      badgeBorder: 'border-[#b7eb8f] dark:border-[#1d522e]',
      disclaimer: '合规提示：场外基金盘中估算净值系基于成分股实时走势的模型测算，与基金公司晚间公布的官方清算净值可能存在偏差。估算数据仅供参考，不构成任何投资依据与交易指令。'
    };
  }, [scenario]);

  const emailSubject = `【${currentScenario.dirText}提醒】${currentScenario.name} ${currentScenario.kind === 'stock' ? '股价' : '估算净值'}${currentScenario.dirText} ${Math.abs(currentScenario.changePct).toFixed(2)}%`;

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="邮件推送样式预览"
        className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6 overflow-y-auto bg-slate-950/60 backdrop-blur-md"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 12, filter: 'blur(6px)' }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 8, filter: 'blur(4px)' }}
          transition={SPRING_PANEL}
          className={`w-full ${deviceFrame === 'mobile' ? 'max-w-sm' : 'max-w-2xl'} transition-all duration-300 bg-[var(--canvas-bg,#fbfbfd)] dark:bg-[#18181b] rounded-[24px] border border-[var(--hairline-border,rgba(0,0,0,0.1))] dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]`}
        >
          {/* macOS 风格邮件客户端顶栏 */}
          <div className="px-4 py-3 bg-slate-100/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-black/[0.06] dark:border-white/[0.08] flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              {/* macOS 窗控点 */}
              <div className="flex items-center gap-1.5 mr-2">
                <div className="w-3 h-3 rounded-full bg-[#FF5F56] border border-[#E0443E]/50 shadow-inner" />
                <div className="w-3 h-3 rounded-full bg-[#FFBD2E] border border-[#DEA123]/50 shadow-inner" />
                <div className="w-3 h-3 rounded-full bg-[#27C93F] border border-[#1AAB29]/50 shadow-inner" />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200">
                邮件客户端渲染视图
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100/70 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                HTML 仿真
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* 视口模拟切换 (桌面 / 移动) */}
              <div className="hidden sm:flex items-center bg-black/[0.04] dark:bg-white/[0.06] p-0.5 rounded-lg text-slate-500 dark:text-zinc-400">
                <button
                  type="button"
                  onClick={() => setDeviceFrame('desktop')}
                  className={`p-1 rounded-md transition-colors ${deviceFrame === 'desktop' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow-sm' : 'hover:text-slate-900 dark:hover:text-white'}`}
                  title="桌面端宽屏渲染"
                >
                  <Laptop size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setDeviceFrame('mobile')}
                  className={`p-1 rounded-md transition-colors ${deviceFrame === 'mobile' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow-sm' : 'hover:text-slate-900 dark:hover:text-white'}`}
                  title="手机端窄屏渲染"
                >
                  <Smartphone size={13} />
                </button>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="关闭预览"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* 场景切换微胶囊工具栏 */}
          <div className="px-4 py-2.5 bg-slate-50/70 dark:bg-zinc-900/40 border-b border-black/[0.05] dark:border-white/[0.06] flex items-center justify-between gap-2 overflow-x-auto">
            <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 whitespace-nowrap">
              监控标的场景:
            </span>
            <div className="flex items-center gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] p-1 rounded-full shrink-0">
              <button
                type="button"
                onClick={() => setScenario('stock_up')}
                className={`relative px-3 py-1 text-xs font-medium rounded-full transition-colors flex items-center gap-1.5 cursor-pointer ${
                  scenario === 'stock_up'
                    ? 'text-white'
                    : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {scenario === 'stock_up' && (
                  <motion.span
                    layoutId="preview-scenario-pill"
                    transition={SPRING_TAB}
                    className="absolute inset-0 rounded-full bg-[#ff453a]"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1">
                  <TrendingUp size={12} />
                  平安银行 (+3.25%)
                </span>
              </button>

              <button
                type="button"
                onClick={() => setScenario('fund_down')}
                className={`relative px-3 py-1 text-xs font-medium rounded-full transition-colors flex items-center gap-1.5 cursor-pointer ${
                  scenario === 'fund_down'
                    ? 'text-white'
                    : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {scenario === 'fund_down' && (
                  <motion.span
                    layoutId="preview-scenario-pill"
                    transition={SPRING_TAB}
                    className="absolute inset-0 rounded-full bg-[#30d158]"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1">
                  <TrendingDown size={12} />
                  华夏成长 (-2.10%)
                </span>
              </button>
            </div>
          </div>

          {/* 邮件正文视口（具备独立滚动） */}
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 bg-[#f5f5f7] dark:bg-[#0c0c0e]">
            {/* 邮件信头元数据卡片 */}
            <div className="mb-4 bg-white dark:bg-zinc-900 rounded-xl p-3 border border-slate-200/80 dark:border-zinc-800 shadow-sm text-xs space-y-1.5">
              <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
                <span className="font-semibold text-slate-700 dark:text-zinc-200">发件人:</span>
                <span className="font-mono truncate max-w-[320px] text-right">{displayMailFrom}</span>
              </div>
              <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
                <span className="font-semibold text-slate-700 dark:text-zinc-200">收件人:</span>
                <span className="font-mono text-slate-600 dark:text-zinc-400">subscriber@company.com</span>
              </div>
              <div className="flex items-start justify-between text-slate-500 dark:text-zinc-400 pt-1 border-t border-slate-100 dark:border-zinc-800">
                <span className="font-semibold text-slate-700 dark:text-zinc-200 flex-shrink-0 mr-2">主题:</span>
                <span className="font-medium text-slate-900 dark:text-zinc-100 text-right">{emailSubject}</span>
              </div>
            </div>

            {/* 真实邮件 HTML 渲染沙盒卡片 */}
            <div className="bg-white dark:bg-[#1a1a1e] rounded-[18px] border border-[#e5e5e7] dark:border-zinc-800 p-5 sm:p-7 shadow-md max-w-[560px] mx-auto text-slate-900 dark:text-zinc-100">
              {/* 顶部栏 */}
              <div className="flex items-center justify-between text-xs text-[#86868b] mb-2">
                <span>{displayAppName} · 价格监控提醒</span>
                <span className="text-[11px] bg-[#f0f0f2] dark:bg-zinc-800 text-[#636366] dark:text-zinc-400 px-2 py-0.5 rounded-full font-medium">
                  {currentScenario.market}
                </span>
              </div>

              {/* 标的名称与代码 */}
              <div className="flex items-baseline gap-2 mb-4">
                <h2 className="text-lg font-bold tracking-tight m-0 text-[#1d1d1f] dark:text-zinc-100">
                  {currentScenario.name}
                </h2>
                <span className="font-mono text-xs text-[#86868b]">
                  {currentScenario.code}
                </span>
              </div>

              {/* 涨跌幅大微岛 */}
              <div className={`p-4 rounded-xl border ${currentScenario.badgeBg} ${currentScenario.badgeBorder} mb-4`}>
                <div className="text-xs text-[#86868b] dark:text-zinc-400 mb-1">
                  {currentScenario.changeTitle}
                </div>
                <div
                  className={`text-3xl font-extrabold tracking-tight tabular-nums ${currentScenario.color}`}
                >
                  {currentScenario.changePct > 0 ? '+' : ''}
                  {currentScenario.changePct.toFixed(2)}%
                </div>
              </div>

              {/* 行情参数表格 */}
              <div className="divide-y divide-slate-100 dark:divide-zinc-800/80 text-[13px]">
                <div className="py-2 flex items-center justify-between">
                  <span className="text-[#86868b] dark:text-zinc-400">{currentScenario.curLabel}</span>
                  <span className="font-mono font-bold text-[#1d1d1f] dark:text-zinc-100 tabular-nums">
                    {currentScenario.currentPrice}
                  </span>
                </div>
                <div className="py-2 flex items-center justify-between">
                  <span className="text-[#86868b] dark:text-zinc-400">{currentScenario.refLabel}（基准）</span>
                  <span className="font-mono text-[#86868b] dark:text-zinc-400 tabular-nums">
                    {currentScenario.referencePrice}
                  </span>
                </div>
                {currentScenario.openPrice && (
                  <div className="py-2 flex items-center justify-between">
                    <span className="text-[#86868b] dark:text-zinc-400">开盘价格</span>
                    <span className="font-mono text-[#1d1d1f] dark:text-zinc-100 tabular-nums">
                      {currentScenario.openPrice}
                    </span>
                  </div>
                )}
                <div className="py-2 flex items-center justify-between">
                  <span className="text-[#86868b] dark:text-zinc-400 flex items-center gap-1">
                    <Clock size={12} /> 触发时间
                  </span>
                  <span className="font-mono text-slate-700 dark:text-zinc-300 tabular-nums">
                    {new Date().toLocaleDateString('zh-CN')} 14:35:00
                  </span>
                </div>
              </div>

              {/* 免责与页脚声明 */}
              <div className="mt-5 pt-4 border-t border-slate-100 dark:border-zinc-800 text-[11px] leading-relaxed text-[#86868b] dark:text-zinc-500">
                <div className="mb-2 flex items-start gap-1">
                  <ShieldCheck size={12} className="flex-shrink-0 mt-0.5 text-slate-400" />
                  <span>{currentScenario.disclaimer}</span>
                </div>
                <div>
                  本邮件由 <span className="font-medium text-slate-700 dark:text-zinc-300">{displayAppName}</span> 自动发送。如不再需要提醒，请登录系统关闭对应规则。
                </div>
              </div>
            </div>
          </div>

          {/* 底部关闭与提示栏 */}
          <div className="px-5 py-3 bg-white dark:bg-zinc-900 border-t border-black/[0.06] dark:border-white/[0.08] flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-zinc-500">
              <Sparkles size={12} className="text-blue-500" />
              <span>应用名与发件人实时响应，所见即所得</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-full text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 transition-colors cursor-pointer"
            >
              完成预览
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}
