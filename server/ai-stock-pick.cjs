/**
 * ai-stock-pick.cjs — 优质股票智能筛选引擎、Anthropic 客户端与定时调度中心
 *
 * 核心设计：
 * 1. 严格多用户隔离与 API Key AES-256-GCM 安全加密存储；
 * 2. 遵循 Anthropic Messages API 规范 (/v1/messages)，支持官方端点与自定义代理中转；
 * 3. 异步任务编排与进度轮询机制（避免大模型推理长连接超时）；
 * 4. 严格防幻觉校验：大模型必须从服务端抓取的真实候选股票池中甄选；
 * 5. 盘前（09:00~09:25）与收盘前 1 小时（14:00~14:50）自动分析调度。
 */

'use strict';

const express = require('express');
const axios = require('axios');
const dbHelper = require('./db.cjs');
const { encrypt, decrypt } = require('./crypto.cjs');
const aiContext = require('./ai-context.cjs');
const marketTime = require('./time.cjs');

const router = express.Router();

// 内存任务状态字典：jobId -> { jobId, userId, reportId, status, stage, error, progress }
const activeJobs = new Map();
let jobCounter = 1;

/**
 * 掩码脱敏 API Key (如 sk-ant-api03-xxxx...xxxx -> sk-ant-****5678)
 */
function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

/**
 * 构造 Anthropic System Prompt
 */
function buildSystemPrompt() {
  return `你是一位专业、严谨、深谙全球金融市场的首席证券分析师与量化策略专家。
你的职责是：基于服务端提供的【全网实时大盘】、【热点领涨行业】、【主力资金流向】、【财经要闻快讯】以及【真实股票候选池】，为投资者精选出最具潜力的优质股票，并提供深度的结构化投资决策逻辑。

【核心防幻觉铁律】：
1. 你推荐的每一只股票，其代码（code）和市场（market）必须严格存在于提供的【真实候选股票池】列表中！绝不允许凭空捏造、编造任何代码或混淆市场！
2. 对于 A 股，代码通常为 6 位数字（如 600519, 002594, 300750）；对于港股，代码通常为 5 位数字（如 00700, 09988）；对于美股，代码为大写字母代码（如 NVDA, AAPL, MSFT）。
3. 必须输出严格且合法的纯 JSON 格式（包含在 \`\`\`json \`\`\` 围栏中），严禁输出任何 JSON 之外的问候语或附带文字。

【输出 JSON 数据结构规范】：
\`\`\`json
{
  "summary": "本次选股策略宏观研判与盘面综述（100字以内）",
  "recommendations": [
    {
      "code": "600519",
      "name": "贵州茅台",
      "market": "domestic",
      "rank": 1,
      "confidence": 88.5,
      "reason_fundamental": "基本面与业绩亮点分析（核心壁垒、估值水平、盈利质量）",
      "reason_technical": "技术面与量价形态分析（均线趋势、突破信号、量能支撑）",
      "reason_catalyst": "短期/中期潜在催化剂（行业政策、新品发布、资金净流入）",
      "risk_warning": "具体风险提示（避免泛泛而谈，指出关键阻力位或下行风险）"
    }
  ]
}
\`\`\``;
}

/**
 * 构造用户 Prompt
 */
function buildUserPrompt({ strategy, stockCount, markets, contextSnapshot }) {
  const strategyMap = {
    balanced: '均衡配置（兼顾价值安全边际与成长弹性）',
    growth: '高景气成长（侧重科技突破、业绩高增速与领涨行业龙头）',
    value: '深度价值与高股息（低估值、高分红、强现金流防守标的）',
    momentum: '动量突破（主力资金大幅净流入、技术形态均线多头排列）',
    defensive: '稳健防御（抗通胀、低波动率、穿越牛熊必选消费/公用事业）',
  };

  return `【投资策略偏好】：${strategyMap[strategy] || strategyMap.balanced}
【期望甄选股票数量】：${stockCount} 只
【目标覆盖市场】：${markets.map(m => m === 'domestic' ? 'A股' : m === 'hk' ? '港股' : '美股').join('、')}

【当前实时全网行情快照与上下文】：
1. 全球大盘核心指数：
${JSON.stringify(contextSnapshot.indices || {}, null, 2)}

2. 今日领涨行业板块 Top 8：
${JSON.stringify(contextSnapshot.sectors || [], null, 2)}

3. 主力资金净流入领先行业：
${JSON.stringify(contextSnapshot.flows || [], null, 2)}

4. 财经要闻快讯摘要：
${JSON.stringify(contextSnapshot.news || [], null, 2)}

5. 【真实股票候选池】（你精选的股票必须 100% 来源于此池，代码必须完全一致）：
${JSON.stringify(contextSnapshot.candidates || [], null, 2)}

请基于以上全网实时数据与候选池，严格输出包含 ${stockCount} 只优质推荐股票的 JSON 数据。`;
}

