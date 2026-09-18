import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Tag,
  Button,
  Spin,
  Empty,
  Modal,
  message,
  Input,
  Select,
} from 'antd';
import {
  Landmark,
  ShieldCheck,
  Zap,
  TrendingUp,
  RefreshCw,
  Plus,
  Check,
  Sparkles,
  LineChart,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Search,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  Scale,
  DollarSign,
  PieChart,
  FileText,
  Clock,
} from 'lucide-react';
import {
  fetchBankStocksOverview,
  fetchBankStocksList,
  fetchBankMacroNews,
  diagnoseBankStock,
  addWatchlistItem,
  type BankStockItem,
  type BankOverview,
  type BankMacroNews,
  type BankAiDiagnoseResult,
} from '../services/api';

interface BankStocksTabProps {
  currentUser?: string;
  onOpenDetail?: (
    code: string,
    market: 'domestic' | 'hk' | 'us' | 'other',
    kind?: 'fund' | 'stock',
    initialData?: any
  ) => void;
}

const TIER_OPTIONS = [
  { key: 'all', label: '全部稳健资产', icon: <Layers className="w-4 h-4" /> },
  { key: 't0_cash', label: 'T+0 场内活钱', icon: <Zap className="w-4 h-4 text-amber-500" />, desc: '盘中可用·保本稳健' },
  { key: 'national', label: '国有六大行', icon: <Landmark className="w-4 h-4 text-blue-500" />, desc: '主权底仓·高股息' },
  { key: 'commercial', label: '优质股份行', icon: <Scale className="w-4 h-4 text-purple-500" />, desc: '零售壁垒·估值弹性' },
  { key: 'regional', label: '区域高成长', icon: <TrendingUp className="w-4 h-4 text-emerald-500" />, desc: '极低不良·超厚拨备' },
  { key: 'etf', label: '银行/红利 ETF', icon: <PieChart className="w-4 h-4 text-indigo-500" />, desc: '一篮子分散·防暴雷' },
  { key: 'hk', label: '港股高息折价', icon: <DollarSign className="w-4 h-4 text-rose-500" />, desc: 'AH实时折价·扣税后精算' },
];

/**
 * 内联文本格式化：将 **重点词** 渲染为 <strong> 标签并去除生硬的星号
 */
function FormattedInlineText({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={idx} className="font-semibold text-slate-900 dark:text-slate-100">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </>
  );
}

interface ParsedDiagnosisSection {
  title: string;
  content: string;
  type: 'dividend' | 'credit' | 'mechanism' | 'default';
}

function parseDiagnosis(raw: string): { intro?: string; sections: ParsedDiagnosisSection[] } {
  if (!raw) return { sections: [] };
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let intro = '';
  const sections: ParsedDiagnosisSection[] = [];
  let currentSection: ParsedDiagnosisSection | null = null;

  for (const line of lines) {
    // 匹配如: **1. 【分红确定性与股息安全垫】**: 内容 或 **1. 【...】** 内容 或 1. 【...】
    const match = line.match(/^(?:\*\*)?(?:[1-3一二三]\s*[.、\s]*)?【([^】]+)】(?:\*\*)?[:：]?\s*(.*)/);
    if (match) {
      if (currentSection) sections.push(currentSection);
      const title = match[1].trim();
      let type: ParsedDiagnosisSection['type'] = 'default';
      if (/分红|股息|现金流/.test(title)) {
        type = 'dividend';
      } else if (/信贷|资产质量|抗风险|底线|不良|拨备/.test(title)) {
        type = 'credit';
      } else if (/交易|机制|流动性|风险提示|交收|规则|税/.test(title)) {
        type = 'mechanism';
      }
      currentSection = {
        title,
        content: match[2]?.trim() || '',
        type,
      };
    } else if (currentSection) {
      currentSection.content = currentSection.content
        ? `${currentSection.content}\n${line}`
        : line;
    } else {
      // 导言或前置总结：剔除前后 ** 和冒号
      const cleanLine = line.replace(/^\*\*|\*\*$/g, '').replace(/[:：]$/, '').trim();
      if (cleanLine) {
        intro = intro ? `${intro} · ${cleanLine}` : cleanLine;
      }
    }
  }
  if (currentSection) sections.push(currentSection);

  // 如果大模型未按规范结构输出，优雅降级为单卡片渲染
  if (sections.length === 0 && raw.trim()) {
    sections.push({
      title: '标的客观深度诊断研报',
      content: raw.trim(),
      type: 'default',
    });
  }

  return { intro, sections };
}

const SPRING = {
  default: { type: 'spring' as const, bounce: 0, duration: 0.32 },
  card: { type: 'spring' as const, bounce: 0.06, duration: 0.38 },
  stagger: 0.08,
};

const AI_STEPS = [
  { icon: '🔍', text: '正在调取历史中报分红、股息率基准与红利税负...' },
  { icon: '🛡️', text: '正在核算信贷资产质量、不良率与拨备安全边际...' },
  { icon: '✨', text: '大模型多维客观严谨推演完成，正在结构化排版研报...' },
];

