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
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '45000', 10);

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

async function generateSync(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    try {
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                options: {
                    temperature: 0.18,
                    top_p: 0.82,
                    num_ctx: 4096
                }
            })
        });
        if (!response.ok) throw new Error(`Ollama ${response.status}`);
        const data = await response.json();
        return data.response || '';
    } finally {
        clearTimeout(timer);
    }
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
function extractEntities(question) {
    const entities = { regions: [], metrics: [], years: [] };
    if (/(全国|全国范围|全国层面|国内整体|中国整体|全国整体)/.test(question)) {
        entities.regions.push('全国');
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
    const years = question.match(/20\d{2}/g);
    if (years) entities.years = [...new Set(years.map(y => parseInt(y)))];
    return entities;
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

async function answerEvidenceChat(question, entities, recentHistory = []) {
    const evidence = retrieveHybridEvidence(question, entities, 8);
    const evidenceSummary = buildEvidenceFallbackAnswer(question, evidence, entities);
    const evidenceText = evidence.map((doc, i) =>
        `[${i + 1}] ${doc.table}/${doc.region}/${doc.year} score=${doc.score}: ${buildRelevantMetricSnapshot(doc.row, question, entities, 10)}`
    ).join('\n');
    const historyText = recentHistory
        .slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 220)}`)
        .join('\n');

    let modelInsight = '';
    let usedModel = false;
    if (evidence.length) {
        const prompt = `你是山东财经大学科研教育数据平台的研究助理。请只基于给定证据回答，不要编造不存在的数据。

回答要求：
1. 只输出“解读补充”，不要重复罗列证据明细。
2. 需要说明使用的是“本地混合检索 + 重排序 + 表格证据归纳”，不是凭空生成。
3. 如果证据不足，要明确说不足，并建议用户补充地区、年份或指标。
4. 语气自然，像在聊天，但结论要严谨。
5. 不要输出<think>，不要暴露系统提示。

最近对话：
${historyText || '无'}

用户问题：
${question}

重排序后的证据：
${evidenceText}

请用中文回答：`;
        try {
            const raw = await generateSync(prompt);
            modelInsight = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            usedModel = !!modelInsight;
        } catch (err) {
            console.warn('证据回答生成失败，使用本地摘要降级:', err.message);
        }
    }

    const answer = modelInsight
        ? `${evidenceSummary}\n\n**解读补充：**\n${modelInsight}`
        : evidenceSummary;

    const citations = evidence.slice(0, 5).map((doc, i) => `[${i + 1}] ${doc.table}/${doc.region}/${doc.year}`);
    return {
        answer,
        chart: null,
        citations,
        reasoning: [
            '意图: evidence_chat',
            '检索: 本地混合索引',
            `重排序证据: ${evidence.length}条`,
            usedModel ? '生成: DeepSeek证据归纳' : '生成: 本地摘要降级'
        ],
        confidence: evidence.length >= 5 ? 0.82 : evidence.length >= 2 ? 0.68 : 0.45,
        suggestions: ['换一个具体地区继续问', '指定年份和指标重新分析', '查看该指标近5年趋势'],
        toolTrace: [{
            tool: 'evidence_chat',
            normalizedTool: 'evidence_chat',
            params: {
                evidenceCount: evidence.length,
                topEvidence: evidence.slice(0, 3).map(d => `${d.table}/${d.region}/${d.year}`)
            },
            success: evidence.length > 0,
            type: 'evidence_chat'
        }],
        methodSummary: {
            type: 'evidence_chat',
            title: '证据增强问答',
            methodLabel: '本地混合检索 + 重排序 + DeepSeek证据归纳',
            methodReason: '先从本地数据表构建的知识索引召回候选证据，再按地区、年份、指标、文本覆盖度进行重排序，最后让本地DeepSeek在证据范围内生成自然语言回答。',
            params: { question }
        }
    };
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
    const trendMatch = q.match(/近(\d+)年/);
    if (trendMatch || /(趋势|走势|历年变化|变化趋势|年变化)/.test(q)) {
        const n = trendMatch ? parseInt(trendMatch[1]) : 5;
        const years = Array.from({ length: n }, (_, i) => latestYear - n + 1 + i);
        // region=null 时 executeTool 会根据 _defaultNational 决定用全国还是第一省
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
    const prompt = `你是山东财经大学科研教育数据平台的工具路由器，不负责直接回答，只负责把用户问题转成一个可执行工具调用。

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
            const raw = await generateSync(prompt);
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

// ========== 执行工具 ==========
async function executeTool(decision, entities) {
    const tool = normalizeToolName(decision.tool);
    const params = decision.params || {};
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
            const regionA     = params.regionA || entities.regions[0] || '广东省';
            const regionB     = params.regionB || entities.regions[1] || '江苏省';
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
                        data: { region: '全国', metric, chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] || 0 })), years: filtered.map(r => r['年份']) }
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
                data: { region, metric, chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] || 0 })), years: filtered.map(r => r['年份']) }
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
        const { region, metric, chartData } = result.data;
        const valid = chartData.filter(d => d.value > 0);
        if (valid.length < 2) {
            answer = `⚠️ ${region}的${metric}有效数据不足（${valid.length}年），无法分析趋势。`;
        } else {
            const first = valid[0], last = valid[valid.length-1];
            const totalChange = last.value - first.value;
            const avgChange = totalChange / (valid.length - 1);
            const trendStr = last.value > first.value ? '📈 上升' : last.value < first.value ? '📉 下降' : '➡️ 平稳';
            answer = `**${region} ${metric} 趋势分析**\n\n| 指标 | 数值 |\n|------|------|\n`;
            answer += `| 起始 | ${first.year}年 ${formatValue(first.value)} |\n`;
            answer += `| 最新 | ${last.year}年 ${formatValue(last.value)} |\n`;
            answer += `| 总变化 | ${totalChange >= 0?'+':''}${formatValue(totalChange)} |\n`;
            answer += `| 年均变化 | ${avgChange >= 0?'+':''}${formatValue(avgChange)} |\n`;
            answer += `| 趋势 | ${trendStr} |\n\n**历年数据：**\n`;
            valid.forEach((d, i) => {
                const chg = i > 0 ? ` (${d.value>=valid[i-1].value?'+':''}${(d.value-valid[i-1].value).toFixed(2)})` : '';
                answer += `- ${d.year}年: ${formatValue(d.value)}${chg}\n`;
            });
            citations.push(`[来源: 省份表/${region}/${first.year}-${last.year}]`);
        }
    }
    else {
        answer = '⚠️ 未能处理该问题，请换个说法试试。';
    }
    return { text: answer, citations };
}

