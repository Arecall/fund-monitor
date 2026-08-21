import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Modal,
  Form,
  Input,
  Select,
  AutoComplete,
  Checkbox,
  Slider,
  Switch,
  Collapse,
  Tag,
  Tooltip,
  Empty,
  Spin,
  Progress,
  Popconfirm,
  message,
} from 'antd';
import {
  Sparkles,
  Settings,
  Zap,
  RefreshCw,
  Plus,
  TrendingUp,
  AlertTriangle,
  Flame,
  CheckCircle2,
  Clock,
  Layers,
  Trash2,
  LineChart,
  Target,
} from 'lucide-react';
import {
  fetchAiConfig,
  saveAiConfig,
  testAiConfig,
  startAiAnalysis,
  pollAiJob,
  fetchAiReports,
  fetchAiReportDetail,
  deleteAiReport,
  addWatchlistItem,
  type AiUserConfig,
  type AiStockPickReport,
  type AiStockRecommendation,
} from '../services/api';

interface AiStockPickTabProps {
  onOpenDetail?: (code: string, market: 'domestic' | 'hk' | 'us' | 'other') => void;
}

const STRATEGY_OPTIONS = [
  { value: 'balanced', label: '⚖️ 均衡配置 (兼顾价值安全边际与成长弹性)' },
  { value: 'growth', label: '🚀 高景气成长 (侧重科技突破与领涨龙头)' },
  { value: 'value', label: '💰 深度价值与红利 (低估值、高分红防守标的)' },
  { value: 'momentum', label: '🔥 动量突破 (主力资金大幅净流入与均线多头)' },
  { value: 'defensive', label: '🛡️ 稳健防御 (抗通胀、低波动抗跌核心资产)' },
];

const MODEL_PRESETS = [
  { value: 'claude-3-7-sonnet-20250219', label: 'claude-3-7-sonnet-20250219 (推荐·强推理)' },
  { value: 'claude-3-5-sonnet-20241022', label: 'claude-3-5-sonnet-20241022 (高精度)' },
  { value: 'claude-3-5-haiku-20241022', label: 'claude-3-5-haiku-20241022 (极速轻量)' },
  { value: 'claude-opus-4-5-20250501', label: 'claude-opus-4-5-20250501 (旗舰算力)' },
];

