require('dotenv').config();
const FlexSearch = require('flexsearch');
const express = require('express');
const cors = require('cors');
const { ChromaClient } = require('chromadb');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const ss = require('simple-statistics');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ========== 全局变量 ==========
let collection = null;
let bm25Index = null;
let allDocuments = [];
let hybridIndex = null;
let hybridDocuments = [];
let rawDataCache = { national: [], province: [], city: [] };
let metricNameList = [];
const sessionHistories = new Map();
const MAX_HISTORY = Math.max(1, parseInt(process.env.MAX_HISTORY || '6', 10));
const SESSION_TTL_MS = Math.max(1, parseInt(process.env.SESSION_TTL_MINUTES || '30', 10)) * 60 * 1000;
const MAX_SESSIONS = Math.max(10, parseInt(process.env.MAX_SESSIONS || '500', 10));
const DISABLE_HISTORY = process.env.DISABLE_HISTORY === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.MODEL_NAME || 'deepseek-r1:7b';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
const OLLAMA_FAST_MODEL = process.env.OLLAMA_FAST_MODEL || 'deepseek-r1:7b';

// DeepSeek API 配置（优先使用，没有 Key 时自动降级到本地 Ollama）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const USE_DEEPSEEK_API = !!DEEPSEEK_API_KEY;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS origin denied'));
    }
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 数据接口 ==========
app.get('/api/data', async (req, res) => {
    try {
        const dataPath = path.join(__dirname, 'data.json');
        const data = await fs.readFile(dataPath, 'utf-8');
        res.json(JSON.parse(data));
    } catch (err) {
        console.error('读取 data.json 失败:', err);
        res.status(500).json({ error: '读取数据文件失败' });
    }
});

// ========== 辅助函数 ==========
function cleanMetricName(key) {
    return key.replace(/[（(].*?[）)]/g, '').trim();
}

function formatValue(val) {
    if (val === undefined || val === null) return '无数据';
    if (Number.isInteger(val)) return val.toString();
    return parseFloat(val.toFixed(4)).toString();
}

function sanitizeSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return 'default';
    const clean = sessionId.trim();
    return /^[a-zA-Z0-9_-]{1,80}$/.test(clean) ? clean : null;
}

function validateQuestion(question) {
    if (typeof question !== 'string') return '问题必须是字符串';
    const clean = question.trim();
    if (!clean) return '请提供问题';
    if (clean.length > 1000) return '问题过长，请控制在1000字以内';
    return null;
}

function cleanupExpiredSessions() {
    if (DISABLE_HISTORY) {
        sessionHistories.clear();
        return;
    }
    const now = Date.now();
    for (const [key, history] of sessionHistories.entries()) {
        const lastAccess = history._lastAccess || history[history.length - 1]?.ts || 0;
        if (!lastAccess || now - lastAccess > SESSION_TTL_MS) {
            sessionHistories.delete(key);
        }
    }
    if (sessionHistories.size <= MAX_SESSIONS) return;
    const removable = [...sessionHistories.entries()]
        .sort((a, b) => (a[1]._lastAccess || 0) - (b[1]._lastAccess || 0));
    while (sessionHistories.size > MAX_SESSIONS && removable.length) {
        sessionHistories.delete(removable.shift()[0]);
    }
}

function getSessionHistory(sessionId) {
    if (DISABLE_HISTORY) return [];
    cleanupExpiredSessions();
    const key = sanitizeSessionId(sessionId) || 'default';
    if (!sessionHistories.has(key)) {
        sessionHistories.set(key, []);
    }
    const history = sessionHistories.get(key);
    history._lastAccess = Date.now();
    return history;
}

function pushSessionHistory(sessionId, role, content, meta = null) {
    if (DISABLE_HISTORY) return [];
    const history = getSessionHistory(sessionId);
    const item = { role, content: String(content || '').slice(0, 1200), ts: Date.now() };
    if (meta && typeof meta === 'object') item.meta = meta;
    history.push(item);
    history._lastAccess = item.ts;
    if (history.length > MAX_HISTORY * 2) {
        history.splice(0, history.length - MAX_HISTORY * 2);
    }
    return history;
}

function normalizeToolName(tool) {
    const map = {
        query_trend: 'trend_analysis',
        compare_regions: 'compare',
        predict_future: 'forecast',
        rank_provinces: 'get_ranking',
        query_point: 'point_query'
    };
    return map[tool] || tool;
}

function getForecastInterval(history, forecastValue, targetYear = null) {
    if (!history || history.length < 3 || typeof forecastValue !== 'number') return null;
    const diffs = [];
    for (let i = 1; i < history.length; i++) diffs.push(history[i].value - history[i - 1].value);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const variance = diffs.reduce((s, d) => s + Math.pow(d - mean, 2), 0) / Math.max(1, diffs.length - 1);
    const latestYear = history[history.length - 1]?.year || 0;
    const step = Math.max(1, Math.abs((targetYear || latestYear + 1) - latestYear));
    const band = Math.max(Math.sqrt(variance) * 1.64 * Math.sqrt(step), Math.abs(forecastValue) * 0.03 * Math.sqrt(step));
    return {
        lower: Number((forecastValue - band).toFixed(4)),
        upper: Number((forecastValue + band).toFixed(4)),
        confidenceLabel: history.length < 5 ? '偏低' : step >= 4 ? '偏低' : step >= 2 ? '中等' : '较高'
    };
}

// 安全解析 LLM 返回的 JSON，多层容错
function safeParseJSON(raw) {
    if (!raw || typeof raw !== 'string') return null;
    // 去除 think 标签（deepseek-r1 特有）
    let str = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // 去除 markdown 代码块
    str = str.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    // 提取第一个 { } 块
    const start = str.indexOf('{');
    const end = str.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    str = str.slice(start, end + 1);
    // 修复尾随逗号
    str = str.replace(/,(\s*[}\]])/g, '$1');
    // 修复 order 未加引号
    str = str.replace(/(["']?order["']?\s*:\s*)([a-zA-Z]+)([,\s}])/gi, '$1"$2"$3');
    // 补缺失的右括号
    let open = 0, close = 0;
    for (const ch of str) { if (ch === '{') open++; if (ch === '}') close++; }
    while (close < open) { str += '}'; close++; }
    try { return JSON.parse(str); } catch (e) { return null; }
}

async function generateSync(prompt, timeoutMs = OLLAMA_TIMEOUT_MS) {
    if (USE_DEEPSEEK_API) {
        return generateDeepSeek(prompt, timeoutMs);
    }
    return generateOllama(prompt, timeoutMs);
}

// DeepSeek 官方 API（有 Key 时使用）
async function generateDeepSeek(prompt, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 2048,
                temperature: 0.18,
                stream: false
            })
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`DeepSeek API ${response.status}: ${err.slice(0, 200)}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`DeepSeek API 超时（${timeoutMs}ms）`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// 本地 Ollama（无 Key 时降级使用）
async function generateOllama(prompt, timeoutMs = OLLAMA_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                options: { temperature: 0.18, top_p: 0.82, num_ctx: 4096 }
            })
        });
        if (!response.ok) throw new Error(`Ollama ${response.status}`);
        const data = await response.json();
        return data.response || '';
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Ollama 生成超时（${timeoutMs}ms）`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// 快速调用（路由/实体提取/压缩等轻量任务）
async function generateFast(prompt, timeoutMs = 15000) {
    if (USE_DEEPSEEK_API) {
        // API 调用速度已经很快，直接复用，超时缩短
        return generateDeepSeek(prompt, Math.min(timeoutMs, 20000));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: OLLAMA_FAST_MODEL,
                prompt,
                stream: false,
                options: { temperature: 0.1, top_p: 0.8, num_ctx: 2048 }
            })
        });
        if (!response.ok) throw new Error(`Ollama fast ${response.status}`);
        const data = await response.json();
        return data.response || '';
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`快速模型超时（${timeoutMs}ms）`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function getEmbedding(text) {
    const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
        model: OLLAMA_EMBED_MODEL,
        prompt: String(text || '').slice(0, 4000)
    }, { timeout: OLLAMA_TIMEOUT_MS });
    if (!Array.isArray(response.data?.embedding)) {
        throw new Error('Ollama embedding 返回为空');
    }
    return response.data.embedding;
}

function normalizeText(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9&‰%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSearchTerms(text = '') {
    const normalized = normalizeText(text);
    const terms = new Set();
    normalized.split(/\s+/).filter(Boolean).forEach(t => terms.add(t));
    const compact = normalized.replace(/\s+/g, '');
    for (let i = 0; i < compact.length - 1; i++) {
        const bi = compact.slice(i, i + 2);
        if (/[\u4e00-\u9fa5]/.test(bi)) terms.add(bi);
    }
    return [...terms];
}

function lexicalOverlapScore(query, text) {
    const qTerms = getSearchTerms(query).filter(t => t.length >= 2);
    if (!qTerms.length) return 0;
    const hay = normalizeText(text);
    let hit = 0;
    for (const term of qTerms) {
        if (hay.includes(term)) hit += term.length > 3 ? 1.35 : 1;
    }
    return hit / Math.max(4, qTerms.length);
}

// ========== 加载原始数据 ==========
async function loadDataCache() {
    if (rawDataCache.province.length > 0) return;
    const dataPath = path.join(__dirname, 'data.json');
    const rawData = await fs.readFile(dataPath, 'utf-8');
    const fullData = JSON.parse(rawData);
    rawDataCache.national = fullData['全国'] || [];
    rawDataCache.province = fullData['省份'] || [];
    rawDataCache.city = fullData['地级市'] || [];
    const sampleRow = rawDataCache.province[0];
    if (sampleRow) {
        metricNameList = Object.keys(sampleRow).filter(key => {
            if (key === '年份' || key === '地区') return false;
            return typeof sampleRow[key] === 'number';
        });
        console.log(`📊 共加载 ${metricNameList.length} 个指标：${metricNameList.slice(0,5).join('、')}...`);
    }
    console.log(`📊 数据缓存完成`);
}

function buildMetricSnapshot(row, maxMetrics = 8) {
    return metricNameList
        .filter(metric => typeof row[metric] === 'number' && !Number.isNaN(row[metric]))
        .slice(0, maxMetrics)
        .map(metric => `${cleanMetricName(metric)}=${formatValue(row[metric])}`)
        .join('，');
}

function getRelevantMetrics(question = '', entities = {}) {
    const q = String(question);
    const preferred = [];
    if (entities.metrics?.[0]) preferred.push(entities.metrics[0]);
    if (/(教育|高校|大学|人才|受教育)/.test(q)) {
        preferred.push('普通高校数量', '人均受教育年限', '教育支出水平', '万人大学生数', '普通高校专任教师数与在校学生数之比');
    }
    if (/(人工智能|AI|智能化|机器人|数字化)/i.test(q)) {
        preferred.push('人工智能应用水平', '工业机器人密度', '互联网普及度', '信息传输计算机软件业从业人员数/年末从业人员数');
    }
    if (/(创新|专利|研发|科研|R&D)/i.test(q)) {
        preferred.push('发明专利授予数', '实用新型专利申请授权数', '科学支出水平', 'R&D人员/年末从业人员数');
    }
    const resolved = [];
    for (const name of preferred) {
        const real = metricNameList.find(m => m === name || cleanMetricName(m) === cleanMetricName(name) || m.includes(name) || name.includes(cleanMetricName(m)));
        if (real && !resolved.includes(real)) resolved.push(real);
    }
    for (const metric of metricNameList) {
        if (!resolved.includes(metric)) resolved.push(metric);
    }
    return resolved;
}

function buildRelevantMetricSnapshot(row, question = '', entities = {}, maxMetrics = 8) {
    return getRelevantMetrics(question, entities)
        .filter(metric => typeof row[metric] === 'number' && !Number.isNaN(row[metric]))
        .slice(0, maxMetrics)
        .map(metric => `${cleanMetricName(metric)}=${formatValue(row[metric])}`)
        .join('，');
}

function buildHybridKnowledgeIndex() {
    hybridDocuments = [];
    let id = 0;
    const sources = [
        { table: '全国', rows: rawDataCache.national },
        { table: '省份', rows: rawDataCache.province },
        { table: '地级市', rows: rawDataCache.city }
    ];

    for (const source of sources) {
        for (const row of source.rows || []) {
            const region = row['地区'] || '全国';
            const year = row['年份'];
            if (!year) continue;
            const metricText = buildMetricSnapshot(row, 19);
            const text = `${source.table}数据 ${region} ${year}年：${metricText}`;
            hybridDocuments.push({
                id: id++,
                text,
                table: source.table,
                region,
                year,
                row
            });
        }
    }

    hybridIndex = new FlexSearch.Index({
        tokenize: 'full',
        resolution: 9,
        cache: 100
    });
    hybridDocuments.forEach(doc => hybridIndex.add(doc.id, doc.text));
    console.log(`✅ 本地混合知识索引构建完成 (${hybridDocuments.length}条)`);
}

// ========== 字段匹配（精确优先） ==========
function findRealKey(rows, metric) {
    if (!rows || !rows.length) return null;
    const sample = rows[0];
    const cleanMetric = cleanMetricName(metric);
    // 1. 精确匹配
    if (sample[metric] !== undefined) return metric;
    // 2. 去括号精确匹配
    const exact = Object.keys(sample).find(k =>
        k !== '年份' && k !== '地区' && cleanMetricName(k) === cleanMetric
    );
    if (exact) return exact;
    // 3. 包含匹配（短的在长的里）
    return Object.keys(sample).find(k =>
        k !== '年份' && k !== '地区' &&
        (cleanMetricName(k).includes(cleanMetric) || cleanMetric.includes(cleanMetricName(k)))
    ) || null;
}

function getLatestYear(rows) {
    if (!rows || !rows.length) return 2023;
    const years = rows.map(r => r['年份']).filter(y => typeof y === 'number');
    return years.length ? Math.max(...years) : 2023;
}

function parseYearRange(text = '') {
    const q = String(text || '');
    const rangeMatch = q.match(/(20\d{2})\s*(?:年)?\s*(?:到|至|—|-|~|～|--|－)\s*(20\d{2})\s*(?:年)?/);
    if (!rangeMatch) return null;
    let start = parseInt(rangeMatch[1], 10);
    let end = parseInt(rangeMatch[2], 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start > end) [start, end] = [end, start];
    if (end - start > 80) return null;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// ========== 工具函数 ==========
function getRanking(metric, year, order = 'desc', topN = 10, table = 'province') {
    const rows = table === 'national' ? rawDataCache.national
               : table === 'city' ? rawDataCache.city
               : rawDataCache.province;
    if (!rows.length) return [];
    if (!year) year = getLatestYear(rows);
    const realKey = findRealKey(rows, metric);
    if (!realKey) { console.warn(`getRanking: 找不到字段 "${metric}"`); return []; }
    console.log(`getRanking: "${metric}" → "${realKey}", year=${year}`);
    const yearData = rows.filter(r => r['年份'] === year);
    const valid = yearData
        .map(r => ({ region: r['地区'] || '全国', value: r[realKey] }))
        .filter(item => typeof item.value === 'number' && !isNaN(item.value));
    valid.sort((a, b) => order === 'desc' ? b.value - a.value : a.value - b.value);
    return valid.slice(0, topN);
}

function getHistoricalData(metric, region, yearsBack = 10) {
    const isNational = !region || region === '全国';
    const sourceRows = isNational ? rawDataCache.national : rawDataCache.province;
    const realKey = findRealKey(sourceRows, metric) || metric;
    const rows = sourceRows.filter(r =>
        (isNational || r['地区'] === region) && typeof r[realKey] === 'number'
    ).sort((a, b) => a['年份'] - b['年份']);
    const result = rows.map(r => ({ year: r['年份'], value: r[realKey] }));
    return yearsBack && result.length > yearsBack ? result.slice(-yearsBack) : result;
}

function holtLinearForecast(data, targetYear, alpha = 0.5, beta = 0.5) {
    if (!data || data.length < 2) return null;
    let level = data[0].value, trend = data[1].value - data[0].value;
    for (let i = 1; i < data.length; i++) {
        const prev = level;
        level = alpha * data[i].value + (1 - alpha) * (level + trend);
        trend = beta * (level - prev) + (1 - beta) * trend;
    }
    const steps = targetYear - data[data.length - 1].year;
    return steps <= 0 ? data[data.length - 1].value : level + steps * trend;
}

function linearRegressionForecast(data, targetYear) {
    if (!data || data.length < 2) return null;
    const xs = data.map(d => d.year);
    const ys = data.map(d => d.value);
    const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const denom = xs.reduce((s, x) => s + Math.pow(x - xMean, 2), 0);
    if (!denom) return ys[ys.length - 1];
    const slope = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0) / denom;
    const intercept = yMean - slope * xMean;
    return intercept + slope * targetYear;
}

function driftForecast(data, targetYear) {
    if (!data || data.length < 2) return null;
    const first = data[0], last = data[data.length - 1];
    const span = Math.max(1, last.year - first.year);
    const drift = (last.value - first.value) / span;
    return last.value + drift * (targetYear - last.year);
}

function movingAverageForecast(data, targetYear) {
    if (!data || data.length < 2) return null;
    const windowSize = Math.min(4, data.length);
    const recent = data.slice(-windowSize);
    const avg = recent.reduce((s, d) => s + d.value, 0) / recent.length;
    const recentTrend = recent.length >= 2
        ? (recent[recent.length - 1].value - recent[0].value) / Math.max(1, recent[recent.length - 1].year - recent[0].year)
        : 0;
    return avg + recentTrend * Math.max(0, targetYear - data[data.length - 1].year);
}

function scoreForecastMethod(data, methodFn) {
    if (!data || data.length < 5) return { rmse: Infinity, mape: Infinity };
    const holdout = Math.min(3, Math.floor(data.length / 3));
    const errors = [];
    const pctErrors = [];
    for (let i = data.length - holdout; i < data.length; i++) {
        const train = data.slice(0, i);
        const pred = methodFn(train, data[i].year);
        if (typeof pred !== 'number' || Number.isNaN(pred)) continue;
        const err = pred - data[i].value;
        errors.push(err * err);
        if (Math.abs(data[i].value) > 1e-9) pctErrors.push(Math.abs(err / data[i].value));
    }
    if (!errors.length) return { rmse: Infinity, mape: Infinity };
    return {
        rmse: Math.sqrt(errors.reduce((a, b) => a + b, 0) / errors.length),
        mape: pctErrors.length ? pctErrors.reduce((a, b) => a + b, 0) / pctErrors.length : null
    };
}

function getMetricForecastProfile(metric = '') {
    const name = String(metric);
    if (/(高校数量|图书馆个数|专利|人数|人员|藏书)/.test(name)) {
        return '计数型指标，预测值已做非负约束，优先比较近期误差，避免给出不合理的负数。';
    }
    if (/(比|率|水平|普及度|强度|密度|年限|结构)/.test(name)) {
        return '比例/强度型指标，优先选择回测误差较低且不过度放大短期波动的方法。';
    }
    return '连续型年度指标，综合长期趋势、近期变化和回测误差选择预测方法。';
}

function chooseForecastModel(data, targetYear, metric = '') {
    if (!data || data.length < 2) {
        return { value: null, method: 'insufficient', methodLabel: '数据不足', methodReason: '至少需要2个年份的数据才能进行外推。', backtest: null };
    }
    const allNonNegative = data.every(d => d.value >= 0);
    const profile = getMetricForecastProfile(metric);
    const candidates = [
        { method: 'linear_regression', methodLabel: '线性回归趋势预测', fn: linearRegressionForecast, methodReason: '适合长期趋势较稳定、指标随年份呈近似线性变化的数据。' },
        { method: 'holt_linear', methodLabel: 'Holt线性指数平滑', fn: holtLinearForecast, methodReason: '适合存在趋势但短期波动也需要被平滑处理的年度时间序列。' },
        { method: 'drift', methodLabel: '平均漂移外推', fn: driftForecast, methodReason: '适合样本较少或趋势变化不宜过度拟合的数据。' },
        { method: 'moving_average_trend', methodLabel: '近年移动均值趋势外推', fn: movingAverageForecast, methodReason: '适合近期走势比早期数据更有参考价值的指标。' }
    ];
    const scored = candidates.map(c => {
        const rawValue = c.fn(data, targetYear);
        const value = allNonNegative && typeof rawValue === 'number' ? Math.max(0, rawValue) : rawValue;
        const backtest = scoreForecastMethod(data, c.fn);
        return { ...c, value, backtest };
    }).filter(c => typeof c.value === 'number' && !Number.isNaN(c.value));

    scored.sort((a, b) => {
        const ar = Number.isFinite(a.backtest.rmse) ? a.backtest.rmse : Number.MAX_SAFE_INTEGER;
        const br = Number.isFinite(b.backtest.rmse) ? b.backtest.rmse : Number.MAX_SAFE_INTEGER;
        return ar - br;
    });

    const best = scored[0] || candidates[2];
    return {
        value: best.value,
        method: best.method,
        methodLabel: best.methodLabel,
        methodReason: `${best.methodReason}${profile}`,
        backtest: best.backtest && Number.isFinite(best.backtest.rmse)
            ? {
                rmse: Number(best.backtest.rmse.toFixed(4)),
                mape: best.backtest.mape == null ? null : Number((best.backtest.mape * 100).toFixed(2))
            }
            : null
    };
}

function buildForecastPath(data, targetYear, forecastModel, metric = '') {
    if (!data?.length || !forecastModel || !forecastModel.method) return [];
    const latestYear = data[data.length - 1].year;
    if (!targetYear || targetYear <= latestYear) return [];
    const methodFns = {
        linear_regression: linearRegressionForecast,
        holt_linear: holtLinearForecast,
        drift: driftForecast,
        moving_average_trend: movingAverageForecast
    };
    const fn = methodFns[forecastModel.method] || movingAverageForecast;
    const allNonNegative = data.every(d => d.value >= 0);
    const path = [];
    for (let year = latestYear + 1; year <= targetYear; year++) {
        let value = fn(data, year);
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        if (allNonNegative) value = Math.max(0, value);
        path.push({ year, value: Number(value.toFixed(4)), estimated: true });
    }
    return path;
}

function buildForecastMeta(history, targetYear, forecastModel, metric = '') {
    const latestYear = history?.[history.length - 1]?.year || null;
    const step = latestYear ? Math.max(0, targetYear - latestYear) : 0;
    const path = buildForecastPath(history, targetYear, forecastModel, metric);
    return {
        latestActualYear: latestYear,
        forecastStep: step,
        forecastType: step <= 1 ? '单步预测' : '多步预测',
        usesActualIntermediateData: false,
        path,
        caution: step <= 1
            ? '目标年份紧邻最新真实年份，属于单步外推。'
            : `当前数据最新到${latestYear}年，${targetYear}年是向后${step}步外推；中间年份为模型路径估计，不是真实观测值。`
    };
}

// ========== 实体提取 ==========

// 原始 regex 版本（兜底用）
function extractEntities(question) {
    const entities = { regions: [], metrics: [], years: [] };
    if (/(全国|全国范围|全国层面|国内整体|中国整体|全国整体)/.test(question)) {
        entities.regions.push('全国');
    }

    // 地区大类词典（不依赖LLM，直接展开）
    const regionGroupMap = {
        '华东': ['上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省'],
        '华南': ['广东省', '广西壮族自治区', '海南省'],
        '华北': ['北京市', '天津市', '河北省', '山西省', '内蒙古自治区'],
        '华中': ['河南省', '湖北省', '湖南省'],
        '东北': ['辽宁省', '吉林省', '黑龙江省'],
        '西南': ['重庆市', '四川省', '贵州省', '云南省', '西藏自治区'],
        '西北': ['陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区'],
        '经济强省': ['广东省', '江苏省', '浙江省', '山东省', '北京市', '上海市'],
        '发达省份': ['广东省', '江苏省', '浙江省', '山东省', '北京市', '上海市'],
        '沿海省份': ['广东省', '江苏省', '浙江省', '福建省', '山东省', '上海市', '天津市', '河北省', '辽宁省', '海南省']
    };
    for (const [group, provinces] of Object.entries(regionGroupMap)) {
        if (question.includes(group)) {
            for (const p of provinces) {
                if (!entities.regions.includes(p)) entities.regions.push(p);
            }
        }
    }
    const regionMap = {
        '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
        '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
        '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
        '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
        '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
        '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
        '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
        '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
        '青海': '青海省'
    };
    const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))];
    for (const p of provinceList) { if (question.includes(p)) entities.regions.push(p); }
    for (const [short, full] of Object.entries(regionMap)) {
        if (question.includes(short) && !entities.regions.includes(full)) entities.regions.push(full);
    }
    for (const m of metricNameList) {
        if (question.includes(m) || question.includes(cleanMetricName(m))) entities.metrics.push(m);
    }
    if (!entities.metrics.length && /(教育水平|高校|大学|高等教育|学校|人工智能|AI|智能化|机器人|创新|专利|发明|知识产权|数字化|互联网|科研|研发|R&D)/i.test(question)) {
        const inferred = inferMetric(question);
        if (inferred && !entities.metrics.includes(inferred)) entities.metrics.push(inferred);
    }
    const yearRange = parseYearRange(question);
    if (yearRange) {
        entities.years = yearRange;
    } else {
        const years = question.match(/20\d{2}/g);
        if (years) entities.years = [...new Set(years.map(y => parseInt(y)))];
    }
    return entities;
}