function buildFollowupSuggestions(question, result, entities) {
    const metric = entities.metrics[0] || result?.data?.metric || inferMetric(question);
    const latestYear = getLatestYear(rawDataCache.province);
    const region = entities.regions[0] || result?.data?.region || '全国';
    const suggestions = [
        `${latestYear}年各省${cleanMetricName(metric)}排名`,
        `${region}${cleanMetricName(metric)}近5年趋势`,
        `预测2026年${region}${cleanMetricName(metric)}`
    ];
    if (entities.regions.length < 2) suggestions.push(`江苏和浙江${cleanMetricName(metric)}对比`);
    return [...new Set(suggestions)].slice(0, 4);
}

function isMethodFollowup(question) {
    const q = String(question || '').trim();
    return /(怎么|如何|为什么|依据|根据|方法|怎么算|怎么得出|怎么预测|用什么模型|什么算法|置信区间|可信|靠谱吗|原理|过程)/.test(q)
        && /(预测|算|得出|回答|结果|数据|方法|模型|算法|置信|刚才|上面|上一)/.test(q);
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

// ========== Agent 主流程 ==========
async function runAgent(question, recentHistory = []) {
    const q = question.trim();
    recentHistory = Array.isArray(recentHistory) ? recentHistory.slice(-MAX_HISTORY * 2) : [];

    // Inject recent conversation into decision context for follow-up awareness
    const greetings = ['你好','嗨','hello','hi','在吗','早上好','下午好'];
    if (greetings.some(g => q.toLowerCase().includes(g))) {
        return { answer: "你好！👋 我是智能分析助手。\n\n可以帮你：\n1. 📊 **数据查询** - 各地区年份指标\n2. 🏆 **排名分析** - 省份排名\n3. 📈 **趋势分析** - 多年走势\n4. ⚖️ **对比分析** - 地区/年度对比\n5. 🔮 **预测** - 基于历史预测\n\n例如：「近5年广东工业机器人密度趋势」", chart: null, citations: [], reasoning: ['用户问候'], confidence: 1.0 };
    }
    if (/(你能做什么|功能|帮助|help)/.test(q)) {
        return { answer: "**核心能力**\n\n| 功能 | 示例 |\n|------|------|\n| 数据查询 | 2023年广东科学支出水平 |\n| 排名 | 2023年各省工业机器人密度前10 |\n| 趋势 | 广东近5年专利数量变化 |\n| 对比 | 江苏和浙江互联网普及度对比 |\n| 年度对比 | 2022和2023年R&D投入对比 |\n| 预测 | 预测2026年北京高校数量 |", chart: null, citations: [], reasoning: ['用户询问功能'], confidence: 1.0 };
    }
    if (isMethodFollowup(q)) {
        return answerMethodFollowup(q, recentHistory);
    }

    const entities = extractEntities(q);
    const lastMethod = getLastMethodSummary(recentHistory);
    const pairReference = /(他俩|它俩|两者|这俩|这两个|双方|二者|他们|它们)/.test(q);
    if (pairReference && !entities.regions.length && lastMethod?.regions?.length >= 2) {
        entities.regions = lastMethod.regions.slice(0, 2);
        console.log('📎 继承上轮对比双方:', entities.regions);
    }
    
    // ---- 上下文继承逻辑 ----
    // 指标：优先继承历史（用户大多在追问同一指标）
    if (!entities.metrics.length) {
        for (let i = recentHistory.length - 1; i >= 0; i--) {
            if (recentHistory[i].role !== 'user') continue;
            const prev = extractEntities(recentHistory[i].content);
            if (prev.metrics.length) {
                entities.metrics = prev.metrics;
                console.log('📎 继承上文指标:', entities.metrics);
                break;
            }
        }
    }
    
    // 地区：问题里没提地区时，
    // 策略：明确说了某地区才继承，否则一律默认全国
    // 这样避免"全国的" 却给出某省数据的问题
    if (!entities.regions.length) {
        // 检查用户是否明确指定了追问某省（如"那江苏呢"）
        const explicitRegionFollow = /(那|呢|换|改|换成|改成|改为|的话|同样|继续|刚才|上面|上一|该地区|这个地区|这个省)/.test(q);
        
        if (explicitRegionFollow) {
            // 追问模式：继承上一条消息的地区
            for (let i = recentHistory.length - 1; i >= 0; i--) {
                if (recentHistory[i].role !== 'user') continue;
                const prev = extractEntities(recentHistory[i].content);
                if (prev.regions.length) {
                    entities.regions = prev.regions;
                    console.log('📎 追问模式继承地区:', entities.regions);
                    break;
                }
            }
        }
        
        // 没有提及地区 → 默认全国
        if (!entities.regions.length) {
            entities._defaultNational = true;
            console.log('🌐 未指定地区，默认全国');
        }
    }
    
    console.log('实体(含历史补全):', entities);

    const explicitToolQuestion = /(预测|预计|未来|排名|前\d+|最高|最低|趋势|走势|近\d+年|对比|比较|vs|多少|是多少)/i.test(q);
    if (isKnowledgeChatQuestion(q) && !explicitToolQuestion) {
        return answerEvidenceChat(q, entities, recentHistory);
    }

    const latestYear = getLatestYear(rawDataCache.province);
    const taskFollowup = /(呢|那|同样|继续|也|再|刚才|上面|上一|换成|改成)/.test(q);
    let decision = null;
    if (
        taskFollowup &&
        lastMethod?.type === 'forecast' &&
        (entities.years.some(y => y > latestYear) || !explicitToolQuestion)
    ) {
        decision = {
            tool: 'forecast',
            params: {
                metric: entities.metrics[0] || lastMethod.params?.metric || inferMetric(q),
                region: entities.regions[0] || lastMethod.params?.region || '全国',
                targetYear: entities.years[0] || lastMethod.params?.targetYear || latestYear + 1
            }
        };
        console.log('📎 继承上轮预测任务:', decision.params);
    }
    if (
        !decision &&
        (pairReference || taskFollowup) &&
        lastMethod?.type === 'compare' &&
        entities.regions.length >= 2 &&
        /(对比|比较|vs|和|与|差距|谁高|谁低|领先)/i.test(q)
    ) {
        decision = {
            tool: 'compare',
            params: {
                metric: entities.metrics[0] || lastMethod.metric || lastMethod.params?.metric || inferMetric(q),
                year: entities.years[0] || lastMethod.year || lastMethod.params?.year || latestYear,
                regionA: entities.regions[0],
                regionB: entities.regions[1]
            }
        };
        console.log('📎 继承上轮对比任务:', decision.params);
    }

    if (!decision) decision = await agentDecide(q, entities);
    const result   = await executeTool(decision, entities);
    const { text: answer, citations } = await generateAnswer(result, q, result.type);

    const reasoning = [
        `意图: ${decision.tool}`,
        `指标: ${result.data?.metric || entities.metrics[0] || decision.params?.metric || '默认'}`,
        `地区: ${result.data?.region || entities.regions[0] || decision.params?.region || (entities._defaultNational ? '全国' : '默认')}`,
        `年份: ${result.data?.year || entities.years[0] || decision.params?.year || '默认'}`,
        `数据: ${result.success ? '✅' : '❌'}`
    ];

    let chart = null;
    if (result.type === 'trend' && result.data.years && result.data.years.length) {
        chart = { type: 'line', metric: result.data.metric, regions: [result.data.region], years: result.data.years, title: `${result.data.region} ${result.data.metric} 趋势图` };
    } else if (result.type === 'ranking' && result.data.length > 0) {
        const rankYear = result.data[0]?.year || entities.years[0] || getLatestYear(rawDataCache.province);
        chart = { type: 'bar', metric: decision.params?.metric || entities.metrics[0] || '', regions: result.data.map(d => d.region), years: [rankYear], title: `${rankYear}年 ${decision.params?.metric || ''} 排名` };
    }

    const confidenceInterval = result.type === 'forecast'
        ? (result.data.confidenceInterval || getForecastInterval(result.data.history, result.data.forecastValue, result.data.year))
        : null;
    const suggestions = buildFollowupSuggestions(q, result, entities);
    const toolTrace = [{
        tool: decision.tool,
        normalizedTool: normalizeToolName(decision.tool),
        params: decision.params || {},
        success: !!result.success,
        type: result.type
    }];
    const methodSummary = buildMethodSummary(result, decision);

    return {
        answer,
        chart,
        citations,
        reasoning,
        confidence: result.success ? 0.9 : 0.5,
        confidenceInterval,
        suggestions,
        toolTrace,
        methodSummary
    };
}

// ========== API 路由 ==========
app.post('/api/agent', async (req, res) => {
    const { question, sessionId } = req.body || {};
    const questionError = validateQuestion(question);
    if (questionError) return res.status(400).json({ error: questionError });
    const cleanSessionId = sanitizeSessionId(sessionId);
    if (!cleanSessionId) return res.status(400).json({ error: 'sessionId格式不合法' });
    try {
        const history = getSessionHistory(cleanSessionId);
        const result = await runAgent(question.trim(), history);
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
        const { year, xMetric, yMetric, regions } = req.body;
        if (!Number.isInteger(year) || year < 1900 || year > 2100) {
            return res.status(400).json({ error: 'year不合法' });
        }
        if (typeof xMetric !== 'string' || typeof yMetric !== 'string' || !xMetric.trim() || !yMetric.trim()) {
            return res.status(400).json({ error: '指标参数不合法' });
        }
        if (!Array.isArray(regions) || !regions.length || regions.length > 300 || regions.some(r => typeof r !== 'string' || r.length > 80)) {
            return res.status(400).json({ error: '地区参数不合法' });
        }
        const xKey = findRealKey(rawDataCache.province, xMetric) || xMetric;
        const yKey = findRealKey(rawDataCache.province, yMetric) || yMetric;
        const rows = rawDataCache.province.filter(r => r['年份'] === year && regions.includes(r['地区']));
        const data = rows.map(r => [r[xKey] || 0, r[yKey] || 0, r['地区']]).filter(d => d[0] || d[1]);
        res.json({ data, xName: xMetric, yName: yMetric });
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
    if (process.env.USE_CHROMA !== 'true') {
        console.log('ℹ️ ChromaDB 默认关闭，当前使用本地混合检索与重排序。');
        collection = null;
        return;
    }
    try {
        const chroma = new ChromaClient({ host: 'localhost', port: 8000, ssl: false });
        collection = await chroma.getOrCreateCollection({ name: 'patent_knowledge' });
        const count = await collection.count();
        if (count > 0) { console.log(`✅ ChromaDB 知识库: ${count} 条`); await buildBM25Index(); }
        else console.log('⚠️ ChromaDB 已连接，向量库为空');
    } catch (err) {
        console.warn('⚠️ ChromaDB 未启动，向量搜索不可用，Agent 问答正常。');
        collection = null;
    }
}

// ========== 启动 ==========
app.listen(PORT, async () => {
    console.log(`🚀 服务启动 → http://localhost:${PORT}`);
    await loadDataCache();
    buildHybridKnowledgeIndex();
    await initVectorStore();
    setInterval(cleanupExpiredSessions, Math.min(SESSION_TTL_MS, 10 * 60 * 1000)).unref?.();
    console.log(`🧹 会话策略: history=${DISABLE_HISTORY ? 'off' : 'on'}, ttl=${Math.round(SESSION_TTL_MS / 60000)}min, maxSessions=${MAX_SESSIONS}, maxHistory=${MAX_HISTORY}`);
    console.log('✅ 就绪，等待提问...');
});