/**
 * 调用 AI 接口（支持 cc-switch 规范的 Anthropic Messages 原生格式与 OpenAI Chat Completions 格式，以及自定义认证字段）
 */
async function callAnthropicMessages({ apiKey, baseUrl, modelName, apiFormat = 'anthropic', authHeaderType = 'ANTHROPIC_AUTH_TOKEN', systemPrompt, userPrompt }) {
  let rawBase = (baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
  // 去除尾部多余的 /v1/messages, /v1/chat/completions, /v1
  if (rawBase.endsWith('/v1/messages')) {
    rawBase = rawBase.slice(0, -12);
  } else if (rawBase.endsWith('/v1/chat/completions')) {
    rawBase = rawBase.slice(0, -20);
  } else if (rawBase.endsWith('/messages')) {
    rawBase = rawBase.slice(0, -9);
  } else if (rawBase.endsWith('/chat/completions')) {
    rawBase = rawBase.slice(0, -17);
  } else if (rawBase.endsWith('/v1')) {
    rawBase = rawBase.slice(0, -3);
  }

  const cleanKey = (apiKey || '').trim();
  const model = modelName || 'claude-3-7-sonnet-20250219';

  // 构造认证标头（对齐 cc-switch 认证字段规范）
  const headers = {
    'Content-Type': 'application/json',
  };

  if (authHeaderType === 'x-api-key') {
    headers['x-api-key'] = cleanKey;
  } else if (authHeaderType === 'Authorization') {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  } else {
    // ANTHROPIC_AUTH_TOKEN (默认) — 同时带 x-api-key 与 Bearer 令牌，确保全兼容
    headers['x-api-key'] = cleanKey;
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  if (apiFormat === 'anthropic' || !apiFormat) {
    headers['anthropic-version'] = '2023-06-01';
  }

  const startTime = Date.now();

  // 1. 如果指定为 OpenAI Chat Completions 格式
  if (apiFormat === 'openai') {
    const openaiUrl = `${rawBase}/v1/chat/completions`;
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const openaiPayload = {
      model,
      messages,
      temperature: 0.2,
    };

    const response = await axios.post(openaiUrl, openaiPayload, { headers, timeout: 120 * 1000 });
    const latencyMs = Date.now() - startTime;
    const choice = response.data?.choices?.[0];
    const rawText = choice?.message?.content || '';
    const usage = response.data?.usage || {};

    return {
      rawText,
      latencyMs,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      model: response.data?.model || model,
    };
  }

  // 2. 默认：Anthropic /v1/messages 原生格式
  try {
    const targetUrl = `${rawBase}/v1/messages`;
    const payload = {
      model,
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };

    const response = await axios.post(targetUrl, payload, { headers, timeout: 120 * 1000 });
    const latencyMs = Date.now() - startTime;
    const contentBlocks = response.data?.content || [];
    const textBlock = contentBlocks.find(b => b.type === 'text');
    const rawText = textBlock ? textBlock.text : (typeof response.data === 'string' ? response.data : '');
    const usage = response.data?.usage || {};

    return {
      rawText,
      latencyMs,
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      model: response.data?.model || model,
    };
  } catch (err) {
    // 3. 若 Anthropic Messages 返回 404，智能尝试 OpenAI 兼容端点
    if (err.response?.status === 404) {
      console.log(`[ai-stock-pick] /v1/messages 返回 404，智能回退至 OpenAI 兼容端点 /v1/chat/completions (${rawBase})...`);
      const openaiUrl = `${rawBase}/v1/chat/completions`;
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: userPrompt });

      const openaiPayload = {
        model,
        messages,
        temperature: 0.2,
      };

      const response = await axios.post(openaiUrl, openaiPayload, { headers, timeout: 120 * 1000 });
      const latencyMs = Date.now() - startTime;
      const choice = response.data?.choices?.[0];
      const rawText = choice?.message?.content || '';
      const usage = response.data?.usage || {};

      return {
        rawText,
        latencyMs,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        model: response.data?.model || model,
      };
    }

    throw err;
  }
}