// LLM 实体提取（语义理解，识别"华东"、"经济强省"等模糊表达）
async function llmExtractEntities(question, recentHistory = []) {
    const metricHints = metricNameList.slice(0, 40).map(cleanMetricName).join('、');
    const historyHint = recentHistory.slice(-4)
        .map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 120)}`)
        .join('\n');
    const prompt = `你是实体提取器，从用户问题中提取结构化信息。只返回 JSON，不要解释，不要 <think>，不要 Markdown。

可用指标（选最匹配的，不要编造）：${metricHints}

省份规范名示例：广东省、江苏省、浙江省、山东省、北京市、上海市、全国
地区大类展开规则（必须展开为具体省份）：
- 华东 → 上海市、江苏省、浙江省、安徽省、福建省、江西省、山东省
- 华南 → 广东省、广西壮族自治区、海南省
- 华北 → 北京市、天津市、河北省、山西省、内蒙古自治区
- 华中 → 河南省、湖北省、湖南省
- 东北 → 辽宁省、吉林省、黑龙江省
- 西南 → 重庆市、四川省、贵州省、云南省
- 经济强省/发达省份 → 广东省、江苏省、浙江省、山东省、北京市、上海市

最近对话：
${historyHint || '无'}

用户问题：${question}

返回格式（严格 JSON）：
{
  "regions": ["地区名（省份全称或全国，如有）"],
  "metrics": ["最匹配的指标名（从可用指标里选，最多2个）"],
  "years": [年份数字数组，如有],
  "intent_hint": "trend|forecast|ranking|compare|point|chat 之一"
}`;

    try {
        const raw = await generateFast(prompt, 15000);
        const parsed = safeParseJSON(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const regionMap = {
            '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
            '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
            '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
            '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
            '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
            '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
            '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
            '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
            '青海': '青海省'
        };
        const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))];

        const normalizedRegions = (parsed.regions || []).map(r => {
            if (r === '全国') return '全国';
            if (provinceList.includes(r)) return r;
            if (regionMap[r]) return regionMap[r];
            for (const [short, full] of Object.entries(regionMap)) {
                if (r.includes(short)) return full;
            }
            return r;
        }).filter(Boolean);

        const normalizedMetrics = (parsed.metrics || []).map(m => {
            const cleanM = cleanMetricName(m);
            const exact = metricNameList.find(ml => ml === m || cleanMetricName(ml) === cleanM);
            if (exact) return exact;
            const partial = metricNameList.find(ml =>
                cleanMetricName(ml).includes(cleanM) || cleanM.includes(cleanMetricName(ml))
            );
            return partial || null;
        }).filter(Boolean);

        const normalizedYears = (parsed.years || [])
            .map(y => parseInt(y))
            .filter(y => Number.isFinite(y) && y >= 1990 && y <= 2100);

        return {
            regions: normalizedRegions,
            metrics: normalizedMetrics,
            years: normalizedYears,
            intent_hint: parsed.intent_hint || null
        };
    } catch (err) {
        console.warn('LLM 实体提取失败，回退 regex:', err.message);
        return null;
    }
}

// LLM 优先，regex 兜底的异步版本（供 runAgent 调用）
async function extractEntitiesAsync(question, recentHistory = []) {
    const llmResult = await llmExtractEntities(question, recentHistory);
    if (llmResult && (llmResult.regions.length || llmResult.metrics.length || llmResult.years.length)) {
        const yearRange = parseYearRange(question);
        if (yearRange && yearRange.length > llmResult.years.length) {
            llmResult.years = yearRange;
        }
        if (!llmResult.metrics.length) {
            const inferred = inferMetric(question);
            if (inferred) llmResult.metrics.push(inferred);
        }
        console.log('✅ LLM 实体提取:', JSON.stringify(llmResult));
        return llmResult;
    }
    console.warn('⚠️ LLM 实体提取无结果，使用 regex 兜底');
    return extractEntities(question);
}

// 对话历史摘要压缩：当历史过长时压缩旧内容，避免 context 超限
async function compressHistoryIfNeeded(history, maxTokenEstimate = 2000) {
    if (!history || history.length <= 4) return history;
    const totalChars = history.reduce((sum, h) => sum + String(h.content || '').length, 0);
    const estimatedTokens = Math.ceil(totalChars / 1.5);
    if (estimatedTokens <= maxTokenEstimate) return history;

    const toCompress = history.slice(0, Math.floor(history.length / 2));
    const toKeep = history.slice(Math.floor(history.length / 2));
    const histText = toCompress
        .map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 300)}`)
        .join('\n');
    const prompt = `请将以下对话历史压缩成一段不超过200字的摘要，保留关键的地区、指标、年份和结论，供后续对话参考。只输出摘要文字，不要其他内容。

对话历史：
${histText}

摘要：`;
    try {
        const raw = await generateFast(prompt, 12000);
        const summary = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (summary && summary.length > 10) {
            console.log('📝 历史已压缩，原长度:', toCompress.length, '条');
            return [
                { role: 'assistant', content: `[历史摘要] ${summary}`, ts: Date.now() },
                ...toKeep
            ];
        }
    } catch (err) {
        console.warn('历史压缩失败，使用原始截取:', err.message);
    }
    return toKeep;
}

function inferMetric(text) {
    const synonymGroups = [
        { keys: ['教育水平', '高校', '大学', '高等教育', '学校'], metrics: ['普通高校数量', 'R&D经费投入强度'] },
        { keys: ['人工智能普及', '智能化', 'ai普及', 'AI普及', '人工智能'], metrics: ['人工智能应用水平', '工业机器人密度'] },
        { keys: ['创新能力', '专利', '发明', '知识产权'], metrics: ['发明专利授予数', '实用新型专利申请授权数'] },
        { keys: ['数字化', '互联网', '网络普及'], metrics: ['互联网普及度'] },
        { keys: ['科研投入', '研发投入', 'R&D', '研发'], metrics: ['R&D经费投入强度', '科学支出水平'] }
    ];
    for (const group of synonymGroups) {
        if (group.keys.some(k => text.includes(k))) {
            for (const name of group.metrics) {
                const matched = metricNameList.find(m => m.includes(name) || cleanMetricName(m).includes(name));
                if (matched) return matched;
            }
        }
    }
    if (text.includes('机器人')) return metricNameList.find(m => m.includes('机器人')) || '工业机器人密度';
    if (text.includes('科学') || text.includes('支出')) return metricNameList.find(m => m.includes('科学')) || '科学支出水平';
    if (text.includes('专利')) return metricNameList.find(m => m.includes('专利')) || '实用新型专利申请授权数';
    if (text.includes('互联网') || text.includes('普及')) return metricNameList.find(m => m.includes('互联网')) || '互联网普及度';
    if (text.includes('高校') || text.includes('大学')) return metricNameList.find(m => m.includes('高校')) || '普通高校数量';
    if (text.includes('R&D') || text.includes('研发')) return metricNameList.find(m => m.includes('R&D') || m.includes('研发')) || 'R&D经费投入强度';
    return metricNameList[0] || '科学支出水平';
}

function expandQueryForRetrieval(question, entities = {}) {
    const additions = [];
    const metric = entities.metrics?.[0] || inferMetric(question);
    if (metric) additions.push(metric, cleanMetricName(metric));
    for (const r of entities.regions || []) additions.push(r);
    for (const y of entities.years || []) additions.push(String(y));
    const synonymHints = [
        ['教育水平', '普通高校数量 人均受教育年限 教育支出水平 万人大学生数'],
        ['人工智能', '人工智能应用水平 工业机器人密度 互联网普及度'],
        ['创新', '发明专利授予数 实用新型专利申请授权数 R&D 科学支出水平'],
        ['数字化', '互联网普及度 信息传输计算机软件业'],
        ['科研', 'R&D人员 科学支出水平 科研综合技术服务业']
    ];
    for (const [key, value] of synonymHints) {
        if (String(question).includes(key)) additions.push(value);
    }
    return `${question} ${additions.join(' ')}`;
}

function rerankHybridDocuments(question, docs, entities = {}) {
    const metric = entities.metrics?.[0] || inferMetric(question);
    const cleanMetric = metric ? cleanMetricName(metric) : '';
    const latestYear = getLatestYear(rawDataCache.province);
    const regionSet = new Set(entities.regions || []);
    const yearSet = new Set((entities.years || []).map(Number));

    return docs.map((doc, idx) => {
        let score = 0;
        score += lexicalOverlapScore(question, doc.text) * 5;
        if (cleanMetric && doc.text.includes(cleanMetric)) score += 3.2;
        if (metric && doc.text.includes(metric)) score += 3.5;
        if (regionSet.has(doc.region)) score += 3;
        if (!regionSet.size && doc.table === '全国') score += 0.8;
        if (yearSet.has(doc.year)) score += 2.6;
        if (!yearSet.size && doc.year === latestYear) score += 0.9;
        if (doc.table === '省份') score += 0.25;
        score += Math.max(0, 1 - idx / 120) * 0.4;
        return { ...doc, score: Number(score.toFixed(4)) };
    }).sort((a, b) => b.score - a.score);
}