function AiDiagnosisSkeleton() {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setStepIdx(1), 1200);
    const t2 = setTimeout(() => setStepIdx(2), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const currentStep = AI_STEPS[stepIdx];

  return (
    <div className="space-y-3">
      {/* 动态步骤探针栏 */}
      <div className="flex items-center justify-between text-xs px-3.5 py-2.5 bg-indigo-50/80 dark:bg-indigo-950/40 rounded-xl border border-indigo-100 dark:border-indigo-900/50 text-indigo-700 dark:text-indigo-300">
        <div className="flex items-center gap-2">
          <span className="animate-spin text-sm">⚙️</span>
          <span className="font-medium animate-pulse">{currentStep.icon} {currentStep.text}</span>
        </div>
        <span className="text-[10px] font-mono text-indigo-500/80">{stepIdx + 1}/3 步</span>
      </div>

      {/* 3 张 1:1 预占位骨架卡片（高度与真实成稿 1:1 匹配，消除高度跳跃） */}
      {[
        { titleWidth: 'w-36', tagWidth: 'w-16', color: 'border-emerald-100/70 dark:border-emerald-950/40 bg-emerald-50/20' },
        { titleWidth: 'w-44', tagWidth: 'w-20', color: 'border-blue-100/70 dark:border-blue-950/40 bg-blue-50/20' },
        { titleWidth: 'w-40', tagWidth: 'w-24', color: 'border-amber-100/70 dark:border-amber-950/40 bg-amber-50/20' },
      ].map((sk, i) => (
        <div
          key={i}
          className={`p-3.5 rounded-xl border ${sk.color} space-y-2.5 animate-pulse`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-slate-200 dark:bg-slate-700" />
              <div className={`h-4 rounded-md bg-slate-200 dark:bg-slate-700 ${sk.titleWidth}`} />
            </div>
            <div className={`h-4 rounded-md bg-slate-200/80 dark:bg-slate-700/80 ${sk.tagWidth}`} />
          </div>
          <div className="space-y-1.5 pl-1">
            <div className="h-3.5 rounded bg-slate-200/60 dark:bg-slate-700/60 w-full" />
            <div className="h-3.5 rounded bg-slate-200/60 dark:bg-slate-700/60 w-[92%]" />
            <div className="h-3.5 rounded bg-slate-200/60 dark:bg-slate-700/60 w-[78%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AiDiagnosisView({ text }: { text: string }) {
  const prefersReducedMotion = useReducedMotion();
  const { intro, sections } = useMemo(() => parseDiagnosis(text), [text]);

  const SECTION_THEMES = {
    dividend: {
      icon: <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />,
      badge: '分红与股息',
      badgeClass: 'bg-emerald-100/90 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-200/80 dark:border-emerald-800/60',
      cardClass: 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-100/80 dark:border-emerald-900/40',
    },
    credit: {
      icon: <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" />,
      badge: '资产底线与风控',
      badgeClass: 'bg-blue-100/90 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border-blue-200/80 dark:border-blue-800/60',
      cardClass: 'bg-blue-50/50 dark:bg-blue-950/20 border-blue-100/80 dark:border-blue-900/40',
    },
    mechanism: {
      icon: <Scale className="w-4 h-4 text-amber-600 dark:text-amber-400" />,
      badge: '交易机制与流动性',
      badgeClass: 'bg-amber-100/90 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-200/80 dark:border-amber-800/60',
      cardClass: 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-100/80 dark:border-amber-900/40',
    },
    default: {
      icon: <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />,
      badge: '深度体检',
      badgeClass: 'bg-indigo-100/90 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-300 border-indigo-200/80 dark:border-indigo-800/60',
      cardClass: 'bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-100/80 dark:border-indigo-900/40',
    },
  };

  return (
    <div className="space-y-2.5">
      {intro && (
        <motion.div
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING.card, delay: 0.04 }}
          className="text-xs font-semibold text-slate-700 dark:text-slate-300 px-3.5 py-2 bg-slate-100/80 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60 flex items-center gap-2"
        >
          <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="leading-snug"><FormattedInlineText text={intro} /></span>
        </motion.div>
      )}

      <div className="space-y-2.5">
        {sections.map((sec, idx) => {
          const theme = SECTION_THEMES[sec.type] || SECTION_THEMES.default;
          return (
            <motion.div
              key={idx}
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                ...SPRING.card,
                delay: prefersReducedMotion ? 0 : 0.08 + idx * SPRING.stagger,
              }}
              className={`p-3.5 rounded-xl border ${theme.cardClass} shadow-2xs space-y-2 transition-all`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="p-1 rounded-lg bg-white dark:bg-slate-900 shadow-2xs shrink-0">
                    {theme.icon}
                  </div>
                  <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                    <FormattedInlineText text={sec.title} />
                  </h4>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border whitespace-nowrap shrink-0 ${theme.badgeClass}`}>
                  {theme.badge}
                </span>
              </div>

              <div className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed pl-1 whitespace-pre-line">
                <FormattedInlineText text={sec.content} />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

export function BankStocksTab({ onOpenDetail }: BankStocksTabProps) {
  const prefersReducedMotion = useReducedMotion();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [overview, setOverview] = useState<BankOverview | null>(null);
  const [stocks, setStocks] = useState<BankStockItem[]>([]);
  const [news, setNews] = useState<BankMacroNews[]>([]);
  const [selectedTier, setSelectedTier] = useState<string>('all');
  const [searchText, setSearchText] = useState<string>('');
  const [sortBy, setSortBy] = useState<string>('dividendYield');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [showNoticeBanner, setShowNoticeBanner] = useState(true);
  const [addedMap, setAddedMap] = useState<Record<string, boolean>>({});

  // AI 诊断弹窗状态
  const [diagnoseModalOpen, setDiagnoseModalOpen] = useState(false);
  const [diagnosingStock, setDiagnosingStock] = useState<BankStockItem | null>(null);
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<BankAiDiagnoseResult | null>(null);

  // 加载全量数据
  const loadData = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);

    try {
      const [overviewRes, listRes, newsRes] = await Promise.allSettled([
        fetchBankStocksOverview(),
        fetchBankStocksList('all', sortBy, sortOrder),
        fetchBankMacroNews(),
      ]);

      if (overviewRes.status === 'fulfilled' && overviewRes.value.success) {
        setOverview(overviewRes.value.data);
      }
      if (listRes.status === 'fulfilled' && listRes.value.success) {
        setStocks(listRes.value.data);
      }
      if (newsRes.status === 'fulfilled' && newsRes.value.success) {
        setNews(newsRes.value.data);
      }
    } catch (err: any) {
      message.error('加载银行红利数据失败: ' + (err.message || '未知错误'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sortBy, sortOrder]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 加入自选
  const handleAddToWatchlist = async (stock: BankStockItem) => {
    try {
      const res = await addWatchlistItem({
        code: stock.code,
        kind: 'stock',
        market: stock.market,
      });
      if (res.success) {
        setAddedMap(prev => ({ ...prev, [stock.code]: true }));
        message.success(`已将 ${stock.name} (${stock.code}) 加入自选！`);
      } else {
        message.info(res.message || '已在自选列表中');
      }
    } catch (err: any) {
      message.error('加入自选失败: ' + err.message);
    }
  };

  // 发起 AI 深度体检
  const handleOpenDiagnose = async (stock: BankStockItem) => {
    setDiagnosingStock(stock);
    setDiagnoseResult(null);
    setDiagnoseModalOpen(true);
    setDiagnoseLoading(true);

    try {
      const result = await diagnoseBankStock({
        code: stock.code,
        name: stock.name,
        market: stock.market,
      });
      if (result.success) {
        setDiagnoseResult(result);
      } else {
        message.warning('诊断生成遇到异常，请稍后重试');
      }
    } catch (err: any) {
      message.error('AI 诊断失败: ' + (err.message || '未知网络错误'));
    } finally {
      setDiagnoseLoading(false);
    }
  };

  // 搜索过滤与跨分类智能联动
  const { filteredStocks, isCrossTierMatch } = useMemo(() => {
    const q = searchText.trim().toLowerCase();

    // 如果未输入搜索词，按当前选中 Tab 过滤
    if (!q) {
      const list = selectedTier === 'all' ? stocks : stocks.filter(s => s.tier === selectedTier);
      return { filteredStocks: list, isCrossTierMatch: false };
    }

    const matcher = (s: BankStockItem) =>
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      (s.feederCodes && s.feederCodes.some(c => c.toLowerCase().includes(q))) ||
      (s.feederDesc && s.feederDesc.toLowerCase().includes(q)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(q)));

    // 1. 先在当前分类内搜索
    const currentTierList = selectedTier === 'all' ? stocks : stocks.filter(s => s.tier === selectedTier);
    const matchesInCurrent = currentTierList.filter(matcher);

    if (matchesInCurrent.length > 0 || selectedTier === 'all') {
      return { filteredStocks: matchesInCurrent, isCrossTierMatch: false };
    }

    // 2. 当前分类无结果时，自动跨全量分类检索
    const matchesInAll = stocks.filter(matcher);
    return { filteredStocks: matchesInAll, isCrossTierMatch: matchesInAll.length > 0 };
  }, [stocks, selectedTier, searchText]);

  return (
    <div className="space-y-5 pb-16 max-w-7xl mx-auto px-2 sm:px-4">
      {/* 1. 顶部 Header 与操作 */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-2xl sm:text-3xl">🏦</span>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
                银行·稳健红利专区
              </h1>
              <span className="px-2.5 py-0.5 text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800 rounded-full">
                金融精算级量化 + 配置大模型诊断
              </span>
            </div>
            <p className="mt-2 text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              立足金融投资常识与多维客观准则，区分 A 股免税与港股通 20% 红利税实得收益，动态计算 AH 实时折溢价，覆盖国有大行底仓、优质股份行、区域城商行与 T+0 场内货币工具。
            </p>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto shrink-0">
            <Button
              icon={<RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />}
              onClick={() => loadData(true)}
              loading={refreshing}
              className="rounded-xl flex items-center gap-1.5 border-slate-300 dark:border-slate-700 dark:text-slate-200 hover:border-emerald-500"
            >
              刷新行情与汇率
            </Button>
          </div>
        </div>

        {/* 2. 专业金融常识客观审视与防误导 Banner */}
        <div className="mt-4 border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 rounded-xl p-3.5 transition-all">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400 font-semibold text-xs sm:text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>专业金融常识与流动性关键辨析（拒绝盲目迎合）</span>
            </div>
            <button
              onClick={() => setShowNoticeBanner(!showNoticeBanner)}
              className="text-xs text-amber-700 dark:text-amber-400 hover:underline flex items-center gap-1 cursor-pointer"
            >
              {showNoticeBanner ? (
                <>收起辨析 <ChevronUp className="w-3.5 h-3.5" /></>
              ) : (
                <>展开辨析 <ChevronDown className="w-3.5 h-3.5" /></>
              )}
            </button>
          </div>

          {showNoticeBanner && (
            <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-amber-900 dark:text-amber-300/90 leading-relaxed">
              <div className="flex items-start gap-1.5">
                <span className="font-bold shrink-0">① 股票非保本：</span>
                <span>二级市场股价每日波动，极端行情下分红收益无法完全覆盖本金浮亏，严禁等同于保本存款。</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="font-bold shrink-0">② 港股通 20% 红利税：</span>
                <span>港股名义股息虽达 6.5%~7%，但内地个人通过港股通强制扣除 20% 红利税，到手实得约 5.2%~5.6%，本专区已做实得换算。</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="font-bold shrink-0">③ 资金可用 ≠ 可转出：</span>
                <span>T+0 货币 ETF 卖出后盘中在证券账户即刻可用；提现到银行卡受银证转账交易时段（工作日 9:00~16:00）约束，夜间与非交易日无法提现。</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="font-bold shrink-0">④ 货基机制差异：</span>
                <span>华宝添益（面值100元按日结转份额）与银华日利（净值累加年末集中除权分红）机制不同，二级市场买卖存在微小贴水波动。</span>
              </div>
              <div className="flex items-start gap-1.5 md:col-span-2">
                <span className="font-bold shrink-0">⑤ 财报报告期时间戳：</span>
                <span>不良贷款率、拨备覆盖率均按上市公司季报统一公布（当前为 2024 中报基准），不随二级市场日频刷新。</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. 板块估值与晴雨表温度计（双重视角：算术平均 vs 市值加权） */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm relative overflow-hidden">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>行业平均股息率</span>
              <DollarSign className="w-4 h-4 text-emerald-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                {overview.sectorAvgDividendYield}%
              </span>
              <span className="text-xs text-slate-400">算术均值</span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              市值加权: <strong className="font-mono text-slate-700 dark:text-slate-300">{overview.sectorWeightedDividendYield}%</strong>（大行权重高）
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm relative overflow-hidden">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>板块市净率 (PB)</span>
              <Scale className="w-4 h-4 text-blue-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-bold text-blue-600 dark:text-blue-400 font-mono">
                {overview.sectorAvgPb}
              </span>
              <span className="text-xs text-slate-400">倍 (样本均值)</span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              市值加权 PB: <strong className="font-mono text-slate-700 dark:text-slate-300">{overview.sectorWeightedPb}倍</strong>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm relative overflow-hidden">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>破净银行比例</span>
              <ShieldCheck className="w-4 h-4 text-purple-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-bold text-purple-600 dark:text-purple-400 font-mono">
                {overview.brokenNetRatio}%
              </span>
              <span className="text-xs text-slate-400 font-mono">({overview.brokenNetCount}只破净)</span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500"></span>
              资产价格深度折价交易
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm relative overflow-hidden">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>今日跟踪与汇率</span>
              <TrendingUp className="w-4 h-4 text-amber-500" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-rose-500 font-mono">
                ↑{overview.upCount}
              </span>
              <span className="text-xs font-semibold text-emerald-500 font-mono">
                ↓{overview.downCount}
              </span>
              <span className="text-xs font-semibold text-slate-400 font-mono">
                -{overview.flatCount}
              </span>
              <span className="text-[11px] text-slate-400 font-mono border-l border-slate-200 dark:border-slate-700 pl-2">
                汇率 {overview.hkdCnyRate ? overview.hkdCnyRate.toFixed(4) : '0.8550'}
              </span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-400" />
              <span>更新时间: {overview.updateTime}</span>
            </div>
          </div>
        </div>
      )}

      {/* 4. 分类梯队切换与搜索排序 */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm space-y-4">
        {/* 梯队胶囊导航 */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
          {TIER_OPTIONS.map(opt => {
            const isSelected = selectedTier === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setSelectedTier(opt.key)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-slate-900 text-white dark:bg-emerald-600 dark:text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700/80'
                }`}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>

        {/* 搜索与排序栏 */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <Input
              placeholder="搜索标的（如 招行、银华日利、601398、007467联接、AH折价...）"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              allowClear
              className="pl-9 rounded-xl border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">排序:</span>
            <Select
              value={sortBy}
              onChange={val => setSortBy(val)}
              className="w-36"
              options={[
                { value: 'dividendYield', label: '名义股息率' },
                { value: 'afterTaxDividendYield', label: '税后实得股息率' },
                { value: 'stabilityScore', label: '综合稳健度' },
                { value: 'pb', label: '市净率 PB' },
                { value: 'price', label: '当前股价' },
                { value: 'changePct', label: '今日涨跌幅' },
              ]}
            />
            <Button
              size="small"
              onClick={() => setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))}
              className="rounded-lg text-xs"
            >
              {sortOrder === 'desc' ? '降序 ↓' : '升序 ↑'}
            </Button>
          </div>
        </div>
      </div>

      {/* 跨分类搜索智能提示 */}
      {isCrossTierMatch && (
        <div className="flex items-center justify-between text-xs bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-xl px-4 py-2.5 shadow-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-base">💡</span>
            <span>当前分类下未找到，已自动为您检索并呈现全量资产库中的匹配标的</span>
          </div>
          <button
            onClick={() => setSelectedTier('all')}
            className="underline font-semibold cursor-pointer hover:text-indigo-900 dark:hover:text-indigo-200"
          >
            切换到全部分类
          </button>
        </div>
      )}

      {/* 5. 标的资产矩阵列表 */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <Spin size="large" />
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">正在拉取全市场银行实时报价与精算财报指标...</p>
        </div>
      ) : filteredStocks.length === 0 ? (
        <div className="py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 text-center shadow-sm">
          <Empty description="未找到符合条件的标的" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredStocks.map(stock => {
            const isAdded = !!addedMap[stock.code];
            const isUp = stock.changePct > 0;
            const isDown = stock.changePct < 0;
            const isT0 = stock.tier === 't0_cash';
            const isHk = stock.tier === 'hk';
            const isEtf = stock.tier === 'etf';
            const isLowPrice = isT0 || isEtf || (stock.price > 0 && stock.price < 5.0);

            return (
              <div
                key={stock.symbol}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-emerald-500/50 dark:hover:border-emerald-500/40 rounded-2xl p-4 sm:p-5 shadow-sm hover:shadow-md transition-all flex flex-col justify-between group"
              >
                <div>
                  {/* 卡片头部 */}
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="cursor-pointer"
                      onClick={() => onOpenDetail?.(
                        stock.code,
                        stock.market,
                        stock.isFund ? 'fund' : 'stock',
                        {
                          name: stock.name,
                          dwjz: String(stock.price),
                          gsz: String(stock.price),
                          gszzl: String(stock.changePct),
                          gztime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                          market: stock.market,
                        }
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-base sm:text-lg text-slate-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                          {stock.name}
                        </span>
                        <span className="text-xs font-mono text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                          {stock.code}
                        </span>
                        {isHk && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400">
                            HK 港股通
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        <Tag color={isT0 ? 'gold' : isHk ? 'magenta' : 'blue'} className="text-[11px] rounded-md m-0">
                          {stock.tierName}
                        </Tag>
                        {stock.riskLevel && (
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            {stock.riskLevel}
                          </span>
                        )}
                        {stock.reportPeriod && (
                          <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-400">
                            {stock.reportPeriod}
                          </span>
                        )}
                        {stock.dividendFrequency && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/50">
                            💰 {stock.dividendFrequency}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 右侧价格与涨跌（自适应 3 位毫厘精度） */}
                    <div className="text-right shrink-0">
                      <div className="text-lg sm:text-xl font-bold font-mono text-slate-900 dark:text-white">
                        {stock.price > 0 ? (
                          <>
                            {isHk ? 'HK$' : '¥'}{stock.price.toFixed(isLowPrice ? 3 : 2)}
                          </>
                        ) : (
                          '--'
                        )}
                      </div>
                      <div
                        className={`text-xs font-mono font-semibold flex items-center justify-end gap-0.5 ${
                          isUp ? 'text-rose-500' : isDown ? 'text-emerald-500' : 'text-slate-400'
                        }`}
                      >
                        {isUp ? <ArrowUpRight className="w-3.5 h-3.5" /> : isDown ? <ArrowDownRight className="w-3.5 h-3.5" /> : null}
                        <span>{isUp ? '+' : ''}{stock.changePct.toFixed(2)}%</span>
                      </div>
                    </div>
                  </div>

                  {/* 核心指标矩阵（金融专业口径展示：ETF 专属实时折溢价率替换空置 PB） */}
                  <div className="mt-4 grid grid-cols-3 gap-2 bg-slate-50 dark:bg-slate-800/60 rounded-xl p-2.5 text-center">
                    <div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-400">
                        {isT0 ? '参考年化' : isHk ? '税后实得股息' : '静态股息率'}
                      </div>
                      <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 font-mono mt-0.5">
                        {isHk
                          ? `${stock.afterTaxDividendYield.toFixed(2)}%`
                          : stock.dividendYield > 0
                          ? `${stock.dividendYield.toFixed(2)}%`
                          : '--'}
                      </div>
                      <div className="text-[9px] text-slate-400 mt-0.5">
                        {isHk
                          ? `税前: ${stock.dividendYield.toFixed(2)}%`
                          : isT0
                          ? '每日计息'
                          : '持股>1年免税'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-400">
                        {isT0 ? '交易机制' : isHk ? 'AH实时折价' : isEtf ? '实时折溢价' : '市净率 (PB)'}
                      </div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono mt-0.5">
                        {isT0 ? (
                          <span className="text-amber-600 dark:text-amber-400 font-semibold">T+0 回转</span>
                        ) : isHk ? (
                          <span className="text-rose-600 dark:text-rose-400 font-mono">
                            {stock.discountRate !== null && stock.discountRate !== undefined
                              ? `${stock.discountRate}%`
                              : '--'}
                          </span>
                        ) : isEtf ? (
                          <span className={`font-mono ${
                            stock.premiumRate != null && stock.premiumRate < 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : stock.premiumRate != null && stock.premiumRate > 0
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}>
                            {stock.premiumRate != null
                              ? `${stock.premiumRate >= 0 ? '+' : ''}${stock.premiumRate.toFixed(2)}%`
                              : stock.iopv
                              ? `¥${stock.iopv.toFixed(3)}`
                              : '--'}
                          </span>
                        ) : stock.pb ? (
                          <span className={stock.pb < 1.0 ? 'text-blue-600 dark:text-blue-400' : ''}>
                            {stock.pb}倍
                          </span>
                        ) : (
                          '--'
                        )}
                      </div>
                      <div className="text-[9px] text-slate-400 mt-0.5">
                        {isT0
                          ? '盘中可用'
                          : isHk
                          ? '折算汇率动态'
                          : isEtf
                          ? stock.premiumRate != null && stock.premiumRate < -0.1
                            ? '场内折价'
                            : stock.premiumRate != null && stock.premiumRate > 0.1
                            ? '场内溢价'
                            : '平价交易'
                          : stock.pb && stock.pb < 1.0
                          ? '深度破净'
                          : '估值安全'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-400">
                        {isT0 ? '提现时间' : stock.nplRatio ? '不良贷款率' : '综合稳健度'}
                      </div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono mt-0.5">
                        {isT0 ? (
                          <span className="text-xs text-slate-700 dark:text-slate-300">限9-16点</span>
                        ) : stock.nplRatio ? (
                          <span className={stock.nplRatio < 1.0 ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                            {stock.nplRatio}%
                          </span>
                        ) : (
                          `${stock.stabilityScore}分`
                        )}
                      </div>
                      <div className="text-[9px] text-slate-400 mt-0.5">
                        {isT0 ? (
                          '银证转账约束'
                        ) : stock.provisionCoverage ? (
                          `拨备 ${stock.provisionCoverage}%`
                        ) : (
                          '多因子打分'
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 核心亮点与运作机制 */}
                  <div className="mt-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-2">
                    {stock.advantage || '长期稳健分红，具备较厚估值安全边际。'}
                  </div>

                  {/* ETF 跨市场套利与建仓决策指引 */}
                  {stock.arbitrageAdvice && (
                    <div className={`mt-2 text-[11px] px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 ${
                      stock.arbitrageAdvice.type === 'discount'
                        ? 'bg-emerald-50/90 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 border border-emerald-200/80 dark:border-emerald-800/50'
                        : stock.arbitrageAdvice.type === 'premium'
                        ? 'bg-amber-50/90 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/50'
                        : 'bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-slate-800'
                    }`}>
                      <span>💡 决策提示：{stock.arbitrageAdvice.text}</span>
                    </div>
                  )}

                  {/* 针对货基或港股的专业机制提示 */}
                  {isT0 && stock.fundMechanism && (
                    <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-400/90 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1 rounded-lg">
                      💡 机制：{stock.fundMechanism}
                    </div>
                  )}
                  {isHk && stock.taxNote && (
                    <div className="mt-2 text-[11px] text-rose-700 dark:text-rose-400/90 bg-rose-50/60 dark:bg-rose-950/20 px-2 py-1 rounded-lg">
                      ⚠️ 税负：{stock.taxNote}
                    </div>
                  )}
                  {/* 场外联接基金交互区域（外显盘中实时估值净值、A/C 份额持有期精算平衡点与分时联动） */}
                  {stock.feederCodes && stock.feederCodes.length > 0 && (
                    <div className="mt-2.5 p-3 bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40 rounded-xl space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-indigo-800 dark:text-indigo-300 flex items-center gap-1.5">
                          <span>🔗 关联场外公募基金</span>
                          <span className="text-[10px] font-normal text-indigo-600 dark:text-indigo-400 bg-indigo-100/80 dark:bg-indigo-900/60 px-1.5 py-0.2 rounded">
                            {isT0 ? '货币基金' : '穿透实时估值'}
                          </span>
                        </span>
                        <span className="text-[10px] text-indigo-500/80">
                          {isT0 ? '每日计息·无日内分时' : '点击查看场外估算分时'}
                        </span>
                      </div>
                      {isT0 ? (
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          场外关联代码：{stock.feederCodes.join(' / ')}（收益按日结算，不随盘中价格波动）
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1.5">
                            {stock.feederCodes.map((fCode) => {
                              const valuation = stock.feederValuations?.find(v => v.code === fCode);
                              const isClassC = valuation?.shareClass === 'C'
                                || /([cC]类?|联接[cC])$/i.test(valuation?.name || '')
                                || /([cC]类?|联接[cC])/i.test(valuation?.name || '')
                                || fCode === '007467' || fCode === '001594' || fCode === '011531';
                              const shareClassLabel = isClassC ? 'C类·短波段' : 'A类·长定投';
                              const isValUp = (valuation?.gszzlNum ?? 0) > 0;
                              const isValDown = (valuation?.gszzlNum ?? 0) < 0;
                              const breakevenTip = isClassC
                                ? '持有 ≤ 160天更优 (0申购费·满7天免赎)'
                                : '持有 > 160天更优 (长期无销售服务费)';

                              return (
                                <div
                                  key={fCode}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenDetail?.(fCode, 'domestic', 'fund');
                                  }}
                                  className="p-2.5 rounded-xl bg-white dark:bg-slate-900/90 border border-indigo-100 dark:border-indigo-900/60 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-xs transition-all cursor-pointer group flex flex-col gap-1.5"
                                >
                                  {/* 第一行：代码 + 标签 + 实时净值与涨跌 + 分时按钮 */}
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="font-mono text-xs font-bold text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                                        {fCode}
                                      </span>
                                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${
                                        isClassC
                                          ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                                          : 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                                      }`}>
                                        {shareClassLabel}
                                      </span>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                      {valuation ? (
                                        <div className="flex items-center gap-1.5 font-mono text-xs font-semibold">
                                          <span className="text-slate-800 dark:text-slate-200">
                                            {valuation.gsz}
                                          </span>
                                          <span className={`text-[11px] ${
                                            isValUp ? 'text-rose-500' : isValDown ? 'text-emerald-500' : 'text-slate-400'
                                          }`}>
                                            {valuation.gszzl}
                                          </span>
                                        </div>
                                      ) : (
                                        <span className="text-[10px] text-slate-400">实时估值中...</span>
                                      )}
                                      <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 text-[10px] font-medium flex items-center gap-0.5 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                                        分时 <ArrowUpRight className="w-2.5 h-2.5" />
                                      </span>
                                    </div>
                                  </div>

                                  {/* 第二行：持有期量化平衡点建议与合规惩罚费提示 */}
                                  <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-1 pt-1 border-t border-slate-100 dark:border-slate-800/80">
                                    <div className="flex items-center gap-1 min-w-0 truncate">
                                      <span>⏱️</span>
                                      <span className="truncate">{valuation?.breakevenAdvice || breakevenTip}</span>
                                    </div>
                                    <span className="text-[9px] font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 px-1 py-0.2 rounded shrink-0 border border-rose-200/60 dark:border-rose-900/50">
                                      &lt;7天惩罚费1.5%
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-[10px] text-indigo-700/80 dark:text-indigo-400/80 leading-normal flex items-start gap-1">
                            <span className="shrink-0">💡</span>
                            <span>规则提示：场外申赎按当日 15:00 净值未知价交收；非货基持有少于 7 日强制扣除不低于 1.5% 赎回费并计入基金财产。</span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {stock.tags && stock.tags.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {stock.tags.map((t, idx) => (
                        <span
                          key={idx}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 卡片底部操作按钮 */}
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="small"
                      type="default"
                      icon={<Sparkles className="w-3.5 h-3.5 text-indigo-500" />}
                      onClick={() => handleOpenDiagnose(stock)}
                      className="rounded-lg text-xs flex items-center gap-1 dark:border-slate-700 dark:text-slate-300 hover:border-indigo-500 hover:text-indigo-500"
                    >
                      AI 体检
                    </Button>
                    <Button
                      size="small"
                      type="default"
                      icon={<LineChart className="w-3.5 h-3.5 text-blue-500" />}
                      onClick={() => onOpenDetail?.(
                        stock.code,
                        stock.market,
                        stock.isFund ? 'fund' : 'stock',
                        {
                          name: stock.name,
                          dwjz: String(stock.price),
                          gsz: String(stock.price),
                          gszzl: String(stock.changePct),
                          gztime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                          market: stock.market,
                        }
                      )}
                      className="rounded-lg text-xs flex items-center gap-1 dark:border-slate-700 dark:text-slate-300 hover:border-blue-500 hover:text-blue-500"
                    >
                      分时
                    </Button>
                  </div>

                  <Button
                    size="small"
                    type={isAdded ? 'dashed' : 'primary'}
                    icon={isAdded ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    onClick={() => handleAddToWatchlist(stock)}
                    disabled={isAdded}
                    className={`rounded-lg text-xs flex items-center gap-1 ${
                      isAdded
                        ? 'text-slate-400 dark:text-slate-500 border-slate-300 dark:border-slate-700'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {isAdded ? '已在自选' : '加自选'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 6. 宏观政策与银行行业观察 */}
      {news.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-500" />
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              银行业宏观资讯与政策动向（客观研判）
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {news.map(n => (
              <div
                key={n.id}
                className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3.5 border border-slate-200/80 dark:border-slate-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <Tag color="blue" className="text-[11px] rounded m-0">
                    {n.category}
                  </Tag>
                  <span className="text-[11px] text-slate-400">{n.time}</span>
                </div>
                <h3 className="mt-2 text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-200 leading-snug">
                  {n.title}
                </h3>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {n.summary}
                </p>
                <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <span>💡 客观影响:</span>
                  <span>{n.impact}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 7. AI 深度体检诊断弹窗 */}
      <Modal
        title={
          <div className="flex items-center gap-2 text-slate-900 dark:text-white">
            <Sparkles className="w-5 h-5 text-indigo-500" />
            <span>标的 AI 投资价值与风险体检</span>
          </div>
        }
        open={diagnoseModalOpen}
        onCancel={() => setDiagnoseModalOpen(false)}
        footer={[
          <Button key="close" onClick={() => setDiagnoseModalOpen(false)} className="rounded-xl">
            关闭
          </Button>,
          diagnosingStock && (
            <Button
              key="detail"
              type="primary"
              onClick={() => {
                const stock = diagnosingStock;
                // 1. 先启动弹窗平滑退出动画
                setDiagnoseModalOpen(false);
                // 2. 延迟 90ms 触发右侧抽屉滑入，让视线与遮罩从中心自然流向右侧抽屉，
                //    彻底消除两个重叠遮罩的瞬间抢占、页面滚动条抖动与闪黑现象！
                setTimeout(() => {
                  onOpenDetail?.(
                    stock.code,
                    stock.market,
                    stock.isFund ? 'fund' : 'stock',
                    {
                      name: stock.name,
                      dwjz: String(stock.price),
                      gsz: String(stock.price),
                      gszzl: String(stock.changePct),
                      gztime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                      market: stock.market,
                    }
                  );
                }, 90);
              }}
              className="rounded-xl bg-emerald-600 hover:bg-emerald-500 cursor-pointer"
            >
              查看实时分时/K线
            </Button>
          ),
        ]}
        width={680}
        className="dark-modal"
      >
        {diagnosingStock && (
          <div className="space-y-3.5 py-2">
            {/* 标的基本信息条 */}
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/70 rounded-2xl shadow-2xs">
              <div>
                <div className="text-base sm:text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>{diagnosingStock.name}</span>
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                    {diagnosingStock.code}
                  </span>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2">
                  <Tag color="blue" className="text-[11px] m-0 rounded-md">{diagnosingStock.tierName}</Tag>
                  <span>{diagnosingStock.tradeMechanism || 'A股 T+1'}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white font-mono">
                  {diagnosingStock.market === 'hk' ? 'HK$' : '¥'}{diagnosingStock.price.toFixed(
                    diagnosingStock.tier === 't0_cash' || diagnosingStock.tier === 'etf' || (diagnosingStock.price > 0 && diagnosingStock.price < 5.0) ? 3 : 2
                  )}
                </div>
                <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 font-mono mt-0.5">
                  税后实得股息率: {diagnosingStock.afterTaxDividendYield}%
                </div>
              </div>
            </div>

            {/* 诊断内容区域：平滑 Cross-Fade 动效与防高度抖动 */}
            <AnimatePresence mode="wait">
              {diagnoseLoading ? (
                <motion.div
                  key="skeleton"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                >
                  <AiDiagnosisSkeleton />
                </motion.div>
              ) : diagnoseResult ? (
                <motion.div
                  key="result"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.22 }}
                  className="space-y-3"
                >
                  {/* 模型与生成时间栏 */}
                  <div className="flex items-center justify-between text-xs px-3.5 py-2 bg-slate-50/80 dark:bg-slate-800/40 rounded-xl border border-slate-100 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span>分析引擎: <strong className="font-semibold text-slate-700 dark:text-slate-200">{diagnoseResult.model}</strong></span>
                      {diagnoseResult.isAiGenerated ? (
                        <Tag color="purple" className="text-[10px] m-0 rounded-md">大模型生成</Tag>
                      ) : (
                        <Tag color="blue" className="text-[10px] m-0 rounded-md">严谨量化专家规则</Tag>
                      )}
                    </div>
                    <span className="font-mono text-[11px]">生成时间: {diagnoseResult.generatedAt}</span>
                  </div>

                  {/* 结构化与去星号 Markdown 维度研报卡片（支持阶梯微弹簧进场） */}
                  <AiDiagnosisView text={diagnoseResult.diagnosis} />

                  {/* 客观合规提示 */}
                  <motion.div
                    initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...SPRING.card, delay: prefersReducedMotion ? 0 : 0.3 }}
                    className="p-3 bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/70 dark:border-amber-900/40 rounded-xl text-[11px] text-amber-800/90 dark:text-amber-400/90 leading-relaxed flex items-start gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5" />
                    <span>
                      客观合规提示：AI 诊断基于财报客观指标与宏观规则推演，仅供投资参考，不构成任何投资咨询或保本收益承诺。二级市场投资有风险，入市须谨慎。
                    </span>
                  </motion.div>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="py-12"
                >
                  <Empty description="未能生成诊断结果" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default BankStocksTab;