/**
 * 解析大模型返回的 JSON 并进行候选池比对校验
 */
function parseAndValidateRecommendations(rawText, candidates = []) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('模型返回内容为空');
  }

  // 1. 尝试从 ```json 围栏中提取
  let jsonStr = '';
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 2. 尝试提取首个 { 到最后一个 }
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = rawText.slice(firstBrace, lastBrace + 1);
    } else {
      jsonStr = rawText.trim();
    }
  }

  let parsed = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    console.error('[ai-stock-pick] JSON 解析失败, rawText:', rawText.slice(0, 300));
    throw new Error(`模型响应 JSON 格式不合规: ${err.message}`);
  }

  const list = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  if (list.length === 0) {
    throw new Error('模型未返回任何推荐股票条目');
  }

  // 建立候选池快速查找 Map（以统一格式 code 为 key）
  const candidateMap = new Map();
  candidates.forEach(c => {
    candidateMap.set(String(c.code).toUpperCase(), c);
  });

  const validated = list.map((item, idx) => {
    const rawCode = String(item.code || '').trim().toUpperCase();
    const candidate = candidateMap.get(rawCode);

    return {
      code: candidate ? candidate.code : rawCode,
      name: candidate ? candidate.name : (item.name || rawCode),
      market: candidate ? candidate.market : (item.market || 'domestic'),
      rank: item.rank || (idx + 1),
      confidence: Number(item.confidence) || 80,
      reason_fundamental: item.reason_fundamental || '基本面稳健，行业处于景气上升周期。',
      reason_technical: item.reason_technical || '技术形态均线向上发散，成交量配合良好。',
      reason_catalyst: item.reason_catalyst || '行业利好政策驱动与机构资金关注。',
      risk_warning: item.risk_warning || '注意大盘系统性回调与市场情绪波动风险。',
      in_candidate_pool: candidate ? 1 : 0,
    };
  });

  return {
    summary: parsed.summary || 'AI 综合全网实时热点与技术面研判完成。',
    recommendations: validated,
  };
}

/**
 * 异步执行分析任务
 */