function retrieveBM25Evidence(question, entities = {}, limit = 8) {
    if (!bm25Index || !allDocuments.length) return [];
    const expanded = expandQueryForRetrieval(question, entities);
    const ids = new Set();
    try {
        const found = bm25Index.search(expanded, { limit: Math.min(120, Math.max(limit * 10, 40)) });
        for (const id of found) ids.add(Number(id));
    } catch (err) {
        console.warn('BM25 检索失败:', err.message);
    }
    if (!ids.size) return [];
    const candidates = [...ids]
        .map((id, idx) => {
            const text = allDocuments[id];
            if (!text) return null;
            return {
                text: String(text),
                metadata: {},
                source: 'BM25',
                score: Number((lexicalOverlapScore(question, text) * 5 + Math.max(0, 1 - idx / 120)).toFixed(4))
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
}

function retrieveHybridEvidence(question, entities = {}, limit = 8) {
    if (!hybridIndex || !hybridDocuments.length) return [];
    const expanded = expandQueryForRetrieval(question, entities);
    const ids = new Set();
    try {
        const found = hybridIndex.search(expanded, { limit: 120 });
        for (const id of found) ids.add(Number(id));
    } catch (err) {
        console.warn('Hybrid search failed:', err.message);
    }

    for (const doc of hybridDocuments) {
        if (ids.size >= 180) break;
        const regionHit = !entities.regions?.length || entities.regions.includes(doc.region);
        const yearHit = !entities.years?.length || entities.years.includes(doc.year);
        if (regionHit && yearHit) ids.add(doc.id);
    }

    const candidates = [...ids]
        .map(id => hybridDocuments[id])
        .filter(Boolean);
    return rerankHybridDocuments(question, candidates, entities).slice(0, limit);
}

async function retrieveChromaEvidence(question, entities = {}, limit = 8) {
    if (!collection) return [];
    try {
        const queryEmbedding = await Promise.race([
            getEmbedding(expandQueryForRetrieval(question, entities)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma embedding 超时')), 10000))
        ]);

        // 构建 metadata 过滤条件
        let whereFilter = undefined;
        const hasRegion = entities.regions?.length > 0 && !entities.regions.includes('全国');
        const hasSingleYear = entities.years?.length === 1;

        if (hasRegion && hasSingleYear) {
            whereFilter = {
                '$and': [
                    { 'region': { '$in': entities.regions } },
                    { 'year': { '$eq': entities.years[0] } }
                ]
            };
        } else if (hasRegion) {
            whereFilter = { 'region': { '$in': entities.regions } };
        } else if (hasSingleYear) {
            whereFilter = { 'year': { '$eq': entities.years[0] } };
        }

        const queryParams = {
            queryEmbeddings: [queryEmbedding],
            nResults: Math.min(Math.max(limit * 2, 16), 50)
        };
        if (whereFilter) queryParams.where = whereFilter;

        let result = await Promise.race([
            collection.query(queryParams),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma query 超时')), 8000))
        ]);

        let docs = result?.documents?.[0] || [];
        let metadatas = result?.metadatas?.[0] || [];
        let distances = result?.distances?.[0] || [];

        // 过滤后结果不足时，去掉过滤再补充召回
        if (docs.length < limit && whereFilter) {
            console.log('⚠️ Chroma 过滤后结果不足，去掉过滤重查...');
            const fallbackResult = await Promise.race([
                collection.query({ queryEmbeddings: [queryEmbedding], nResults: limit * 2 }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma fallback 超时')), 8000))
            ]);
            const fbDocs = fallbackResult?.documents?.[0] || [];
            const fbMeta = fallbackResult?.metadatas?.[0] || [];
            const fbDist = fallbackResult?.distances?.[0] || [];
            const seen = new Set(docs);
            fbDocs.forEach((d, i) => {
                if (!seen.has(d)) { seen.add(d); docs.push(d); metadatas.push(fbMeta[i]); distances.push(fbDist[i]); }
            });
        }

        const items = docs
            .map((text, i) => ({ text: String(text || ''), metadata: metadatas[i] || {}, distance: distances[i], source: 'ChromaDB' }))
            .filter(item => item.text.trim())
            .sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1))
            .slice(0, limit);

        console.log(`📡 Chroma 召回 ${items.length} 条，最近距离: ${items[0]?.distance?.toFixed(4) ?? 'N/A'}`);
        return items;
    } catch (err) {
        console.warn(`Chroma 向量检索失败，已回退本地检索: ${err.message}`);
        return [];
    }
}

function isKnowledgeChatQuestion(question) {
    const q = String(question || '');
    if (/(怎么预测|用什么模型|什么算法|置信区间|怎么得出)/.test(q)) return false;
    return /(怎么看|分析一下|解读|评价|说明|为什么|原因|关系|影响|建议|总体|整体|概况|怎么样|是否|能不能|适合|帮我写|总结)/.test(q);
}

function buildEvidenceFallbackAnswer(question, evidence, entities = {}) {
    if (!evidence.length) {
        return '我没有在当前数据集中检索到足够相关的证据。你可以补充地区、年份或指标，我会重新检索。';
    }
    const lines = evidence.slice(0, 5).map((doc, i) =>
        `${i + 1}. ${doc.table}/${doc.region}/${doc.year}：${buildRelevantMetricSnapshot(doc.row, question, entities, 6)}`
    );
    return `**基于本地数据的检索摘要**\n\n${lines.join('\n')}\n\n**说明：**当前回答使用本地混合检索和重排序生成。若本地 DeepSeek 未响应，我会先给出证据摘要，避免编造结论。`;
}

function gradeRetrievedEvidence(question, entities = {}, localEvidence = [], chromaEvidence = []) {
    const metric = entities.metrics?.[0] || inferMetric(question);
    const cleanMetric = metric ? cleanMetricName(metric) : '';
    const regions = entities.regions || [];
    const years = (entities.years || []).map(String);
    const localTopScore = localEvidence[0]?.score || 0;
    // cosine 距离：0=完全相同，2=完全相反；0.5以内为好匹配
    const chromaBestDistance = chromaEvidence
        .map(item => Number(item.distance))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
    const joined = [
        ...localEvidence.slice(0, 5).map(doc => doc.text || ''),
        ...chromaEvidence.slice(0, 5).map(doc => doc.text || '')
    ].join('\n');
    const metricHit = !cleanMetric || joined.includes(cleanMetric) || joined.includes(metric);
    const regionHit = !regions.length || regions.some(region => joined.includes(region));
    const yearHit = !years.length || years.some(year => joined.includes(year));
    const enoughLocal = localEvidence.length >= 3 && localTopScore >= 3.0;
    const enoughVector = chromaEvidence.length >= 2 && (chromaBestDistance == null || chromaBestDistance <= 0.5);
    const passed = (enoughLocal || enoughVector) && metricHit && regionHit && yearHit;
    const reasons = [];
    if (!passed) {
        if (!enoughLocal && !enoughVector) reasons.push('召回数量或相关度不足');
        if (!metricHit) reasons.push('未稳定命中指标');
        if (!regionHit) reasons.push('未稳定命中地区');
        if (!yearHit) reasons.push('未稳定命中年份');
    }
    const chromaScore = chromaEvidence.length ? Math.max(0, 0.2 - (chromaBestDistance ?? 1) * 0.1) : 0;
    return {
        passed,
        score: Number(Math.min(0.96, 0.28 + localTopScore / 10 + chromaScore).toFixed(2)),
        localTopScore,
        chromaBestDistance,
        reasons: reasons.length ? reasons : ['证据数量、相关度和实体命中满足要求']
    };
}

async function rewriteQueryForCorrectiveRag(question, entities = {}, grade = {}) {
    const metric = entities.metrics?.[0] || inferMetric(question);
    const years = entities.years?.length ? entities.years.join(' ') : '';
    const regions = entities.regions?.length ? entities.regions.join(' ') : '';
    const query = [
        question,
        regions,
        metric,
        cleanMetricName(metric),
        years,
        expandQueryForRetrieval(question, entities)
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return {
        query,
        reason: `检索质检未通过（${(grade.reasons || []).join('；') || '相关度不足'}），已用地区、年份、指标和同义词扩展查询后重新召回。`
    };
}

async function retrieveCorrectiveEvidence(question, entities = {}) {
    const firstLocal = retrieveHybridEvidence(question, entities, 8);
    const firstBm25 = retrieveBM25Evidence(question, entities, 5);
    let firstChroma = [];
    let firstGrade = gradeRetrievedEvidence(question, entities, firstLocal, [...firstBm25, ...firstChroma]);
    if (!firstGrade.passed) {
        firstChroma = await retrieveChromaEvidence(question, entities, 5);
        firstGrade = gradeRetrievedEvidence(question, entities, firstLocal, [...firstBm25, ...firstChroma]);
    }
    if (firstGrade.passed) {
        return { evidence: firstLocal, chromaEvidence: [...firstBm25, ...firstChroma], grade: firstGrade, corrected: false, query: question, originalGrade: firstGrade, rewriteReason: '' };
    }

    const rewrite = await rewriteQueryForCorrectiveRag(question, entities, firstGrade);
    const rewrittenEntities = extractEntities(rewrite.query);
    const mergedEntities = {
        ...entities,
        regions: [...new Set([...(entities.regions || []), ...(rewrittenEntities.regions || [])])],
        metrics: [...new Set([...(entities.metrics || []), ...(rewrittenEntities.metrics || [])])],
        years: [...new Set([...(entities.years || []), ...(rewrittenEntities.years || [])])]
    };
    const secondLocal = retrieveHybridEvidence(rewrite.query, mergedEntities, 8);
    const secondBm25 = retrieveBM25Evidence(rewrite.query, mergedEntities, 5);
    let secondChroma = [];
    let secondGrade = gradeRetrievedEvidence(question, mergedEntities, secondLocal, [...secondBm25, ...secondChroma]);
    if (!secondGrade.passed) {
        secondChroma = await retrieveChromaEvidence(rewrite.query, mergedEntities, 5);
        secondGrade = gradeRetrievedEvidence(question, mergedEntities, secondLocal, [...secondBm25, ...secondChroma]);
    }
    const firstVectorEvidence = [...firstBm25, ...firstChroma];
    const secondVectorEvidence = [...secondBm25, ...secondChroma];
    const useSecond = secondGrade.passed || (secondLocal.length + secondVectorEvidence.length) >= (firstLocal.length + firstVectorEvidence.length);
    return {
        evidence: useSecond ? secondLocal : firstLocal,
        chromaEvidence: useSecond ? secondVectorEvidence : firstVectorEvidence,
        grade: useSecond ? secondGrade : firstGrade,
        corrected: true,
        query: rewrite.query,
        originalGrade: firstGrade,
        rewriteReason: rewrite.reason
    };
}

async function answerEvidenceChat(question, entities, recentHistory = []) {
    const corrective = await retrieveCorrectiveEvidence(question, entities);
    const evidence = corrective.evidence;
    const chromaEvidence = corrective.chromaEvidence;

    const evidenceText = evidence.map((doc, i) =>
        `[${i + 1}] ${doc.table}/${doc.region}/${doc.year}: ${buildRelevantMetricSnapshot(doc.row, question, entities, 10)}`
    ).join('\n');
    const chromaText = chromaEvidence.map((doc, i) =>
        `[V${i + 1}] ${doc.text.slice(0, 900)}`
    ).join('\n');
    const historyText = recentHistory
        .slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 220)}`)
        .join('\n');

    let answer = '';
    let usedModel = false;

    if (evidence.length || chromaEvidence.length) {
        const prompt = `你是山东财经大学科研教育人才数据平台的研究助理。请只基于给定证据回答用户问题，不要编造数据。

回答要求：
1. 直接回答用户问题，语气自然，像专业助手在聊天。
2. 用数据支撑结论，但不要把证据列表原样罗列给用户。
3. 如果证据不足以回答，直接说明缺什么，建议用户补充地区、年份或指标。
4. 不要主动推荐数据库或证据没有覆盖的问题方向，例如行业、国外/其他国家、企业、学校明细等。
5. 不要输出<think>，不要提及"检索"、"向量库"、"RAG"等技术术语。
6. 中文回答，结构清晰，适度简洁。

最近对话：
${historyText || '无'}

用户问题：
${question}

数据证据：
${evidenceText}
${chromaText ? '\n补充证据：\n' + chromaText : ''}

请直接回答：`;
        try {
            const raw = await Promise.race([
                generateSync(prompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error('证据生成超过60秒，快速降级')), 60000))
            ]);
            answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            usedModel = !!answer;
        } catch (err) {
            console.warn('证据回答生成失败，使用本地摘要降级:', err.message);
        }
    }

    if (!answer) {
        if (evidence.length) {
            const lines = evidence.slice(0, 4).map(doc => {
                const snapshot = buildRelevantMetricSnapshot(doc.row, question, entities, 5);
                return `**${doc.region}（${doc.year}年）**：${snapshot}`;
            });
            answer = lines.join('\n\n');
            if (corrective.corrected) answer += '\n\n> 已自动扩展检索范围以提高相关度。';
        } else {
            answer = '未检索到足够相关的数据，请尝试补充具体地区、年份或指标重新提问。';
        }
    }

    const citations = [
        ...evidence.slice(0, 5).map((doc, i) => `[${i + 1}] ${doc.table}/${doc.region}/${doc.year}`),
        ...chromaEvidence.slice(0, 3).map((doc, i) => `[V${i + 1}] ChromaDB`)
    ];

    return {
        answer: sanitizeUnsupportedFollowups(answer),
        chart: null,
        citations,
        reasoning: [
            '意图: corrective_rag',
            chromaEvidence.length ? '检索: ChromaDB向量库 + 本地混合索引' : '检索: 本地混合索引',
            corrective.corrected ? '纠正: 查询已自动改写重新检索' : '质检: 初次检索通过',
            `本地证据: ${evidence.length}条`,
            `向量证据: ${chromaEvidence.length}条`,
            usedModel ? '生成: 模型证据归纳' : '生成: 数据摘要降级'
        ],
        confidence: corrective.grade.passed ? 0.84 : ((evidence.length + chromaEvidence.length) >= 2 ? 0.66 : 0.42),
        suggestions: ['换一个具体地区继续问', '指定年份和指标重新分析', '查看该指标近5年趋势'],
        toolTrace: [{
            tool: 'corrective_rag',
            normalizedTool: 'corrective_rag',
            params: {
                evidenceCount: evidence.length,
                chromaEvidenceCount: chromaEvidence.length,
                qualityPassed: corrective.grade.passed,
                corrected: corrective.corrected,
                topEvidence: evidence.slice(0, 3).map(d => `${d.table}/${d.region}/${d.year}`)
            },
            success: evidence.length > 0 || chromaEvidence.length > 0,
            type: 'corrective_rag'
        }],
        methodSummary: {
            type: 'corrective_rag',
            title: '数据检索问答',
            methodLabel: '检索 + 质量评估 + 证据约束生成',
            methodReason: '优先使用本地结构化表格证据；证据不足时调用向量库补救，最终只基于召回证据生成回答。',
            params: {
                question,
                corrected: corrective.corrected,
                localEvidenceCount: evidence.length,
                chromaEvidenceCount: chromaEvidence.length,
                qualityScore: corrective.grade.score,
                qualityPassed: corrective.grade.passed
            }
        }
    };
}



// Parse Chinese numeric expressions ("近十年", "近五年", etc.) and Arabic ones ("近10年", "近5年")
function parseChineseNumber(text) {
    if (!text) return null;
    const directMatch = text.match(/(\d+)/);
    if (directMatch) return parseInt(directMatch[1], 10);
    const cnMap = {
        '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
        '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
    };
    // Handle "十", "十一", "十五", "二十", "二十三"
    if (/^十$/.test(text)) return 10;
    if (/^十[一二三四五六七八九]$/.test(text)) return 10 + cnMap[text.charAt(1)];
    if (/^[二三四五六七八九]十$/.test(text)) return cnMap[text.charAt(0)] * 10;
    if (/^[二三四五六七八九]十[一二三四五六七八九]$/.test(text)) return cnMap[text.charAt(0)] * 10 + cnMap[text.charAt(2)];
    if (text.length === 1 && cnMap[text] !== undefined) return cnMap[text];
    return null;
}

// ========== 规则前置意图识别（绕过小模型误判）==========
function ruleBasedDecide(question, entities) {
    const q = question;
    const lower = q.toLowerCase();
    const metric = entities.metrics[0] || inferMetric(lower);
    const region = entities.regions[0] || null;
    const yearMatch = q.match(/20\d{2}/g);
    const latestYear = getLatestYear(rawDataCache.province);

    // ① 趋势：最高优先级，"近N年/趋势/走势/变化/历年" → trend_analysis
    // Supports Arabic ("近10年"), Chinese ("近十年"), or no number ("趋势" defaults to 10 years for richer context)
    const trendMatchArabic = q.match(/近\s*(\d+)\s*年/);
    const trendMatchChinese = q.match(/近([一二两三四五六七八九十]+)年/);
    const explicitYearRange = parseYearRange(q);
    if (trendMatchArabic || trendMatchChinese || /(趋势|走势|历年变化|变化趋势|年变化|历年|增长率|增速|年均增长|平均增长|复合增长)/.test(q)) {
        let years;
        if (explicitYearRange) {
            years = explicitYearRange;
        } else {
            let n;
            if (trendMatchArabic) n = parseInt(trendMatchArabic[1], 10);
            else if (trendMatchChinese) n = parseChineseNumber(trendMatchChinese[1]) || 5;
            else n = 10; // default: more history when only "趋势" is mentioned
            n = Math.max(2, Math.min(n, 30)); // safety cap
            years = Array.from({ length: n }, (_, i) => latestYear - n + 1 + i);
        }
        return { tool: 'trend_analysis', params: { metric, region: region || null, years } };
    }

    // ② 预测："预测/预计/未来"
    if (/(预测|预计|未来)/.test(q)) {
        const targetYear = yearMatch ? parseInt(yearMatch[yearMatch.length - 1]) : latestYear + 2;
        return { tool: 'forecast', params: { metric, region: region || null, targetYear } };
    }

    // ③ 对比两年："2022和2023/2022对比2023"
    if (yearMatch && yearMatch.length >= 2 && /(对比|比较|vs|和|与)/.test(q)) {
        return {
            tool: 'compare',
            params: { metric, year: parseInt(yearMatch[0]), regionA: '全国', regionB: '全国', compareYear: parseInt(yearMatch[1]) }
        };
    }

    // ④ 对比两地："江苏和浙江/江苏对比浙江"
    if (entities.regions.length >= 2 && /(对比|比较|vs|和|与)/.test(q)) {
        return {
            tool: 'compare',
            params: { metric, year: yearMatch ? parseInt(yearMatch[0]) : latestYear, regionA: entities.regions[0], regionB: entities.regions[1] }
        };
    }

    // ⑤ 排名："排名/前N/最高/最低"
    if (/(排名|前\d+|最高|最低|第一|top)/.test(lower)) {
        const order = /(最低|最小|倒数|垫底)/.test(lower) ? 'asc' : 'desc';
        const topMatch = q.match(/前(\d+)/);
        const topN = topMatch ? parseInt(topMatch[1]) : 10;
        return { tool: 'get_ranking', params: { metric, year: yearMatch ? parseInt(yearMatch[0]) : 0, order, topN } };
    }

    // ⑥ 单点查询：有明确地区+年份
    if (region && yearMatch) {
        return { tool: 'point_query', params: { metric, region, year: parseInt(yearMatch[0]) } };
    }

    // 未命中规则 → 交给模型
    return null;
}

// ========== Agent 决策（规则优先，模型兜底）==========
async function agentDecide(question, entities) {
    // 先走规则
    const ruleResult = ruleBasedDecide(question, entities);
    if (ruleResult) {
        console.log('✅ 规则命中:', ruleResult.tool);
        return ruleResult;
    }

    // 规则未命中，交给 LLM
    console.log('⚙️ 规则未命中，调用 LLM...');
    const prompt = `你是山东财经大学科研教育人才数据平台的工具路由器，不负责直接回答，只负责把用户问题转成一个可执行工具调用。

用户问题: "${question}"
已识别实体: ${JSON.stringify(entities)}

硬性规则：
- 只返回一个JSON对象，不要Markdown，不要解释，不要<think>。
- tool 必须是下列之一：rank_provinces, compare_regions, predict_future, query_point, query_trend。
- params 只放工具需要的字段，不要编造不存在的地区、年份或指标。
- 用户问“预测/未来/预计”必须选 predict_future。
- 用户问“排名/前N/最高/最低/top”必须选 rank_provinces。
- 用户问两个地区或两个年份的差异必须选 compare_regions。
- 用户问“趋势/近N年/历年/变化”必须选 query_trend。
- 用户给出明确地区+年份+指标，且不是预测/排名/趋势/对比，选 query_point。
- 没有地区时 region 填 null，让系统默认全国；没有年份时 year 填 0 或省略。

工具参数 schema：
rank_provinces: {"metric": string, "year": number, "order": "desc"|"asc", "topN": number}
compare_regions: {"metric": string, "year": number, "regionA": string, "regionB": string, "compareYear": number|null}
predict_future: {"metric": string, "region": string|null, "targetYear": number}
query_point: {"metric": string, "region": string, "year": number}
query_trend: {"metric": string, "region": string|null, "years": number[]|null}

返回示例：
{"tool":"predict_future","params":{"metric":"普通高校数量","region":"全国","targetYear":2026}}`;

    for (let i = 0; i < 2; i++) {
        try {
            const raw = await generateFast(prompt, 15000);
            const decision = safeParseJSON(raw);
            if (decision && decision.tool && decision.params) {
                // 修正类型
                if (decision.params.year && typeof decision.params.year !== 'number')
                    decision.params.year = parseInt(decision.params.year) || 0;
                if (decision.params.compareYear && typeof decision.params.compareYear !== 'number')
                    decision.params.compareYear = parseInt(decision.params.compareYear);
                if (decision.params.order && !['desc','asc'].includes(decision.params.order))
                    decision.params.order = 'desc';
                console.log('✅ LLM 解析成功:', decision);
                return decision;
            }
        } catch (e) {
            console.log(`LLM attempt ${i+1} 失败:`, e.message);
        }
        await new Promise(r => setTimeout(r, 300));
    }

    // 最终降级
    console.log('⚠️ LLM 失败，使用最终降级');
    const metric = entities.metrics[0] || inferMetric(question);
    const region = entities.regions[0] || null;
    return { tool: 'trend_analysis', params: { metric, region, years: null } };
}

function normalizeAgentDecision(decision, entities = {}, question = '') {
    if (!decision || typeof decision !== 'object') return null;
    const tool = normalizeToolName(decision.tool || decision.intent || '');
    const allowed = new Set(['get_ranking', 'compare', 'forecast', 'point_query', 'trend_analysis', 'evidence_chat', 'chat']);
    if (!allowed.has(tool)) return null;
    const params = { ...(decision.params || {}) };
    if (!params.metric && decision.metric) params.metric = decision.metric;
    if (!params.region && decision.region) params.region = decision.region;
    if (!params.targetYear && decision.targetYear) params.targetYear = decision.targetYear;
    if (!params.year && decision.year) params.year = decision.year;
    if (!params.years && Array.isArray(decision.years)) params.years = decision.years;
    if (!params.metric && entities.metrics?.[0]) params.metric = entities.metrics[0];
    if (!params.region && entities.regions?.[0] && !['get_ranking', 'compare'].includes(tool)) params.region = entities.regions[0];
    if (!params.metric && tool !== 'chat' && tool !== 'evidence_chat') params.metric = inferMetric(question);

    if (params.year != null && typeof params.year !== 'number') params.year = parseInt(params.year) || 0;
    if (params.targetYear != null && typeof params.targetYear !== 'number') params.targetYear = parseInt(params.targetYear) || 0;
    if (params.compareYear != null && typeof params.compareYear !== 'number') params.compareYear = parseInt(params.compareYear) || null;
    if (Array.isArray(params.years)) {
        params.years = params.years.map(y => parseInt(y)).filter(Number.isFinite);
    }
    if (params.order && !['desc', 'asc'].includes(params.order)) params.order = 'desc';
    if (!params.order && tool === 'get_ranking') params.order = /最低|最小|倒数|垫底/.test(question) ? 'asc' : 'desc';
    if (!params.topN && tool === 'get_ranking') params.topN = 10;
    return { tool, params, rationale: decision.rationale || decision.reason || '', needsClarification: !!decision.needsClarification };
}

async function llmPlanSingleAgent(question, entities, recentHistory = [], lastMethod = null) {
    const historyHint = Array.isArray(recentHistory)
        ? recentHistory.slice(-6).map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 180)}`).join('\n')
        : '';
    const metricHints = metricNameList.slice(0, 60).map(cleanMetricName).join('、');
    const prompt = `你是一个成熟的对话式数据分析 Agent 的“大脑”。你要理解用户真实意图，决定是否聊天、检索知识，还是调用数据工具。只返回严格 JSON，不要 Markdown，不要解释，不要 <think>。

可用工具：
- trend_analysis: 趋势/历年/近N年/变化/趋势图
- forecast: 预测/预估/未来年份
- get_ranking: 排名/前N/最高/最低
- compare: 两个地区或两个年份对比
- point_query: 某地区某年份某指标具体值
- evidence_chat: 解释、评价、原因、建议、开放式分析，需要结合本地知识/向量库
- chat: 普通交流、打招呼、闲聊、能力说明

工具参数：
trend_analysis {"metric":string,"region":string|null,"years":number[]|null}
forecast {"metric":string,"region":string|null,"targetYear":number}
get_ranking {"metric":string,"year":number,"order":"desc"|"asc","topN":number}
compare {"metric":string,"year":number,"regionA":string,"regionB":string,"compareYear":number|null}
point_query {"metric":string,"region":string,"year":number}

决策原则：
1. 优先理解用户原话，不要只按关键词死板匹配。
2. 用户要数据、图表、导出、报告时，必须选合适工具，不要闲聊。
3. 用户问“为什么/怎么看/评价/建议/总结”且不是明确数值任务，选 evidence_chat。
4. 用户说“那这个呢/同样/换成/继续”时，要结合上下文继承指标、地区和上一轮任务。
5. 没有地区但问题指全国整体，region 填“全国”；确实没说地区且适合全国，也填“全国”。
6. 不要编造指标；可用指标示例里没有完全匹配时，选择最接近的指标。

可用指标示例：${metricHints}
已识别实体：${JSON.stringify(entities)}
上一轮方法摘要：${lastMethod ? JSON.stringify(lastMethod).slice(0, 900) : '无'}
最近对话：
${historyHint || '无'}

用户问题：${question}

返回格式：
{"tool":"trend_analysis|forecast|get_ranking|compare|point_query|evidence_chat|chat","params":{},"rationale":"一句话说明为什么这样选","needsClarification":false}`;

    try {
        const raw = await generateFast(prompt, 15000);
        const parsed = safeParseJSON(raw);
        const decision = normalizeAgentDecision(parsed, entities, question);
        if (decision) {
            console.log('🧠 LLM主导规划:', decision);
            return decision;
        }
    } catch (err) {
        console.warn('LLM主导规划不可用，降级到规则/旧路由:', err.message);
    }
    return null;
}

async function synthesizeConversationalAnswer(question, draftAnswer, context = {}) {
    if (!draftAnswer || String(draftAnswer).length < 12) return draftAnswer;
    if (context.resultType === 'ranking' || context.resultType === 'point') {
        return draftAnswer;
    }
    const prompt = `你是山东财经大学科研教育人才数据平台的成熟 AI 分析助手。请基于“工具结果草稿”生成自然、清晰、有交流感的最终回答。

要求：
1. 必须忠实于工具结果，不要新增未给出的数值、年份、地区、排名。
2. 保留关键表格、数值、方法、置信区间和数据来源含义。
3. 语气像专业助手，不要模板腔，不要说“修复/工具调用完成/后台”等技术提示。
4. 如果结果显示数据缺失，要直接说明缺什么，并给出下一步可问法。
5. 不要主动引导用户询问数据库或向量库没有覆盖的主题，例如行业数据、国外/其他国家数据、企业数据、学校明细等，除非工具结果或证据明确提供。
6. 追问建议只能围绕当前平台已有口径：全国、省份、地级市、年份、已存在指标、趋势、排名、对比、预测、方法说明。
7. 中文回答，结构清楚，适度简洁。

用户问题：${question}
工具与方法轨迹：${JSON.stringify(context.toolTrace || []).slice(0, 1200)}
证据来源：${JSON.stringify(context.citations || []).slice(0, 900)}
工具结果草稿：
${String(draftAnswer).slice(0, 5000)}

请输出最终回答正文：`;
    try {
        const raw = await generateSync(prompt, 60000);
        const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (cleaned && cleaned.length >= 10 && !/^```/.test(cleaned)) return sanitizeUnsupportedFollowups(cleaned);
    } catch (err) {
        console.warn('最终表达层不可用，使用工具草稿:', err.message);
    }
    return draftAnswer;
}

function sanitizeUnsupportedFollowups(answer) {
    const lines = String(answer || '').split(/\n/);
    const blocked = /(行业|汽车|电子|其他国家|国外|国际|同期国家|企业|公司|学校明细|院校名单)/;
    return lines
        .filter(line => !blocked.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function answerGeneralChat(question, recentHistory = []) {
    const latestYear = getLatestYear(rawDataCache.province);
    const historyHint = Array.isArray(recentHistory)
        ? recentHistory.slice(-6).map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 160)}`).join('\n')
        : '';
    const prompt = `你是山东财经大学科研教育人才数据平台里的 AI 分析助手。请自然交流，但要清楚告诉用户你可以调用数据工具。

你的真实能力：
- 查询省份、地级市、全国数据
- 做趋势、排名、对比、预测、散点关联
- 解释方法、生成报告、导出图表/表格
- 使用 Chroma 向量库和本地数据检索，检索不足时会纠错重查

不要编造具体数据。用户如果只是闲聊，可以简短回应并顺势引导他提出数据问题。

最新数据年份：${latestYear || '未知'}
指标数量：${metricNameList.length}
最近对话：
${historyHint || '无'}

用户：${question}
助手：`;
    try {
        const raw = await generateSync(prompt, 60000);
        const answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (answer) {
            return {
                answer,
                chart: null,
                citations: [],
                reasoning: ['意图: chat', '模式: 对话交流', '策略: 不编造数据，引导调用工具'],
                confidence: 0.88,
                suggestions: ['预测2026年山东省普通高校数量', '全国工业机器人密度近10年趋势', '2024年各省发明专利授予数排名', '江苏和浙江科研指标对比'],
                toolTrace: [{ tool: 'chat', normalizedTool: 'chat', params: {}, success: true, type: 'chat' }]
            };
        }
    } catch (err) {
        console.warn('普通聊天模型不可用，使用固定能力介绍:', err.message);
    }
    return {
        answer: `我在。你可以直接像正常聊天一样问我，也可以让我调用数据工具。\n\n比如：\n- 预测2026年山东省普通高校数量\n- 查看全国工业机器人密度2000到2023年的趋势\n- 对比江苏和浙江发明专利授予数\n- 生成某个指标的分析报告并导出`,
        chart: null,
        citations: [],
        reasoning: ['意图: chat', '模型不可用时降级为能力说明'],
        confidence: 0.75,
        suggestions: ['查看全国趋势', '预测某省指标', '生成分析报告', '导出表格'],
        toolTrace: [{ tool: 'chat', normalizedTool: 'chat', params: {}, success: true, type: 'chat' }]
    };
}

// ========== 执行工具 ==========
async function executeTool(decision, entities) {
    const tool = normalizeToolName(decision.tool);
    const params = decision.params || {};

    // 全局地区名规范化（所有工具共用）
    const _rm = {
        '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
        '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
        '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
        '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
        '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
        '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
        '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
        '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
        '青海': '青海省'
    };
    const _nr = r => (!r || r === '全国') ? r : (_rm[r] || r);
    if (params.region) params.region = _nr(params.region);
    if (params.regionA) params.regionA = _nr(params.regionA);
    if (params.regionB) params.regionB = _nr(params.regionB);
    try {
        // ---- get_ranking ----
        if (tool === 'get_ranking') {
            const metric = params.metric || entities.metrics[0] || metricNameList[0];
            const year   = params.year   || entities.years[0]   || 0;
            const order  = ['desc','asc'].includes(params.order) ? params.order : 'desc';
            const topN   = parseInt(params.topN) || 10;
            const data   = getRanking(metric, year, order, topN, params.table || 'province');
            return { success: true, type: 'ranking', data };
        }

        // ---- compare ----
        if (tool === 'compare') {
            const metric      = params.metric || entities.metrics[0] || metricNameList[0];
            const year        = params.year   || entities.years[0]   || getLatestYear(rawDataCache.province);
            const regionA     = _nr(params.regionA || entities.regions[0] || '广东省');
            const regionB     = _nr(params.regionB || entities.regions[1] || '江苏省');
            const compareYear = params.compareYear || null;
            const isNational  = (regionA === '全国' || regionB === '全国') && !!compareYear;
            const rows        = isNational ? rawDataCache.national : rawDataCache.province;
            const realKey     = findRealKey(rows, metric) || metric;
            const getVal      = (reg, yr) => {
                const row = rows.find(r => r['年份'] === yr && (isNational || r['地区'] === reg));
                return row ? row[realKey] : null;
            };
            return {
                success: true, type: 'compare',
                data: { regionA, valA: getVal(regionA, year), regionB, valB: compareYear ? getVal(regionB, compareYear) : getVal(regionB, year), metric, year, compareYear }
            };
        }

        // ---- forecast ----
        if (tool === 'forecast') {
            const metric      = params.metric || entities.metrics[0] || metricNameList[0];
            const region      = params.region || entities.regions[0] || (entities._defaultNational ? '全国' : '全国');
            const targetYear  = params.targetYear || (getLatestYear(rawDataCache.province) + 2);
            const histData    = getHistoricalData(metric, region);
            const forecastModel = chooseForecastModel(histData, targetYear, metric);
            const forecastValue = forecastModel.value;
            const forecastMeta = buildForecastMeta(histData, targetYear, forecastModel, metric);
            return {
                success: true,
                type: 'forecast',
                data: {
                    region,
                    metric,
                    year: targetYear,
                    forecastValue,
                    history: histData,
                    forecastModel,
                    forecastMeta,
                    confidenceInterval: getForecastInterval(histData, forecastValue, targetYear)
                }
            };
        }

        // ---- point_query ----
        if (tool === 'point_query') {
            const metric  = params.metric || entities.metrics[0] || metricNameList[0];
            const region  = params.region || entities.regions[0] || (entities._defaultNational ? '全国' : '全国');
            const isNational = region === '全国';
            const rows    = isNational ? rawDataCache.national : rawDataCache.province;
            const year    = params.year   || entities.years[0]   || getLatestYear(rows);
            const realKey = findRealKey(rows, metric) || metric;
            const row     = rows.find(r => r['年份'] === year && (isNational || r['地区'] === region));
            return { success: true, type: 'point', data: { region, metric, year, value: row ? row[realKey] : undefined } };
        }

        // ---- trend_analysis ----
        if (tool === 'trend_analysis') {
            const metric = params.metric || entities.metrics[0] || metricNameList[0];
            
            // 无指定地区且有全国数据 → 优先用全国表
            const wantsNationalTrend = entities._defaultNational || params.region === '全国' || entities.regions[0] === '全国';
            if (wantsNationalTrend && rawDataCache.national && rawDataCache.national.length) {
                const natRows = rawDataCache.national;
                const realKey = findRealKey(natRows, metric) || metric;
                const requestedYears = (params.years && params.years.length) ? params.years
                                     : (entities.years && entities.years.length) ? entities.years : null;
                let filtered = [...natRows];
                if (requestedYears && requestedYears.length) {
                    const f = filtered.filter(r => requestedYears.includes(r['年份']));
                    if (f.length) filtered = f;
                }
                filtered.sort((a, b) => a['年份'] - b['年份']);
                if (filtered.length > 0) {
                    console.log(`trend_analysis(全国): "${metric}"→"${realKey}"`);
                    return {
                        success: true, type: 'trend',
                        data: { region: '全国', metric, table: '全国表', chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] || 0 })), years: filtered.map(r => r['年份']) }
                    };
                }
            }
            
            // 有指定省份 or 全国数据不足 → 用省份表
            const allProvinces = [...new Set(rawDataCache.province.map(r => r['地区']))].filter(Boolean);
            const region = params.region || entities.regions[0] || allProvinces[0] || '广东省';
            const requestedYears = (params.years && params.years.length) ? params.years
                                 : (entities.years && entities.years.length) ? entities.years : null;
            const rows    = rawDataCache.province.filter(r => r['地区'] === region);
            const realKey = findRealKey(rows, metric) || metric;
            console.log(`trend_analysis(省份): "${metric}"→"${realKey}", region="${region}"`);
            let filtered = rows;
            if (requestedYears && requestedYears.length) {
                const f = rows.filter(r => requestedYears.includes(r['年份']));
                if (f.length) filtered = f;
            }
            filtered.sort((a, b) => a['年份'] - b['年份']);
            return {
                success: true, type: 'trend',
                data: { region, metric, table: '省份表', chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] || 0 })), years: filtered.map(r => r['年份']) }
            };
        }

        return { success: false, type: 'unknown', data: {}, error: `未知工具: ${tool}` };
    } catch (err) {
        console.error('executeTool 错误:', err);
        return { success: false, type: 'error', data: {}, error: err.message };
    }
}

