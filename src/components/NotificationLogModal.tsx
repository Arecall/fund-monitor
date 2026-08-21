import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  Tabs,
  Table,
  Tag,
  Button,
  Popconfirm,
  Tooltip,
  Empty,
  Switch,
  Input,
  Badge,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  Bell,
  History,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  ArrowDownRight,
  SlidersHorizontal,
  Search,
  ExternalLink,
  ShieldCheck,
  Clock,
} from 'lucide-react';
import {
  fetchAlertHistory,
  fetchAlerts,
  updateAlert,
  deleteAlert,
  clearAlertHistory,
  deleteAlertHistoryItem,
  type AlertItem,
  type AlertHistoryItem,
} from '../services/api';

interface NotificationLogModalProps {
  open: boolean;
  onClose: () => void;
  currentUser: string;
  onToast?: (msg: string) => void;
  onSelectFund?: (code: string) => void;
}

export const NotificationLogModal: React.FC<NotificationLogModalProps> = ({
  open,
  onClose,
  currentUser,
  onToast,
  onSelectFund,
}) => {
  const [activeTab, setActiveTab] = useState<'logs' | 'rules'>('logs');

  // Logs state
  const [logs, setLogs] = useState<AlertHistoryItem[]>([]);
  const [totalLogs, setTotalLogs] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchKeyword, setSearchKeyword] = useState('');

  // Rules state
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [ruleActionLoading, setRuleActionLoading] = useState<number | null>(null);

  // 加载推送历史日志
  const loadHistory = useCallback(async (targetPage = 1, targetPageSize = 10, keyword = '') => {
    setLogsLoading(true);
    try {
      const res = await fetchAlertHistory({
        page: targetPage,
        pageSize: targetPageSize,
        fund_code: keyword ? keyword.trim() : undefined,
      });
      setLogs(res.history || []);
      setTotalLogs(res.total ?? (res.history || []).length);
      setPage(targetPage);
      setPageSize(targetPageSize);
    } catch (err) {
      console.error('加载推送日志失败:', err);
      onToast?.('加载推送历史失败');
    } finally {
      setLogsLoading(false);
    }
  }, [onToast]);

  // 加载订阅规则列表
  const loadAlertRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      const list = await fetchAlerts();
      setAlerts(list);
    } catch (err) {
      console.error('加载订阅规则失败:', err);
      onToast?.('加载订阅规则失败');
    } finally {
      setRulesLoading(false);
    }
  }, [onToast]);

  // 弹窗打开时根据当前 Tab 刷新数据
  useEffect(() => {
    if (open) {
      if (activeTab === 'logs') {
        loadHistory(page, pageSize, searchKeyword);
      } else {
        loadAlertRules();
      }
    }
  }, [open, activeTab, loadHistory, loadAlertRules, page, pageSize, searchKeyword]);

  // 清空当前用户所有推送日志
  const handleClearAllLogs = async () => {
    try {
      await clearAlertHistory();
      onToast?.('已清空个人所有推送日志');
      loadHistory(1, pageSize, searchKeyword);
    } catch (err) {
      console.error('清空日志失败:', err);
      onToast?.('清空日志失败');
    }
  };

  // 删除单条日志
  const handleDeleteLogItem = async (id: number) => {
    try {
      await deleteAlertHistoryItem(id);
      onToast?.('已删除该条推送记录');
      loadHistory(page, pageSize, searchKeyword);
    } catch (err) {
      console.error('删除单条日志失败:', err);
      onToast?.('删除日志失败');
    }
  };

  // 切换订阅激活状态
  const handleToggleAlertActive = async (item: AlertItem) => {
    setRuleActionLoading(item.id);
    try {
      const nextActive = item.is_active === 1 ? false : true;
      await updateAlert(item.id, { is_active: nextActive });
      onToast?.(nextActive ? `已启用 ${item.fund_name || item.fund_code} 提醒` : `已暂停 ${item.fund_name || item.fund_code} 提醒`);
      loadAlertRules();
    } catch (err) {
      console.error('更新订阅状态失败:', err);
      onToast?.('操作失败');
    } finally {
      setRuleActionLoading(null);
    }
  };

  // 删除订阅规则
  const handleDeleteAlert = async (id: number, name: string) => {
    setRuleActionLoading(id);
    try {
      await deleteAlert(id);
      onToast?.(`已删除订阅: ${name}`);
      loadAlertRules();
    } catch (err) {
      console.error('删除订阅失败:', err);
      onToast?.('删除订阅失败');
    } finally {
      setRuleActionLoading(null);
    }
  };

  // 推送日志表格列定义
  const logColumns: ColumnsType<AlertHistoryItem> = [
    {
      title: '推送时间',
      dataIndex: 'sent_at',
      key: 'sent_at',
      width: 165,
      render: (val: string) => {
        const d = new Date(val);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        return (
          <div className="flex flex-col text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-200">{ymd}</span>
            <span className="text-[11px] text-slate-400 font-mono flex items-center gap-1">
              <Clock size={10} className="inline opacity-70" />
              {hms}
            </span>
          </div>
        );
      },
    },
    {
      title: '监控标的',
      key: 'fund',
      width: 170,
      render: (_, record) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-xs text-slate-800 dark:text-slate-100 truncate max-w-[120px]" title={record.fund_name || record.fund_code}>
              {record.fund_name || '—'}
            </span>
            {onSelectFund && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onSelectFund(record.fund_code);
                }}
                className="text-slate-400 hover:text-blue-500 transition-colors p-0.5"
                title="打开详情面板"
              >
                <ExternalLink size={11} />
              </button>
            )}
          </div>
          <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
            {record.fund_code}
          </span>
        </div>
      ),
    },
    {
      title: '触发类型',
      dataIndex: 'direction',
      key: 'direction',
      width: 110,
      render: (direction: 'up' | 'down') => {
        const isUp = direction === 'up';
        return (
          <Tag
            color={isUp ? 'red' : 'green'}
            className="flex items-center gap-0.5 font-bold text-xs px-1.5 py-0.5 border-0 rounded-md w-fit"
          >
            {isUp ? <ArrowUpRight size={12} className="shrink-0" /> : <ArrowDownRight size={12} className="shrink-0" />}
            {isUp ? '上涨突破' : '下跌跌破'}
          </Tag>
        );
      },
    },
    {
      title: '触发涨跌幅',
      dataIndex: 'change_pct',
      key: 'change_pct',
      width: 115,
      render: (pct: number) => {
        const isUp = pct > 0;
        return (
          <span
            className={`font-mono font-bold text-xs tabular-nums ${
              isUp ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
            }`}
          >
            {pct > 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`}
          </span>
        );
      },
    },
    {
      title: '触发价 / 基准价',
      key: 'prices',
      width: 140,
      render: (_, record) => (
        <div className="font-mono text-xs tabular-nums flex flex-col">
          <span className="text-slate-800 dark:text-slate-200 font-semibold">
            {record.current_price != null ? record.current_price.toFixed(4) : '—'}
          </span>
          <span className="text-[10px] text-slate-400">
            基准: {record.reference_price != null ? record.reference_price.toFixed(4) : '—'}
          </span>
        </div>
      ),
    },
    {
      title: '接收邮箱',
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
      render: (email: string) => (
        <span className="text-xs text-slate-600 dark:text-slate-400 font-mono truncate max-w-[150px] inline-block" title={email}>
          {email}
        </span>
      ),
    },
    {
      title: '发送状态',
      dataIndex: 'sent_ok',
      key: 'sent_ok',
      width: 105,
      render: (ok: number, record) => {
        const isSuccess = ok === 1;
        return (
          <Tooltip title={isSuccess ? `Message-ID: ${record.message_id || '成功投递'}` : `错误原因: ${record.error || '发送失败'}`}>
            <Tag
              icon={isSuccess ? <CheckCircle2 size={11} className="mr-0.5" /> : <XCircle size={11} className="mr-0.5" />}
              color={isSuccess ? 'success' : 'error'}
              className="rounded-full text-[11px] px-2 py-0.5 font-medium cursor-pointer"
            >
              {isSuccess ? '成功' : '失败'}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 65,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title="确认删除该条日志？"
          description="删除后不可恢复"
          onConfirm={() => handleDeleteLogItem(record.id)}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true, size: 'small' }}
          cancelButtonProps={{ size: 'small' }}
        >
          <Button
            type="text"
            danger
            size="small"
            icon={<Trash2 size={13} />}
            className="p-1 text-slate-400 hover:text-red-500 rounded-md"
          />
        </Popconfirm>
      ),
    },
  ];

  // 订阅规则表格列定义
  const ruleColumns: ColumnsType<AlertItem> = [
    {
      title: '标的信息',
      key: 'fund',
      width: 180,
      render: (_, record) => (
        <div className="flex flex-col">
          <span className="font-semibold text-xs text-slate-800 dark:text-slate-100 truncate max-w-[140px]" title={record.fund_name || record.fund_code}>
            {record.fund_name || '—'}
          </span>
          <span className="font-mono text-[10px] text-slate-400">{record.fund_code}</span>
        </div>
      ),
    },
    {
      title: '触发条件',
      key: 'thresholds',
      width: 160,
      render: (_, record) => (
        <div className="flex flex-wrap gap-1">
          {record.up_threshold != null && (
            <Tag color="red" className="text-[11px] font-mono font-semibold m-0">
              上涨 ≥ {record.up_threshold}%
            </Tag>
          )}
          {record.down_threshold != null && (
            <Tag color="green" className="text-[11px] font-mono font-semibold m-0">
              下跌 ≥ {record.down_threshold}%
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: '基准净值 / 现价',
      dataIndex: 'reference_price',
      key: 'reference_price',
      width: 130,
      render: (ref: number | null) => (
        <span className="font-mono text-xs text-slate-700 dark:text-slate-300 font-semibold">
          {ref != null ? ref.toFixed(4) : '—'}
        </span>
      ),
    },
    {
      title: '通知邮箱',
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
      render: (email: string) => (
        <span className="text-xs text-slate-600 dark:text-slate-400 font-mono truncate max-w-[160px] inline-block" title={email}>
          {email}
        </span>
      ),
    },
    {
      title: '最近触发',
      key: 'last_triggered',
      width: 140,
      render: (_, record) => {
        if (!record.last_triggered_at) {
          return <span className="text-[11px] text-slate-400">尚未触发</span>;
        }
        const d = new Date(record.last_triggered_at);
        return (
          <div className="flex flex-col text-[11px] text-slate-500 font-mono">
            <span>{d.getMonth() + 1}-{d.getDate()} {String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}</span>
            {record.last_triggered_change_pct != null && (
              <span className={record.last_triggered_change_pct > 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>
                {record.last_triggered_change_pct > 0 ? '+' : ''}{record.last_triggered_change_pct.toFixed(2)}%
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 90,
      render: (active: number, record) => (
        <Switch
          size="small"
          checked={active === 1}
          loading={ruleActionLoading === record.id}
          onChange={() => handleToggleAlertActive(record)}
          checkedChildren="启用"
          unCheckedChildren="暂停"
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 65,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title="确认删除该订阅规则？"
          description={`删除后将不再接收 ${record.fund_name || record.fund_code} 的预警邮件`}
          onConfirm={() => handleDeleteAlert(record.id, record.fund_name || record.fund_code)}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true, size: 'small' }}
          cancelButtonProps={{ size: 'small' }}
        >
          <Button
            type="text"
            danger
            size="small"
            icon={<Trash2 size={13} />}
            loading={ruleActionLoading === record.id}
            className="p-1 text-slate-400 hover:text-red-500 rounded-md"
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnClose
      centered
      className="apple-modal-blur"
      title={
        <div className="flex items-center justify-between pr-8">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <Bell size={16} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="apple-display-heading text-base font-bold text-slate-900 dark:text-slate-100 m-0">
                  预警订阅与推送日志
                </h3>
                <Tag color="blue" className="rounded-full text-[11px] px-2 py-0 font-mono font-medium m-0 flex items-center gap-1">
                  <ShieldCheck size={11} /> 用户: {currentUser}
                </Tag>
              </div>
              <p className="text-xs text-slate-400 dark:text-slate-500 m-0 mt-0.5">
                数据严格按登录用户隔离，仅展示归属于您名下的提醒与投递记录
              </p>
            </div>
          </div>
        </div>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'logs' | 'rules')}
        className="mt-2"
        items={[
          {
            key: 'logs',
            label: (
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <History size={13} />
                推送日志
                {totalLogs > 0 && <Badge count={totalLogs} overflowCount={99} className="ml-1" size="small" />}
              </span>
            ),
            children: (
              <div className="space-y-3 pt-1">
                {/* 顶部筛选与操作栏 */}
                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 dark:bg-white/[0.02] p-2.5 rounded-xl border border-[var(--hairline-border)]">
                  <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-[320px]">
                    <Input
                      size="small"
                      placeholder="按代码筛选 (如 001668)..."
                      prefix={<Search size={12} className="text-slate-400" />}
                      value={searchKeyword}
                      onChange={(e) => setSearchKeyword(e.target.value)}
                      onPressEnter={() => loadHistory(1, pageSize, searchKeyword)}
                      allowClear
                      className="rounded-lg text-xs"
                    />
                    <Button
                      size="small"
                      onClick={() => loadHistory(1, pageSize, searchKeyword)}
                      className="text-xs rounded-lg"
                    >
                      搜索
                    </Button>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="small"
                      icon={<RefreshCw size={12} className={logsLoading ? 'animate-spin' : ''} />}
                      onClick={() => loadHistory(page, pageSize, searchKeyword)}
                      className="text-xs rounded-lg flex items-center gap-1 text-slate-600 dark:text-slate-300"
                    >
                      刷新
                    </Button>

                    {logs.length > 0 && (
                      <Popconfirm
                        title="清空个人所有推送日志？"
                        description="此操作仅清空您本人的推送历史，不可恢复"
                        onConfirm={handleClearAllLogs}
                        okText="清空"
                        cancelText="取消"
                        okButtonProps={{ danger: true, size: 'small' }}
                        cancelButtonProps={{ size: 'small' }}
                      >
                        <Button
                          size="small"
                          danger
                          icon={<Trash2 size={12} />}
                          className="text-xs rounded-lg flex items-center gap-1"
                        >
                          清空日志
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </div>

                {/* 日志数据表格 */}
                <div className="rounded-xl border border-[var(--hairline-border)] overflow-hidden">
                  <Table
                    columns={logColumns}
                    dataSource={logs}
                    rowKey="id"
                    loading={logsLoading}
                    size="small"
                    scroll={{ x: 780 }}
                    pagination={{
                      current: page,
                      pageSize: pageSize,
                      total: totalLogs,
                      showSizeChanger: true,
                      pageSizeOptions: ['10', '20', '50'],
                      showTotal: (total) => `共 ${total} 条推送记录`,
                      onChange: (p, ps) => loadHistory(p, ps, searchKeyword),
                      size: 'small',
                      className: 'p-2 m-0 border-t border-[var(--hairline-border)]',
                    }}
                    locale={{
                      emptyText: (
                        <div className="py-8">
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              <div className="text-xs text-slate-400 space-y-1">
                                <p className="font-semibold text-slate-600 dark:text-slate-300 m-0">暂无推送日志记录</p>
                                <p className="m-0 text-[11px]">当您订阅的基金/股票达到设定的水位线阈值时，系统会自动发送邮件并记录在此</p>
                              </div>
                            }
                          />
                        </div>
                      ),
                    }}
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'rules',
            label: (
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <SlidersHorizontal size={13} />
                我的订阅规则
                {alerts.length > 0 && <Badge count={alerts.length} className="ml-1" size="small" />}
              </span>
            ),
            children: (
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between bg-slate-50 dark:bg-white/[0.02] p-2.5 rounded-xl border border-[var(--hairline-border)]">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    当前共创建 <strong className="text-slate-700 dark:text-slate-200">{alerts.length}</strong> 条价格水位线监控规则
                  </span>
                  <Button
                    size="small"
                    icon={<RefreshCw size={12} className={rulesLoading ? 'animate-spin' : ''} />}
                    onClick={loadAlertRules}
                    className="text-xs rounded-lg flex items-center gap-1"
                  >
                    刷新规则
                  </Button>
                </div>

                <div className="rounded-xl border border-[var(--hairline-border)] overflow-hidden">
                  <Table
                    columns={ruleColumns}
                    dataSource={alerts}
                    rowKey="id"
                    loading={rulesLoading}
                    size="small"
                    scroll={{ x: 740 }}
                    pagination={alerts.length > 10 ? { pageSize: 10, size: 'small', className: 'p-2 m-0' } : false}
                    locale={{
                      emptyText: (
                        <div className="py-8">
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              <div className="text-xs text-slate-400 space-y-1">
                                <p className="font-semibold text-slate-600 dark:text-slate-300 m-0">暂无任何订阅规则</p>
                                <p className="m-0 text-[11px]">点击列表中的任意标的，在详情页右下角即可添加“价格提醒与水位线”订阅</p>
                              </div>
                            }
                          />
                        </div>
                      ),
                    }}
                  />
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
};