export function AiStockPickTab({ onOpenDetail }: AiStockPickTabProps) {
  const [config, setConfig] = useState<AiUserConfig | null>(null);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);

  const [reports, setReports] = useState<AiStockPickReport[]>([]);
  const [totalReports, setTotalReports] = useState(0);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
  const [currentReport, setCurrentReport] = useState<AiStockPickReport | null>(null);
  const [recommendations, setRecommendations] = useState<AiStockRecommendation[]>([]);
  const [loadingReportDetail, setLoadingReportDetail] = useState(false);

  // Analysis job state
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState<string>('');
  const [analyzing, setAnalyzing] = useState(false);

  // Added to watchlist feedback tracker
  const [addedMap, setAddedMap] = useState<Record<string, boolean>>({});

  // 1. Load User Config
  const loadConfig = useCallback(async () => {
    setLoadingConfig(true);
    try {
      const data = await fetchAiConfig();
      setConfig(data);
    } catch (err: any) {
      console.error('加载 AI 配置失败:', err);
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  // 2. Load Reports History
  const loadReports = useCallback(async (selectFirst = true) => {
    try {
      const data = await fetchAiReports(1, 10);
      setReports(data.reports);
      setTotalReports(data.total);

      if (selectFirst && data.reports.length > 0) {
        setSelectedReportId(data.reports[0].id);
      }
    } catch (err: any) {
      console.error('加载报告列表失败:', err);
    }
  }, []);

  // 3. Load Report Detail
  const loadReportDetail = useCallback(async (id: number) => {
    setLoadingReportDetail(true);
    try {
      const data = await fetchAiReportDetail(id);
      setCurrentReport(data.report);
      setRecommendations(data.recommendations);
    } catch (err: any) {
      message.error('加载报告详情失败: ' + err.message);
    } finally {
      setLoadingReportDetail(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadReports(true);
  }, [loadConfig, loadReports]);

  useEffect(() => {
    if (selectedReportId) {
      loadReportDetail(selectedReportId);
    } else {
      setCurrentReport(null);
      setRecommendations([]);
    }
  }, [selectedReportId, loadReportDetail]);

  // 4. Job Poller
  useEffect(() => {
    if (!activeJobId) return;

    const timer = setInterval(async () => {
      try {
        const res = await pollAiJob(activeJobId);
        setJobStage(res.stage);

        if (res.status === 'done') {
          clearInterval(timer);
          setActiveJobId(null);
          setAnalyzing(false);
          message.success('🎉 优质股票智能筛选完成！');
          await loadReports(false);
          if (res.reportId) {
            setSelectedReportId(res.reportId);
          }
        } else if (res.status === 'failed') {
          clearInterval(timer);
          setActiveJobId(null);
          setAnalyzing(false);
          message.error(`选股分析失败: ${res.error || '未知错误'}`);
          loadReports(false);
        }
      } catch (err) {
        // Continue polling
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [activeJobId, loadReports]);

  // 5. Trigger Immediate Analysis
  const handleStartAnalysis = async () => {
    if (!config?.configured) {
      message.warning('请先配置并保存 Anthropic API Key');
      setConfigModalOpen(true);
      return;
    }

    setAnalyzing(true);
    setJobStage('queued');
    try {
      const res = await startAiAnalysis();
      if (res.jobId) {
        setActiveJobId(res.jobId);
        message.loading({ content: '正在抓取全网热点与资金数据并调用 AI 推理...', key: 'ai-analyzing', duration: 3 });
      }
    } catch (err: any) {
      setAnalyzing(false);
      message.error(err.message || '发起分析任务失败');
    }
  };

  // 6. Add to watchlist
  const handleAddToWatchlist = async (rec: AiStockRecommendation) => {
    try {
      const res = await addWatchlistItem({
        code: rec.code,
        kind: 'stock',
        market: rec.market,
      });
      if (res.success) {
        setAddedMap(prev => ({ ...prev, [rec.code]: true }));
        message.success(`已将 ${rec.name} (${rec.code}) 加入自选！`);
      } else {
        message.info(res.message || '已在自选列表中');
      }
    } catch (err: any) {
      message.error('加入自选失败: ' + err.message);
    }
  };

  // 7. Delete report
  const handleDeleteReport = async (reportId: number) => {
    try {
      await deleteAiReport(reportId);
      message.success('报告已删除');
      const nextReports = reports.filter(r => r.id !== reportId);
      setReports(nextReports);
      if (selectedReportId === reportId) {
        setSelectedReportId(nextReports.length > 0 ? nextReports[0].id : null);
      }
    } catch (err: any) {
      message.error('删除报告失败: ' + err.message);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Top Header Card ── */}
      <section className="apple-card p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-500 text-white flex items-center justify-center shadow-md">
            <Sparkles size={22} className="animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="apple-display-heading text-lg font-bold text-slate-800 dark:text-slate-100">
                优质股票智能筛选
              </h2>
              <Tag color={config?.configured ? 'blue' : 'default'} className="rounded-full text-[10px] px-2">
                {config?.configured ? (
                  <span className="flex items-center gap-1 font-mono">
                    <CheckCircle2 size={10} /> {config.model_name.split('-')[1] || 'Claude'} 已连接
                  </span>
                ) : (
                  '未配置 API'
                )}
              </Tag>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              全网宏观大盘 · 热点领涨板块 · 主力资金动向 · 财经快讯与真实标的候选池深度推理
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end flex-wrap">
          <Button
            icon={<Settings size={14} />}
            onClick={() => setConfigModalOpen(true)}
            className="rounded-full text-xs font-semibold"
          >
            AI 接口配置
          </Button>

          <Button
            type="primary"
            icon={<Zap size={14} />}
            loading={analyzing}
            onClick={handleStartAnalysis}
            className="rounded-full text-xs font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-md"
          >
            {analyzing ? '智能选股分析中...' : '立即智能选股'}
          </Button>
        </div>
      </section>

      {/* ── Active Analysis Progress Card ── */}
      {analyzing && (
        <section className="apple-card p-5 border border-blue-200/60 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-bold text-blue-700 dark:text-blue-300">
              <Spin size="small" />
              <span>全网实时热点抓取与 AI 深度分析中</span>
            </div>
            <span className="text-[11px] font-mono text-blue-500 font-medium">
              {jobStage === 'context' && '正在拉取实时大盘、领涨板块与主力资金流向...'}
              {jobStage === 'prompting' && '正在构建防幻觉真实股票候选池...'}
              {jobStage === 'inferring' && 'Anthropic Messages API 正在进行多维度逻辑推理...'}
              {jobStage === 'parsing' && '正在解析校验推荐结果与风险提示...'}
              {(!jobStage || jobStage === 'queued') && '任务已入队，准备就绪...'}
            </span>
          </div>
          <Progress
            percent={
              jobStage === 'context' ? 30
                : jobStage === 'prompting' ? 50
                : jobStage === 'inferring' ? 80
                : jobStage === 'parsing' ? 95 : 15
            }
            status="active"
            strokeColor={{ '0%': '#108ee9', '100%': '#87d068' }}
            showInfo={false}
          />
        </section>
      )}

      {/* ── Main Content Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Left Column: History Reports List */}
        <div className="lg:col-span-1 flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <span className="apple-eyebrow flex items-center gap-1.5">
              <Clock size={13} className="text-slate-400" /> 分析历史 ({totalReports})
            </span>
            <Button
              type="text"
              size="small"
              icon={<RefreshCw size={12} />}
              onClick={() => loadReports(false)}
              className="text-slate-400 hover:text-slate-600 text-xs p-1"
            />
          </div>

          <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
            {reports.length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-xs border border-[var(--hairline-border)] rounded-2xl bg-white/40 dark:bg-white/[0.02]">
                暂无分析历史，点击上方“立即智能选股”生成首份研报。
              </div>
            ) : (
              reports.map(report => {
                const isSelected = selectedReportId === report.id;
                const triggerLabel =
                  report.trigger_type === 'pre_market' ? '盘前自动'
                    : report.trigger_type === 'close' ? '收盘前1h' : '手动分析';
                return (
                  <div
                    key={report.id}
                    onClick={() => setSelectedReportId(report.id)}
                    className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex flex-col gap-1.5 ${
                      isSelected
                        ? 'border-blue-500/80 bg-blue-50/70 dark:bg-blue-950/40 shadow-sm'
                        : 'border-[var(--hairline-border)] bg-white/60 dark:bg-white/[0.02] hover:bg-slate-50 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Tag
                        color={report.trigger_type === 'manual' ? 'blue' : 'purple'}
                        className="text-[10px] rounded-full px-2 m-0 font-medium"
                      >
                        {triggerLabel}
                      </Tag>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-slate-400 font-mono">
                          {report.created_at.slice(5, 16)}
                        </span>
                        <Popconfirm
                          title="确认删除该分析报告？"
                          onConfirm={(e) => {
                            e?.stopPropagation();
                            handleDeleteReport(report.id);
                          }}
                          onPopupClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            type="text"
                            size="small"
                            onClick={(e) => e.stopPropagation()}
                            icon={<Trash2 size={11} className="text-slate-300 hover:text-red-500" />}
                            className="p-0.5 h-auto"
                          />
                        </Popconfirm>
                      </div>
                    </div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center justify-between">
                      <span>推荐 {report.rec_count || report.stock_count || 5} 只标的</span>
                      <span className="text-[10px] text-slate-400 font-mono">{report.markets.join('/')}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Recommendations Stream */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          {loadingReportDetail ? (
            <div className="apple-card p-16 flex flex-col items-center justify-center gap-3">
              <Spin size="large" tip="正在加载推荐研报..." />
            </div>
          ) : !currentReport ? (
            <div className="apple-card p-12 text-center flex flex-col items-center justify-center gap-3">
              <Empty description="暂未选择或生成分析报告" />
              <Button type="primary" onClick={handleStartAnalysis} className="rounded-full text-xs font-semibold mt-2">
                立即生成精选股票报告
              </Button>
            </div>
          ) : (
            <>
              {/* Report Summary Card */}
              <section className="apple-card p-5 bg-gradient-to-br from-white/90 to-slate-50/60 dark:from-[#1c1c1e] dark:to-[#161618]">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-3 pb-2 border-b border-[var(--hairline-border)]">
                  <div className="flex items-center gap-2">
                    <Target size={16} className="text-blue-500" />
                    <h3 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
                      投资策略研判与盘面综述
                    </h3>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                    <span>模型: {currentReport.model}</span>
                    <span>·</span>
                    <span>{currentReport.created_at}</span>
                  </div>
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed font-medium bg-slate-100/50 dark:bg-white/5 p-3.5 rounded-xl border border-[var(--hairline-border)]">
                  {currentReport.summary || 'AI 综合全网宏观大盘走势、领涨板块动向及资金偏好，已从真实候选池中甄选出如下优质标的：'}
                </p>
              </section>

              {/* Recommendations Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recommendations.map(rec => {
                  const isAdded = !!addedMap[rec.code];
                  const marketLabel = rec.market === 'us' ? '美股' : rec.market === 'hk' ? '港股' : 'A股';
                  const marketTagColor = rec.market === 'us' ? 'purple' : rec.market === 'hk' ? 'cyan' : 'blue';

                  return (
                    <div
                      key={rec.code}
                      className="apple-card p-5 flex flex-col justify-between gap-4 border border-[var(--hairline-border)] hover:border-blue-300/60 dark:hover:border-blue-700/60 transition-all shadow-sm group"
                    >
                      <div>
                        {/* Card Header: Rank, Name, Code, Market, Confidence */}
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-mono font-bold text-xs flex items-center justify-center border border-blue-200/50 dark:border-blue-800/40">
                              #{rec.rank}
                            </div>
                            <div>
                              <div className="flex items-center gap-1.5">
                                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                  {rec.name}
                                </h4>
                                <Tag color={marketTagColor} className="text-[10px] font-bold rounded-md px-1.5 py-0 m-0">
                                  {marketLabel}
                                </Tag>
                              </div>
                              <span className="text-[11px] font-mono text-slate-400">{rec.code}</span>
                            </div>
                          </div>

                          <Tooltip title="AI 综合技术面与基本面量化置信度评分">
                            <div className="text-right">
                              <span className="text-[10px] text-slate-400 block font-medium">置信度</span>
                              <span className="text-xs font-bold font-mono text-indigo-600 dark:text-indigo-400">
                                {rec.confidence}%
                              </span>
                            </div>
                          </Tooltip>
                        </div>

                        {/* Four Dimensions Logic */}
                        <div className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300">
                          {/* 1. Fundamental */}
                          <div className="bg-slate-50 dark:bg-white/[0.02] p-2.5 rounded-xl border border-[var(--hairline-border)]">
                            <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">
                              <Layers size={13} className="text-blue-500" /> 基本面与行业景气
                            </div>
                            <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                              {rec.reason_fundamental}
                            </p>
                          </div>

                          {/* 2. Technical */}
                          <div className="bg-slate-50 dark:bg-white/[0.02] p-2.5 rounded-xl border border-[var(--hairline-border)]">
                            <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">
                              <TrendingUp size={13} className="text-emerald-500" /> 技术形态与量价趋势
                            </div>
                            <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                              {rec.reason_technical}
                            </p>
                          </div>

                          {/* 3. Catalyst */}
                          <div className="bg-slate-50 dark:bg-white/[0.02] p-2.5 rounded-xl border border-[var(--hairline-border)]">
                            <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">
                              <Flame size={13} className="text-amber-500" /> 潜在催化剂与动向
                            </div>
                            <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                              {rec.reason_catalyst}
                            </p>
                          </div>

                          {/* 4. Risk Warning */}
                          <div className="bg-red-50/60 dark:bg-red-950/20 p-2.5 rounded-xl border border-red-200/50 dark:border-red-900/40 text-red-700 dark:text-red-300">
                            <div className="flex items-center gap-1.5 text-[11px] font-bold mb-1">
                              <AlertTriangle size={13} className="text-red-500" /> 风险警示
                            </div>
                            <p className="text-[11px] leading-relaxed opacity-90">
                              {rec.risk_warning}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Card Footer Actions */}
                      <div className="flex items-center justify-between gap-2 pt-3 border-t border-[var(--hairline-border)]">
                        <Button
                          type="default"
                          size="small"
                          icon={<LineChart size={13} />}
                          onClick={() => onOpenDetail?.(rec.code, rec.market)}
                          className="rounded-full text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 cursor-pointer"
                        >
                          查看分时/K线
                        </Button>

                        <Button
                          type={isAdded ? 'dashed' : 'primary'}
                          size="small"
                          icon={isAdded ? <CheckCircle2 size={13} /> : <Plus size={13} />}
                          disabled={isAdded}
                          onClick={() => handleAddToWatchlist(rec)}
                          className={`rounded-full text-xs font-semibold cursor-pointer ${
                            isAdded ? 'text-emerald-600' : 'bg-blue-600 hover:bg-blue-500'
                          }`}
                        >
                          {isAdded ? '已在自选' : '加入自选'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── AI Config Modal ── */}
      <AiConfigModal
        open={configModalOpen}
        config={config}
        loading={loadingConfig}
        onClose={() => setConfigModalOpen(false)}
        onSaved={loadConfig}
      />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   AI Config Modal
   ─────────────────────────────────────────────────────────────────── */

interface AiConfigModalProps {
  open: boolean;
  config: AiUserConfig | null;
  loading: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function AiConfigModal({ open, config, onClose, onSaved }: AiConfigModalProps) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (config && open) {
      form.setFieldsValue({
        api_key: '',
        base_url: config.base_url || 'https://api.anthropic.com',
        model_name: config.model_name || 'claude-3-7-sonnet-20250219',
        api_format: config.api_format || 'anthropic',
        auth_header_type: config.auth_header_type || 'ANTHROPIC_AUTH_TOKEN',
        markets: config.markets || ['domestic'],
        stock_count: config.stock_count || 5,
        strategy: config.strategy || 'balanced',
        pre_market_enabled: !!config.pre_market_enabled,
        close_enabled: !!config.close_enabled,
      });
    }
  }, [config, open, form]);

  const handleTest = async () => {
    const values = form.getFieldsValue();
    setTesting(true);
    try {
      const res = await testAiConfig({
        api_key: values.api_key || undefined,
        base_url: values.base_url,
        model_name: values.model_name,
        api_format: values.api_format,
        auth_header_type: values.auth_header_type,
      });
      if (res.success) {
        message.success(`连接成功！延迟: ${res.latencyMs}ms (模型: ${res.model})`);
      } else {
        message.error(`连接失败: ${res.error || '未知错误'}`);
      }
    } catch (err: any) {
      message.error(`连接测试异常: ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await saveAiConfig(values);
      if (res.success) {
        message.success('AI 选股配置保存成功！');
        onSaved();
        onClose();
      }
    } catch (err: any) {
      message.error(err.message || '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-bold">
          <Settings size={18} className="text-blue-500" />
          <span>Anthropic API 接口与选股策略配置</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="test" loading={testing} onClick={handleTest} className="rounded-full text-xs font-semibold">
          测试 API 连通性
        </Button>,
        <Button key="cancel" onClick={onClose} className="rounded-full text-xs">
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave} className="rounded-full text-xs font-bold bg-blue-600">
          保存配置
        </Button>,
      ]}
      width={620}
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4">
        {/* 1. API Key */}
        <Form.Item
          name="api_key"
          label={
            <div className="flex items-center justify-between w-full gap-2">
              <span className="font-semibold text-xs text-slate-700 dark:text-slate-200">
                Anthropic API Key (API 密钥)
              </span>
              {config?.configured && (
                <span className="text-[10px] font-mono text-emerald-600 font-normal">
                  已安全加密存储 ({config.apiKeyMasked})
                </span>
              )}
            </div>
          }
          extra="密钥采用 AES-256-GCM 独立加密存储，留空表示保留已有密钥。"
        >
          <Input.Password
            placeholder={config?.configured ? '留空保留原密钥，输入新 Key 覆盖' : 'sk-ant-api03-...'}
            className="rounded-xl"
          />
        </Form.Item>

        {/* 2. Base URL */}
        <Form.Item
          name="base_url"
          label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">模型调用地址 (Base URL)</span>}
          rules={[{ required: true, message: '请输入模型调用地址' }]}
          extra="支持官方地址 https://api.anthropic.com 或第三方中转代理地址。"
        >
          <Input placeholder="https://api.anthropic.com" className="rounded-xl" />
        </Form.Item>

        {/* 3. Model Name */}
        <Form.Item
          name="model_name"
          label={
            <div className="flex items-center justify-between w-full">
              <span className="font-semibold text-xs text-slate-700 dark:text-slate-200">
                模型名称 (Model)
              </span>
              <span className="text-[10px] text-blue-500 font-normal">支持直接输入任意自定义模型</span>
            </div>
          }
          rules={[{ required: true, message: '请选择或输入模型名称' }]}
          extra="支持自由输入任意自定义模型名称（如 deepseek-r1、gpt-4o、claude-3-7-sonnet 等），亦可从预设推荐中快速选择。"
        >
          <AutoComplete
            options={MODEL_PRESETS.map(p => ({ value: p.value, label: `${p.value} (${p.label.split('(')[1] || ''}` }))}
            placeholder="输入或选择模型名称，如 claude-3-7-sonnet-20250219"
            className="rounded-xl"
            filterOption={(inputValue, option) =>
              (option?.value?.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1) ||
              (option?.label?.toString().toUpperCase().indexOf(inputValue.toUpperCase()) !== -1)
            }
          />
        </Form.Item>

        {/* 高级选项 (API 格式与认证字段，对齐 cc-switch 规范) */}
        <div className="mb-4">
          <Collapse
            ghost
            items={[
              {
                key: 'advanced',
                label: (
                  <span className="font-semibold text-xs text-slate-700 dark:text-slate-200">
                    高级选项
                  </span>
                ),
                children: (
                  <div className="space-y-3 pt-1">
                    {/* API 格式 */}
                    <Form.Item
                      name="api_format"
                      label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">API 格式</span>}
                      extra="选择供应商 API 的输入格式"
                      className="mb-3"
                    >
                      <Select
                        options={[
                          { label: 'Anthropic Messages (原生)', value: 'anthropic' },
                          { label: 'OpenAI Chat Completions', value: 'openai' },
                        ]}
                        className="rounded-xl"
                      />
                    </Form.Item>

                    {/* 认证字段 */}
                    <Form.Item
                      name="auth_header_type"
                      label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">认证字段</span>}
                      extra="选择写入配置的认证环境变量名 / 请求头认证字段"
                      className="mb-0"
                    >
                      <Select
                        options={[
                          { label: 'ANTHROPIC_AUTH_TOKEN (默认)', value: 'ANTHROPIC_AUTH_TOKEN' },
                          { label: 'x-api-key', value: 'x-api-key' },
                          { label: 'Authorization (Bearer)', value: 'Authorization' },
                        ]}
                        className="rounded-xl"
                      />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />
        </div>

        {/* 4. Target Markets & Stock Count */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Form.Item
            name="markets"
            label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">目标筛选市场 (多选)</span>}
            rules={[{ required: true, message: '请至少选择一个市场' }]}
          >
            <Checkbox.Group
              options={[
                { label: 'A股', value: 'domestic' },
                { label: '港股', value: 'hk' },
                { label: '美股', value: 'us' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="stock_count"
            label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">推荐股票数量 (3~10 只)</span>}
          >
            <Slider min={3} max={10} marks={{ 3: '3只', 5: '5只', 8: '8只', 10: '10只' }} />
          </Form.Item>
        </div>

        {/* 5. Strategy */}
        <Form.Item
          name="strategy"
          label={<span className="font-semibold text-xs text-slate-700 dark:text-slate-200">选股投资风格偏好</span>}
        >
          <Select options={STRATEGY_OPTIONS} className="rounded-xl" />
        </Form.Item>

        {/* 6. Scheduled Triggers */}
        <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-[var(--hairline-border)] flex flex-col gap-3">
          <span className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
            <Clock size={13} className="text-blue-500" /> 自动化定时分析策略
          </span>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">盘前自动分析</div>
              <div className="text-[10px] text-slate-400">交易日 09:00~09:25 自动结合隔夜要闻与集合竞价生成研报</div>
            </div>
            <Form.Item name="pre_market_enabled" valuePropName="checked" className="m-0">
              <Switch />
            </Form.Item>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-200/50 dark:border-white/5">
            <div>
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">收盘前 1 小时自动分析</div>
              <div className="text-[10px] text-slate-400">交易日 14:00~14:50 自动捕捉日内强势异动与尾盘抢筹机会</div>
            </div>
            <Form.Item name="close_enabled" valuePropName="checked" className="m-0">
              <Switch />
            </Form.Item>
          </div>
        </div>
      </Form>
    </Modal>
  );
}