// ========== 生成自然语言回答 ==========
async function generateAnswer(result, question, type) {
    let answer = '';
    const citations = [];

    if (type === 'ranking') {
        const items = result.data;
        if (!items || !items.length) return { text: '未找到相关排名数据，请确认指标名称或年份是否正确。', citations: [] };
        answer = `**排名结果**\n\n`;
        items.forEach((item, i) => {
            answer += `${i+1}. **${item.region}**：${formatValue(item.value)}\n`;
            citations.push(`[来源: 省份表/${item.region}/第${i+1}名]`);
        });
    }
    else if (type === 'compare') {
        const { regionA, valA, regionB, valB, metric, year, compareYear } = result.data;
        if (compareYear) {
            if (valA == null || valB == null) {
                answer = `⚠️ 数据不存在，请检查年份或指标是否正确`;
            } else {
                const diff = valB - valA, pct = valA !== 0 ? ((diff/valA)*100).toFixed(2) : 'N/A';
                const trend = diff > 0 ? '↑ 增长' : diff < 0 ? '↓ 下降' : '→ 持平';
                answer = `**${metric} 年度对比**\n\n| 年份 | 数值 | 变化 |\n|------|------|------|\n`;
                answer += `| ${regionA}年 | ${formatValue(valA)} | - |\n`;
                answer += `| ${compareYear}年 | ${formatValue(valB)} | ${trend} ${Math.abs(diff).toFixed(2)} (${pct}%) |\n\n`;
                citations.push(`[来源: 全国表/${year}]`, `[来源: 全国表/${compareYear}]`);
            }
        } else {
            if (valA == null || valB == null) {
                answer = `⚠️ ${valA == null ? regionA : regionB}的${metric}数据不存在`;
            } else {
                const winner = valA > valB ? regionA : regionB;
                const diff = Math.abs(valA - valB);
                const pct = Math.min(valA,valB) !== 0 ? ((diff/Math.min(valA,valB))*100).toFixed(2) : 'N/A';
                answer = `**${metric} 地区对比（${year}年）**\n\n| 地区 | 数值 | 差距 |\n|------|------|------|\n`;
                answer += `| ${regionA} | ${formatValue(valA)} | - |\n`;
                answer += `| ${regionB} | ${formatValue(valB)} | ${diff.toFixed(2)} (${pct}%) |\n\n`;
                answer += `🏆 **${winner}** 领先\n`;
                citations.push(`[来源: 省份表/${regionA}/${year}]`, `[来源: 省份表/${regionB}/${year}]`);
            }
        }
    }
    else if (type === 'forecast') {
        const { region, metric, year, forecastValue, history, confidenceInterval, forecastModel, forecastMeta } = result.data;
        if (!forecastValue) {
            answer = `⚠️ ${region}的${metric}历史数据不足（${history.length}条），无法预测。`;
            history.slice(-3).forEach(h => { answer += `\n- ${h.year}年: ${formatValue(h.value)}`; });
        } else {
            const last = history[history.length-1];
            answer = `**${metric} 预测结果**\n\n| 项目 | 数值 |\n|------|------|\n`;
            answer += `| 预测地区 | ${region} |\n| 预测年份 | ${year} |\n`;
            if (forecastMeta?.latestActualYear) answer += `| 最新真实年份 | ${forecastMeta.latestActualYear} |\n`;
            if (forecastMeta?.forecastStep) answer += `| 预测步长 | ${forecastMeta.forecastStep}步（${forecastMeta.forecastType}） |\n`;
            answer += `| 预测值 | **${formatValue(forecastValue)}** |\n`;
            if (forecastModel?.methodLabel) answer += `| 预测方法 | ${forecastModel.methodLabel} |\n`;
            if (confidenceInterval) answer += `| 置信区间 | ${formatValue(confidenceInterval.lower)} - ${formatValue(confidenceInterval.upper)} |\n`;
            answer += `| 趋势 | ${forecastValue > last.value ? '↑ 上升' : '↓ 下降'} |\n`;
            answer += `| 置信度 | ${confidenceInterval?.confidenceLabel || '中等'}（${history.length}年数据） |\n\n**历史参考：**\n`;
            history.slice(-5).forEach(h => { answer += `- ${h.year}年: ${formatValue(h.value)}\n`; });
            if (forecastMeta?.path?.length) {
                answer += `\n**预测路径参考：**\n`;
                forecastMeta.path.forEach(p => {
                    const suffix = p.year === year ? '目标年' : '中间估计';
                    answer += `- ${p.year}年: ${formatValue(p.value)}（${suffix}，模型估计）\n`;
                });
            }
            if (forecastModel?.methodReason) {
                answer += `\n**方法说明：**${forecastModel.methodReason}`;
                if (forecastMeta?.caution) {
                    answer += ` ${forecastMeta.caution}`;
                }
                if (forecastMeta?.forecastStep > 1) {
                    answer += ` 因此该结果不是基于真实${year - 1}年数据继续计算，而是从${forecastMeta.latestActualYear}年历史序列直接进行${forecastMeta.forecastStep}步预测。`;
                }
                if (forecastModel.backtest) {
                    answer += ` 最近历史回测 RMSE=${forecastModel.backtest.rmse}`;
                    if (forecastModel.backtest.mape != null) answer += `，MAPE=${forecastModel.backtest.mape}%`;
                    answer += `。`;
                }
            }
            citations.push(`[来源: 预测模型/${forecastModel?.methodLabel || '时间序列外推'}/${history.length}年数据]`);
        }
    }
    else if (type === 'point') {
        const { region, metric, year, value } = result.data;
        answer = value !== undefined
            ? `**${year}年 ${region} ${metric}**\n\n📊 **${formatValue(value)}**`
            : `⚠️ 未找到${year}年${region}的${metric}数据`;
        citations.push(`[来源: 省份表/${region}/${year}]`);
    }
    else if (type === 'trend') {
        const { region, metric, chartData, table } = result.data;
        const valid = chartData.filter(d => d.value > 0);
        if (valid.length < 2) {
            answer = `⚠️ ${region}的${metric}有效数据不足（${valid.length}年），无法分析趋势。`;
        } else {
            const first = valid[0], last = valid[valid.length-1];
            const totalChange = last.value - first.value;
            const avgChange = totalChange / (valid.length - 1);
            const yearSpan = Math.max(1, last.year - first.year || valid.length - 1);
            const cagr = first.value > 0 && last.value > 0 ? (Math.pow(last.value / first.value, 1 / yearSpan) - 1) * 100 : null;
            const yoyRates = [];
            for (let i = 1; i < valid.length; i++) {
                if (valid[i - 1].value > 0) yoyRates.push((valid[i].value - valid[i - 1].value) / valid[i - 1].value * 100);
            }
            const avgYoY = yoyRates.length ? yoyRates.reduce((a, b) => a + b, 0) / yoyRates.length : null;
            const trendStr = last.value > first.value ? '📈 上升' : last.value < first.value ? '📉 下降' : '➡️ 平稳';
            const wantsGrowthRate = /(增长率|增速|年均增长|平均增长|复合增长|CAGR)/i.test(question);
            answer = `**${region} ${metric} ${wantsGrowthRate ? '年均增长率分析' : '趋势分析'}**\n\n| 指标 | 数值 |\n|------|------|\n`;
            answer += `| 起始 | ${first.year}年 ${formatValue(first.value)} |\n`;
            answer += `| 最新 | ${last.year}年 ${formatValue(last.value)} |\n`;
            answer += `| 总变化 | ${totalChange >= 0?'+':''}${formatValue(totalChange)} |\n`;
            answer += `| 年均变化 | ${avgChange >= 0?'+':''}${formatValue(avgChange)} |\n`;
            if (cagr != null) answer += `| 年均增长率（CAGR） | ${cagr >= 0 ? '+' : ''}${cagr.toFixed(2)}% |\n`;
            if (avgYoY != null) answer += `| 平均同比增长率 | ${avgYoY >= 0 ? '+' : ''}${avgYoY.toFixed(2)}% |\n`;
            answer += `| 趋势 | ${trendStr} |\n\n**历年数据：**\n`;
            valid.forEach((d, i) => {
                const yoy = i > 0 && valid[i - 1].value > 0 ? `，同比${((d.value - valid[i - 1].value) / valid[i - 1].value * 100 >= 0 ? '+' : '')}${((d.value - valid[i - 1].value) / valid[i - 1].value * 100).toFixed(2)}%` : '';
                const chg = i > 0 ? ` (${d.value>=valid[i-1].value?'+':''}${(d.value-valid[i-1].value).toFixed(2)}${wantsGrowthRate ? yoy : ''})` : '';
                answer += `- ${d.year}年: ${formatValue(d.value)}${chg}\n`;
            });
            if (wantsGrowthRate) {
                answer += `\n**说明：**年均增长率使用首末值计算复合年均增长率（CAGR），平均同比增长率则是逐年同比增速的算术平均。前者更适合概括长期区间，后者更能反映年度波动。\n`;
            }
            citations.push(`[来源: ${table || (region === '全国' ? '全国表' : '省份表')}/${region}/${first.year}-${last.year}]`);
        }
    }
    else {
        answer = '⚠️ 未能处理该问题，请换个说法试试。';
    }
    return { text: answer, citations };
}