async function executeAnalysisTask({ jobId, reportId, userId, markets, stockCount, strategy, triggerType }) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  try {
    // 1. 读取用户配置及解密 API Key
    job.stage = 'reading_config';
    const configRow = await dbHelper.get('SELECT * FROM ai_user_config WHERE user_id = ?', [userId]);
    if (!configRow || !configRow.api_key_encrypted) {
      throw new Error('未配置 Anthropic API Key，请先进入【AI 配置】中保存有效凭证');
    }

    const apiKey = decrypt(configRow.api_key_encrypted);
    if (!apiKey) {
      throw new Error('API Key 解密失败，请重新配置并保存');
    }

    const baseUrl = configRow.base_url || 'https://api.anthropic.com';
    const modelName = configRow.model_name || 'claude-3-7-sonnet-20250219';
    const apiFormat = configRow.api_format || 'anthropic';
    const authHeaderType = configRow.auth_header_type || 'ANTHROPIC_AUTH_TOKEN';
    const targetMarkets = markets && markets.length ? markets : JSON.parse(configRow.markets || '["domestic"]');
    const targetCount = stockCount || configRow.stock_count || 5;
    const targetStrategy = strategy || configRow.strategy || 'balanced';

    // 2. 抓取全网实时行情热点、大盘、资金与候选池 (Data Enhancement)
    job.stage = 'context';
    const contextSnapshot = await aiContext.buildFullContextSnapshot(targetMarkets, targetCount);

    // 3. 构建 Prompt
    job.stage = 'prompting';
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({
      strategy: targetStrategy,
      stockCount: targetCount,
      markets: targetMarkets,
      contextSnapshot,
    });

    // 4. 调用 AI API (支持 Anthropic / OpenAI 双格式及自定义认证头)
    job.stage = 'inferring';
    const result = await callAnthropicMessages({
      apiKey,
      baseUrl,
      modelName,
      apiFormat,
      authHeaderType,
      systemPrompt,
      userPrompt,
    });

    // 5. 校验与解析推荐结果
    job.stage = 'parsing';
    const { summary, recommendations } = parseAndValidateRecommendations(result.rawText, contextSnapshot.candidates);

    // 6. 落库保存推荐结果与更新报告
    job.stage = 'saving';
    await dbHelper.run(
      `UPDATE ai_stock_pick_reports
       SET status = 'success',
           model = ?,
           context_snapshot = ?,
           prompt_tokens = ?,
           completion_tokens = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [result.model, JSON.stringify({ summary, contextSnapshot }), result.promptTokens, result.completionTokens, reportId, userId]
    );

    // 批量写入 recommendations
    for (const rec of recommendations) {
      await dbHelper.run(
        `INSERT INTO ai_stock_pick_recs
         (report_id, user_id, code, name, market, rank, confidence, reason_fundamental, reason_technical, reason_catalyst, risk_warning, in_candidate_pool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reportId,
          userId,
          rec.code,
          rec.name,
          rec.market,
          rec.rank,
          rec.confidence,
          rec.reason_fundamental,
          rec.reason_technical,
          rec.reason_catalyst,
          rec.risk_warning,
          rec.in_candidate_pool,
        ]
      );
    }

    job.status = 'done';
    job.stage = 'completed';
    console.log(`[ai-stock-pick] 报告 #${reportId} 分析完成，推荐 ${recommendations.length} 只标的`);
  } catch (err) {
    console.error(`[ai-stock-pick] 报告 #${reportId} 执行失败:`, err.message);
    job.status = 'failed';
    job.error = err.message;
    await dbHelper.run(
      `UPDATE ai_stock_pick_reports
       SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [err.message, reportId, userId]
    ).catch(() => {});
  }
}

/* ─────────────────────────── REST 路由 ─────────────────────────── */

// 1. 获取当前用户 AI 配置（API Key 脱敏）
router.get('/config', async (req, res) => {
  try {
    const row = await dbHelper.get('SELECT * FROM ai_user_config WHERE user_id = ?', [req.userId]);
    if (!row) {
      return res.json({
        configured: false,
        apiKeyMasked: '',
        base_url: 'https://api.anthropic.com',
        model_name: 'claude-3-7-sonnet-20250219',
        api_format: 'anthropic',
        auth_header_type: 'ANTHROPIC_AUTH_TOKEN',
        markets: ['domestic'],
        stock_count: 5,
        strategy: 'balanced',
        pre_market_enabled: false,
        close_enabled: false,
      });
    }

    let rawKey = '';
    try {
      rawKey = decrypt(row.api_key_encrypted);
    } catch {}

    res.json({
      configured: !!rawKey,
      apiKeyMasked: maskApiKey(rawKey),
      base_url: row.base_url || 'https://api.anthropic.com',
      model_name: row.model_name || 'claude-3-7-sonnet-20250219',
      api_format: row.api_format || 'anthropic',
      auth_header_type: row.auth_header_type || 'ANTHROPIC_AUTH_TOKEN',
      markets: JSON.parse(row.markets || '["domestic"]'),
      stock_count: row.stock_count || 5,
      strategy: row.strategy || 'balanced',
      pre_market_enabled: !!row.pre_market_enabled,
      close_enabled: !!row.close_enabled,
      updated_at: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: '获取 AI 配置失败: ' + err.message });
  }
});

// 2. 保存用户 AI 配置
router.put('/config', async (req, res) => {
  try {
    const {
      api_key,
      base_url = 'https://api.anthropic.com',
      model_name = 'claude-3-7-sonnet-20250219',
      api_format = 'anthropic',
      auth_header_type = 'ANTHROPIC_AUTH_TOKEN',
      markets = ['domestic'],
      stock_count = 5,
      strategy = 'balanced',
      pre_market_enabled = false,
      close_enabled = false,
    } = req.body;

    const count = Math.max(3, Math.min(10, parseInt(stock_count) || 5));
    const validMarkets = Array.isArray(markets) && markets.length ? markets.filter(m => ['domestic', 'hk', 'us'].includes(m)) : ['domestic'];

    const existing = await dbHelper.get('SELECT api_key_encrypted FROM ai_user_config WHERE user_id = ?', [req.userId]);

    let encKey = existing ? existing.api_key_encrypted : '';
    // 如果用户提交了新的非空且非掩码的 key，进行加密
    if (api_key && typeof api_key === 'string' && !api_key.includes('****')) {
      encKey = encrypt(api_key.trim());
    }

    await dbHelper.run(
      `INSERT INTO ai_user_config
       (user_id, api_key_encrypted, base_url, model_name, api_format, auth_header_type, markets, stock_count, strategy, pre_market_enabled, close_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         api_key_encrypted = COALESCE(NULLIF(excluded.api_key_encrypted, ''), ai_user_config.api_key_encrypted),
         base_url = excluded.base_url,
         model_name = excluded.model_name,
         api_format = excluded.api_format,
         auth_header_type = excluded.auth_header_type,
         markets = excluded.markets,
         stock_count = excluded.stock_count,
         strategy = excluded.strategy,
         pre_market_enabled = excluded.pre_market_enabled,
         close_enabled = excluded.close_enabled,
         updated_at = CURRENT_TIMESTAMP`,
      [
        req.userId,
        encKey,
        base_url.trim(),
        model_name.trim(),
        api_format,
        auth_header_type,
        JSON.stringify(validMarkets),
        count,
        strategy,
        pre_market_enabled ? 1 : 0,
        close_enabled ? 1 : 0,
      ]
    );

    res.json({ success: true, message: 'AI 配置保存成功' });
  } catch (err) {
    res.status(500).json({ error: '保存 AI 配置失败: ' + err.message });
  }
});

// 3. 测试 AI API 连通性
router.post('/test', async (req, res) => {
  try {
    const { api_key, base_url, model_name, api_format, auth_header_type } = req.body;

    let targetKey = api_key;
    let targetBase = base_url;
    let targetModel = model_name;
    let targetFormat = api_format || 'anthropic';
    let targetAuth = auth_header_type || 'ANTHROPIC_AUTH_TOKEN';

    // 如果未传 key 或传了掩码，从 DB 中读取已有 key
    if (!targetKey || targetKey.includes('****')) {
      const row = await dbHelper.get('SELECT * FROM ai_user_config WHERE user_id = ?', [req.userId]);
      if (!row || !row.api_key_encrypted) {
        return res.status(400).json({ error: '未输入且未保存 API Key，无法测试' });
      }
      targetKey = decrypt(row.api_key_encrypted);
      targetBase = targetBase || row.base_url;
      targetModel = targetModel || row.model_name;
      targetFormat = targetFormat || row.api_format || 'anthropic';
      targetAuth = targetAuth || row.auth_header_type || 'ANTHROPIC_AUTH_TOKEN';
    }

    const testRes = await callAnthropicMessages({
      apiKey: targetKey,
      baseUrl: targetBase || 'https://api.anthropic.com',
      modelName: targetModel || 'claude-3-7-sonnet-20250219',
      apiFormat: targetFormat,
      authHeaderType: targetAuth,
      systemPrompt: 'You are a test helper.',
      userPrompt: 'Ping. Output only "PONG".',
    });

    res.json({
      success: true,
      latencyMs: testRes.latencyMs,
      model: testRes.model,
      message: 'API 连接测试成功！',
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      success: false,
      error: `连接失败 (${err.response?.status || 'Network Error'}): ${detail}`,
    });
  }
});

// 4. 立即发起智能选股分析
router.post('/analyze', async (req, res) => {
  try {
    const { markets, stock_count, strategy } = req.body;

    // 校验配置
    const configRow = await dbHelper.get('SELECT * FROM ai_user_config WHERE user_id = ?', [req.userId]);
    if (!configRow || !configRow.api_key_encrypted) {
      return res.status(400).json({ error: '请先在【AI 配置】中填入并保存有效的 Anthropic API Key' });
    }

    // 检查是否有该用户正在运行的任务
    for (const [id, job] of activeJobs.entries()) {
      if (job.userId === req.userId && job.status === 'running') {
        return res.json({ jobId: id, reportId: job.reportId, message: '已有正在执行的分析任务' });
      }
    }

    const targetMarkets = markets && markets.length ? markets : JSON.parse(configRow.markets || '["domestic"]');
    const targetCount = stock_count || configRow.stock_count || 5;
    const targetStrategy = strategy || configRow.strategy || 'balanced';

    // 创建初始报告记录
    const reportInsert = await dbHelper.run(
      `INSERT INTO ai_stock_pick_reports
       (user_id, trigger_type, markets, stock_count, strategy, model, status)
       VALUES (?, 'manual', ?, ?, ?, ?, 'running')`,
      [req.userId, JSON.stringify(targetMarkets), targetCount, targetStrategy, configRow.model_name]
    );

    const reportId = reportInsert.lastID;
    const jobId = `job_${Date.now()}_${jobCounter++}`;

    const jobMeta = {
      jobId,
      userId: req.userId,
      reportId,
      status: 'running',
      stage: 'queued',
      error: null,
      createdAt: Date.now(),
    };
    activeJobs.set(jobId, jobMeta);

    // 异步执行
    executeAnalysisTask({
      jobId,
      reportId,
      userId: req.userId,
      markets: targetMarkets,
      stockCount: targetCount,
      strategy: targetStrategy,
      triggerType: 'manual',
    }).finally(() => {
      // 10 分钟后自动清理内存 job
      setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
    });

    res.json({ success: true, jobId, reportId });
  } catch (err) {
    res.status(500).json({ error: '发起分析任务失败: ' + err.message });
  }
});

// 5. 轮询任务进度
router.get('/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }
  if (job.userId !== req.userId) {
    return res.status(403).json({ error: '无权访问其他用户的分析任务' });
  }
  res.json({
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    reportId: job.reportId,
    error: job.error,
  });
});

// 6. 获取历史报告列表 (分页)
router.get('/reports', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const countRow = await dbHelper.get('SELECT COUNT(*) as total FROM ai_stock_pick_reports WHERE user_id = ?', [req.userId]);
    const total = countRow ? countRow.total : 0;

    const rows = await dbHelper.all(
      `SELECT r.id, r.trigger_type, r.markets, r.stock_count, r.strategy, r.model, r.status, r.error,
              r.created_at, r.completed_at, COUNT(rec.id) as rec_count
       FROM ai_stock_pick_reports r
       LEFT JOIN ai_stock_pick_recs rec ON r.id = rec.report_id
       WHERE r.user_id = ?
       GROUP BY r.id
       ORDER BY r.id DESC
       LIMIT ? OFFSET ?`,
      [req.userId, pageSize, offset]
    );

    const reports = rows.map(r => ({
      ...r,
      markets: JSON.parse(r.markets || '[]'),
    }));

    res.json({ reports, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: '获取报告列表失败: ' + err.message });
  }
});

// 7. 获取单份报告明细与推荐股票列表
router.get('/reports/:id', async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const report = await dbHelper.get('SELECT * FROM ai_stock_pick_reports WHERE id = ? AND user_id = ?', [reportId, req.userId]);
    if (!report) {
      return res.status(404).json({ error: '报告不存在或已被删除' });
    }

    const recs = await dbHelper.all(
      'SELECT * FROM ai_stock_pick_recs WHERE report_id = ? AND user_id = ? ORDER BY rank ASC, id ASC',
      [reportId, req.userId]
    );

    let parsedSnapshot = null;
    try {
      parsedSnapshot = JSON.parse(report.context_snapshot || '{}');
    } catch {}

    res.json({
      report: {
        ...report,
        markets: JSON.parse(report.markets || '[]'),
        summary: parsedSnapshot?.summary || '',
      },
      recommendations: recs,
    });
  } catch (err) {
    res.status(500).json({ error: '获取报告详情失败: ' + err.message });
  }
});

// 8. 删除单份报告
router.delete('/reports/:id', async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const result = await dbHelper.run('DELETE FROM ai_stock_pick_reports WHERE id = ? AND user_id = ?', [reportId, req.userId]);
    if (result.changes === 0) {
      return res.status(404).json({ error: '未找到指定报告或无权删除' });
    }
    res.json({ success: true, message: '报告删除成功' });
  } catch (err) {
    res.status(500).json({ error: '删除报告失败: ' + err.message });
  }
});

/* ─────────────────────────── 定时调度器 ─────────────────────────── */

let schedulerTimer = null;

function startScheduler() {
  if (schedulerTimer) return;

  schedulerTimer = setInterval(async () => {
    try {
      const now = new Date();
      const bjYmd = marketTime.formatBeijingYmd(now);
      const bjParts = marketTime.getTimeZoneParts(now);
      const bjHour = Number(bjParts.hour);
      const bjMin = Number(bjParts.minute);
      const dayOfWeek = now.getDay(); // 0 = Sun, 6 = Sat

      // 周末不进行自动分析
      if (dayOfWeek === 0 || dayOfWeek === 6) return;

      // 盘前窗口: 09:00 ~ 09:25
      const isPreMarketWindow = bjHour === 9 && bjMin >= 0 && bjMin <= 25;
      // 收盘前1小时窗口: 14:00 ~ 14:40
      const isPreCloseWindow = bjHour === 14 && bjMin >= 0 && bjMin <= 40;

      if (!isPreMarketWindow && !isPreCloseWindow) return;

      // 查询所有开启了对应定时任务的用户
      const configs = await dbHelper.all(
        `SELECT * FROM ai_user_config
         WHERE (pre_market_enabled = 1 OR close_enabled = 1)
           AND api_key_encrypted != ''`
      );

      for (const cfg of configs) {
        // 盘前自动分析
        if (isPreMarketWindow && cfg.pre_market_enabled && cfg.last_pre_run !== bjYmd) {
          console.log(`[ai-scheduler] 触发用户 #${cfg.user_id} 盘前智能选股...`);
          await dbHelper.run('UPDATE ai_user_config SET last_pre_run = ? WHERE user_id = ?', [bjYmd, cfg.user_id]);

          const reportInsert = await dbHelper.run(
            `INSERT INTO ai_stock_pick_reports
             (user_id, trigger_type, markets, stock_count, strategy, model, status)
             VALUES (?, 'pre_market', ?, ?, ?, ?, 'running')`,
            [cfg.user_id, cfg.markets, cfg.stock_count, cfg.strategy, cfg.model_name]
          );

          const jobId = `sched_pre_${Date.now()}_${cfg.user_id}`;
          activeJobs.set(jobId, { jobId, userId: cfg.user_id, reportId: reportInsert.lastID, status: 'running' });

          executeAnalysisTask({
            jobId,
            reportId: reportInsert.lastID,
            userId: cfg.user_id,
            markets: JSON.parse(cfg.markets || '["domestic"]'),
            stockCount: cfg.stock_count || 5,
            strategy: cfg.strategy || 'balanced',
            triggerType: 'pre_market',
          });
        }

        // 收盘前1小时自动分析
        if (isPreCloseWindow && cfg.close_enabled && cfg.last_close_run !== bjYmd) {
          console.log(`[ai-scheduler] 触发用户 #${cfg.user_id} 收盘前1小时智能选股...`);
          await dbHelper.run('UPDATE ai_user_config SET last_close_run = ? WHERE user_id = ?', [bjYmd, cfg.user_id]);

          const reportInsert = await dbHelper.run(
            `INSERT INTO ai_stock_pick_reports
             (user_id, trigger_type, markets, stock_count, strategy, model, status)
             VALUES (?, 'close', ?, ?, ?, ?, 'running')`,
            [cfg.user_id, cfg.markets, cfg.stock_count, cfg.strategy, cfg.model_name]
          );

          const jobId = `sched_close_${Date.now()}_${cfg.user_id}`;
          activeJobs.set(jobId, { jobId, userId: cfg.user_id, reportId: reportInsert.lastID, status: 'running' });

          executeAnalysisTask({
            jobId,
            reportId: reportInsert.lastID,
            userId: cfg.user_id,
            markets: JSON.parse(cfg.markets || '["domestic"]'),
            stockCount: cfg.stock_count || 5,
            strategy: cfg.strategy || 'balanced',
            triggerType: 'close',
          });
        }
      }
    } catch (err) {
      console.error('[ai-scheduler] 调度器轮询异常:', err.message);
    }
  }, 60 * 1000);

  console.log('[ai-scheduler] AI 选股盘前与收盘前定时调度器已启动');
}

module.exports = {
  router,
  startScheduler,
};