function buildFollowupSuggestions(question, result, entities) {
    const metric = entities.metrics[0] || result?.data?.metric || inferMetric(question);
    const cleanMetric = cleanMetricName(metric);
    const latestYear = getLatestYear(rawDataCache.province);
    const region = entities.regions[0] || result?.data?.region || '全国';
    const type = result?.type || '';
    const suggestions = [];

    // Tailor suggestions by analysis type
    if (type === 'trend') {
        suggestions.push(`预测2026年${region}${cleanMetric}`);
        suggestions.push(`${region}${cleanMetric}年均增长率`);
        suggestions.push(`${latestYear}年各省${cleanMetric}排名`);
        if (entities.regions.length < 2) suggestions.push(`江苏和浙江${cleanMetric}对比`);
    } else if (type === 'forecast') {
        suggestions.push(`你是怎么预测的？`);
        suggestions.push(`${region}${cleanMetric}近10年趋势`);
        suggestions.push(`${latestYear}年各省${cleanMetric}排名`);
        suggestions.push(`换一个省份预测同样指标`);
    } else if (type === 'ranking') {
        const topRegion = result?.data?.[0]?.region || '榜首地区';
        suggestions.push(`${topRegion}${cleanMetric}近10年趋势`);
        suggestions.push(`预测2026年${cleanMetric}排名`);
        suggestions.push(`${cleanMetric}最低5省`);
        suggestions.push(`换一年再看排名`);
    } else if (type === 'compare') {
        const rA = result?.data?.regionA || entities.regions[0];
        const rB = result?.data?.regionB || entities.regions[1];
        if (rA) suggestions.push(`${rA}${cleanMetric}近10年趋势`);
        if (rB) suggestions.push(`${rB}${cleanMetric}近10年趋势`);
        suggestions.push(`两地差距的可能原因？`);
        suggestions.push(`${latestYear}年各省${cleanMetric}排名`);
    } else {
        // point_query / evidence_chat / default
        suggestions.push(`${region}${cleanMetric}近10年趋势`);
        suggestions.push(`${latestYear}年各省${cleanMetric}排名`);
        suggestions.push(`预测2026年${region}${cleanMetric}`);
        if (entities.regions.length < 2) suggestions.push(`江苏和浙江${cleanMetric}对比`);
    }

    return [...new Set(suggestions)].filter(Boolean).slice(0, 4);
}

function isForecastComparisonQuestion(question, entities = {}) {
    const q = String(question || '');
    const detectedRegions = detectMentionedRegions(q);
    return /(预测|预估|未来|预计)/.test(q)
        && /(对比|比较|比对|相比|差距|谁高|谁低|领先|和|与|vs)/i.test(q)
        && ((Array.isArray(entities.regions) && entities.regions.length >= 2) || detectedRegions.length >= 2);
}

function isMultiRegionForecastQuestion(question, entities = {}) {
    const q = String(question || '');
    if (!/(预测|预估|未来|预计)/.test(q)) return false;
    const mixedIntent = /(趋势|走势|近[一二两三四五六七八九十\d]+年|排名|前\d+|对比|比较|比对|多少|是多少)/.test(q);
    const numberedOrSeparated = /(^|[。；;！？?\n\r])\s*(?:第?\d+\s*[\.、，,)]|[（(]\d+[）)])|[。；;！？?\n\r]/.test(q);
    const metricCount = Array.isArray(entities.metrics) ? entities.metrics.length : extractEntities(q).metrics.length;
    if (mixedIntent && (numberedOrSeparated || metricCount > 1)) return false;
    const detectedRegions = detectMentionedRegions(q);
    const regionCount = Math.max(detectedRegions.length, Array.isArray(entities.regions) ? entities.regions.length : 0);
    return regionCount >= 2;
}

function detectMentionedRegions(question = '') {
    const q = String(question || '');
    const hits = [];
    const add = (name, at) => {
        if (!name || at < 0) return;
        const existing = hits.find(item => item.name === name);
        if (existing) existing.at = Math.min(existing.at, at);
        else hits.push({ name, at });
    };
    const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))].filter(Boolean);
    for (const region of provinceList) {
        add(region, q.indexOf(region));
    }
    const aliases = {
        '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
        '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
        '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
        '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
        '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
        '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
        '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
        '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
        '青海': '青海省'
    };
    for (const [shortName, fullName] of Object.entries(aliases)) {
        add(fullName, q.indexOf(shortName));
    }
    return hits.sort((a, b) => a.at - b.at).map(item => item.name);
}

function buildForecastResult(metric, region, targetYear) {
    const history = getHistoricalData(metric, region);
    const forecastModel = chooseForecastModel(history, targetYear, metric);
    const forecastValue = forecastModel.value;
    const forecastMeta = buildForecastMeta(history, targetYear, forecastModel, metric);
    return {
        region,
        metric,
        year: targetYear,
        forecastValue,
        history,
        forecastModel,
        forecastMeta,
        confidenceInterval: getForecastInterval(history, forecastValue, targetYear)
    };
}

function answerForecastComparison(question, entities) {
    const metric = entities.metrics[0] || inferMetric(question);
    const latestYear = getLatestYear(rawDataCache.province);
    const targetYear = entities.years.find(y => y >= latestYear) || entities.years[0] || latestYear + 1;
    const detectedRegions = detectMentionedRegions(question);
    const [regionA, regionB] = (detectedRegions.length >= 2 ? detectedRegions : entities.regions).slice(0, 2);
    const a = buildForecastResult(metric, regionA, targetYear);
    const b = buildForecastResult(metric, regionB, targetYear);
    const valid = typeof a.forecastValue === 'number' && typeof b.forecastValue === 'number';
    const diff = valid ? b.forecastValue - a.forecastValue : null;
    const leader = valid ? (a.forecastValue > b.forecastValue ? regionA : b.forecastValue > a.forecastValue ? regionB : '两地持平') : null;
    const pct = valid && Math.min(Math.abs(a.forecastValue), Math.abs(b.forecastValue)) > 1e-9
        ? Math.abs(diff / Math.min(Math.abs(a.forecastValue), Math.abs(b.forecastValue)) * 100).toFixed(2)
        : 'N/A';

    let answer = `**${targetYear}年 ${regionA} vs ${regionB} ${metric}预测对比**\n\n`;
    answer += `| 地区 | 预测值 | 预测方法 | 置信区间 | 历史样本 |\n|------|------:|------|------|------|\n`;
    const row = (item) => {
        const ci = item.confidenceInterval ? `${formatValue(item.confidenceInterval.lower)} - ${formatValue(item.confidenceInterval.upper)}` : '暂无';
        return `| ${item.region} | **${formatValue(item.forecastValue)}** | ${item.forecastModel?.methodLabel || '时间序列外推'} | ${ci} | ${item.history.length}年 |\n`;
    };
    answer += row(a);
    answer += row(b);
    if (valid) {
        answer += `\n**对比结论：**${leader === '两地持平' ? '两地预测值基本持平' : `${leader}预测值更高`}，差值约 **${formatValue(Math.abs(diff))}**，相对差距约 **${pct}%**。\n`;
    } else {
        answer += `\n**对比结论：**至少一方历史数据不足，无法形成可靠预测差值。\n`;
    }
    answer += `\n**历史参考：**\n`;
    [a, b].forEach(item => {
        answer += `- ${item.region}：`;
        answer += item.history.slice(-5).map(h => `${h.year}年 ${formatValue(h.value)}`).join('；') || '暂无有效历史数据';
        answer += `\n`;
    });
    answer += `\n**方法说明：**系统先分别抽取两地同一指标的历史序列，分别选择回测误差更稳定的预测方法，再比较两个预测值。该结果是从${latestYear}年附近的最新真实数据向${targetYear}年外推，不是把某一地结果直接套用到另一地。\n`;

    return {
        answer,
        chart: null,
        citations: [
            `[来源: 预测模型/${regionA}/${metric}/${a.history.length}年数据]`,
            `[来源: 预测模型/${regionB}/${metric}/${b.history.length}年数据]`
        ],
        reasoning: [
            '意图: forecast_compare',
            `指标: ${metric}`,
            `地区: ${regionA}、${regionB}`,
            `年份: ${targetYear}`,
            '流程: 分别预测两地，再比较预测值'
        ],
        confidence: valid ? 0.88 : 0.55,
        suggestions: [
            `${regionA}${metric}近10年趋势`,
            `${regionB}${metric}近10年趋势`,
            `${targetYear}年各省${cleanMetricName(metric)}预测排名`,
            '你是怎么预测的？'
        ],
        toolTrace: [
            { tool: 'forecast', normalizedTool: 'forecast', params: { metric, region: regionA, targetYear }, success: typeof a.forecastValue === 'number', type: 'forecast' },
            { tool: 'forecast', normalizedTool: 'forecast', params: { metric, region: regionB, targetYear }, success: typeof b.forecastValue === 'number', type: 'forecast' },
            { tool: 'forecast_compare', normalizedTool: 'forecast_compare', params: { metric, regionA, regionB, targetYear }, success: valid, type: 'forecast_compare' }
        ],
        methodSummary: {
            type: 'forecast_compare',
            title: `${regionA}与${regionB}${targetYear}年预测对比`,
            methodLabel: '双地区分别预测 + 差值比较',
            methodReason: '针对“预测并比对”的复合问题，先分别预测两个地区，再比较预测值、置信区间和历史样本，避免只回答最后一个地区。',
            params: { metric, regionA, regionB, targetYear },
            regions: [regionA, regionB],
            metric,
            year: targetYear
        }
    };
}

function answerMultiRegionForecast(question, entities) {
    const metric = entities.metrics[0] || inferMetric(question);
    const latestYear = getLatestYear(rawDataCache.province);
    const targetYear = entities.years.find(y => y >= latestYear) || entities.years[0] || latestYear + 1;
    const detectedRegions = detectMentionedRegions(question);
    const regions = (detectedRegions.length >= 2 ? detectedRegions : entities.regions).slice(0, 8);
    const items = regions.map(region => buildForecastResult(metric, region, targetYear));
    const validItems = items.filter(item => typeof item.forecastValue === 'number');
    const sortedValid = [...validItems].sort((a, b) => b.forecastValue - a.forecastValue);

    let answer = `**${targetYear}年 ${regions.join('、')} ${metric}分别预测**\n\n`;
    answer += `| 地区 | 预测值 | 趋势 | 预测方法 | 置信区间 | 历史样本 |\n|------|------:|------|------|------|------|\n`;
    items.forEach(item => {
        const latestActual = item.history[item.history.length - 1];
        const trend = latestActual && typeof item.forecastValue === 'number'
            ? (item.forecastValue > latestActual.value ? '上升' : item.forecastValue < latestActual.value ? '下降' : '持平')
            : '未知';
        const ci = item.confidenceInterval ? `${formatValue(item.confidenceInterval.lower)} - ${formatValue(item.confidenceInterval.upper)}` : '暂无';
        answer += `| ${item.region} | **${formatValue(item.forecastValue)}** | ${trend} | ${item.forecastModel?.methodLabel || '时间序列外推'} | ${ci} | ${item.history.length}年 |\n`;
    });

    if (validItems.length >= 2) {
        const leader = sortedValid[0];
        const low = sortedValid[sortedValid.length - 1];
        const spread = Math.abs(leader.forecastValue - low.forecastValue);
        if (spread < 1e-9) {
            answer += `\n**横向结论：**这些地区预测值基本持平，均约为 **${formatValue(leader.forecastValue)}**。\n`;
        } else {
            answer += `\n**横向结论：**${leader.region}预测值最高（${formatValue(leader.forecastValue)}），${low.region}预测值最低（${formatValue(low.forecastValue)}），最高与最低差值约 **${formatValue(spread)}**。\n`;
        }
    }

    answer += `\n**历史参考：**\n`;
    items.forEach(item => {
        answer += `- ${item.region}：`;
        answer += item.history.slice(-5).map(h => `${h.year}年 ${formatValue(h.value)}`).join('；') || '暂无有效历史数据';
        answer += `\n`;
    });
    answer += `\n**方法说明：**这是一个多地区同指标预测任务。系统先识别所有地区，再对每个地区分别抽取历史序列、选择回测误差更稳定的预测模型，最后把预测值放在同一张表里对照，不会只回答其中一个地区。\n`;

    return {
        answer,
        chart: null,
        citations: items.map(item => `[来源: 预测模型/${item.region}/${metric}/${item.history.length}年数据]`),
        reasoning: [
            '意图: multi_region_forecast',
            `指标: ${metric}`,
            `地区: ${regions.join('、')}`,
            `年份: ${targetYear}`,
            '流程: 识别多个地区，逐一预测并汇总'
        ],
        confidence: validItems.length === items.length ? 0.88 : 0.62,
        suggestions: [
            `${targetYear}年这些地区预测值排序`,
            `${regions[0] || '广东省'}${metric}近10年趋势`,
            `${regions[1] || '山东省'}${metric}近10年趋势`,
            '你是怎么预测的？'
        ],
        toolTrace: [
            ...items.map(item => ({
                tool: 'forecast',
                normalizedTool: 'forecast',
                params: { metric, region: item.region, targetYear },
                success: typeof item.forecastValue === 'number',
                type: 'forecast'
            })),
            {
                tool: 'multi_region_forecast',
                normalizedTool: 'multi_region_forecast',
                params: { metric, regions, targetYear },
                success: validItems.length > 0,
                type: 'multi_region_forecast'
            }
        ],
        methodSummary: {
            type: 'multi_region_forecast',
            title: `${targetYear}年多地区${metric}预测`,
            methodLabel: '多地区分别预测 + 汇总对照',
            methodReason: '针对一个问题中包含多个地区的预测任务，逐一执行预测后统一汇总，避免只回答第一个或最后一个地区。',
            params: { metric, regions, targetYear },
            regions,
            metric,
            year: targetYear
        }
    };
}

function isMethodFollowup(question) {
    const q = String(question || '').trim();
    if (isForecastMethodOptionQuestion(q)) return false;
    return /(怎么|如何|为什么|依据|根据|方法|怎么算|怎么得出|怎么预测|用什么模型|什么算法|置信区间|可信|靠谱吗|原理|过程)/.test(q)
        && /(预测|算|得出|回答|结果|数据|方法|模型|算法|置信|刚才|上面|上一)/.test(q);
}

function isForecastMethodOptionQuestion(question) {
    const q = String(question || '').trim();
    // 如果带有明确重新预测的动作意图，不在这里拦截，交给LLM处理
    if (/(换.*方法.*预测|用.*方法.*预测|重新预测|换种.*预测|用线性回归|用holt|用漂移|用移动均值)/.test(q)) return false;
    return /(还有|其他|其它|别的|换一种|换个|能不能用|可不可以用|是否可以用).*(预测|预估|外推|模型|算法|方法)/.test(q)
        || /(预测|预估|外推).*(还有|其他|其它|别的).*(方法|模型|算法)/.test(q);
}

// 识别"比较四种方法/所有方法并排"意图
function isForecastMethodCompareQuestion(question) {
    const q = String(question || '').trim();
    return /(比较|对比|并排|所有方法|四种方法|各种方法|哪种方法|哪个方法|方法对比|方法比较).*(预测|方法|结果|模型)/.test(q)
        || /(预测).*(比较|对比|并排|所有方法|四种|各种)/.test(q)
        || /四种方法|所有方法|各方法/.test(q);
}

// 四种方法并排比较预测
function answerForecastMethodCompare(question, recentHistory = []) {
    const last = getLastMethodSummary(recentHistory);

    // 从上一轮或当前问题中获取指标、地区、目标年份
    const entities = extractEntities(question);
    const metric = entities.metrics[0] || last?.params?.metric || inferMetric(question);
    const region = entities.regions[0] || last?.params?.region || last?.regions?.[0] || '全国';
    const latestYear = getLatestYear(rawDataCache.province);
    const targetYear = entities.years.find(y => y > latestYear)
        || last?.params?.targetYear
        || last?.forecastMeta?.latestActualYear && last.forecastMeta.latestActualYear + 2
        || latestYear + 2;

    const history = getHistoricalData(metric, region);
    if (!history || history.length < 2) {
        return {
            answer: `⚠️ ${region}的${metric}历史数据不足（${history?.length || 0}条），无法进行四种方法比较，至少需要2年数据。`,
            chart: null, citations: [], reasoning: ['数据不足'], confidence: 0.3,
            suggestions: [`查看${region}有哪些指标`, '换一个指标试试'],
            toolTrace: [{ tool: 'forecast_method_compare', normalizedTool: 'forecast_method_compare', params: { metric, region, targetYear }, success: false, type: 'forecast' }]
        };
    }

    const allNonNegative = history.every(d => d.value >= 0);

    // 跑四种方法
    const methods = [
        { key: 'linear_regression', label: '线性回归趋势预测', fn: linearRegressionForecast,
          desc: '适合长期趋势平稳、近似线性变化的数据' },
        { key: 'holt_linear', label: 'Holt线性指数平滑', fn: holtLinearForecast,
          desc: '适合有趋势但短期有波动的年度序列' },
        { key: 'drift', label: '平均漂移外推', fn: driftForecast,
          desc: '适合样本较少或不宜过度拟合的数据' },
        { key: 'moving_average_trend', label: '近年移动均值趋势外推', fn: movingAverageForecast,
          desc: '近期走势比早期数据更重要时使用' }
    ];

    const results = methods.map(m => {
        let value = m.fn(history, targetYear);
        if (typeof value === 'number' && allNonNegative) value = Math.max(0, value);
        const backtest = scoreForecastMethod(history, m.fn);
        const ci = getForecastInterval(history, value, targetYear);
        return { ...m, value, backtest, ci };
    });

    // 标记最优（RMSE最小）
    const validResults = results.filter(r => typeof r.value === 'number' && !Number.isNaN(r.value));
    const bestRmse = Math.min(...validResults.map(r => Number.isFinite(r.backtest?.rmse) ? r.backtest.rmse : Infinity));
    const bestMethod = validResults.find(r => r.backtest?.rmse === bestRmse);

    // 系统自动选的方法
    const autoModel = chooseForecastModel(history, targetYear, metric);

    let answer = `**${region} ${metric} — 四种预测方法并排比较（目标年份：${targetYear}年）**\n\n`;
    answer += `| 方法 | 预测值 | 置信区间 | 回测RMSE | 回测MAPE | 推荐 |\n`;
    answer += `|------|------:|------|------:|------:|:----:|\n`;

    results.forEach(r => {
        const val = typeof r.value === 'number' && !Number.isNaN(r.value) ? formatValue(r.value) : '数据不足';
        const ci = r.ci ? `${formatValue(r.ci.lower)} ~ ${formatValue(r.ci.upper)}` : '—';
        const rmse = r.backtest && Number.isFinite(r.backtest.rmse) ? r.backtest.rmse.toFixed(2) : '—';
        const mape = r.backtest?.mape != null ? `${(r.backtest.mape * 100).toFixed(2)}%` : '—';
        const isAuto = autoModel.method === r.key;
        const recommend = isAuto ? '✅ 系统选择' : '';
        answer += `| ${r.label} | **${val}** | ${ci} | ${rmse} | ${mape} | ${recommend} |\n`;
    });

    answer += `\n**系统自动选择：${autoModel.methodLabel}**`;
    answer += `\n原因：${autoModel.methodReason}\n`;

    if (bestMethod) {
        answer += `\n**回测误差最小：${bestMethod.label}**（RMSE=${bestMethod.backtest.rmse.toFixed(2)}）`;
        if (autoModel.method !== bestMethod.key) {
            answer += `，与系统选择一致` === `，与系统选择一致` ? '' : '';
        }
    }

    answer += `\n\n**历史数据参考（近5年）：**\n`;
    history.slice(-5).forEach(h => { answer += `- ${h.year}年: ${formatValue(h.value)}\n`; });

    answer += `\n**说明：** 四种方法均基于同一历史序列计算，预测值差异反映了各方法对趋势的不同假设。系统默认选择回测误差最小的方法，但你也可以指定某种方法重新预测，例如"用Holt方法预测${region}${metric}"。`;

    const citations = [`[来源: 预测模块/四种方法并排/${region}/${metric}/${history.length}年数据]`];
    const cleanMetric = cleanMetricName(metric);

    return {
        answer,
        chart: null,
        citations,
        reasoning: [
            '意图: forecast_method_compare',
            `指标: ${metric}`,
            `地区: ${region}`,
            `目标年份: ${targetYear}`,
            `历史样本: ${history.length}年`,
            `系统选择: ${autoModel.methodLabel}`
        ],
        confidence: 0.92,
        suggestions: [
            `用线性回归预测${region}${cleanMetric}`,
            `用Holt方法预测${region}${cleanMetric}`,
            `${region}${cleanMetric}近10年趋势`,
            `${targetYear}年各省${cleanMetric}排名`
        ],
        toolTrace: [{
            tool: 'forecast_method_compare',
            normalizedTool: 'forecast_method_compare',
            params: { metric, region, targetYear, historyLength: history.length },
            success: true,
            type: 'forecast'
        }],
        methodSummary: {
            type: 'forecast_method_compare',
            title: `${region} ${metric} 四种方法比较`,
            methodLabel: '四种时间序列方法并排比较',
            methodReason: '同时运行线性回归、Holt指数平滑、平均漂移、移动均值四种方法，通过回测误差横向对比，帮助用户理解不同假设下的预测差异。',
            params: { metric, region, targetYear }
        }
    };
}

function answerForecastMethodOptions(question, recentHistory = []) {
    const last = getLastMethodSummary(recentHistory);
    const current = last?.type === 'forecast'
        ? `上一轮预测使用的是 **${last.methodLabel || '时间序列外推'}**。`
        : '你上一轮不是预测任务，所以我不应该把这个问题强行接到上一轮趋势分析上。';
    const answer = `${current}

可以，当前系统里已经内置了多种预测思路，不是只有一种：

| 方法 | 适合情况 | 优点 | 注意点 |
|------|------|------|------|
| 线性回归趋势预测 | 长期变化比较平稳 | 解释直观，能看出长期方向 | 遇到短期突变时可能反应慢 |
| Holt 线性指数平滑 | 有趋势但也有波动 | 会平滑噪声，适合年度序列 | 参数会影响结果 |
| 平均漂移外推 | 样本较少或趋势不宜过拟合 | 稳健，不容易过度拟合 | 对结构性拐点不敏感 |
| 近年移动均值趋势外推 | 近期走势比早期更重要 | 更重视近几年变化 | 如果最近异常，会被放大 |

现在默认做法是：先让这些方法都试算，再用最近历史回测误差选择更稳的一个，所以不是写死某一种模型。

如果你希望更进一步，我可以继续加一个“指定预测方法”能力，例如你问：  
“用线性回归预测山东省2025年普通高校数量”  
系统就不再自动选模型，而是按你指定的方法重算，并把不同方法的结果并排比较。`;

    return {
        answer,
        chart: null,
        citations: ['[来源: 预测模块/内置时间序列方法]'],
        reasoning: ['意图: forecast_method_options', '识别为预测方法体系追问', '未强行继承上一轮非预测任务'],
        confidence: 0.94,
        suggestions: ['比较四种方法的预测结果', '用线性回归重新预测', '解释Holt线性指数平滑', '预测2026年全国工业机器人密度'],
        toolTrace: [{
            tool: 'forecast_method_options',
            normalizedTool: 'forecast_method_options',
            params: { lastType: last?.type || null },
            success: true,
            type: 'method_chat'
        }]
    };
}

function buildMethodSummary(result, decision) {
    const tool = normalizeToolName(decision?.tool);
    const data = result?.data || {};
    const summary = {
        tool,
        type: result?.type || tool,
        params: decision?.params || {},
        success: !!result?.success
    };

    if (result?.type === 'forecast') {
        const model = data.forecastModel || {};
        const meta = data.forecastMeta || {};
        summary.title = `${data.region || '指定地区'} ${data.metric || '指标'} ${data.year || ''}年预测`;
        summary.methodLabel = model.methodLabel || '时间序列外推';
        summary.methodReason = model.methodReason || '基于历史年度序列进行趋势外推。';
        summary.historyYears = Array.isArray(data.history) ? data.history.map(d => d.year) : [];
        summary.historyCount = summary.historyYears.length;
        summary.forecastValue = data.forecastValue;
        summary.confidenceInterval = data.confidenceInterval || null;
        summary.backtest = model.backtest || null;
        summary.forecastMeta = meta;
    } else if (result?.type === 'trend') {
        summary.title = `${data.region || '指定地区'} ${data.metric || '指标'}趋势分析`;
        summary.methodLabel = '年度序列趋势分析';
        summary.methodReason = '按年份提取有效观测值，计算起止变化、年均变化，并绘制趋势线。';
    } else if (result?.type === 'ranking') {
        summary.title = '省域排名计算';
        summary.methodLabel = '截面排序';
        summary.methodReason = '在同一年份的省份表中筛选有效数值，按指标升序或降序排序后取前N名。';
    } else if (result?.type === 'compare') {
        summary.title = '对比分析';
        summary.methodLabel = '双对象差值与百分比差异';
        summary.methodReason = '提取两个地区或两个年份的同一指标，计算绝对差值和相对百分比差异。';
        summary.regions = [data.regionA, data.regionB].filter(Boolean);
        summary.metric = data.metric;
        summary.year = data.year;
    } else if (result?.type === 'point') {
        summary.title = `${data.region || '指定地区'} ${data.metric || '指标'}定点查询`;
        summary.methodLabel = '精确查表';
        summary.methodReason = '按地区、年份、指标在数据表中定位单条记录，不做模型推断。';
    }
    return summary;
}

function getLastMethodSummary(history) {
    if (!Array.isArray(history)) return null;
    for (let i = history.length - 1; i >= 0; i--) {
        const meta = history[i]?.meta;
        if (meta?.methodSummary) return meta.methodSummary;
    }
    return null;
}

function answerMethodFollowup(question, recentHistory) {
    const last = getLastMethodSummary(recentHistory);
    if (!last) {
        return {
            answer: "**方法说明**\n\n我还没有拿到上一轮可解释的分析结果，所以不会直接编一个预测过程。\n\n你可以先问：`预测2026年山东省普通高校数量`。我完成预测后，再问`你是怎么预测的`，我会基于上一轮的工具记录解释所用模型、历史样本、回测误差和置信区间。",
            chart: null,
            citations: [],
            reasoning: ['识别为方法追问', '未找到上一轮工具记录'],
            confidence: 0.95,
            suggestions: ['预测2026年山东省普通高校数量', '2024年各省普通高校数量排名', '山东省普通高校数量近5年趋势'],
            toolTrace: []
        };
    }

    let answer = `**${last.title || '上一轮分析'}的方法说明**\n\n`;
    answer += `| 项目 | 说明 |\n|------|------|\n`;
    answer += `| 分析类型 | ${last.methodLabel || '结构化数据分析'} |\n`;
    if (last.type === 'forecast') {
        const meta = last.forecastMeta || {};
        if (meta.latestActualYear) answer += `| 最新真实年份 | ${meta.latestActualYear} |\n`;
        if (meta.forecastStep) answer += `| 预测步长 | ${meta.forecastStep}步（${meta.forecastType || '预测'}） |\n`;
        answer += `| 预测值 | ${formatValue(last.forecastValue)} |\n`;
        if (last.confidenceInterval) {
            answer += `| 置信区间 | ${formatValue(last.confidenceInterval.lower)} - ${formatValue(last.confidenceInterval.upper)} |\n`;
        }
        if (last.historyCount) {
            const years = last.historyYears && last.historyYears.length
                ? `${Math.min(...last.historyYears)}-${Math.max(...last.historyYears)}`
                : `${last.historyCount}年`;
            answer += `| 历史样本 | ${years}，共${last.historyCount}个年度观测 |\n`;
        }
        if (last.backtest) {
            answer += `| 回测误差 | RMSE=${last.backtest.rmse}${last.backtest.mape != null ? `，MAPE=${last.backtest.mape}%` : ''} |\n`;
        }
    }
    answer += `\n**具体过程：**\n`;
    if (last.type === 'forecast') {
        answer += `1. 先按地区、指标抽取历史年度数据，并过滤空值/非数值。\n`;
        answer += `2. 同时试算多种轻量时间序列方法：线性回归趋势、Holt线性指数平滑、平均漂移外推、近年移动均值趋势外推。\n`;
        answer += `3. 用最近历史点做回测，比较误差，选择当前数据上更稳的方法。\n`;
        answer += `4. 对计数、比例、强度类指标做合理约束，并基于残差波动给出置信区间。\n\n`;
        if (last.forecastMeta?.path?.length) {
            answer += `**预测路径：**\n`;
            last.forecastMeta.path.forEach(p => {
                answer += `- ${p.year}年: ${formatValue(p.value)}（模型估计）\n`;
            });
            answer += `\n`;
        }
        if (last.forecastMeta?.forecastStep > 1) {
            answer += `**关键说明：**没有使用真实中间年份数据。该结果是从${last.forecastMeta.latestActualYear}年最新真实值出发，直接向后${last.forecastMeta.forecastStep}步外推；中间年份只作为模型路径参考。\n\n`;
        }
    }
    answer += `**为什么用这个方法：**${last.methodReason || '该方法与当前数据结构和问题意图匹配。'}`;

    return {
        answer,
        chart: null,
        citations: [`[来源: 会话工具记录/${last.methodLabel || last.type}]`],
        reasoning: ['识别为方法追问', `继承上一轮: ${last.type || 'analysis'}`, `方法: ${last.methodLabel || '结构化分析'}`],
        confidence: 0.96,
        confidenceInterval: last.confidenceInterval || null,
        suggestions: ['换一个省份继续预测', '查看该指标近5年趋势', '比较江苏和浙江同一指标'],
        toolTrace: [{
            tool: 'explain_method',
            normalizedTool: 'explain_method',
            params: last.params || {},
            success: true,
            type: 'method_explanation'
        }]
    };
}

// ========== Agent 主流程（LLM驱动版）==========

/**
 * llmDecideAction: 核心决策函数
 * 把工具列表、完整对话历史、上一轮状态全部交给 DeepSeek
 * 让 LLM 决定：调哪个工具、用什么参数、还是需要追问
 */
async function llmDecideAction(question, recentHistory = [], lastMethod = null) {
    const latestYear = getLatestYear(rawDataCache.province);
    const allMetrics = metricNameList.map(m => cleanMetricName(m)).join('、');

    // 构建完整的上下文历史
    const historyText = recentHistory.slice(-8).map(h => {
        const role = h.role === 'user' ? '用户' : '助手';
        const content = String(h.content || '').slice(0, 300);
        return `${role}: ${content}`;
    }).join('\n');

    // 上一轮方法摘要
    const lastMethodText = lastMethod ? `上一轮分析：${lastMethod.type}，指标=${lastMethod.params?.metric || ''}，地区=${lastMethod.params?.region || lastMethod.regions?.[0] || ''}，年份=${lastMethod.params?.targetYear || lastMethod.params?.year || ''}` : '无';

    const prompt = `你是山东财经大学科研教育人才数据平台的智能分析助手。请理解用户问题的真实意图，决定下一步行动。

## 平台真实指标（只能用这些）
${allMetrics}

## 数据覆盖
最新年份：${latestYear}年，覆盖全国、31省份、200+地级市

## 可用工具
- trend_analysis: 查看某指标的历年趋势变化
  参数: {"metric":"指标名","region":"地区或全国","years":[年份数组，近N年]}
- forecast: 预测某指标未来某年的值
  参数: {"metric":"指标名","region":"地区或全国","targetYear":年份数字}
- get_ranking: 某年份某指标的省份排名
  参数: {"metric":"指标名","year":年份数字,"order":"desc或asc","topN":数字}
- compare: 两个地区或两个年份的指标对比
  参数: {"metric":"指标名","year":年份,"regionA":"地区A","regionB":"地区B","compareYear":null或年份}
- point_query: 查询某地区某年份某指标的具体数值
  参数: {"metric":"指标名","region":"地区","year":年份数字}
- forecast_compare: 比较四种预测方法的结果并排展示，用于"换种方法/比较方法/哪种方法更好"
  参数: {"metric":"指标名","region":"地区","targetYear":年份}
- evidence_chat: 开放式分析、原因解释、建议、评价类问题，也用于多地区（3个以上）对比分析
  参数: {}
- chat: 闲聊、平台介绍、能力说明
  参数: {}

## 决策规则
1. 用户说"换一个地区/换个省份"但没说具体哪里 → action=ask_clarification，clarification="请问您想换哪个省份或地区？"
2. 用户说"换成山东/换广东省"→ 继承上一轮指标和年份，region换成新地区，直接调工具
3. 用户说"换种方法预测/用线性回归预测/比较四种方法" → tool=forecast_compare，继承上一轮指标地区年份
4. 用户说"那浙江呢/江苏的呢" → 继承上一轮指标，region换成提到的省份
5. 趋势类：含"近N年" → years取近N年的数组；含"历年/所有/全部/多年/所有年份" → years传null表示取全部历史数据；只说"趋势"不带年数 → years传null
6. 含"为什么/原因/怎么看/评价/建议" → evidence_chat
7. 含"华东/华南/华北/多个省/几个省的对比/多地区对比" → 必须用evidence_chat，不能用compare（compare只支持两个地区），同时在regions字段列出所有省份
8. 两个地区对比 → compare工具，regionA和regionB填具体省份全称
9. 参数不完整且无法从上下文推断 → ask_clarification
10. 普通问候、功能询问 → chat

## 对话历史
${historyText || '无'}

## 上一轮分析状态
${lastMethodText}

## 用户问题
${question}

## 输出格式（严格JSON，不要解释，不要markdown）
{
  "action": "call_tool 或 ask_clarification 或 answer_directly",
  "tool": "工具名（action=call_tool时必填）",
  "params": {参数对象},
  "clarification": "追问内容（action=ask_clarification时填写）",
  "rationale": "一句话说明决策原因",
  "regions": ["如果涉及多个地区，列出所有地区名"]
}`;

    try {
        const raw = await generateFast(prompt, 20000);
        const parsed = safeParseJSON(raw);
        if (!parsed || !parsed.action) return null;
        console.log('🧠 LLM决策:', JSON.stringify(parsed).slice(0, 200));
        return parsed;
    } catch (err) {
        console.warn('LLM决策失败:', err.message);
        return null;
    }
}

/**
 * 从LLM决策结果中规范化工具参数
 */
function normalizeLLMDecision(decision, lastMethod = null) {
    if (!decision || decision.action !== 'call_tool') return null;
    const tool = normalizeToolName(decision.tool || '');
    const allowed = ['get_ranking','compare','forecast','point_query','trend_analysis','evidence_chat','chat'];
    if (!allowed.includes(tool)) return null;

    const params = { ...(decision.params || {}) };
    const latestYear = getLatestYear(rawDataCache.province);

    // 规范化年份类型
    if (params.year != null) params.year = parseInt(params.year) || latestYear;
    if (params.targetYear != null) params.targetYear = parseInt(params.targetYear) || (latestYear + 2);
    if (params.compareYear != null) params.compareYear = parseInt(params.compareYear) || null;
    if (Array.isArray(params.years)) params.years = params.years.map(y => parseInt(y)).filter(Number.isFinite);

    // 强制覆盖：用户说"历年/所有/全部"时取全部数据，不管LLM传了什么年份数组
    const qLower = (decision._originalQuestion || '').toLowerCase();
    if (tool === 'trend_analysis' && Array.isArray(params.years) &&
        /(历年|所有年|全部年|所有数据|全部数据|全年|各年|每年|年年|从.*年|2000年|2001年)/.test(decision._originalQuestion || '')) {
        params.years = null;
        console.log('📅 检测到历年意图，强制years=null');
    }

    // 规范化排序
    if (params.order && !['desc','asc'].includes(params.order)) params.order = 'desc';
    if (!params.order && tool === 'get_ranking') params.order = 'desc';
    if (!params.topN && tool === 'get_ranking') params.topN = 10;

    // 补全缺失参数（从上一轮继承）
    if (!params.metric && lastMethod?.params?.metric) params.metric = lastMethod.params.metric;
    if (!params.metric) params.metric = metricNameList[0] || '';
    if (!params.region && tool !== 'get_ranking' && tool !== 'compare') {
        params.region = lastMethod?.params?.region || lastMethod?.regions?.[0] || '全国';
    }
    if (!params.targetYear && tool === 'forecast') {
        params.targetYear = lastMethod?.params?.targetYear || (latestYear + 2);
    }
    if (!params.year && tool === 'get_ranking') params.year = latestYear;

    // 规范化地区名（短名 → 全称，与 extractEntities 保持一致）
    const regionMap = {
        '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
        '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
        '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
        '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
        '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
        '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
        '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
        '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
        '青海': '青海省'
    };
    const normalizeRegion = r => {
        if (!r || r === '全国') return r;
        if (regionMap[r]) return regionMap[r];
        // 包含匹配：如 "山东省" 已经是全称直接返回
        const provinceList = [...new Set(rawDataCache.province.map(row => row['地区']))];
        if (provinceList.includes(r)) return r;
        // 短名包含匹配
        for (const [short, full] of Object.entries(regionMap)) {
            if (r.includes(short)) return full;
        }
        return r;
    };
    if (params.region) params.region = normalizeRegion(params.region);
    if (params.regionA) params.regionA = normalizeRegion(params.regionA);
    if (params.regionB) params.regionB = normalizeRegion(params.regionB);
    // regions 数组也规范化（多地区场景）
    if (Array.isArray(decision.regions)) {
        decision.regions = decision.regions.map(normalizeRegion);
    }

    // 规范化指标名（匹配真实字段）
    if (params.metric) {
        const cleanM = cleanMetricName(params.metric);
        const matched = metricNameList.find(m => m === params.metric || cleanMetricName(m) === cleanM ||
            cleanMetricName(m).includes(cleanM) || cleanM.includes(cleanMetricName(m)));
        if (matched) params.metric = matched;
    }

    return { tool, params, rationale: decision.rationale || '' };
}

/**
 * 主 Agent 循环
 * 架构：LLM决策 → 工具执行 → Corrective RAG → 生成回答
 */
async function runAgent(question, recentHistory = []) {
    const q = question.trim();

    // 历史压缩
    recentHistory = await compressHistoryIfNeeded(
        Array.isArray(recentHistory) ? recentHistory.slice(-MAX_HISTORY * 2) : []
    );

    const lastMethod = getLastMethodSummary(recentHistory);
    const latestYear = getLatestYear(rawDataCache.province);

    // ── 平台事实类问题：直接从数据源返回，不走LLM ──────
    // 这类问题LLM无法准确回答，必须从真实数据读取

    // 1. 指标列表查询
    if (/(有哪些指标|指标有哪些|指标列表|包含哪些指标|指标是什么|什么指标|哪些指标|指标名称|都有什么指标|指标都有|全部指标|所有指标)/.test(q)) {
        const realMetrics = metricNameList.map((m, i) => `${i + 1}. ${cleanMetricName(m)}`).join('\n');
        return {
            answer: `平台共收录 **${metricNameList.length}** 个指标，均来自真实数据，具体如下：\n\n${realMetrics}\n\n直接用指标名提问即可，例如"近10年工业机器人密度趋势"或"2024年各省发明专利排名"。`,
            chart: null, citations: [],
            reasoning: ['意图: 指标列表查询', '直接从数据源返回'],
            confidence: 1.0,
            suggestions: metricNameList.slice(0, 4).map(m => `近10年${cleanMetricName(m)}趋势`)
        };
    }

    // 2. 年份覆盖 / 最新年份
    if (/(最新.*年|哪.*年|覆盖.*年|数据.*年份|年份.*数据|最近.*年份|到.*哪年|数据.*到|截止|最新数据)/.test(q) && !/(预测|预计|趋势|近\d)/.test(q)) {
        const allYears = [...new Set([...rawDataCache.national, ...rawDataCache.province].map(r => r['年份']).filter(Boolean))].sort();
        const minYear = allYears[0], maxYear = allYears[allYears.length - 1];
        return {
            answer: `平台数据覆盖 **${minYear}–${maxYear}** 年，共 ${allYears.length} 个年份，最新数据为 **${maxYear}** 年。\n\n全国数据：${rawDataCache.national.length} 条\n省份数据：${rawDataCache.province.length} 条\n地级市数据：${rawDataCache.city.length} 条`,
            chart: null, citations: [],
            reasoning: ['意图: 年份覆盖查询', '直接从数据源返回'],
            confidence: 1.0,
            suggestions: [`${maxYear}年各省工业机器人密度排名`, `近10年全国普通高校数量趋势`, `预测2026年全国科学支出水平`]
        };
    }

    // 3. 地区覆盖查询
    if (/(有哪些省|哪些省份|覆盖.*省|省份.*列表|有哪些地区|地区.*范围|哪些城市|地级市.*哪些|覆盖.*地区)/.test(q)) {
        const provinces = [...new Set(rawDataCache.province.map(r => r['地区']).filter(Boolean))].sort();
        const cityCount = [...new Set(rawDataCache.city.map(r => r['地区']).filter(Boolean))].length;
        return {
            answer: `平台覆盖以下地区：\n\n**省级（${provinces.length}个）：**\n${provinces.join('、')}\n\n**地级市：** ${cityCount}+ 个\n\n**全国汇总数据：** 有`,
            chart: null, citations: [],
            reasoning: ['意图: 地区覆盖查询', '直接从数据源返回'],
            confidence: 1.0,
            suggestions: provinces.slice(0, 4).map(p => `${p}近10年工业机器人密度趋势`)
        };
    }

    // 4. 数据量查询
    if (/(多少.*数据|数据.*多少|数据量|几条数据|数据规模|数据.*条数)/.test(q)) {
        const total = rawDataCache.national.length + rawDataCache.province.length + rawDataCache.city.length;
        return {
            answer: `平台共有 **${total.toLocaleString()}** 条数据记录：\n\n- 全国汇总：${rawDataCache.national.length} 条\n- 省份数据：${rawDataCache.province.length} 条\n- 地级市数据：${rawDataCache.city.length} 条\n\n覆盖 **${metricNameList.length}** 个指标，时间跨度涵盖多个年份。`,
            chart: null, citations: [],
            reasoning: ['意图: 数据量查询', '直接从数据源返回'],
            confidence: 1.0,
            suggestions: ['近10年全国工业机器人密度趋势', '2024年各省普通高校数量排名']
        };
    }

    // 5. 能力/功能查询
    if (/(你能做什么|能做什么|有什么功能|功能有哪些|帮助|支持.*功能|怎么用|如何使用|使用说明|help$)/i.test(q)) {
        return {
            answer: `**平台核心功能：**\n\n| 功能 | 说明 | 示例 |\n|------|------|------|\n| 趋势分析 | 查看指标历年变化 | 近10年工业机器人密度趋势 |\n| 排名 | 省份横向排名 | 2024年各省发明专利前10 |\n| 地区对比 | 两省指标对比 | 江苏和浙江R&D投入对比 |\n| 年度对比 | 同指标不同年份 | 2020和2024年科学支出对比 |\n| 预测 | 时序外推预测 | 预测2026年全国高校数量 |\n| 单点查询 | 精确查某年某省值 | 2023年广东普通高校数量 |\n| 开放分析 | 原因/建议/评价 | 为什么广东机器人密度高 |\n\n**数据范围：** ${metricNameList.length} 个指标，覆盖全国+31省份+200+地级市，最新到 **${latestYear}** 年。`,
            chart: null, citations: [],
            reasoning: ['意图: 功能查询', '直接返回平台能力说明'],
            confidence: 1.0,
            suggestions: ['有哪些指标', '覆盖哪些省份', '近10年工业机器人密度趋势', `${latestYear}年各省发明专利排名`]
        };
    }

    // 6. 某指标是否存在 / 有没有XXX数据
    const hasDataMatch = q.match(/(有没有|有.*数据|支持.*指标|能查.*吗|有.*指标)(.*?)(?:的数据|指标|数据)?$/);
    if (/(有没有|能查|支持查询|有.*的数据)/.test(q) && !/(趋势|排名|预测|对比|分析)/.test(q)) {
        const entities = extractEntities(q);
        const metric = entities.metrics[0];
        const region = entities.regions[0];
        if (metric) {
            return {
                answer: `有的，平台包含 **${cleanMetricName(metric)}** 指标，覆盖${region ? `**${region}**及` : ''}全国31个省份，最新到 **${latestYear}** 年。\n\n你可以直接问我：\n- "${region || '广东省'}近10年${cleanMetricName(metric)}趋势"\n- "${latestYear}年各省${cleanMetricName(metric)}排名"\n- "预测2026年${region || '全国'}${cleanMetricName(metric)}"`,
                chart: null, citations: [],
                reasoning: ['意图: 指标存在性查询', `命中指标: ${metric}`],
                confidence: 1.0,
                suggestions: [`${region || '全国'}近10年${cleanMetricName(metric)}趋势`, `${latestYear}年各省${cleanMetricName(metric)}排名`, `预测2026年${region || '全国'}${cleanMetricName(metric)}`]
            };
        }
    }

    // 7. 打招呼
    const greetings = ['你好','嗨','hello','hi','在吗','早上好','下午好','晚上好','您好'];
    if (greetings.some(g => q.toLowerCase() === g || q.toLowerCase().startsWith(g))) {
        return answerGeneralChat(q, recentHistory);
    }

    // ── Step 1: LLM 决策 ──────────────────────────────
    const llmDecision = await llmDecideAction(q, recentHistory, lastMethod);

    // LLM 要求追问
    if (llmDecision?.action === 'ask_clarification') {
        const clarification = llmDecision.clarification || '请补充更多信息，例如具体地区、年份或指标。';
        console.log('❓ LLM要求追问:', clarification);
        return {
            answer: clarification,
            chart: null,
            citations: [],
            reasoning: ['意图: 需要澄清', `缺失: ${clarification}`],
            confidence: 0.95,
            suggestions: buildClarificationSuggestions(q, lastMethod),
            toolTrace: [{ tool: 'clarification', normalizedTool: 'clarification', params: {}, success: true, type: 'clarification' }]
        };
    }

    // LLM 决定直接聊天
    if (llmDecision?.action === 'answer_directly' || llmDecision?.tool === 'chat') {
        return answerGeneralChat(q, recentHistory);
    }

    // LLM 决定四种方法并排比较预测
    if (llmDecision?.tool === 'forecast_compare') {
        const fakeHistory = [...recentHistory];
        if (lastMethod) fakeHistory._lastMethod = lastMethod;
        return answerForecastMethodCompare(q, recentHistory);
    }

    // LLM 决定调用 evidence_chat
    if (llmDecision?.tool === 'evidence_chat') {
        const entities = await extractEntitiesAsync(q, recentHistory);
        // 处理多地区（华东等）- 优先用LLM展开的regions
        if (llmDecision.regions?.length > 0) {
            const regionMap = {
                '广东': '广东省', '江苏': '江苏省', '浙江': '浙江省', '山东': '山东省',
                '北京': '北京市', '上海': '上海市', '天津': '天津市', '重庆': '重庆市',
                '安徽': '安徽省', '福建': '福建省', '江西': '江西省', '河南': '河南省',
                '湖北': '湖北省', '湖南': '湖南省', '四川': '四川省', '贵州': '贵州省',
                '云南': '云南省', '陕西': '陕西省', '甘肃': '甘肃省', '海南': '海南省',
                '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省', '河北': '河北省',
                '山西': '山西省', '内蒙古': '内蒙古自治区', '广西': '广西壮族自治区',
                '西藏': '西藏自治区', '新疆': '新疆维吾尔自治区', '宁夏': '宁夏回族自治区',
                '青海': '青海省'
            };
            entities.regions = llmDecision.regions.map(r => regionMap[r] || r);
        }
        // 继承上一轮指标（上下文追问时实体提取可能为空）
        if (!entities.metrics.length && lastMethod?.params?.metric) {
            entities.metrics = [lastMethod.params.metric];
        }
        // 继承上一轮地区
        if (!entities.regions.length && lastMethod?.params?.region) {
            entities.regions = [lastMethod.params.region];
        }
        return answerEvidenceChat(q, entities, recentHistory);
    }

    // ── Step 2: 规范化工具决策 ────────────────────────
    let toolDecision = normalizeLLMDecision({ ...llmDecision, _originalQuestion: q }, lastMethod);

    // LLM决策失败，降级到规则
    if (!toolDecision) {
        console.warn('⚠️ LLM决策无效，降级到规则');
        const entities = await extractEntitiesAsync(q, recentHistory);
        // 补全实体继承
        if (!entities.metrics.length && lastMethod?.params?.metric) {
            entities.metrics = [lastMethod.params.metric];
        }
        if (!entities.regions.length) {
            entities._defaultNational = true;
        }
        const ruleDecision = ruleBasedDecide(q, entities);
        if (ruleDecision) {
            toolDecision = ruleDecision;
        } else {
            // 最终降级：evidence_chat
            return answerEvidenceChat(q, entities, recentHistory);
        }
    }

    console.log('🔧 执行工具:', toolDecision.tool, JSON.stringify(toolDecision.params).slice(0, 150));

    // ── Step 3: 处理特殊多地区情况 ──────────────────────
    if (llmDecision?.regions?.length > 1 && toolDecision.tool === 'forecast') {
        const entities = { regions: llmDecision.regions, metrics: [toolDecision.params.metric], years: [] };
        return answerMultiRegionForecast(q, entities);
    }
    if (llmDecision?.regions?.length >= 2 && toolDecision.tool === 'compare') {
        toolDecision.params.regionA = llmDecision.regions[0];
        toolDecision.params.regionB = llmDecision.regions[1];
    }

    // ── Step 4: 处理预测对比 ─────────────────────────────
    const entities_for_special = { 
        regions: llmDecision?.regions || (toolDecision.params.regionA ? [toolDecision.params.regionA, toolDecision.params.regionB] : [toolDecision.params.region || '全国']),
        metrics: [toolDecision.params.metric],
        years: toolDecision.params.targetYear ? [toolDecision.params.targetYear] : []
    };
    if (isForecastComparisonQuestion(q, entities_for_special)) {
        return answerForecastComparison(q, entities_for_special);
    }

    // ── Step 5: 执行工具 ──────────────────────────────────
    const entities = await extractEntitiesAsync(q, recentHistory);
    const result = await executeTool(toolDecision, entities);

    // ── Step 6: 生成回答 ──────────────────────────────────
    const generated = await generateAnswer(result, q, result.type);
    const citations = generated.citations || [];

    let chart = null;
    if (result.type === 'trend' && result.data.years?.length) {
        chart = {
            type: 'line',
            metric: result.data.metric,
            regions: [result.data.region],
            years: result.data.years,
            table: result.data.table || (result.data.region === '全国' ? '全国表' : '省份表'),
            title: `${result.data.region} ${result.data.metric} 趋势图`
        };
    } else if (result.type === 'ranking' && result.data.length > 0) {
        const rankYear = toolDecision.params?.year || latestYear;
        chart = {
            type: 'bar',
            metric: toolDecision.params?.metric || '',
            regions: result.data.map(d => d.region),
            years: [rankYear],
            title: `${rankYear}年 ${toolDecision.params?.metric || ''} 排名`
        };
    }

    const confidenceInterval = result.type === 'forecast'
        ? (result.data.confidenceInterval || getForecastInterval(result.data.history, result.data.forecastValue, result.data.year))
        : null;

    const toolTrace = [{
        tool: toolDecision.tool,
        normalizedTool: normalizeToolName(toolDecision.tool),
        params: toolDecision.params || {},
        success: !!result.success,
        type: result.type
    }];
    const methodSummary = buildMethodSummary(result, toolDecision);

    // ── Step 7: LLM 润色最终回答 ─────────────────────────
    const answer = await synthesizeConversationalAnswer(q, generated.text || '', {
        resultType: result.type,
        success: result.success,
        citations,
        toolTrace,
        methodSummary
    });

    const suggestions = buildFollowupSuggestions(q, result, entities);

    return {
        answer,
        chart,
        citations,
        reasoning: [
            `LLM决策: ${toolDecision.tool}`,
            toolDecision.rationale || '',
            `指标: ${result.data?.metric || toolDecision.params?.metric || ''}`,
            `地区: ${result.data?.region || toolDecision.params?.region || '全国'}`,
            `数据: ${result.success ? '✅' : '❌'}`
        ].filter(Boolean),
        confidence: result.success ? 0.9 : 0.5,
        confidenceInterval,
        suggestions,
        toolTrace,
        methodSummary
    };
}

/**
 * 生成追问场景的建议问题
 */
function buildClarificationSuggestions(question, lastMethod) {
    const metric = lastMethod?.params?.metric || inferMetric(question);
    const cleanMetric = cleanMetricName(metric);
    const latestYear = getLatestYear(rawDataCache.province);
    return [
        `预测2026年广东省${cleanMetric}`,
        `预测2026年山东省${cleanMetric}`,
        `预测2026年江苏省${cleanMetric}`,
        `${latestYear}年各省${cleanMetric}排名`
    ].filter(Boolean).slice(0, 4);
}


// ========== API 路由 ==========
function splitCompoundQuestions(question) {
    const text = String(question || '').trim();
    if (!text) return [];
    if (text.length <= 18) return [text];

    if (/(预测|预计|未来).*(对比|比较|比对|vs|VS|差距|谁高|谁低)/.test(text)
        && detectMentionedRegions(text).length >= 2
        && extractEntities(text).metrics.length <= 1) {
        return [text];
    }

    const numbered = text
        .replace(/(^|[\n\r。；;！？?])\s*(?:第?\d+\s*[\.、，,)]|[（(]\d+[）)])/g, '$1||')
        .replace(/\s+(?=\d+\s*[\.、，,)]\s*[\u4e00-\u9fa5])/g, '||')
        .replace(/([。；;！？?])\s*(?=\d+\s*[\.、，,)]\s*)/g, '$1||');

    const hardParts = numbered
        .split(/\|\||[\n\r]+|[\uFF1F?;\uFF1B。]+/g)
        .map(s => s.trim())
        .filter(Boolean);
    const baseParts = hardParts.length > 1 ? hardParts : [text];
    const intentPattern = /(预测|预估|未来|排名|前\d+|最高|最低|趋势|走势|变化|对比|比较|比对|vs|多少|是多少|评价|分析|说明|建议|怎么看)/i;
    const splitters = /(?:另外|还有|并且|同时|顺便|再帮我|再看|再查|再分析|以及)/g;
    const result = [];

    for (const part of baseParts) {
        if (/(预测|预计|未来).*(对比|比较|比对|vs|VS|差距|谁高|谁低)/.test(part)
            && detectMentionedRegions(part).length >= 2
            && extractEntities(part).metrics.length <= 1) {
            result.push(part);
            continue;
        }
        const chunks = part
            .replace(splitters, '||')
            .split('||')
            .map(s => s.trim().replace(/^[\uFF0C,\u3001\u3002.\s]+|[\uFF0C,\u3001\u3002.\s]+$/g, ''))
            .filter(Boolean);
        if (chunks.length > 1 && chunks.every(c => intentPattern.test(c) || c.length >= 8)) {
            result.push(...chunks);
        } else {
            result.push(part);
        }
    }

    const deduped = [];
    for (const item of result) {
        if (item && !deduped.includes(item)) deduped.push(item);
    }
    return deduped.slice(0, 6);
}

function normalizePlannedTasks(plan, originalQuestion) {
    const rawTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const cleaned = [];
    for (const task of rawTasks) {
        const q = String(task?.question || '').trim()
            .replace(/^[\s\d\.、，,;；。:：)）(（]+/, '')
            .replace(/[\s;；。]+$/, '');
        if (q.length < 4) continue;
        if (q.length > String(originalQuestion || '').length + 8) continue;
        if (!cleaned.includes(q)) cleaned.push(q);
    }
    return cleaned.slice(0, 6);
}

function looksLikeCompoundQuestion(question) {
    const q = String(question || '');
    if (!q.trim()) return false;
    if (/(^|[。；;！？?\n\r])\s*(?:第?\d+\s*[\.、，,)]|[（(]\d+[）)])/.test(q)) return true;
    const intentHits = (q.match(/预测|预估|未来|趋势|走势|排名|前\d+|对比|比较|比对|多少|是多少|评价|分析/g) || []).length;
    const metricHits = extractEntities(q).metrics.length;
    return intentHits >= 2 || metricHits >= 2 || /另外|还有|并且|同时|顺便|以及|再帮我|再看|再查|再分析/.test(q);
}

async function planCompoundQuestions(question, history = []) {
    const text = String(question || '').trim();
    const fallback = splitCompoundQuestions(text);
    if (!looksLikeCompoundQuestion(text)) return fallback;

    const metricHints = metricNameList.slice(0, 40).join('、');
    const historyHint = Array.isArray(history)
        ? history.slice(-4).map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 120)}`).join('\n')
        : '';
    const prompt = `你是科研教育人才数据平台的“问题任务规划器”。请把用户的一次输入拆成可以独立执行的数据分析子任务，只返回严格 JSON。

要求：
1. 不要回答问题，只做任务拆解。
2. 如果一句话包含不同意图或不同指标，例如“预测山东高校数量。给我广东机器人密度趋势”，必须拆成多个 task。
3. 如果是同一指标同一意图的多地区问题，例如“分别预测广东、山东、山西2025年高校数量”，保留为一个 task。
4. 如果是“预测山东并和江苏比对”这种同一指标的预测对比，也保留为一个 task。
5. task.question 必须是用户原意的自然语言短句，不要补造数据，不要合并不同指标。
6. 最多 6 个任务。

可用指标示例：${metricHints}
最近上下文：
${historyHint || '无'}

用户输入：${text}

返回格式：
{"tasks":[{"question":"...","intent":"forecast|trend|ranking|compare|point|chat","regions":[],"metric":"","years":[]}]}`

    for (let i = 0; i < 2; i++) {
        try {
            const raw = await generateFast(prompt, 15000);
            const plan = safeParseJSON(raw);
            const tasks = normalizePlannedTasks(plan, text);
            if (tasks.length >= 2) {
                console.log('🧭 LLM任务规划:', tasks);
                return tasks;
            }
            if (tasks.length === 1 && fallback.length <= 1) return tasks;
        } catch (err) {
            console.warn('任务规划模型不可用，使用规则拆分:', err.message);
            break;
        }
    }
    return fallback;
}
async function runAgentBatch(question, history = []) {
    const parts = await planCompoundQuestions(question, history);
    if (parts.length <= 1) {
        return runAgent(question.trim(), history);
    }

    const localHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY * 2) : [];
    const results = [];
    for (const part of parts) {
        const result = await runAgent(part, localHistory);
        results.push({ question: part, result });
        localHistory.push({ role: 'user', content: part, ts: Date.now() });
        localHistory.push({
            role: 'assistant',
            content: result.answer || '',
            ts: Date.now(),
            meta: {
                methodSummary: result.methodSummary || null,
                toolTrace: result.toolTrace || [],
                confidenceInterval: result.confidenceInterval || null,
                citations: result.citations || []
            }
        });
        if (localHistory.length > MAX_HISTORY * 2) {
            localHistory.splice(0, localHistory.length - MAX_HISTORY * 2);
        }
    }

    const answer = results.map((item, index) => {
        return `### 问题 ${index + 1}：${item.question}\n\n${item.result.answer || '未生成回答'}`;
    }).join('\n\n---\n\n');
    const citations = [...new Set(results.flatMap(item => item.result.citations || []))].slice(0, 12);
    const reasoning = [
        `识别到 ${parts.length} 个子问题，已逐项分析`,
        ...results.flatMap((item, index) => (item.result.reasoning || []).slice(0, 2).map(r => `Q${index + 1}: ${r}`))
    ].slice(0, 10);
    const toolTrace = results.flatMap(item => item.result.toolTrace || []);
    const suggestions = [...new Set(results.flatMap(item => item.result.suggestions || []))].slice(0, 4);
    const confidenceValues = results.map(item => item.result.confidence).filter(v => typeof v === 'number');

    return {
        answer,
        chart: results.find(item => item.result.chart)?.result.chart || null,
        citations,
        reasoning,
        confidence: confidenceValues.length
            ? Number((confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length).toFixed(2))
            : 0.85,
        suggestions,
        toolTrace,
        methodSummary: {
            type: 'compound_question',
            title: '多问题拆解分析',
            methodLabel: '问题拆解 + 顺序 Agent 调用 + 结果合并',
            methodReason: '用户一次输入中包含多个独立意图时，系统先拆成子问题，再逐个调用检索、排名、趋势、对比或预测工具，最后合并为完整回答。',
            params: { question, parts }
        }
    };
}

app.post('/api/agent', async (req, res) => {
    const { question, sessionId } = req.body || {};
    const questionError = validateQuestion(question);
    if (questionError) return res.status(400).json({ error: questionError });
    const cleanSessionId = sanitizeSessionId(sessionId);
    if (!cleanSessionId) return res.status(400).json({ error: 'sessionId格式不合法' });
    try {
        const history = getSessionHistory(cleanSessionId);
        const result = await runAgentBatch(question.trim(), history);
        pushSessionHistory(cleanSessionId, 'user', question.trim());
        pushSessionHistory(cleanSessionId, 'assistant', result.answer, {
            methodSummary: result.methodSummary || null,
            toolTrace: result.toolTrace || [],
            confidenceInterval: result.confidenceInterval || null,
            citations: result.citations || []
        });
        res.json(result);
    } catch (err) {
        console.error('Agent 错误:', err);
        res.status(500).json({ error: err.message, answer: '抱歉，出现错误，请稍后再试。', citations: [], reasoning: ['处理异常', err.message] });
    }
});

app.post('/api/clear_history', (req, res) => {
    const cleanSessionId = sanitizeSessionId(req.body?.sessionId);
    if (!cleanSessionId) return res.status(400).json({ error: 'sessionId格式不合法' });
    sessionHistories.delete(cleanSessionId);
    res.json({ ok: true, sessionId: cleanSessionId });
});

app.post('/api/scatter', async (req, res) => {
    try {
        const { table, year, xMetric, yMetric, regions } = req.body;
        const tableName = table === 'city' ? 'city' : 'province';
        if (!Number.isInteger(year) || year < 1900 || year > 2100) {
            return res.status(400).json({ error: 'year不合法' });
        }
        if (typeof xMetric !== 'string' || typeof yMetric !== 'string' || !xMetric.trim() || !yMetric.trim()) {
            return res.status(400).json({ error: '指标参数不合法' });
        }
        if (!Array.isArray(regions) || !regions.length || regions.length > 300 || regions.some(r => typeof r !== 'string' || r.length > 80)) {
            return res.status(400).json({ error: '地区参数不合法' });
        }
        const sourceRows = tableName === 'city' ? rawDataCache.city : rawDataCache.province;
        const xKey = findRealKey(sourceRows, xMetric);
        const yKey = findRealKey(sourceRows, yMetric);
        if (!xKey || !yKey) {
            return res.status(400).json({
                error: '指标不存在',
                missing: { xMetric: xKey ? null : xMetric, yMetric: yKey ? null : yMetric }
            });
        }
        const rows = sourceRows.filter(r => (r['年份'] ?? r['时间']) === year && regions.includes(r['地区']));
        if (!rows.length) {
            return res.status(404).json({ error: '未找到匹配地区或年份的数据' });
        }
        const data = rows
            .map(r => [r[xKey], r[yKey], r['地区']])
            .filter(d => Number.isFinite(Number(d[0])) && Number.isFinite(Number(d[1])));
        if (!data.length) {
            return res.status(404).json({ error: '所选地区在当前指标下没有可绘制数据' });
        }
        res.json({ data, xName: xMetric, yName: yMetric, table: tableName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== BM25 & ChromaDB ==========
async function buildBM25Index() {
    if (!collection) return;
    try {
        const count = await collection.count();
        if (!count) return;
        const allData = await collection.get();
        const docs = allData.documents;
        if (!docs || !docs.length) return;
        bm25Index = new FlexSearch.Index({ tokenize: 'full' });
        docs.forEach((doc, idx) => { bm25Index.add(idx, doc); });
        allDocuments = docs;
        console.log(`✅ BM25 索引构建完成 (${docs.length}条)`);
    } catch (e) { console.warn('BM25 构建失败:', e.message); }
}

async function initVectorStore() {
    if (process.env.DISABLE_CHROMA === 'true') {
        console.log('ℹ️ ChromaDB 已按 DISABLE_CHROMA=true 关闭，当前使用本地混合检索与重排序。');
        collection = null;
        return;
    }
    const originalWarn = console.warn;
    console.warn = (...args) => {
        const msg = args.map(a => String(a)).join(' ');
        if (msg.includes('DefaultEmbeddingFunction') && msg.includes('@chroma-core/default-embed')) return;
        originalWarn(...args);
    };
    try {
        const chroma = new ChromaClient({ host: 'localhost', port: 8000, ssl: false });
        collection = await chroma.getOrCreateCollection({
            name: 'patent_knowledge',
            embeddingFunction: null
        });
        const count = await collection.count();
        if (count > 0) {
            console.log(`✅ ChromaDB 知识库已连接: patent_knowledge / ${count} 条`);
            await buildBM25Index();
        } else {
            console.log('⚠️ ChromaDB 已连接，但 patent_knowledge 为空；将自动使用本地混合检索。');
        }
    } catch (err) {
        console.warn(`⚠️ ChromaDB 未连接成功（${err.message}），已自动降级为本地混合检索。`);
        collection = null;
    } finally {
        console.warn = originalWarn;
    }
}

// ========== 启动 ==========
app.listen(PORT, async () => {
    console.log(`🚀 服务启动 → http://localhost:${PORT}`);
    if (USE_DEEPSEEK_API) {
        console.log(`🤖 推理引擎: DeepSeek API (${DEEPSEEK_MODEL})`);
    } else {
        console.log(`🤖 推理引擎: 本地 Ollama (${OLLAMA_MODEL})，未检测到 DEEPSEEK_API_KEY`);
    }
    await loadDataCache();
    buildHybridKnowledgeIndex();
    await initVectorStore();
    setInterval(cleanupExpiredSessions, Math.min(SESSION_TTL_MS, 10 * 60 * 1000)).unref?.();
    console.log(`🧹 会话策略: history=${DISABLE_HISTORY ? 'off' : 'on'}, ttl=${Math.round(SESSION_TTL_MS / 60000)}min, maxSessions=${MAX_SESSIONS}, maxHistory=${MAX_HISTORY}`);
    console.log('✅ 就绪，等待提问...');
});
