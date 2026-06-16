process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.message));
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
let nationalMetricList = [];
let cityMetricList = [];
const sessionHistories = new Map();
const MAX_HISTORY = Math.max(1, parseInt(process.env.MAX_HISTORY || '12', 10));
const SESSION_TTL_MS = Math.max(1, parseInt(process.env.SESSION_TTL_MINUTES || '30', 10)) * 60 * 1000;
const MAX_SESSIONS = Math.max(10, parseInt(process.env.MAX_SESSIONS || '500', 10));
const DISABLE_HISTORY = process.env.DISABLE_HISTORY === 'true';
const ENABLE_DEBUG_ROUTES = process.env.ENABLE_DEBUG_ROUTES === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.MODEL_NAME || 'deepseek-r1:7b';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
const OLLAMA_FAST_MODEL = process.env.OLLAMA_FAST_MODEL || 'deepseek-r1:7b';
// 硅基流动 embedding API（替代 Ollama embedding，无需本地显存）
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || '';
const SILICONFLOW_EMBED_MODEL = process.env.SILICONFLOW_EMBED_MODEL || 'BAAI/bge-m3';
const USE_SILICONFLOW_EMBED = !!SILICONFLOW_API_KEY;

// DeepSeek API 配置（优先使用，没有 Key 时自动降级到本地 Ollama）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const USE_DEEPSEEK_API = !!DEEPSEEK_API_KEY;

// 网络搜索配置（可选，不配置时跳过网搜兜底）
const TAVILY_API_KEY  = process.env.TAVILY_API_KEY  || '';
const SERPER_API_KEY  = process.env.SERPER_API_KEY  || '';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
        if (/\.ngrok-free\.dev$/.test(origin)) return callback(null, true);
        if (/\.ngrok\.io$/.test(origin)) return callback(null, true);
        if (/^https?:\/\/sdufe-ssm\.cn$/.test(origin)) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS origin denied'));
    }
}));
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', 'true'); next(); });
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 诊断接口 ==========
app.get('/api/debug/chroma', async (req, res) => {
    if (!ENABLE_DEBUG_ROUTES) {
        return res.status(404).json({ error: 'Not found' });
    }
    try {
        if (!collection) return res.json({ error: 'collection 未初始化' });
        const total = await collection.count();
        // 查知识文档（metadata.table = knowledge）
        const knowledgeSample = await collection.get({
            where: { table: { '$eq': 'knowledge' } },
            limit: 5,
            include: ['documents', 'metadatas']
        });
        // 关键词测试
        const kwTest = await collection.get({
            whereDocument: { '$contains': '德国' },
            limit: 3,
            include: ['documents', 'metadatas']
        }).catch(e => ({ error: e.message }));
        res.json({
            total,
            knowledgeDocCount: knowledgeSample.documents?.length ?? 0,
            knowledgeSample: knowledgeSample.documents?.slice(0, 2).map(d => String(d).slice(0, 200)) ?? [],
            germanyKeywordHits: kwTest.error ? kwTest : kwTest.documents?.length,
            germanySample: kwTest.documents?.slice(0, 1).map(d => String(d).slice(0, 300)) ?? []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// ========== 常量 ==========
// 省份简称→全称（全局共享，避免在 extractEntities / llmExtractEntities 各自维护）
const REGION_MAP = {
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

// 关键词→指标 同义词组（全局共享，getRelevantMetrics / inferMetric / expandQueryForRetrieval 均引用此表）
const METRIC_SYNONYMS = [
    // 人才称号类
    { keys: ['长江学者', '长江'],               metrics: ['长江学者'] },
    { keys: ['杰青', '杰出青年'],               metrics: ['杰青'] },
    { keys: ['优青', '优秀青年'],               metrics: ['优青'] },
    { keys: ['万人领军', '万人计划', '领军人才'], metrics: ['万人领军'] },
    { keys: ['万人青拔', '青年拔尖'],            metrics: ['万人青拔'] },
    { keys: ['博士后', '博创'],                 metrics: ['博士后创新人才支持计划'] },
    { keys: ['科协托举', '青年人才托举'],         metrics: ['中国科协青年人才托举工程'] },
    { keys: ['国家工程师'],                     metrics: ['国家卓越工程师奖'] },
    // 科技创新类
    { keys: ['人工智能', '智能化', 'AI', 'ai'],  metrics: ['人工智能应用水平', '工业机器人密度'] },
    { keys: ['机器人', '工业机器人'],             metrics: ['工业机器人密度'] },
    { keys: ['专利', '发明专利', '知识产权'],     metrics: ['发明专利授予数', '实用新型专利申请授权数'] },
    { keys: ['科研投入', '研发投入', 'R&D', '研发经费'], metrics: ['科研经费投入强度', '科学支出水平'] },
    { keys: ['科技人员', '研发人员', 'R&D人员'],  metrics: ['科技人员投入强度', 'R&D人员/年末从业人员数'] },
    { keys: ['技术市场', '成果转化'],             metrics: ['技术市场活跃度', '技术市场交易额/万元'] },
    // 教育类
    { keys: ['高校', '大学', '高等教育', '教育水平', '教育'], metrics: ['普通高校数量', '万人大学生数', '人均受教育年限', '教育支出水平', '生均教育经费支出'] },
    { keys: ['受教育', '教育年限'],               metrics: ['人均受教育年限'] },
    { keys: ['教育支出', '教育经费'],             metrics: ['教育支出水平', '生均教育经费支出'] },
    { keys: ['中小学', '基础教育'],              metrics: ['中小学学校数量'] },
    // 数字化类
    { keys: ['互联网', '网络普及', '数字化'],     metrics: ['互联网普及度', '电信业务总量', '信息传输计算机软件业从业人员数/年末从业人员数'] },
    { keys: ['信息技术', 'IT', '软件'],          metrics: ['信息技术人才', '信息传输计算机软件业从业人员数/年末从业人员数'] },
    // 人力资本类
    { keys: ['人力资本', '人才密度', '人才水平', '人才'], metrics: ['人力资本水平', '人才人口密度', '高级职称人才占人口比例', '长江学者', '杰青', '优青', '万人领军'] },
    { keys: ['高级职称', '职称'],                metrics: ['高级职称人才占人口比例'] },
    { keys: ['产业结构', '产业升级', '产业'],     metrics: ['产业结构高级化', '产业结构指数', '全员劳动生产率', '新产品销售收入'] },
    // 科研产出类
    { keys: ['论文', '发表论文', '科技论文'],     metrics: ['普通高校发表论文数', '人才平均科技论文'] },
    { keys: ['科研成果', '成果', '科研'],         metrics: ['人才平均科技成果', '科研经费利用效果', '科研经费投入强度', '科技人员投入强度', 'R&D人员/年末从业人员数', '普通高校发表论文数'] },
];

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
        rank_provinces: 'get_ranking',
        query_point: 'point_query'
    };
    return map[tool] || tool;
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

// ── 主流RAG做法：将追问压缩为独立完整问题（condense question）──
// 参考 LangChain ConversationalRetrievalChain / LlamaIndex chat engine 的默认步骤
async function condenseQuestion(question, history) {
    if (!history || history.length === 0) return question;

    // 快速判断：以下情况明显是独立问题，跳过LLM调用节省延迟
    const isObviouslyStandalone =
        question.length > 25 ||                                   // 够长，信息完整
        /^\d{4}年/.test(question) ||                              // 以年份开头
        /^(请|帮|告诉我|分析|比较|列出)/.test(question) ||  // 明确指令性开头
        !/[一-龥]/.test(question);                        // 纯英文/数字
    if (isObviouslyStandalone) return question;

    // 构建简短历史上下文（只取最近2轮，控制token）
    const lastTurns = history.slice(-4)
        .map(h => `${h.role === 'user' ? 'U' : 'A'}: ${String(h.content || '').replace(/（追问[\s\S]*?）/g, '').trim().slice(0, 100)}`)
        .join('\n');

    const prompt = `根据对话历史，把追问改写成独立完整的中文问题。若已完整则原样返回，禁止解释或换行。

历史：
${lastTurns}

追问：${question}
独立问题：`;

    try {
        const raw = await generateSync(prompt, 8000, 80);
        const condensed = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().split('\n')[0].slice(0, 150);
        if (condensed && condensed.length >= 2) {
            if (condensed !== question) console.log(`🔍 问题压缩: "${question}" → "${condensed}"`);
            return condensed;
        }
    } catch (e) {
        console.warn('[condenseQuestion] 失败，使用原问题:', e.message);
    }
    return question;
}

async function generateSync(prompt, timeoutMs = OLLAMA_TIMEOUT_MS, maxTokens = 2048) {
    if (USE_DEEPSEEK_API) {
        return generateDeepSeek(prompt, timeoutMs, maxTokens);
    }
    return generateOllama(prompt, timeoutMs);
}

// DeepSeek 官方 API（有 Key 时使用）
async function generateDeepSeek(prompt, timeoutMs = 30000, maxTokens = 2048) {
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
                max_tokens: maxTokens,
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

// ── Embedding LRU 缓存（最多 200 条，避免同一查询重复调 Ollama）─────
const embeddingCache = new Map();
const EMBEDDING_CACHE_MAX = 200;

async function getEmbedding(text) {
    const prompt = String(text || '').slice(0, 4000);
    if (embeddingCache.has(prompt)) {
        // 刷新 LRU 顺序
        const cached = embeddingCache.get(prompt);
        embeddingCache.delete(prompt);
        embeddingCache.set(prompt, cached);
        return cached;
    }
    let embedding;
    if (USE_SILICONFLOW_EMBED) {
        // 硅基流动 embedding API（与 OpenAI 兼容）
        const sfRes = await axios.post('https://api.siliconflow.cn/v1/embeddings', {
            model: SILICONFLOW_EMBED_MODEL,
            input: prompt,
            encoding_format: 'float'
        }, {
            headers: { Authorization: `Bearer ${SILICONFLOW_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        if (!Array.isArray(sfRes.data?.data?.[0]?.embedding)) {
            throw new Error('硅基流动 embedding 返回为空');
        }
        embedding = sfRes.data.data[0].embedding;
    } else {
        const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
            model: OLLAMA_EMBED_MODEL,
            prompt
        }, { timeout: OLLAMA_TIMEOUT_MS });
        if (!Array.isArray(response.data?.embedding)) {
            throw new Error('Ollama embedding 返回为空');
        }
        embedding = response.data.embedding;
    }
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        embeddingCache.delete(embeddingCache.keys().next().value);
    }
    embeddingCache.set(prompt, embedding);
    return embedding;
}

// ── MMR：最大边际相关性去重 ──────────────────────────────────────
// 在保证相关度的同时降低 chunk 间冗余，让 LLM 看到更多样化的证据
function textSimilarity(a, b) {
    const bigrams = s => {
        const clean = String(s || '').slice(0, 300);
        const set = new Set();
        for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
        return set;
    };
    const ba = bigrams(a), bb = bigrams(b);
    if (!ba.size && !bb.size) return 1;
    let inter = 0;
    for (const g of ba) if (bb.has(g)) inter++;
    return inter / (ba.size + bb.size - inter);
}

function applyMMR(docs, lambda = 0.7, topK = 8) {
    if (docs.length <= topK) return docs;
    const remaining = [...docs];
    const selected = [];
    while (selected.length < topK && remaining.length > 0) {
        let bestScore = -Infinity, bestIdx = 0;
        for (let i = 0; i < remaining.length; i++) {
            const relevance = 1 - Math.min(1, remaining[i].distance ?? 0.5);
            const maxSim = selected.length
                ? Math.max(...selected.map(s => textSimilarity(remaining[i].text, s.text)))
                : 0;
            const score = lambda * relevance - (1 - lambda) * maxSim;
            if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }
    return selected;
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
    // 地级市用"时间"字段，统一重命名为"年份"，与其他表保持一致
    rawDataCache.city = (fullData['地级市'] || []).map(row => {
        if ('时间' in row && !('年份' in row)) {
            const { 时间, 时间地区, ...rest } = row;
            return { 年份: 时间, ...rest };
        }
        return row;
    });
    const sampleRow = rawDataCache.province[0];
    if (sampleRow) {
        metricNameList = Object.keys(sampleRow).filter(key => {
            if (key === '年份' || key === '地区') return false;
            return typeof sampleRow[key] === 'number';
        });
        console.log(`📊 共加载 ${metricNameList.length} 个指标：${metricNameList.slice(0,5).join('、')}...`);
    }
    const nationalSample = rawDataCache.national[0];
    if (nationalSample) {
        nationalMetricList = Object.keys(nationalSample).filter(k => k !== '年份' && k !== '地区' && typeof nationalSample[k] === 'number');
    }
    const citySample = rawDataCache.city[0];
    if (citySample) {
        cityMetricList = Object.keys(citySample).filter(k => k !== '年份' && k !== '地区' && typeof citySample[k] === 'number');
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
    // 从 METRIC_SYNONYMS 收集命中的指标（统一维护，无需三处各自硬编码）
    for (const group of METRIC_SYNONYMS) {
        if (group.keys.some(k => q.toLowerCase().includes(k.toLowerCase()))) {
            preferred.push(...group.metrics);
        }
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

function isAllMetricDetailQuestion(question = '') {
    return /(各项指标|各项数据|各指标|全部指标|所有指标|全部数据|所有数据|完整指标|指标明细|指标详情|\d+项指标)/.test(String(question));
}

function isPartialMetricDetailQuestion(question = '', entities = {}) {
    const q = String(question);
    return getMentionedMetricNames(q, entities).length >= 2
        || /(部分指标|指定指标|这些指标|这几个指标|几个指标|以下指标|若干指标|部分数据)/.test(q);
}

// ── 模糊指标匹配评分（覆盖全部指标，不依赖手写 alias）────────────
function fuzzyMatchMetric(query, metric) {
    const q = String(query).toLowerCase();
    const m = cleanMetricName(metric).toLowerCase();
    const mFull = metric.toLowerCase();
    if (q.includes(mFull) || q.includes(m)) return 1.0;          // 完全命中
    // 分词交集评分
    const qTokens = q.match(/[一-龥a-z0-9]+/g) || [];
    const mTokens = m.match(/[一-龥a-z0-9]+/g) || [];
    if (!qTokens.length || !mTokens.length) return 0;
    // 子串命中得高分
    let score = 0;
    for (const mt of mTokens) {
        if (mt.length < 2) continue;
        if (q.includes(mt)) score += mt.length * 2;
        else for (const qt of qTokens) {
            if (qt.length >= 2 && (mt.includes(qt) || qt.includes(mt))) score += Math.min(mt.length, qt.length);
        }
    }
    return score / (m.length + 1);
}

function findFuzzyMetrics(question, threshold = 0.6) {
    if (!metricNameList.length) return [];
    return metricNameList
        .map(m => ({ metric: m, score: fuzzyMatchMetric(question, m) }))
        .filter(x => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map(x => x.metric);
}

function getMentionedMetricNames(question = '', entities = {}) {
    const q = String(question);
    const candidates = [...(entities.metrics || [])];

    // 精确匹配（保留高置信度路径）
    for (const metric of metricNameList) {
        const clean = cleanMetricName(metric);
        if (q.includes(metric) || q.includes(clean)) candidates.push(metric);
    }

    // 模糊匹配补全（score ≥ 0.8 才加入，避免误匹配）
    if (!candidates.length) {
        const fuzzy = findFuzzyMetrics(q, 0.8);
        candidates.push(...fuzzy.slice(0, 3));
    }

    const resolved = [];
    for (const name of candidates) {
        const clean = cleanMetricName(name);
        const real = metricNameList.find(metric =>
            metric === name ||
            cleanMetricName(metric) === clean ||
            cleanMetricName(metric).includes(clean) ||
            clean.includes(cleanMetricName(metric))
        );
        if (real && !resolved.includes(real)) resolved.push(real);
    }
    return resolved;
}

// ── 元数据查询：指标数量 / 指标列表 ──────────────────────────
function answerMetaQuery(question, recentHistory = []) {
    const q = question.trim();

    // 检测上一轮是否是指标数量/列表回答（用于追问识别）
    const lastAssistant = [...recentHistory].reverse().find(h => h.role === 'assistant');
    const lastWasMeta = lastAssistant && /指标数|省份表.*最丰富|三张表/.test(String(lastAssistant.content || ''));

    // 追问"谁最多/哪个最多/最多的"时，若上一轮是元数据回答，直接答
    if (lastWasMeta && /谁最多|哪个最多|哪张.*最多|最多.*哪|哪个多/.test(q)) {
        const counts = [
            { name: '全国表', count: nationalMetricList.length },
            { name: '省份表', count: metricNameList.length },
            { name: '地级市表', count: cityMetricList.length }
        ].sort((a, b) => b.count - a.count);
        const top = counts[0];
        return {
            answer: `**${top.name}**指标最多，共 **${top.count} 个**。\n\n三张表完整对比：${counts.map(c => `${c.name} ${c.count} 个`).join('、')}。`,
            citations: [], reasoning: ['追问元数据：哪张表指标最多']
        };
    }

    // 匹配"有多少指标""指标多少""有哪些指标""包含哪些指标"类问题
    if (!/(指标|维度|字段).*(多少|几个|哪些|列表|有什么|什么指标)|(多少|几个).*(指标|维度|字段)/.test(q)) return null;

    const provCount = metricNameList.length;
    const natCount = nationalMetricList.length;
    const cityCount = cityMetricList.length;

    const asksNational = /(全国|国家|national)/i.test(q);
    const asksCity = /(地级市|城市|市级|city)/i.test(q);
    const asksProv = /(省|省级|province)/i.test(q);
    const wantsList = /(哪些|列表|有什么|什么指标)/.test(q);

    // 列出全部指标
    const provList = metricNameList.map(cleanMetricName).join('、');
    const natList = nationalMetricList.map(cleanMetricName).join('、');
    const cityList = cityMetricList.map(cleanMetricName).join('、');

    // 只问某一张表
    if (asksNational && !asksProv && !asksCity) {
        let ans = `**全国表** 共有 **${natCount} 个指标**。`;
        if (wantsList && natCount > 0) ans += `\n\n${natList}`;
        return { answer: ans, citations: [], reasoning: ['元数据查询：全国表指标列表'] };
    }
    if (asksCity && !asksProv && !asksNational) {
        let ans = `**地级市表** 共有 **${cityCount} 个指标**。`;
        if (wantsList && cityCount > 0) ans += `\n\n${cityList}`;
        return { answer: ans, citations: [], reasoning: ['元数据查询：地级市表指标列表'] };
    }

    // 问全部或省级
    // 动态找出指标最多的表
    const tableRanked = [
        { name: '省份表', count: provCount },
        { name: '全国表', count: natCount },
        { name: '地级市表', count: cityCount }
    ].sort((a, b) => b.count - a.count);
    const richest = tableRanked[0].name;

    const provLabel = richest === '省份表' ? '省份表（最多）' : '省份表';
    const natLabel  = richest === '全国表'  ? '全国表（最多）'  : '全国表';
    const cityLabel = richest === '地级市表' ? '地级市表（最多）' : '地级市表';

    let ans = `平台数据集共包含三张表，指标数量如下：\n\n| 数据表 | 指标数 |\n|---|---:|\n| ${provLabel} | **${provCount}** |\n| ${natLabel} | **${natCount}** |\n| ${cityLabel} | **${cityCount}** |\n`;
    if (wantsList) {
        if (provCount > 0) ans += `\n**省份表指标：** ${provList}`;
        if (natCount > 0) ans += `\n\n**全国表指标：** ${natList}`;
        if (cityCount > 0) ans += `\n\n**地级市表指标：** ${cityList}`;
    } else {
        ans += `\n**${richest}**指标最多（${tableRanked[0].count} 个），可用于趋势、排名、对比分析；如需查看完整列表，可以问"${richest}有哪些指标"。`;
    }
    return { answer: ans, citations: [], reasoning: ['元数据查询：三表指标数量概览'] };
}

function answerAllMetricDetails(question, entities = null) {
    const parsed = entities || extractEntities(question);
    const year = parsed.years?.find(y => Number.isInteger(Number(y))) || null;
    const region = parsed.regions?.[0] || null;
    const wantsAll = isAllMetricDetailQuestion(question);
    const wantsPartial = isPartialMetricDetailQuestion(question, parsed);
    if (!year || !region || (!wantsAll && !wantsPartial)) return null;

    const isNational = region === '全国';
    const rows = isNational ? rawDataCache.national : rawDataCache.province;
    const row = rows.find(r => (r['年份'] ?? r['时间']) === Number(year) && (isNational || r['地区'] === region));
    if (!row) {
        return {
            answer: `⚠️ 未找到 **${year}年${region}** 的指标明细数据。\n\n你可以换一个年份，或先问“数据覆盖到哪年”。`,
            chart: null,
            citations: [`[来源: ${isNational ? '全国表' : '省份表'}/${region}/${year}]`],
            reasoning: ['意图: 地区年度全指标明细查询', '未命中对应地区/年份行'],
            confidence: 0.75,
            suggestions: [`${region}近10年科学支出水平趋势`, `${year}年各省科学支出水平排名`, `江苏和浙江科学支出水平对比`],
            methodSummary: {
                type: 'all_metric_detail',
                title: '年度全指标明细查询',
                methodLabel: '地区 + 年份 + 全指标明细',
                methodReason: '用户询问某地区某年份的各项/全部指标时，直接读取结构化数据表中的完整指标列。',
                params: { region, year, table: isNational ? '全国表' : '省份表' }
            }
        };
    }

    const selectedMetricNames = wantsAll
        ? metricNameList
        : [...new Set(getMentionedMetricNames(question, parsed).map(metric => findRealKey(rows, metric) || metric).filter(Boolean))];

    if (!wantsAll && !selectedMetricNames.length) {
        return {
            answer: `可以查，但我还需要你指定要看的指标名。\n\n例如：**${region}${year}年科学支出水平、工业机器人密度、普通高校数量**。`,
            chart: null,
            citations: [],
            reasoning: ['意图: 部分指标明细查询', '缺少具体指标名'],
            confidence: 0.9,
            suggestions: [
                `${region}${year}年科学支出水平、工业机器人密度、普通高校数量`,
                `${region}${year}年教育支出水平和人均受教育年限`,
                `${region}${year}年发明专利授予数和互联网普及度`
            ],
            methodSummary: {
                type: 'partial_metric_detail_clarify',
                title: '部分指标明细查询',
                methodLabel: '地区 + 年份 + 部分指标',
                methodReason: '用户想查看部分指标，但未给出具体指标名。',
                params: { region, year, table: isNational ? '全国表' : '省份表' }
            }
        };
    }

    const details = selectedMetricNames
        .filter(metric => row[metric] !== undefined && row[metric] !== null && row[metric] !== '')
        .map(metric => ({ metric: cleanMetricName(metric), value: row[metric] }));
    if (!details.length) {
        return {
            answer: `⚠️ 找到了 **${year}年${region}** 的数据行，但没有匹配到你指定的指标。\n\n可以换成平台已有指标名，例如：科学支出水平、工业机器人密度、普通高校数量。`,
            chart: null,
            citations: [`[来源: ${isNational ? '全国表' : '省份表'}/${region}/${year}]`],
            reasoning: ['意图: 部分指标明细查询', '指定指标未命中有效数值'],
            confidence: 0.75,
            suggestions: [
                `${region}${year}年科学支出水平、工业机器人密度、普通高校数量`,
                `${region}近10年科学支出水平趋势`,
                `${year}年各省科学支出水平排名`
            ],
            methodSummary: {
                type: 'partial_metric_detail',
                title: '部分指标明细查询',
                methodLabel: '地区 + 年份 + 部分指标',
                methodReason: '用户询问某地区某年份的部分指标时，按指定指标名读取结构化数据表。',
                params: { region, year, table: isNational ? '全国表' : '省份表', requestedMetrics: parsed.metrics || [] }
            }
        };
    }
    const tableLines = details.map((item, index) => `| ${index + 1} | ${item.metric} | ${formatValue(Number(item.value))} |`).join('\n');
    const answer = wantsAll
        ? `找到了。**${year}年${region}** 共有 **${details.length} 项可用指标**：\n\n| 序号 | 指标 | 数值 |\n|---:|---|---:|\n${tableLines}\n\n这些数值来自${isNational ? '全国表' : '省份表'}原始数据行，适合继续做趋势、排名或地区对比。`
        : `找到了。**${year}年${region}** 你指定的 **${details.length} 项指标** 如下：\n\n| 序号 | 指标 | 数值 |\n|---:|---|---:|\n${tableLines}\n\n这些数值来自${isNational ? '全国表' : '省份表'}原始数据行。`;

    return {
        answer,
        chart: null,
        citations: [`[来源: ${isNational ? '全国表' : '省份表'}/${region}/${year}]`],
        reasoning: [wantsAll ? '意图: 地区年度全指标明细查询' : '意图: 地区年度部分指标明细查询', `命中数据行: ${region}/${year}`, `返回指标数: ${details.length}`],
        confidence: 1,
        suggestions: [
            `${region}科学支出水平近10年趋势`,
            `${year}年各省科学支出水平排名`,
            `江苏和浙江科学支出水平对比`
        ],
        methodSummary: {
            type: wantsAll ? 'all_metric_detail' : 'partial_metric_detail',
            title: wantsAll ? '年度全指标明细查询' : '年度部分指标明细查询',
            methodLabel: wantsAll ? '地区 + 年份 + 全指标明细' : '地区 + 年份 + 部分指标明细',
            methodReason: wantsAll ? '用户询问某地区某年份的各项/全部指标时，直接读取结构化数据表中的完整指标列。' : '用户询问某地区某年份的部分指标时，按指定指标名读取结构化数据表。',
            params: { region, year, table: isNational ? '全国表' : '省份表', metricCount: details.length }
        }
    };
}

function buildMetricDetailEntitiesWithContext(question, history = []) {
    const parsed = extractEntities(question);
    const last = getLastMethodSummary(history);
    const lastParams = last?.params || {};
    if (!parsed.regions.length && lastParams.region) parsed.regions = [lastParams.region];
    if (!parsed.years.length && Number.isInteger(Number(lastParams.year))) parsed.years = [Number(lastParams.year)];
    return parsed;
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
                year
                // 不存 row，避免与 rawDataCache 双份存储；需要时用 lookupRowForDoc 反查
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

// hybridDocuments 里不再存 row，需要时按 table/region/year 反查（O(n) 但只在 top-5 结果上调用）
function lookupRowForDoc(doc) {
    const tableMap = { '全国': rawDataCache.national, '省份': rawDataCache.province, '地级市': rawDataCache.city };
    const rows = tableMap[doc.table] || [];
    return rows.find(r => (r['地区'] || '全国') === doc.region && r['年份'] === doc.year) || {};
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
    const latestYear = getLatestYear(rows);
    if (!year) year = latestYear;
    const realKey = findRealKey(rows, metric);
    if (!realKey) {
        console.warn(`getRanking: 找不到字段 "${metric}"`);
        return [];   // 真正的字段缺失
    }
    // 若请求年份无数据，自动降级到最新有效年份
    let yearData = rows.filter(r => r['年份'] === year);
    const usedYear = yearData.length ? year : latestYear;
    if (!yearData.length) {
        yearData = rows.filter(r => r['年份'] === latestYear);
        console.warn(`getRanking: ${year}年无数据，自动降级到${latestYear}年`);
    }
    const valid = yearData
        .map(r => ({ region: r['地区'] || '全国', value: r[realKey], _year: usedYear }))
        .filter(item => typeof item.value === 'number' && !isNaN(item.value));
    valid.sort((a, b) => order === 'desc' ? b.value - a.value : a.value - b.value);
    const result = valid.slice(0, topN);
    if (usedYear !== year) result._yearFallback = `${year}年无数据，已展示${usedYear}年`;
    return result;
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
    const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))];
    for (const p of provinceList) { if (question.includes(p) && !entities.regions.includes(p)) entities.regions.push(p); }
    for (const [short, full] of Object.entries(REGION_MAP)) {
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
  "intent_hint": "trend|ranking|compare|point|chat 之一"
}`;

    try {
        const raw = await generateFast(prompt, 15000);
        const parsed = safeParseJSON(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))];

        const normalizedRegions = (parsed.regions || []).map(r => {
            if (r === '全国') return '全国';
            if (provinceList.includes(r)) return r;
            if (REGION_MAP[r]) return REGION_MAP[r];
            for (const [short, full] of Object.entries(REGION_MAP)) {
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
// cachedDecision: llmDecideAction 已返回的决策对象（含 entities 字段），可直接复用跳过 LLM 调用
async function extractEntitiesAsync(question, recentHistory = [], cachedDecision = null) {
    // ── 优先从 llmDecideAction 的决策结果中复用 entities，省掉一次 LLM 调用 ──
    if (cachedDecision?.entities) {
        const ce = cachedDecision.entities;
        const provinceList = [...new Set(rawDataCache.province.map(r => r['地区']))];
        const regions = (ce.regions || []).map(r => {
            if (r === '全国') return '全国';
            if (provinceList.includes(r)) return r;
            if (REGION_MAP[r]) return REGION_MAP[r];
            for (const [short, full] of Object.entries(REGION_MAP)) {
                if (r.includes(short)) return full;
            }
            return r;
        }).filter(Boolean);
        const metrics = (ce.metrics || []).map(m => {
            const cleanM = cleanMetricName(m);
            return metricNameList.find(ml => ml === m || cleanMetricName(ml) === cleanM ||
                cleanMetricName(ml).includes(cleanM) || cleanM.includes(cleanMetricName(ml))) || null;
        }).filter(Boolean);
        const years = (ce.years || []).map(y => parseInt(y)).filter(y => Number.isFinite(y) && y >= 1990 && y <= 2100);
        // 补充 regions（多地区场景：decision.regions 可能比 entities.regions 更全）
        const decisionRegions = (cachedDecision.regions || []).map(r => REGION_MAP[r] || r);
        const mergedRegions = [...new Set([...regions, ...decisionRegions])].filter(Boolean);
        // 补全缺失指标：先推断当前问题，断链时从 history 回溯
        if (!metrics.length) {
            const inferred = inferMetric(question) || inferMetricFromHistory(recentHistory);
            if (inferred) metrics.push(inferred);
        }
        const yearRange = parseYearRange(question);
        const mergedYears = yearRange && yearRange.length > years.length ? yearRange : years;
        console.log('♻️  复用 llmDecideAction entities:', JSON.stringify({ regions: mergedRegions, metrics, years: mergedYears }));
        return { regions: mergedRegions, metrics, years: mergedYears, intent_hint: cachedDecision.tool || null };
    }

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

// 对话历史摘要压缩：保留关键轮次（含指标/地区），压缩其余旧内容
async function compressHistoryIfNeeded(history, maxTokenEstimate = 10000) {
    if (!history || history.length <= 8) return history;
    const totalChars = history.reduce((sum, h) => sum + String(h.content || '').length, 0);
    const estimatedTokens = Math.ceil(totalChars / 1.5);
    if (estimatedTokens <= maxTokenEstimate) return history;

    // 标记"关键轮次"：包含指标或地区的 user 消息
    const isKeyRound = (h) => h.role === 'user' && (
        metricNameList.some(m => String(h.content).includes(cleanMetricName(m))) ||
        /省|市|全国|地区|指标/.test(String(h.content))
    );

    // 把历史分为"旧的可压缩"和"新的保留"两段
    const half = Math.floor(history.length / 2);
    const oldPart = history.slice(0, half);
    const newPart = history.slice(half);

    // 旧的部分：关键轮次直接保留，其余压缩
    const pinned = oldPart.filter(isKeyRound);
    const toCompress = oldPart.filter(h => !isKeyRound(h));
    const toKeep = [...pinned.slice(-4), ...newPart]; // 至多保留4条旧关键轮
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
    // 引用模块级 METRIC_SYNONYMS，无需在此维护重复的同义词组
    for (const group of METRIC_SYNONYMS) {
        if (group.keys.some(k => text.toLowerCase().includes(k.toLowerCase()))) {
            for (const name of group.metrics) {
                const matched = metricNameList.find(m =>
                    m === name || cleanMetricName(m) === cleanMetricName(name) ||
                    m.includes(name) || cleanMetricName(m).includes(cleanMetricName(name))
                );
                if (matched) return matched;
            }
        }
    }
    // 精确 synonym 没命中，用模糊匹配兜底
    const fuzzy = findFuzzyMetrics(text, 0.7);
    if (fuzzy.length) return fuzzy[0];
    return metricNameList[0] || '科学支出水平';
}

/**
 * 从最近对话历史中回溯最后一个明确指标
 * 用于 lastMethod 断链时（如方法追问后、跨轮）保持指标继承
 */
function inferMetricFromHistory(recentHistory = []) {
    if (!Array.isArray(recentHistory)) return null;
    // 从最新到最旧扫描 assistant 消息的 meta，找有 metric 的那一条
    for (let i = recentHistory.length - 1; i >= 0; i--) {
        const h = recentHistory[i];
        const metricFromMeta = h?.meta?.methodSummary?.params?.metric
            || h?.meta?.toolTrace?.[0]?.params?.metric;
        if (metricFromMeta) return metricFromMeta;
        // 扫描 user 消息里能推断出的指标
        if (h?.role === 'user') {
            const m = inferMetric(String(h.content || ''));
            // inferMetric 有兜底会返回 metricNameList[0]，需区分"真命中"和"兜底"
            const text = String(h.content || '').toLowerCase();
            const isTrueHit = metricNameList.some(name =>
                text.includes(cleanMetricName(name).toLowerCase()) || text.includes(name.toLowerCase())
            );
            if (isTrueHit && m) return m;
        }
    }
    return null;
}

function expandQueryForRetrieval(question, entities = {}) {
    const additions = [];
    const metric = entities.metrics?.[0] || inferMetric(question);
    if (metric) additions.push(metric, cleanMetricName(metric));
    for (const r of entities.regions || []) additions.push(r);
    for (const y of entities.years || []) additions.push(String(y));
    // 引用 METRIC_SYNONYMS，无需维护重复的 synonymHints 数组
    const q = String(question);
    for (const group of METRIC_SYNONYMS) {
        if (group.keys.some(k => q.toLowerCase().includes(k.toLowerCase()))) {
            additions.push(...group.metrics);
        }
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

// ── HyDE：假设文档嵌入 ──────────────────────────────────────────
// 让 LLM 先猜一个答案，用答案的语义（更接近文档空间）增强 embedding 检索
async function generateHypotheticalAnswer(question) {
    const prompt = `用1-2句话写出下面问题的可能答案，直接给出具体数据和结论，不确定也要猜测：\n${question}`;
    try {
        const raw = await Promise.race([
            generateFast(prompt, 8000),
            new Promise((_, reject) => setTimeout(() => reject(new Error('HyDE超时')), 4000))
        ]);
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 400);
    } catch {
        return '';
    }
}

async function retrieveChromaEvidence(question, entities = {}, limit = 8, hydeText = '') {
    if (!collection) return [];
    try {
        // ── 页码查询检测（"第N页" + 可选《书名》）────────────────────
        const pageQueryMatch = question.match(/第\s*(\d{1,4})\s*页/);
        const queryPage = pageQueryMatch ? parseInt(pageQueryMatch[1]) : null;
        const bookMatch = question.match(/《([^》]{2,50})》/);
        const queryFilenameHint = bookMatch
            ? bookMatch[1].replace(/\.pdf$/i, '').trim()
            : null;

        // 页码查询时去掉"第N页"和《书名》再做语义搜索，避免干扰 embedding
        const semanticQuestion = queryPage
            ? question.replace(/第\s*\d{1,4}\s*页/, '').replace(/《[^》]+》/g, '').trim() || question
            : question;

        const baseQuery = expandQueryForRetrieval(semanticQuestion, entities);
        let queryEmbedding;
        if (hydeText) {
            // 平均 HyDE embedding 与原始 query embedding，融合"文档语义"与"问题语义"
            const [origEmb, hydeEmb] = await Promise.all([
                getEmbedding(baseQuery),
                getEmbedding(hydeText)
            ]);
            queryEmbedding = origEmb.map((v, i) => (v + hydeEmb[i]) / 2);
        } else {
            queryEmbedding = await Promise.race([
                getEmbedding(baseQuery),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma embedding 超时')), 10000))
            ]);
        }

        // ── 知识文档精准过滤逻辑 ────────────────────────────
        // doc_year 过滤：问题或 entities 中有明确年份时优先匹配该年发布的文档
        // 只在问题含报告/全球特征时启用，避免干扰纯结构化数据查询的 ChromaDB 辅助召回
        const isKnowledgeQuery = /报告|指数|白皮书|研究|分析|发布|发表|出版/.test(question) || GLOBAL_COUNTRIES_RE.test(question);
        const yearInQ = (question + ' ' + String(entities.year || '')).match(/20(2[0-9])/);
        const docYearFilter = (isKnowledgeQuery && yearInQ) ? parseInt(yearInQ[0]) : null;

        // 具体国家过滤（排除全球/国际/世界等泛指词）：用 whereDocument.$contains 做内容级过滤
        const specificCountry = KNOWLEDGE_SPECIFIC_COUNTRIES.find(c => question.includes(c));

        const queryParams = {
            queryEmbeddings: [queryEmbedding],
            nResults: Math.min(Math.max(limit * 2, 16), 50)
        };

        // 构建 where 过滤器
        if (queryPage !== null) {
            console.log(`📄 页码查询：第${queryPage}页${queryFilenameHint ? ' · ' + queryFilenameHint : ''}`);
            queryParams.where = { '$and': [{ 'table': { '$eq': 'knowledge' } }, { 'page': { '$eq': queryPage } }] };
        } else if (docYearFilter) {
            queryParams.where = { '$and': [{ 'table': { '$eq': 'knowledge' } }, { 'doc_year': { '$eq': docYearFilter } }] };
            console.log(`📅 知识文档年份过滤：doc_year=${docYearFilter}${specificCountry ? ' + 国家:' + specificCountry : ''}`);
            if (specificCountry) queryParams.whereDocument = { '$contains': specificCountry };
        } else {
            queryParams.where = { 'table': { '$eq': 'knowledge' } };
            if (specificCountry) {
                queryParams.whereDocument = { '$contains': specificCountry };
                console.log(`🌍 知识文档国家过滤：${specificCountry}`);
            }
        }

        let result;
        try {
            result = await Promise.race([
                collection.query(queryParams),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma query 超时')), 8000))
            ]);
        } catch (e) {
            // whereDocument 不被当前 ChromaDB 版本支持时，去掉该参数重试
            if (queryParams.whereDocument) {
                console.warn('⚠️ whereDocument 不支持，降级重试（无内容过滤）:', e.message?.slice(0, 80));
                const fallbackParams = { ...queryParams };
                delete fallbackParams.whereDocument;
                result = await Promise.race([
                    collection.query(fallbackParams),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma query 超时')), 8000))
                ]);
            } else {
                throw e;
            }
        }

        let docs = result?.documents?.[0] || [];
        let metadatas = result?.metadatas?.[0] || [];
        let distances = result?.distances?.[0] || [];

        // 结果不足时（非页码查询）扩大召回，回退到无精准过滤的兜底查询
        if (docs.length < limit && queryPage === null) {
            // 若有国家过滤且结果为空，先单独用 whereDocument 做关键词召回补充
            if (specificCountry && docs.length === 0) {
                try {
                    const kwResult = await Promise.race([
                        collection.query({ queryEmbeddings: [queryEmbedding], nResults: limit * 2,
                            where: { 'table': { '$eq': 'knowledge' } },
                            whereDocument: { '$contains': specificCountry } }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 5000))
                    ]);
                    const kwDocs = kwResult?.documents?.[0] || [];
                    if (kwDocs.length > 0) {
                        docs = kwDocs;
                        metadatas = kwResult?.metadatas?.[0] || [];
                        distances = kwResult?.distances?.[0] || [];
                        console.log(`🌍 国家关键词召回补充 ${docs.length} 条（${specificCountry}）`);
                    }
                } catch (_) { /* whereDocument 失败则跳过 */ }
            }
            if (docs.length < limit) {
            console.log('⚠️ Chroma 结果不足，扩大召回（去掉年份/国家过滤）...');
            const fallbackResult = await Promise.race([
                collection.query({ queryEmbeddings: [queryEmbedding], nResults: limit * 2, where: { 'table': { '$eq': 'knowledge' } } }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Chroma fallback 超时')), 8000))
            ]);
            const fbDocs = fallbackResult?.documents?.[0] || [];
            const fbMeta = fallbackResult?.metadatas?.[0] || [];
            const fbDist = fallbackResult?.distances?.[0] || [];
            const seen = new Set(docs);
            fbDocs.forEach((d, i) => {
                if (!seen.has(d)) { seen.add(d); docs.push(d); metadatas.push(fbMeta[i]); distances.push(fbDist[i]); }
            });
            } // end if docs.length < limit (inner)
        } // end if docs.length < limit (outer)

        let items = docs
            .map((text, i) => ({ text: String(text || ''), metadata: metadatas[i] || {}, distance: distances[i], source: 'ChromaDB' }))
            .filter(item => item.text.trim())
            .sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1))
            .slice(0, limit);

        // 如果指定了书名，优先展示匹配文件的结果（软过滤：匹配的排前，不删除不匹配的）
        if (queryPage !== null && queryFilenameHint) {
            const matched = items.filter(item => {
                const fn = (item.metadata?.filename || item.metadata?.source || '').replace(/\.pdf$/i, '');
                return fn.includes(queryFilenameHint) || queryFilenameHint.includes(fn.slice(0, 6));
            });
            if (matched.length > 0) {
                const unmatched = items.filter(item => !matched.includes(item));
                items = [...matched, ...unmatched].slice(0, limit);
                console.log(`📄 书名过滤：${matched.length}条匹配「${queryFilenameHint}」，共保留${items.length}条`);
            }
        }

        console.log(`📡 Chroma 向量召回 ${items.length} 条，最近距离: ${items[0]?.distance?.toFixed(4) ?? 'N/A'}`);

        // ── 关键词兜底：向量召回不足或质量差时，用 where_document 文本匹配补充 ──
        // 触发条件：召回数量不足，或最佳向量距离 > 0.45（余弦相似度 < 0.55，说明匹配质量低）
        // 注意：0.22 阈值过严，会把相似度 0.78 的优质结果也触发兜底，引入噪声
        const bestDist = items[0]?.distance ?? 1;
        if (items.length < Math.ceil(limit / 2) || bestDist > 0.45) {
            // 按词长降序：越长越具体，越容易精准命中目标内容
            const keywords = extractKeywordsForChroma(question).sort((a, b) => b.length - a.length);
            if (keywords.length) {
                for (const kw of keywords.slice(0, 3)) {
                    try {
                        const kwResult = await Promise.race([
                            collection.get({
                                where: { 'table': { '$eq': 'knowledge' } },
                                whereDocument: { '$contains': kw },
                                limit: limit * 2,
                                include: ['documents', 'metadatas']
                            }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('关键词检索超时')), 5000))
                        ]);
                        const kwDocs = kwResult?.documents || [];
                        const kwMeta = kwResult?.metadatas || [];
                        const seen = new Set(items.map(d => d.text));
                        kwDocs.forEach((text, i) => {
                            const t = String(text || '').trim();
                            if (t && !seen.has(t)) {
                                seen.add(t);
                                items.push({ text: t, metadata: kwMeta[i] || {}, distance: 0.6, source: 'ChromaDB-keyword' });
                            }
                        });
                        // 不再提前 break：让所有关键词都搜完，保证最具体的词也被使用
                    } catch (kwErr) {
                        console.warn(`关键词检索失败 [${kw}]:`, kwErr.message);
                    }
                }
                items = items.slice(0, limit);
                console.log(`📡 关键词补充后共 ${items.length} 条`);
            }
        }

        return items;
    } catch (err) {
        console.warn(`Chroma 向量检索失败，已回退本地检索: ${err.message}`, err);
        return [];
    }
}

/**
 * 从问题中提取适合 ChromaDB where_document 文本匹配的关键词
 * 过滤掉停用词和过短词，保留实质性词汇
 */
function extractKeywordsForChroma(question) {
    const stopwords = new Set(['的', '了', '吗', '呢', '啊', '是', '有', '在', '和', '与', '或', '对', '把', '被', '让', '使',
        '这', '那', '什么', '怎么', '为什么', '如何', '哪些', '多少', '几个', '一个', '请问', '告诉', '介绍', '分析',
        '情况', '表现', '特点', '问题', '方面', '目前', '现在', '近年', '最近', '发展', '变化', '趋势']);
    // 提取2字以上、不在停用词表里的词组
    const tokens = question.match(/[一-龥a-zA-Z]{2,}/g) || [];
    return [...new Set(tokens.filter(t => !stopwords.has(t) && t.length >= 2))];
}



function buildEvidenceFallbackAnswer(question, evidence, entities = {}) {
    if (!evidence.length) {
        return '我没有在当前数据集中检索到足够相关的证据。你可以补充地区、年份或指标，我会重新检索。';
    }
    const lines = evidence.slice(0, 5).map((doc, i) =>
        `${i + 1}. ${doc.table}/${doc.region}/${doc.year}：${buildRelevantMetricSnapshot(lookupRowForDoc(doc), question, entities, 6)}`
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
    // 精确命中 > 前缀部分命中（取前8字），避免指标名细微差异（如括号/单位）导致CRAG反复重查
    const metricPrefix = cleanMetric.slice(0, 8);
    const metricHit = !cleanMetric || joined.includes(cleanMetric) || joined.includes(metric) ||
        (metricPrefix.length >= 4 && joined.includes(metricPrefix));
    const regionHit = !regions.length || regions.some(region => joined.includes(region));
    const yearHit = !years.length || years.some(year => joined.includes(year));
    const enoughLocal = localEvidence.length >= 3 && localTopScore >= 3.0;
    const enoughVector = chromaEvidence.length >= 2 && (chromaBestDistance == null || chromaBestDistance <= 0.5);
    // 命中知识文档时不强制要求 regionHit/yearHit：
    // 知识文档 chunk 可能不显式包含省份/年份字符串，但内容仍然相关
    // 去掉"localEvidence 为空"的限制，避免偶发的低质量本地行导致 yearOk 失效
    const hasKnowledgeHit = chromaEvidence.some(d => d.metadata?.table === 'knowledge' || d.source === 'ChromaDB');
    const regionOk  = regionHit  || hasKnowledgeHit;
    const yearOk    = yearHit    || hasKnowledgeHit;
    const passed = (enoughLocal || enoughVector) && metricHit && regionOk && yearOk;
    const reasons = [];
    if (!passed) {
        if (!enoughLocal && !enoughVector) reasons.push('召回数量或相关度不足');
        if (!metricHit) reasons.push('未稳定命中指标');
        if (!regionHit) reasons.push('未稳定命中地区');
        if (!yearHit) reasons.push('未稳定命中年份');
    }
    // chromaScore 范围 0~0.5：distance=0 → 0.5，distance=0.5 → 0.25，distance>=1 → 0
    const chromaScore = chromaEvidence.length ? Math.max(0, 0.5 - (chromaBestDistance ?? 1) * 0.5) : 0;
    return {
        passed,
        score: Number(Math.min(0.96, 0.28 + localTopScore / 10 + chromaScore).toFixed(2)),
        localTopScore,
        chromaBestDistance,
        reasons: reasons.length ? reasons : ['证据数量、相关度和实体命中满足要求']
    };
}

// ── CRAG 升级：LLM 评估器 ─────────────────────────────────────
// 规则已明确通过(score>0.75)时跳过LLM节省延迟；borderline/明确失败时调LLM二次判定
async function gradeRetrievedEvidenceWithLLM(question, entities, localEvidence, chromaEvidence) {
    const ruleGrade = gradeRetrievedEvidence(question, entities, localEvidence, chromaEvidence);
    // 规则高置信通过，直接用
    if (ruleGrade.passed && ruleGrade.score >= 0.75) {
        return { ...ruleGrade, llmGrade: 'skipped', evaluator: 'rule' };
    }
    // 无任何证据，不用LLM
    const allDocs = [...localEvidence.slice(0, 3), ...chromaEvidence.slice(0, 3)];
    if (!allDocs.length) return { ...ruleGrade, llmGrade: 'incorrect', evaluator: 'rule' };

    const docSnippets = allDocs
        .map((d, i) => {
            const cleanText = String(d.text || '').replace(/^(【(来源|章节)[^】]*】\n*)+/, '');
            return `[${i + 1}] ${cleanText.slice(0, 350)}`;
        })
        .join('\n');
    const prompt = `你是RAG检索质量评估器。判断检索证据是否能回答用户问题。

用户问题：${question}
检索证据：
${docSnippets}

仅返回JSON，不要多余文字：
{"grade":"correct"|"ambiguous"|"incorrect","reason":"一句话","confidence":0.0到1.0}`;

    try {
        const raw = await generateFast(prompt, 8000);
        const match = raw.match(/\{[\s\S]*?\}/);
        const json = match ? JSON.parse(match[0]) : {};
        const llmGrade = ['correct', 'ambiguous', 'incorrect'].includes(json.grade) ? json.grade : 'ambiguous';
        const confidence = typeof json.confidence === 'number' ? json.confidence : 0.5;
        const passed = llmGrade === 'correct' || (llmGrade === 'ambiguous' && ruleGrade.passed);
        return {
            passed,
            score: Number(Math.min(0.96, confidence).toFixed(2)),
            llmGrade,
            reasons: [json.reason || ''],
            localTopScore: ruleGrade.localTopScore,
            chromaBestDistance: ruleGrade.chromaBestDistance,
            evaluator: 'llm'
        };
    } catch (e) {
        console.warn('LLM评估器失败，回退规则:', e.message);
        return { ...ruleGrade, llmGrade: 'unknown', evaluator: 'rule_fallback' };
    }
}

async function rewriteQueryForCorrectiveRag(question, entities = {}, grade = {}) {
    const metric = entities.metrics?.[0] || inferMetric(question);
    const years = entities.years?.length ? entities.years.join('、') : '';
    const regions = entities.regions?.length ? entities.regions.join('、') : '';
    const failReasons = (grade.reasons || []).join('；') || '相关度不足';

    // 规则兜底：若LLM超时则直接拼接扩词
    const ruleQuery = [question, regions, metric, cleanMetricName(metric), years,
        expandQueryForRetrieval(question, entities)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const prompt = `你是RAG查询改写器。第一次检索失败原因：${failReasons}。
请把用户原始问题改写成更适合向量检索的新查询，要求：
1. 补全省略的地区/年份/指标全称
2. 加入同义词和相关概念
3. 只返回改写后的查询字符串，不要解释，不要JSON

原始问题：${question}
已知地区：${regions || '未指定'}
已知指标：${metric ? cleanMetricName(metric) : '未指定'}
已知年份：${years || '未指定'}`;

    try {
        const rewritten = (await generateFast(prompt, 6000)).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const query = rewritten && rewritten.length > 4 && rewritten.length < 300 ? rewritten : ruleQuery;
        return { query, reason: `LLM改写查询（原因：${failReasons}）` };
    } catch (e) {
        return { query: ruleQuery, reason: `规则扩词改写（LLM失败：${e.message}）` };
    }
}

// ── CRAG 升级：网络搜索兜底 ──────────────────────────────────
async function webSearchFallback(question, entities) {
    if (!TAVILY_API_KEY && !SERPER_API_KEY) return [];
    const metric  = entities.metrics?.[0]  ? cleanMetricName(entities.metrics[0])  : '';
    const year    = entities.years?.[0]    || '';
    // entities.regions 只含中国省份；全球查询时 regions 为空，用问题原文避免搜错方向
    const isGlobalQ = entities.regions?.length === 0 && !metric;
    const searchQ = isGlobalQ
        ? question.slice(0, 80)   // 直接用问题原文，不附加"科研教育人才"
        : [entities.regions?.[0] || '中国', metric, year, '科研教育人才 统计数据'].filter(Boolean).join(' ');
    try {
        if (TAVILY_API_KEY) {
            const resp = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, query: searchQ, max_results: 5, search_depth: 'basic' })
            });
            if (!resp.ok) throw new Error(`Tavily ${resp.status}`);
            const data = await resp.json();
            return (data.results || []).map(r => ({
                text: `【网络来源】${r.title}\n${r.content || r.snippet || ''}`,
                source: 'web', url: r.url, distance: 0.35, score: 2
            }));
        }
        if (SERPER_API_KEY) {
            const resp = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
                body: JSON.stringify({ q: searchQ, num: 5, gl: 'cn', hl: 'zh-cn' })
            });
            if (!resp.ok) throw new Error(`Serper ${resp.status}`);
            const data = await resp.json();
            return (data.organic || []).map(r => ({
                text: `【网络来源】${r.title}\n${r.snippet || ''}`,
                source: 'web', url: r.link, distance: 0.35, score: 2
            }));
        }
    } catch (e) {
        console.warn('网络搜索兜底失败:', e.message);
    }
    return [];
}

// ── CRAG 升级：知识精炼 ───────────────────────────────────────
// 从检索到的文档里提取与问题直接相关的片段，去掉噪音
async function refineKnowledge(question, documents) {
    if (!documents.length) return documents;
    // 只对包含知识文档的结果做精炼（纯结构化数据精炼意义不大）
    const hasDocs = documents.some(d => d.source === 'ChromaDB' || d.source === 'web' || d.metadata?.table === 'knowledge');
    if (!hasDocs) return documents;

    // 每个 chunk 最多 1100 字（需覆盖章节前缀开销），取前 10 个 chunk
    const docText = documents.slice(0, 10)
        .map((d, i) => {
            const src = d.metadata?.filename || d.metadata?.source || d.source || '';
            const section = d.metadata?.section ? ` §${d.metadata.section}` : '';
            const page = d.metadata?.page ? `  第${d.metadata.page}页` : '';
            // 去掉入库时的 【来源/章节】 前缀标记，让 LLM 只看实质内容
            const cleanText = String(d.text || '').replace(/^(【(来源|章节)[^】]*】\n*)+/, '');
            return `[文档${i + 1}${src ? ' · ' + src : ''}${section}${page}]\n${cleanText.slice(0, 1100)}`;
        }).join('\n\n');

    const prompt = `从以下文档中精炼出与问题直接相关的信息，保留所有原始数据、数字、百分比和表格内容，不要省略具体数值。
如果文档与问题完全无关，返回空字符串。
注意：文档中以"[图表内容]"开头的段落是从图表图片中识别出的描述，直接提取其中数据即可，不要把"[图表内容]"输出到结果里。

问题：${question}

文档：
${docText}

直接输出精炼后的内容，不要标题和解释：`;

    const totalInputLen = documents.slice(0, 10).reduce((s, d) => s + String(d.text || '').length, 0);
    try {
        const refined = (await generateFast(prompt, 8000))
            .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        // 兜底1：精炼结果过短（< 10字）→ 直接用原始列表
        if (!refined || refined.length < 10) return documents;
        // 兜底2：精炼结果 < 原始总长 15% → 过度压缩，可能丢失关键数据，丢弃精炼
        if (totalInputLen > 200 && refined.length < totalInputLen * 0.15) {
            console.warn(`⚠️ 知识精炼过度压缩(${refined.length}/${totalInputLen})，使用原始文档`);
            return documents;
        }
        // 精炼结果作为最高优先级文档插到最前
        return [{ text: refined, source: 'refined', score: 6, distance: 0.1 }, ...documents];
    } catch (e) {
        console.warn('知识精炼失败，回退原始召回:', e.message);
        return documents;
    }
}

async function retrieveCorrectiveEvidence(question, entities = {}) {
    // ── 第一轮检索：结构化数据 + BM25 + ChromaDB(+HyDE) 并行 ─────
    // 第一轮同时生成 HyDE 假设答案，提升 ChromaDB 第一轮命中率，减少触发第二轮的概率
    const [firstHydeText, firstLocal, firstBm25] = await Promise.all([
        generateHypotheticalAnswer(question),
        Promise.resolve(retrieveHybridEvidence(question, entities, 8)),
        Promise.resolve(retrieveBM25Evidence(question, entities, 5))
    ]);
    const firstChroma = await retrieveChromaEvidence(question, entities, 5, firstHydeText).catch(() => []);

    // LLM评估（规则明确通过时跳过LLM）
    const firstGrade = await gradeRetrievedEvidenceWithLLM(question, entities, firstLocal, [...firstBm25, ...firstChroma]);

    // 第一轮通过 → MMR 去重后知识精炼返回
    if (firstGrade.passed && firstGrade.llmGrade !== 'ambiguous') {
        const deduped = applyMMR([...firstBm25, ...firstChroma], 0.7, 8);
        const refined = await refineKnowledge(question, deduped);
        return { evidence: firstLocal, chromaEvidence: refined, grade: firstGrade,
                 corrected: false, query: question, originalGrade: firstGrade, rewriteReason: '' };
    }

    // ── 第二轮：LLM改写（HyDE 复用第一轮生成的，避免重复调用）────
    const [rewrite] = await Promise.all([
        rewriteQueryForCorrectiveRag(question, entities, firstGrade)
    ]);
    const hydeText = firstHydeText; // 复用第一轮 HyDE
    const rewrittenEntities = extractEntities(rewrite.query);
    const mergedEntities = {
        ...entities,
        regions: [...new Set([...(entities.regions || []), ...(rewrittenEntities.regions || [])])],
        metrics: [...new Set([...(entities.metrics || []), ...(rewrittenEntities.metrics || [])])],
        years:   [...new Set([...(entities.years   || []), ...(rewrittenEntities.years   || [])])]
    };

    const secondLocal  = retrieveHybridEvidence(rewrite.query, mergedEntities, 8);
    const secondBm25   = retrieveBM25Evidence(rewrite.query, mergedEntities, 5);
    let   secondChroma = await retrieveChromaEvidence(rewrite.query, mergedEntities, 5, hydeText).catch(() => []);
    let   secondGrade  = await gradeRetrievedEvidenceWithLLM(question, mergedEntities, secondLocal, [...secondBm25, ...secondChroma]);

    // ── 第三轮：grade=incorrect 或 ambiguous → 网络搜索兜底 ──────
    // ambiguous 也触发：知识文档类问题在本地库不完整，需要网络补充
    const needsWeb = !secondGrade.passed && (
        firstGrade.llmGrade === 'incorrect' || secondGrade.llmGrade === 'incorrect' ||
        firstGrade.llmGrade === 'ambiguous' || secondGrade.llmGrade === 'ambiguous'
    );
    let webEvidence = [];
    if (needsWeb) {
        webEvidence = await webSearchFallback(question, entities);
        if (webEvidence.length) {
            secondChroma = [...secondChroma, ...webEvidence];
            secondGrade  = await gradeRetrievedEvidenceWithLLM(question, mergedEntities, secondLocal, secondChroma);
        }
    }

    // 选更好的那轮结果
    const firstVec  = [...firstBm25,  ...firstChroma];
    const secondVec = [...secondBm25, ...secondChroma];
    const useSecond = secondGrade.passed
        || (secondLocal.length + secondVec.length) >= (firstLocal.length + firstVec.length);

    const finalLocal = useSecond ? secondLocal : firstLocal;
    const finalVec   = useSecond ? secondVec   : firstVec;

    // ── MMR 去重 + 知识精炼 ──────────────────────────────────────
    const refined = await refineKnowledge(question, applyMMR(finalVec, 0.7, 8));

    return {
        evidence:      finalLocal,
        chromaEvidence: refined,
        grade:         useSecond ? secondGrade : firstGrade,
        corrected:     true,
        query:         rewrite.query,
        originalGrade: firstGrade,
        rewriteReason: rewrite.reason,
        webSearchUsed: webEvidence.length > 0
    };
}

async function answerEvidenceChat(question, entities, recentHistory = []) {
    // 明确问报告/白皮书/文献，或问非中国地区话题（德国、美国等）时，跳过本地结构化数据，只用 ChromaDB 回答
    const isReportQuery = /报告|白皮书|文献|指数报告|研究报告|调研|发布的|根据.*报|按照.*报/.test(question);
    const isGlobalQuery = /德国|美国|日本|欧洲|全球|国际|英国|法国|韩国|亚洲|世界|海外|印度|俄罗斯|意大利|加拿大|澳大利亚|新加坡|荷兰|瑞典|芬兰|挪威|丹麦|瑞士|以色列|巴西|墨西哥|阿根廷|西班牙|葡萄牙|波兰|捷克|匈牙利|奥地利|比利时|土耳其|沙特|阿联酋|泰国|越南|马来西亚|印尼|菲律宾|南非|埃及/.test(question);
    let corrective, evidence, chromaEvidence;
    if (isReportQuery || isGlobalQuery) {
        console.log(`🌐 ${isGlobalQuery ? '全球话题' : '报告查询'}，跳过本地结构化数据，直接检索 ChromaDB:`, question);
        const hydeText = await generateHypotheticalAnswer(question).catch(() => '');
        // 枚举类问题（分别/各是/几个/多少个）召回更多，避免漏掉后续章节
        const isEnumerationQ = /分别|各是|各有|几个|多少个|所有|全部|都有哪|列出/.test(question);
        let chroma = await retrieveChromaEvidence(question, entities, isEnumerationQ ? 15 : 10, hydeText).catch(() => []);

        // BM25 知识兜底：ChromaDB 返回的 chunk 中实际含目标国家词不足时补充
        // 适用场景：章节标题未入库导致 whereDocument 过滤失效，宽泛召回返回无关内容
        const specificCountryQ = KNOWLEDGE_SPECIFIC_COUNTRIES.find(c => question.includes(c));
        const countryHitsInChroma = specificCountryQ
            ? chroma.filter(c => (c.text || '').includes(specificCountryQ)).length
            : 0;
        if (specificCountryQ && countryHitsInChroma < 2 && bm25Index && allDocuments.length) {
            try {
                const bm25Hits = bm25Index.search(specificCountryQ, { limit: 40 });
                const existingTexts = new Set(chroma.map(c => (c.text || '').slice(0, 80)));
                const bm25Extras = bm25Hits
                    .map(idx => allDocuments[Number(idx)])
                    .filter(t => t && t.includes(specificCountryQ) && !existingTexts.has(t.slice(0, 80)))
                    .slice(0, 6)
                    .map(t => ({ text: t, metadata: {}, source: 'BM25-knowledge', score: 0.5, distance: 0.1 }));
                if (bm25Extras.length > 0) {
                    console.log(`📚 BM25 知识补充 ${bm25Extras.length} 条（${specificCountryQ}）`);
                    chroma = [...chroma, ...bm25Extras];
                }
            } catch (_) { /* BM25 失败静默跳过 */ }
        }

        // ── CRAG 评分：报告路径同样做质量评估 + 改写 + 网络兜底 ──
        const reportGrade = await gradeRetrievedEvidenceWithLLM(question, entities, [], chroma);
        let reportCorrected = false;
        let reportRewriteReason = '';
        let reportWebUsed = false;

        if (!reportGrade.passed) {
            // 第二轮：改写查询重新检索
            const rewrite = await rewriteQueryForCorrectiveRag(question, entities, reportGrade);
            reportRewriteReason = rewrite.reason;
            const secondChroma = await retrieveChromaEvidence(rewrite.query, entities, isEnumerationQ ? 15 : 10, hydeText).catch(() => []);
            const seen = new Set(chroma.map(c => (c.text || '').slice(0, 80)));
            chroma = [...chroma, ...secondChroma.filter(c => !seen.has((c.text || '').slice(0, 80)))];
            reportCorrected = true;

            // 第三轮：仍不足则网络搜索兜底
            const secondGrade = await gradeRetrievedEvidenceWithLLM(question, entities, [], chroma);
            if (!secondGrade.passed) {
                const webEvidence = await webSearchFallback(question, entities);
                if (webEvidence.length) {
                    chroma = [...chroma, ...webEvidence];
                    reportWebUsed = true;
                }
            }
        }

        const refined = await refineKnowledge(question, applyMMR(chroma, 0.7, 8));
        corrective = { evidence: [], chromaEvidence: refined, grade: reportGrade, corrected: reportCorrected, query: question, originalGrade: reportGrade, rewriteReason: reportRewriteReason, webSearchUsed: reportWebUsed };
        evidence = [];
        chromaEvidence = refined;
    } else {
        corrective = await retrieveCorrectiveEvidence(question, entities);
        evidence = corrective.evidence;
        chromaEvidence = corrective.chromaEvidence;
    }

    // ── 相关性检查：若检索证据与问题主题完全不相符，直接走 chat ──
    const qKeywords = question.replace(/[？?。，,！!的了吗呢啊是否有哪些多少]/g, ' ')
        .split(/\s+/).filter(w => w.length >= 2);
    // d.text 已包含 region/table/年份/指标名，直接用于关键词匹配
    const evidenceText_all = evidence.map(d => d.text || `${d.region}${d.table}`).join('')
        + chromaEvidence.map(d => d.text || '').join('');

    const hasRelevantEvidence = qKeywords.some(kw => evidenceText_all.includes(kw));

    // 知识文档命中时（ChromaDB 有内容）跳过关键词检查，避免误 fallback
    const hasKnowledgeDocs = chromaEvidence.some(d => d.source === 'ChromaDB' || d.source === 'refined' || d.metadata?.table === 'knowledge');
    const isPureDataQuery = entities.metrics?.length > 0 || entities.regions?.length > 0;
    if (!hasRelevantEvidence && !isPureDataQuery && !hasKnowledgeDocs && (evidence.length + chromaEvidence.length) > 0) {
        console.log('⚠️ evidence_chat 证据与问题不相关，fallback 到 chat:', question);
        return answerGeneralChat(question, recentHistory);
    }

    const evidenceText = evidence.map((doc, i) =>
        `[${i + 1}] ${doc.table}/${doc.region}/${doc.year}: ${buildRelevantMetricSnapshot(lookupRowForDoc(doc), question, entities, 10)}`
    ).join('\n');
    const chromaText = chromaEvidence.map((doc, i) =>
        `[V${i + 1}] ${doc.text.slice(0, 2000)}`
    ).join('\n');
    // 主题延续检测：追问短句 OR 关键词重叠 → 视为延续
    const lastUserMsg = [...recentHistory].reverse().find(h => h.role === 'user');
    const isTopicContinued = (() => {
        if (!lastUserMsg) return false;
        if (question.length <= 12) return true;
        if (/^(那|换|再|还有|那么|还是|另外)/.test(question)) return true;
        if (/呢[？?]?$/.test(question)) return true;
        if (/(这个|该|上面|上述|它的|其中|上一|前面|刚才|之前)/.test(question)) return true;
        const hasRegion = Object.keys(REGION_MAP).some(r => question.includes(r)) || /全国/.test(question);
        const hasMetric = metricNameList.some(m => question.includes(cleanMetricName(m)));
        if (hasRegion && !hasMetric) return true;
        const prev = String(lastUserMsg.content || '');
        const keywords = (s) => [...s.matchAll(/[一-龥]{2,}/g), ...s.matchAll(/\d{4}/g)].map(m => m[0]);
        const prevKw = new Set(keywords(prev));
        return keywords(question).some(kw => prevKw.has(kw));
    })();
    const historyText = isTopicContinued
        ? recentHistory
            .slice(-6)
            .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 220)}`)
            .join('\n')
        : '';

    let answer = '';
    let usedModel = false;

    // 构建页码引用提示
    const chromaSourceHint = chromaEvidence
        .filter(d => d.metadata?.filename && d.metadata?.page)
        .slice(0, 3)
        .map((d, i) => {
            const fname = d.metadata.filename;
            const page = d.metadata.page;
            const section = d.metadata?.section ? ` §${d.metadata.section}` : '';
            const url = `/资料/${encodeURIComponent(fname)}#page=${page}`;
            return `  [${i + 1}] 《${fname.replace(/\.pdf$/i, '')}》第${page}页${section} (${url})`;
        })
        .join('\n');
    const sourceHintLine = chromaSourceHint
        ? `\n可引用来源（回答末尾用"来源：《文件名》第N页"格式标注，最多3个）：\n${chromaSourceHint}`
        : '';

    if (evidence.length || chromaEvidence.length) {
        const prompt = `你是山东财经大学科研教育人才数据平台的研究助理。请只基于给定证据回答用户问题，不要编造数据。

回答要求：
1. 直接回答用户问题，语气自然，像专业助手在聊天。
2. 用数据支撑结论，但不要把证据列表原样罗列给用户。
3. 如果证据不足以回答，直接说明缺什么，建议用户提供更多信息。
4. 补充证据（白皮书/报告/文献）中若包含国外国家、全球比较、行业数据等内容，可以基于这些证据回答，不要拒绝。
5. 不要输出<think>，不要提及"检索"、"向量库"、"RAG"等技术术语。
6. 中文回答，结构清晰，适度简洁。
7. 列举多个要点时，使用"一、二、三"或"①②③"等中文序号，不要使用"1. 2. 3."的 Markdown 有序列表格式（前端不渲染 Markdown）。
8. 如果回答引用了补充证据中的报告内容，在回答末尾单独一行标注来源，格式：来源：《报告名》第N页（URL）。最多标注3个。
9. 补充证据中以"[图表内容]"开头的段落是从图片中识别出的图表描述，直接提取其中的数据和结论作为依据，不要把"[图表内容]"这几个字输出给用户。

最近对话：
${historyText || '无'}

用户问题：
${question}

数据证据：
${evidenceText}
${chromaText ? '\n补充证据：\n' + chromaText : ''}${sourceHintLine}

请直接回答：`;
        try {
            const raw = await Promise.race([
                generateSync(prompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error('证据生成超过60秒，快速降级')), 60000))
            ]);
            answer = fixNumberedList(raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
            usedModel = !!answer;
        } catch (err) {
            console.warn('证据回答生成失败，使用本地摘要降级:', err.message);
        }
    }

    if (!answer) {
        if (evidence.length) {
            const lines = evidence.slice(0, 4).map(doc => {
                const snapshot = buildRelevantMetricSnapshot(lookupRowForDoc(doc), question, entities, 5);
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
        answer: sanitizeUnsupportedFollowups(answer, hasKnowledgeDocs),
        chart: null,
        citations,
        reasoning: [
            '意图: corrective_rag',
            chromaEvidence.length ? '检索: ChromaDB向量库 + 本地混合索引' : '检索: 本地混合索引',
            corrective.corrected ? `纠正: ${corrective.rewriteReason || '查询已LLM改写重新检索'}` : `质检: 初次检索通过（评估器: ${corrective.grade?.evaluator || 'rule'}）`,
            corrective.webSearchUsed ? '兜底: 已调用网络搜索补充证据' : null,
            corrective.chromaEvidence?.some(d => d.source === 'refined') ? '精炼: 已提取文档关键片段' : null,
            `本地证据: ${evidence.length}条`,
            `向量证据: ${chromaEvidence.length}条`,
            usedModel ? '生成: 模型证据归纳' : '生成: 数据摘要降级'
        ].filter(Boolean),
        confidence: corrective.grade.passed ? 0.84 : ((evidence.length + chromaEvidence.length) >= 2 ? 0.66 : 0.42),
        suggestions: buildContextualSuggestions(question, 'evidence_chat'),
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

    // 语义否决：含原因/评价/建议/解释意图的问题，规则不强行路由到结构化工具
    // 这类问题即使含"趋势/排名"等词，用户也是在问"为什么"，应走 evidence_chat
    const isAnalyticalIntent = /(为什么|原因|怎么看|如何看|评价|评估|建议|分析原因|说明原因|影响因素|背后|解释|论述|探讨|阐述)/.test(q);
    if (isAnalyticalIntent) return null;

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
        return { tool: 'trend_analysis', params: { metric, region: region || '全国', years } };
    }

    // ③ 对比两年："2022和2023/2022对比2023"
    if (yearMatch && yearMatch.length >= 2 && /(对比|比较|vs|和|与)/.test(q)) {
        const region = entities.regions[0] || '全国';
        return {
            tool: 'compare',
            params: { metric, year: parseInt(yearMatch[0]), regionA: region, regionB: region, compareYear: parseInt(yearMatch[1]) }
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

function normalizeAgentDecision(decision, entities = {}, question = '') {
    if (!decision || typeof decision !== 'object') return null;
    const tool = normalizeToolName(decision.tool || decision.intent || '');
    const allowed = new Set(['get_ranking', 'compare', 'point_query', 'trend_analysis', 'evidence_chat', 'chat']);
    if (!allowed.has(tool)) return null;
    const params = { ...(decision.params || {}) };
    if (!params.metric && decision.metric) params.metric = decision.metric;
    if (!params.region && decision.region) params.region = decision.region;
    if (!params.year && decision.year) params.year = decision.year;
    if (!params.years && Array.isArray(decision.years)) params.years = decision.years;
    if (!params.metric && entities.metrics?.[0]) params.metric = entities.metrics[0];
    if (!params.region && entities.regions?.[0] && !['get_ranking', 'compare'].includes(tool)) params.region = entities.regions[0];
    if (!params.metric && tool !== 'chat' && tool !== 'evidence_chat') params.metric = inferMetric(question);

    if (params.year != null && typeof params.year !== 'number') params.year = parseInt(params.year) || 0;
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
    const citySample = [...new Set(rawDataCache.city.slice(0,20).map(r=>r['地区']).filter(Boolean))].join('、');
    const prompt = `你是一个成熟的对话式数据分析 Agent 的”大脑”。你要理解用户真实意图，决定是否聊天、检索知识，还是调用数据工具。只返回严格 JSON，不要 Markdown，不要解释，不要 <think>。

可用工具：
- trend_analysis: 趋势/历年/近N年/变化/趋势图
- get_ranking: 排名/前N/最高/最低
- compare: 两个地区或两个年份对比
- point_query: 某地区某年份某指标具体值
- evidence_chat: 解释、评价、原因、建议、开放式分析；以及一切涉及已入库报告/白皮书/文献/名单内容的问题（如"报告里说了什么""白皮书的结论""指数怎么构建的""某人才称号的条件"等）
- chat: 普通交流、打招呼、闲聊、能力说明

工具参数：
trend_analysis {"metric":string,"region":string|null,"years":number[]|null}
get_ranking {"metric":string,"year":number,"order":"desc"|"asc","topN":number}
compare {"metric":string,"year":number,"regionA":string,"regionB":string,"compareYear":number|null}
point_query {"metric":string,"region":string,"year":number}

决策原则：
1. 优先理解用户原话，不要只按关键词死板匹配。
2. 用户要数据、图表、导出、报告时，必须选合适工具，不要闲聊。
3. 用户问”为什么/怎么看/评价/建议/总结”且不是明确数值任务，选 evidence_chat。用户提到报告、白皮书、文献、指数构建方法、人才称号条件、名单内容等，一律选 evidence_chat。
4. 用户说”那这个呢/同样/换成/继续”时，要结合上下文继承指标、地区和上一轮任务。
5. 只有用户明确说全国/国家/中国整体/国内整体时，region 才填”全国”；确实没说地区且上下文也无法继承时，不要默认全国，应 needsClarification=true。
6. 不要编造指标；可用指标示例里没有完全匹配时，选择最接近的指标。
7. 用户问”各省/全国各地/省份对比/发展情况/排名”这类覆盖所有省份的问题，优先选 get_ranking，不要选 evidence_chat（RAG 只能返回部分省份的片段，会导致数据不全）。
8. 问题涉及中国以外的国家/地区（如德国、美国、全球、国际对比等），不要选 chat 拒绝，应选 evidence_chat——知识文档库中收录了全球指数报告和白皮书，可能包含相关内容。

可用指标示例：${metricHints}
地级市数据（部分城市）：${citySample}（查询地级市时 region 填城市全名）
已识别实体：${JSON.stringify(entities)}
上一轮方法摘要：${lastMethod ? JSON.stringify(lastMethod).slice(0, 900) : '无'}
最近对话：
${historyHint || '无'}

用户问题：${question}

返回格式：
{"tool":"trend_analysis|get_ranking|compare|point_query|evidence_chat|chat","params":{},"rationale":"一句话说明为什么这样选","needsClarification":false}`;

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
    // ranking / point / trend 草稿已完整，不走 LLM 润色（防止丢失年份/数值）
    if (context.resultType === 'ranking' || context.resultType === 'point' || context.resultType === 'trend') {
        return draftAnswer;
    }
    // compare：只有当有报告证据时才走 LLM 润色（丰富背景解读）
    const hasReportEvidence = Array.isArray(context.reportEvidence) && context.reportEvidence.length > 0;
    if (context.resultType === 'compare' && !hasReportEvidence) {
        return draftAnswer;
    }

    // 并联报告证据片段，并生成可跳转来源提示
    const reportEvidence = context.reportEvidence || [];
    const reportSnippets = reportEvidence
        .slice(0, 6)
        .map((d, i) => {
            const filename = d.metadata?.filename || d.metadata?.source || '';
            const page = d.metadata?.page ? `第${d.metadata.page}页` : '';
            const section = d.metadata?.section ? `§${d.metadata.section}` : '';
            const src = [filename, page, section].filter(Boolean).join(' ');
            return `[报告${i + 1}${src ? ' · ' + src : ''}] ${String(d.text || '').slice(0, 600)}`;
        })
        .join('\n');
    // 构建来源索引，供 LLM 在回答末尾引用
    const sourceIndex = reportEvidence
        .slice(0, 6)
        .map((d, i) => {
            const filename = d.metadata?.filename || d.metadata?.source || '';
            const page = d.metadata?.page;
            const section = d.metadata?.section || '';
            const url = filename ? `/资料/${encodeURIComponent(filename)}${page ? `#page=${page}` : ''}` : '';
            return { filename, page, section, url };
        })
        .filter(s => s.filename);
    const sourceHint = sourceIndex.length
        ? `\n可引用来源（在回答末尾用"来源：《文件名》第N页"格式标注，如有URL可附链接）：\n` +
          sourceIndex.map((s, i) => `  [${i + 1}] 《${s.filename.replace(/\.pdf$/i, '')}》${s.page ? '第' + s.page + '页' : ''}${s.section ? ' §' + s.section : ''} ${s.url ? '(' + s.url + ')' : ''}`).join('\n')
        : '';
    const reportSection = reportSnippets
        ? `\n相关报告/文献内容（保留所有数字和数据，尽量引用原文）：\n${reportSnippets}\n${sourceHint}`
        : '';

    const prompt = `你是山东财经大学科研教育人才数据平台的成熟 AI 分析助手。请基于”工具结果草稿”生成自然、清晰、有交流感的最终回答。

要求：
1. 必须忠实于工具结果，不要新增未给出的数值、年份、地区、排名。
2. 保留关键表格、数值、方法、置信区间和数据来源含义。
3. 如果提供了相关报告内容，可以引用其中的分析背景、政策解读或方法说明来丰富回答，但不要用报告内容替换或矛盾于工具数值。
4. 语气像专业助手，不要模板腔，不要说”修复/工具调用完成/后台”等技术提示。
5. 如果结果显示数据缺失，要直接说明缺什么，并给出下一步可问法。
6. 追问建议只能围绕当前平台已有口径：全国、省份、地级市、年份、已存在指标、趋势、排名、对比、方法说明。
7. 中文回答，结构清楚，适度简洁。
8. 列举多个要点时，使用"一、二、三"或"①②③"等中文序号，不要使用"1. 2. 3."的 Markdown 有序列表格式（前端不渲染 Markdown）。
9. ${context.resultType === 'compare' ? '本次回答的数据来源以平台结构化数据为准，报告内容仅供背景参考。' : '如果回答用到了报告内容，在回答末尾单独一行标注来源，格式：📄 来源：《报告名》第N页。如提供了 URL，格式为：📄 来源：《报告名》第N页（/资料/文件名.pdf#page=N）。最多标注3个来源。'}

用户问题：${question}
工具与方法轨迹：${JSON.stringify(context.toolTrace || []).slice(0, 1200)}
证据来源：${JSON.stringify(context.citations || []).slice(0, 900)}
${reportSection}
工具结果草稿：
${String(draftAnswer).slice(0, 5000)}

请输出最终回答正文：`;
    try {
        const raw = await generateSync(prompt, 60000);
        const cleaned = fixNumberedList(raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
        const hasReportEvidence = (context.reportEvidence || []).length > 0;
        if (cleaned && cleaned.length >= 10 && !/^```/.test(cleaned)) return sanitizeUnsupportedFollowups(cleaned, hasReportEvidence);
    } catch (err) {
        console.warn('最终表达层不可用，使用工具草稿:', err.message);
    }
    return fixNumberedList(draftAnswer);
}

/** 把 LLM 生成的 Markdown 有序列表（全为 1.）转为中文序号，前端不渲染 Markdown */
function fixNumberedList(text) {
    if (!text) return text;
    const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
                 '十一', '十二', '十三', '十四', '十五'];
    // 逐行处理：遇到 "数字. " 开头的行，按块内顺序编号
    const lines = text.split('\n');
    let counter = 0;
    const result = lines.map(line => {
        if (/^\d+\.\s+/.test(line)) {
            const cn = CN[counter] !== undefined ? `${CN[counter]}、` : `${counter + 1}、`;
            counter++;
            return line.replace(/^\d+\.\s+/, cn + ' ');
        }
        // 空行重置计数器（新列表块重新从"一"开始）
        if (line.trim() === '') counter = 0;
        return line;
    });
    return result.join('\n');
}

function sanitizeUnsupportedFollowups(answer, isKnowledgeAnswer = false) {
    // 知识文档回答不过滤（白皮书/报告本身包含国际/企业等内容）
    if (isKnowledgeAnswer) return String(answer || '').replace(/\n{3,}/g, '\n\n').trim();
    const lines = String(answer || '').split(/\n/);
    // 只过滤"平台不支持的追问建议"短语，而非内容词
    // 避免把"汽车行业"、"电子产业"等合法回答内容误删
    const blocked = /(?:平台暂不支持|平台不支持查询|暂不支持该指标|不在平台数据范围|超出平台数据范围|建议前往.*官方网站|建议查阅.*官网|具体院校名单|具体公司.*列表|具体企业.*列表)/;
    return lines
        .filter(line => !blocked.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── 上下文感知建议生成 ────────────────────────────────────────
function buildContextualSuggestions(question, tool = 'chat') {
    const q = String(question);
    const latestYear = getLatestYear(rawDataCache.province) || 2024;

    // 人才计划 / 学者类
    if (/(杰青|优青|长江学者|万人|千人|百人|人才计划|院士|杰出|拔尖|青年托举)/.test(q)) {
        return [
            `${latestYear}年各省杰青数量排名`,
            `近5年长江学者数量趋势`,
            `${latestYear}年各省优青数量对比`,
            '山东省人才计划入选情况'
        ];
    }
    // 高校 / 教育类
    if (/(高校|大学|院校|学生|教师|专任|在校生|录取|教育)/.test(q)) {
        return [
            `${latestYear}年各省普通高校数量排名`,
            '近10年全国高校数量趋势',
            '江苏和浙江高校数量对比'
        ];
    }
    // 科研 / 专利 / R&D
    if (/(专利|科研|R&D|研发|发明|论文|科技|创新)/.test(q)) {
        return [
            `${latestYear}年各省发明专利授予数排名`,
            '近5年全国R&D经费趋势',
            `${latestYear}年科学支出水平各省对比`,
            '广东和江苏专利数量对比'
        ];
    }
    // 经济 / 产业类
    if (/(GDP|产业|经济|工业|制造|机器人|数字化|互联网)/.test(q)) {
        return [
            '全国工业机器人密度近10年趋势',
            `${latestYear}年各省产业结构高级化排名`,
            '江苏和浙江科研指标对比',
            '全国互联网普及度近10年趋势'
        ];
    }
    // evidence_chat 通用追问建议
    if (tool === 'evidence_chat') {
        return ['换一个省份继续查询', `指定${latestYear}年重新分析`, '查看该指标近5年趋势', '对比两个省份的差异'];
    }
    // chat 默认建议
    return [
        `${latestYear}年各省杰青数量前10排名`,
        '近5年长江学者趋势',
        '江苏和浙江R&D投入对比'
    ];
}

async function answerGeneralChat(question, recentHistory = []) {
    const latestYear = getLatestYear(rawDataCache.province);
    const historyHint = Array.isArray(recentHistory)
        ? recentHistory.slice(-6).map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 160)}`).join('\n')
        : '';
    const hasHistory = historyHint && historyHint.length > 0;
    const prompt = `你是山东财经大学科研教育人才数据平台的数据分析助手，直接、简洁地回答用户问题。

规则：
- 不要自我介绍，不要列举自己的能力
- 如果是追问上一个问题（如"单位是什么""能详细说说吗"），直接基于对话上下文回答
- 如果是新的数据需求，简短确认后调用工具
- 如果是闲聊，用一两句话回应，不要展开介绍
- 不编造数据

最新数据年份：${latestYear || '未知'}，指标数量：${metricNameList.length}个
${hasHistory ? `最近对话：\n${historyHint}` : ''}

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
                suggestions: buildContextualSuggestions(question, 'chat'),
                toolTrace: [{ tool: 'chat', normalizedTool: 'chat', params: {}, success: true, type: 'chat' }]
            };
        }
    } catch (err) {
        console.warn('普通聊天模型不可用，使用固定能力介绍:', err.message);
    }
    return {
        answer: `好的，请说。`,
        chart: null,
        citations: [],
        reasoning: ['意图: chat', '模型不可用时降级为能力说明'],
        confidence: 0.75,
        suggestions: ['查看全国趋势', '查看省份排名', '生成分析报告', '导出表格'],
        toolTrace: [{ tool: 'chat', normalizedTool: 'chat', params: {}, success: true, type: 'chat' }]
    };
}

// ========== 执行工具 ==========
async function executeTool(decision, entities) {
    const tool = normalizeToolName(decision.tool);
    const params = decision.params || {};

    // 全局地区名规范化（所有工具共用，引用模块级 REGION_MAP）
    const _nr = r => (!r || r === '全国') ? r : (REGION_MAP[r] || r);
    if (params.region) params.region = _nr(params.region);
    if (params.regionA) params.regionA = _nr(params.regionA);
    if (params.regionB) params.regionB = _nr(params.regionB);
    // ── 地级市判断：检查 region 是否在 city 表中 ────────────
    const cityRegionSet = new Set(rawDataCache.city.map(r => r['地区']).filter(Boolean));
    const isCityRegion = (r) => r && r !== '全国' && cityRegionSet.has(r);

    try {
        // ---- get_ranking ----
        if (tool === 'get_ranking') {
            const metric = params.metric || entities.metrics[0] || metricNameList[0];
            const year   = params.year   || entities.years[0]   || 0;
            const order  = ['desc','asc'].includes(params.order) ? params.order : 'desc';
            const topN   = parseInt(params.topN) || 10;
            // 自动检测是否为地级市排名
            const table  = params.table === 'city'
                || (params.region && isCityRegion(params.region))
                || /(地级市|城市级|市级排名)/.test(String(decision._originalQuestion || ''))
                ? 'city' : (params.table || 'province');
            const data   = getRanking(metric, year, order, topN, table);
            return { success: true, type: 'ranking', data, _table: table };
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

        // ---- point_query ----
        if (tool === 'point_query') {
            const metric  = params.metric || entities.metrics[0] || metricNameList[0];
            const region  = params.region || entities.regions[0];
            const isNational = region === '全国';
            const isCity  = !isNational && isCityRegion(region);
            const rows    = isNational ? rawDataCache.national : isCity ? rawDataCache.city : rawDataCache.province;
            const year    = params.year   || entities.years[0]   || getLatestYear(rows);
            const realKey = findRealKey(rows, metric) || metric;
            const row     = rows.find(r => r['年份'] === year && (isNational || r['地区'] === region));
            return { success: true, type: 'point', data: { region, metric, year, value: row ? row[realKey] : undefined, _table: isCity ? '地级市表' : isNational ? '全国表' : '省份表' } };
        }

        // ---- trend_analysis ----
        if (tool === 'trend_analysis') {
            const metric = params.metric || entities.metrics[0] || metricNameList[0];
            
            // 只有明确指定全国时才使用全国表
            const wantsNationalTrend = params.region === '全国' || entities.regions[0] === '全国';
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
                        data: { region: '全国', metric, table: '全国表', chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] ?? null })), years: filtered.map(r => r['年份']) }
                    };
                }
            }
            
            // 有指定地区 → 判断地级市 or 省份
            const regionParam = params.region || entities.regions[0];
            const isCity = regionParam && isCityRegion(regionParam);
            const sourceTable = isCity ? rawDataCache.city : rawDataCache.province;
            const region = regionParam;
            const requestedYears = (params.years && params.years.length) ? params.years
                                 : (entities.years && entities.years.length) ? entities.years : null;
            const rows    = sourceTable.filter(r => r['地区'] === region);
            const realKey = findRealKey(rows, metric) || metric;
            const tableLabel = isCity ? '地级市表' : '省份表';
            console.log(`trend_analysis(${tableLabel}): "${metric}"→"${realKey}", region="${region}"`);
            let filtered = rows;
            if (requestedYears && requestedYears.length) {
                const f = rows.filter(r => requestedYears.includes(r['年份']));
                if (f.length) filtered = f;
            }
            filtered.sort((a, b) => a['年份'] - b['年份']);
            return {
                success: true, type: 'trend',
                data: { region, metric, table: tableLabel, chartData: filtered.map(r => ({ year: r['年份'], value: r[realKey] ?? null })), years: filtered.map(r => r['年份']) }
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
        if (items._yearFallback) answer += `> ⚠️ ${items._yearFallback}\n\n`;
        answer += `**排名结果**\n\n`;
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
    else if (type === 'point') {
        const { region, metric, year, value } = result.data;
        answer = value !== undefined
            ? `**${year}年 ${region} ${metric}**\n\n📊 **${formatValue(value)}**`
            : `⚠️ 未找到${year}年${region}的${metric}数据`;
        citations.push(`[来源: 省份表/${region}/${year}]`);
    }
    else if (type === 'trend') {
        const { region, metric, chartData, table } = result.data;
        const valid = chartData.filter(d => d.value !== null && d.value !== undefined && !isNaN(d.value));
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

    if (type === 'trend') {
        suggestions.push(`${region}${cleanMetric}年均增长率`);
        suggestions.push(`${latestYear}年各省${cleanMetric}排名`);
        if (entities.regions.length < 2) suggestions.push(`江苏和浙江${cleanMetric}对比`);
    } else if (type === 'ranking') {
        const topRegion = result?.data?.[0]?.region || '榜首地区';
        suggestions.push(`${topRegion}${cleanMetric}近10年趋势`);
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
        if (entities.regions.length < 2) suggestions.push(`江苏和浙江${cleanMetric}对比`);
    }

    return sanitizeSuggestionList(suggestions);
}

function isPredictionOrFutureText(text, latestYear = getLatestYear(rawDataCache.province)) {
    const q = String(text || '');
    if (/(预测|预估|预计|推测|forecast|predict|projection|明年|后年|下一年|下年|未来)/i.test(q)) return true;
    const years = (q.match(/20\d{2}/g) || []).map(y => parseInt(y, 10)).filter(Number.isFinite);
    if (!years.some(y => y > latestYear)) return false;
    return !/(报告|白皮书|文献|资料|发布|出版|全球智数化人才指数报告)/.test(q);
}

function sanitizeSuggestionList(suggestions = []) {
    const latestYear = getLatestYear(rawDataCache.province);
    return [...new Set((suggestions || []).map(s => String(s || '').trim()))]
        .filter(Boolean)
        .filter(s => !isPredictionOrFutureText(s, latestYear))
        .slice(0, 4);
}

function sanitizeAgentResult(result) {
    if (!result || typeof result !== 'object') return result;
    result.suggestions = sanitizeSuggestionList(result.suggestions || []);
    return result;
}

function buildUnsupportedPredictionResponse(question) {
    const latestYear = getLatestYear(rawDataCache.province);
    return {
        answer: `平台目前只支持已有年份数据查询、历史趋势、排名和地区对比，不做未来年份预测。当前结构化数据最新到 **${latestYear}年**。\n\n你可以改问：${latestYear}年相关指标排名，或某地区近几年趋势。`,
        chart: null,
        citations: [],
        reasoning: ['意图: 未来预测请求', `处理: 拒绝预测，仅说明已有数据范围（最新${latestYear}年）`],
        confidence: 1,
        suggestions: sanitizeSuggestionList([
            `${latestYear}年各省科学支出水平排名`,
            `济南市科学支出水平近5年趋势`,
            `江苏和浙江科学支出水平对比`
        ]),
        toolTrace: [{ tool: 'unsupported_prediction', normalizedTool: 'unsupported_prediction', params: {}, success: false }],
        methodSummary: {
            type: 'unsupported_prediction',
            title: '未来预测请求',
            methodLabel: '范围校验',
            methodReason: '平台只读取已有年份结构化数据，不对未来年份做外推预测。',
            params: { question, latestYear }
        }
    };
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

function isCorrelationQuestion(question) {
    const q = String(question || '');
    return /(相关|关系|关联|同步|协同|影响|是否.*有关|有没有.*关系|正相关|负相关|相关性|相关系数)/.test(q);
}

function pearsonCorrelation(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;
    for (const p of points) {
        const dx = p.x - meanX;
        const dy = p.y - meanY;
        numerator += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }
    const denom = Math.sqrt(denomX * denomY);
    if (!denom) return null;
    return numerator / denom;
}

function correlationStrength(r) {
    if (typeof r !== 'number') return '无法判断';
    const abs = Math.abs(r);
    if (abs >= 0.8) return r > 0 ? '强正相关' : '强负相关';
    if (abs >= 0.5) return r > 0 ? '中等正相关' : '中等负相关';
    if (abs >= 0.3) return r > 0 ? '弱正相关' : '弱负相关';
    return '相关性较弱';
}

function answerCorrelationAnalysis(question, entities = null) {
    if (!isCorrelationQuestion(question)) return null;
    const parsed = entities || extractEntities(question);
    const metrics = [...new Set((parsed.metrics || []).map(metric => findRealKey(rawDataCache.province, metric) || metric))]
        .filter(metric => metricNameList.includes(metric))
        .slice(0, 2);
    if (metrics.length < 2) return null;

    const region = (parsed.regions && parsed.regions[0]) || '全国';
    const isNational = region === '全国';
    const sourceRows = isNational ? rawDataCache.national : rawDataCache.province;
    const metricA = findRealKey(sourceRows, metrics[0]) || metrics[0];
    const metricB = findRealKey(sourceRows, metrics[1]) || metrics[1];
    if (!metricA || !metricB) return null;

    const yearRange = parseYearRange(question);
    let minYear = yearRange?.length ? Math.min(...yearRange) : null;
    let maxYear = yearRange?.length ? Math.max(...yearRange) : null;
    if (!minYear && parsed.years?.length >= 2) {
        minYear = Math.min(...parsed.years);
        maxYear = Math.max(...parsed.years);
    }

    let rows = sourceRows.filter(row => {
        const year = row['年份'] ?? row['时间'];
        if (!Number.isInteger(Number(year))) return false;
        if (!isNational && row['地区'] !== region) return false;
        if (minYear && year < minYear) return false;
        if (maxYear && year > maxYear) return false;
        return typeof row[metricA] === 'number' && typeof row[metricB] === 'number';
    }).sort((a, b) => (a['年份'] ?? a['时间']) - (b['年份'] ?? b['时间']));

    if (!rows.length) return null;
    if (!minYear && rows.length > 25) rows = rows.slice(-25);

    const points = rows.map(row => ({
        year: Number(row['年份'] ?? row['时间']),
        x: Number(row[metricA]),
        y: Number(row[metricB])
    })).filter(p => Number.isFinite(p.year) && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length < 3) return null;

    const r = pearsonCorrelation(points);
    const rText = typeof r === 'number' ? r.toFixed(4) : '无法计算';
    const strength = correlationStrength(r);
    const first = points[0];
    const last = points[points.length - 1];
    const cleanA = cleanMetricName(metricA);
    const cleanB = cleanMetricName(metricB);
    const yearLabel = `${first.year}-${last.year}`;
    const latestDataYear = getLatestYear(rawDataCache.province);

    const trendA = points.map(p => p.x);
    const trendB = points.map(p => p.y);
    const answer = `**${region}${yearLabel}年 ${cleanA} 与 ${cleanB} 相关性分析**\n\n`
        + `基于 ${points.length} 个年度有效样本，Pearson 相关系数 **r = ${rText}**，判断为 **${strength}**。\n\n`
        + `| 指标 | ${first.year}年 | ${last.year}年 | 变化 |\n|---|---:|---:|---:|\n`
        + `| ${cleanA} | ${formatValue(first.x)} | ${formatValue(last.x)} | ${formatValue(last.x - first.x)} |\n`
        + `| ${cleanB} | ${formatValue(first.y)} | ${formatValue(last.y)} | ${formatValue(last.y - first.y)} |\n\n`
        + `图表建议一起看：上半部分是两个指标的年度趋势，下半部分是散点相关图。需要注意，相关系数表示同步变化程度，不直接等同于因果关系。`;

    return {
        answer,
        chart: {
            type: 'correlation',
            metric: `${cleanA} vs ${cleanB}`,
            metrics: [metricA, metricB],
            region,
            regions: [region],
            years: points.map(p => p.year),
            trendSeries: [
                { name: cleanA, data: trendA },
                { name: cleanB, data: trendB }
            ],
            scatterData: points.map(p => [p.x, p.y, p.year]),
            correlation: typeof r === 'number' ? Number(r.toFixed(4)) : null,
            title: `${region}${cleanA}与${cleanB}相关性`
        },
        citations: [`[来源: ${isNational ? '全国表' : '省份表'}/${region}/${yearLabel}/${points.length}年数据]`],
        reasoning: [
            '意图: correlation_analysis',
            `地区: ${region}`,
            `指标: ${cleanA}、${cleanB}`,
            `样本: ${points.length}年`,
            `Pearson r: ${rText}`
        ],
        confidence: points.length >= 10 ? 0.9 : 0.72,
        suggestions: [
            `${region}${cleanA}近10年趋势`,
            `${region}${cleanB}近10年趋势`,
            `${latestDataYear}年各省${cleanA}排名`,
            `换一个地区继续分析${cleanA}和${cleanB}相关性`
        ],
        toolTrace: [{
            tool: 'correlation_analysis',
            normalizedTool: 'correlation_analysis',
            params: { region, metrics: [metricA, metricB], years: points.map(p => p.year) },
            success: true,
            type: 'correlation'
        }],
        methodSummary: {
            type: 'correlation_analysis',
            title: `${region}${cleanA}与${cleanB}相关性`,
            methodLabel: '双指标时序匹配 + Pearson 相关系数',
            methodReason: '用户询问两个指标之间的关系时，按同一地区同一年份对齐两个指标，计算相关系数，并同时返回趋势图和散点图。',
            params: { region, metrics: [metricA, metricB], years: points.map(p => p.year) },
            regions: [region],
            metric: `${cleanA} vs ${cleanB}`
        }
    };
}

function isMethodFollowup(question) {
    const q = String(question || '').trim();
    return /(怎么|如何|为什么|依据|根据|方法|怎么算|怎么得出|用什么模型|什么算法|可信|靠谱吗|原理|过程)/.test(q)
        && /(算|得出|回答|结果|数据|方法|模型|算法|刚才|上面|上一)/.test(q);
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

    if (result?.type === 'trend') {
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
            answer: "**方法说明**\n\n我还没有拿到上一轮可解释的分析结果。你可以先查询趋势、排名、对比或定点数据，再问“你是怎么分析的”，我会基于上一轮的工具记录说明口径和计算过程。",
            chart: null,
            citations: [],
            reasoning: ['识别为方法追问', '未找到上一轮工具记录'],
            confidence: 0.95,
            suggestions: ['2024年各省普通高校数量排名', '山东省普通高校数量近5年趋势', '江苏和浙江R&D投入对比'],
            toolTrace: []
        };
    }

    let answer = `**${last.title || '上一轮分析'}的方法说明**\n\n`;
    answer += `| 项目 | 说明 |\n|------|------|\n`;
    answer += `| 分析类型 | ${last.methodLabel || '结构化数据分析'} |\n`;
    answer += `\n**具体过程：**\n`;
    answer += `1. 根据用户问题识别地区、年份和指标。\n`;
    answer += `2. 在平台结构化数据中定位对应表和字段。\n`;
    answer += `3. 按查询类型执行趋势、排名、对比或定点取值，并生成可追溯结果。\n\n`;
    answer += `**为什么用这个方法：**${last.methodReason || '该方法与当前数据结构和问题意图匹配。'}`;

    return {
        answer,
        chart: null,
        citations: [`[来源: 会话工具记录/${last.methodLabel || last.type}]`],
        reasoning: ['识别为方法追问', `继承上一轮: ${last.type || 'analysis'}`, `方法: ${last.methodLabel || '结构化分析'}`],
        confidence: 0.96,
        confidenceInterval: last.confidenceInterval || null,
        suggestions: ['查看该指标近5年趋势', '比较江苏和浙江同一指标', '查看最新年份排名'],
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

    // 主题延续检测：追问短句 OR 关键词重叠 → 视为延续
    const lastUserTurn = [...recentHistory].reverse().find(h => h.role === 'user');
    const isContinued = (() => {
        if (!lastUserTurn) return false;
        // ① 短句（≤12字）或以追问词开头/结尾 → 几乎必然是延续
        if (question.length <= 12) return true;
        if (/^(那|换|再|还有|那么|还是|另外)/.test(question)) return true;
        if (/呢[？?]?$/.test(question)) return true;
        // ② 含指代词 → 指向上文
        if (/(这个|该|上面|上述|它的|其中|上一|前面|刚才|之前)/.test(question)) return true;
        // ③ 问题只含地区/年份，未提任何指标 → 指标需从上文继承
        const hasRegion = Object.keys(REGION_MAP).some(r => question.includes(r)) || /全国/.test(question);
        const hasMetric = metricNameList.some(m => question.includes(cleanMetricName(m)));
        if (hasRegion && !hasMetric) return true;
        // ④ 长句做关键词重叠判断
        const prev = String(lastUserTurn.content || '');
        const keywords = (s) => [...s.matchAll(/[一-龥]{2,}/g), ...s.matchAll(/\d{4}/g)].map(m => m[0]);
        const prevKw = new Set(keywords(prev));
        return keywords(question).some(kw => prevKw.has(kw));
    })();

    // 话题不连续时只保留最近2轮（保留基本会话感知但不干扰决策）
    const historySlice = isContinued ? recentHistory.slice(-8) : recentHistory.slice(-2);
    const historyText = historySlice.map(h => {
        const role = h.role === 'user' ? '用户' : '助手';
        const content = String(h.content || '').slice(0, 300);
        return `${role}: ${content}`;
    }).join('\n');

    // 话题不连续时不传上一轮方法摘要（避免错误继承指标/地区）
    const lastMethodText = (isContinued && lastMethod)
        ? `上一轮分析：${lastMethod.type}，指标=${lastMethod.params?.metric || ''}，地区=${lastMethod.params?.region || lastMethod.regions?.[0] || ''}，年份=${lastMethod.params?.year || ''}`
        : '无';

    const prompt = `你是山东财经大学科研教育人才数据平台的智能分析助手。请理解用户问题的真实意图，决定下一步行动。

## 平台真实指标（只能用这些）
${allMetrics}

## 数据覆盖
最新年份：${latestYear}年，覆盖全国、31省份、200+地级市

## 可用工具
- trend_analysis: 查看某指标的历年趋势变化
  参数: {"metric":"指标名","region":"地区或全国","years":[年份数组，近N年]}
- get_ranking: 某年份某指标的省份排名
  参数: {"metric":"指标名","year":年份数字,"order":"desc或asc","topN":数字}
- compare: 两个地区或两个年份的指标对比
  参数: {"metric":"指标名","year":年份,"regionA":"地区A","regionB":"地区B","compareYear":null或年份}
- point_query: 查询某地区某年份某指标的具体数值
  参数: {"metric":"指标名","region":"地区","year":年份数字}
- evidence_chat: 开放式分析、原因解释、建议、评价类问题，也用于多地区（3个以上）对比分析
  参数: {}
- chat: 闲聊、平台介绍、能力说明
  参数: {}

## 决策规则
1. 用户说"换一个地区/换个省份"但没说具体哪里 → action=ask_clarification，clarification="请问您想换哪个省份或地区？"
2. 用户说"换成山东/换广东省"→ 继承上一轮指标和年份，region换成新地区，直接调工具
3. 用户说"那浙江呢/江苏的呢" → 继承上一轮指标，region换成提到的省份
4. 趋势类：含"近N年" → years取近N年的数组；含"历年/所有/全部/多年/所有年份" → years传null表示取全部历史数据；只说"趋势"不带年数 → years传null
5. 含"为什么/原因/怎么看/评价/建议" → evidence_chat
6. 含"华东/华南/华北/多个省/几个省的对比/多地区对比" → 必须用evidence_chat，不能用compare（compare只支持两个地区），同时在regions字段列出所有省份
7. 两个地区对比 → compare工具，regionA和regionB填具体省份全称
8. 参数不完整且无法从上下文推断 → ask_clarification
9. 平台不做预测、预估、未来年份外推。用户要求预测或查询超过最新年份的数据时，不要调用趋势/排名/对比工具，应说明超出数据范围。
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
  "regions": ["如果涉及多个地区，列出所有地区名"],
  "entities": {
    "regions": ["从问题中识别的地区（省份全称或全国）"],
    "metrics": ["从问题中识别的指标名（从可用指标里选，最多2个）"],
    "years": [年份数字数组，如有]
  }
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
function normalizeLLMDecision(decision, lastMethod = null, recentHistory = []) {
    if (!decision || decision.action !== 'call_tool') return null;
    const tool = normalizeToolName(decision.tool || '');
    const allowed = ['get_ranking','compare','point_query','trend_analysis','evidence_chat','chat'];
    if (!allowed.includes(tool)) return null;

    const params = { ...(decision.params || {}) };
    const latestYear = getLatestYear(rawDataCache.province);

    // 规范化年份类型
    if (params.year != null) params.year = parseInt(params.year) || latestYear;
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

    // 补全缺失参数（从上一轮继承，断链时从 history 回溯）
    if (!params.metric && lastMethod?.params?.metric) params.metric = lastMethod.params.metric;
    if (!params.metric) params.metric = inferMetricFromHistory(recentHistory) || metricNameList[0] || '';
    if (!params.region && tool !== 'get_ranking' && tool !== 'compare') {
        params.region = lastMethod?.params?.region || lastMethod?.regions?.[0] || '';
    }
    if (!params.year && tool === 'get_ranking') params.year = latestYear;

    // 规范化地区名（短名 → 全称，与 extractEntities 保持一致）
    const normalizeRegion = r => {
        if (!r || r === '全国') return r;
        if (REGION_MAP[r]) return REGION_MAP[r];
        // 包含匹配：如 "山东省" 已经是全称直接返回
        const provinceList = [...new Set(rawDataCache.province.map(row => row['地区']))];
        if (provinceList.includes(r)) return r;
        // 短名包含匹配
        for (const [short, full] of Object.entries(REGION_MAP)) {
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

    // LLM 返回 years=null 但问题含"近N年" → 强制补算年份数组，防止返回全部历史数据
    if (tool === 'trend_analysis' && (!params.years || !params.years.length)) {
        const orig = decision._originalQuestion || '';
        const matchArabic  = orig.match(/近\s*(\d+)\s*年/);
        const matchChinese = orig.match(/近([一二两三四五六七八九十百]+)年/);
        if (matchArabic || matchChinese) {
            const n = Math.max(2, Math.min(
                matchArabic ? parseInt(matchArabic[1]) : (parseChineseNumber(matchChinese[1]) || 5),
                30
            ));
            params.years = Array.from({ length: n }, (_, i) => latestYear - n + 1 + i);
            console.log(`📅 "近${n}年"补算 years:`, params.years);
        }
    }

    return { tool, params, rationale: decision.rationale || '' };
}

// 全球/非中国地区关键词正则（模块级常量，供 runAgent 多处复用）
const GLOBAL_COUNTRIES_RE = /德国|美国|日本|欧洲|全球|国际|英国|法国|韩国|亚洲|世界|海外|印度|俄罗斯|意大利|加拿大|澳大利亚|新加坡|荷兰|瑞典|芬兰|挪威|丹麦|瑞士|以色列|巴西|墨西哥|阿根廷|西班牙|葡萄牙|波兰|捷克|匈牙利|奥地利|比利时|土耳其|沙特|阿联酋|泰国|越南|马来西亚|印尼|菲律宾|南非|埃及/;

// 知识文档国家过滤用数组（排除泛指词，只保留具体国家）
// 与 knowledge_ingest.py COUNTRY_KEYWORDS 保持同步
const KNOWLEDGE_SPECIFIC_COUNTRIES = [
    '德国','美国','日本','英国','法国','韩国','印度','俄罗斯','意大利','加拿大',
    '澳大利亚','新加坡','荷兰','瑞典','芬兰','挪威','丹麦','瑞士','以色列',
    '巴西','墨西哥','阿根廷','西班牙','葡萄牙','波兰','捷克','匈牙利','奥地利',
    '比利时','土耳其','沙特','阿联酋','泰国','越南','马来西亚','印尼','菲律宾',
    '南非','埃及'
];

/**
 * 短追问扩写："以色列呢" → "以色列的数字经济发展情况"
 * 检测 "X呢/X呢？" 格式，从历史里找上一条实质性问题，把实体替换后重建完整问题。
 * 避免短查询 embedding 语义信号不足导致召回跑偏。
 */
function expandShortFollowup(question, recentHistory) {
    if (!/呢[？?]?\s*$/.test(question) || question.length > 15) return question;
    const entity = question.replace(/呢[？?]?\s*$/, '').trim();
    if (!entity || entity.length < 2) return question;

    // 找历史里最近一条实质性用户问题
    // 允许：不以"呢"结尾 OR 长度>10（复合问题如"法国的数字经济？以色列呢？"）
    const prevQ = [...recentHistory]
        .reverse()
        .find(h => {
            const t = String(h.content || '');
            return h.role === 'user' && t.length > 4
                && (!/呢[？?]?\s*$/.test(t) || t.length > 10);
        });
    if (!prevQ) {
        // 无历史时：国家名 + 通用描述，至少提供基本语义信号
        if (GLOBAL_COUNTRIES_RE.test(entity)) {
            const expanded = `${entity}的发展情况和相关数据`;
            console.log(`🔗 追问扩写（无历史）：「${question}」→「${expanded}」`);
            return expanded;
        }
        return question;
    }
    // 复合问题只取第一个问句作为谓语参考（去掉"以色列呢？"之类的追问尾巴）
    let prevText = String(prevQ.content || '').trim();
    if (/呢[？?]?\s*$/.test(prevText)) {
        prevText = prevText.split(/[？?]/)[0].trim() || prevText;
    }

    // 找上一条问题里的国家/地区实体（用于替换）
    const allCountries = [...KNOWLEDGE_SPECIFIC_COUNTRIES, '中国', '全国', '欧洲', '亚洲', '全球'];
    const prevCountry = allCountries.find(c => prevText.includes(c));

    let expanded;
    if (prevCountry) {
        // 把上一条问题里的国家换成新实体
        expanded = prevText.replace(new RegExp(prevCountry, 'g'), entity);
    } else {
        // 兜底：直接把实体拼到上一条问题前面
        expanded = `${entity}的${prevText.replace(/^.*?[的关于]/, '')}`;
    }
    if (expanded === prevText || expanded === question) return question;
    console.log(`🔗 追问扩写：「${question}」→「${expanded}」`);
    return expanded;
}

/**
 * 主 Agent 循环
 * 架构：LLM决策 → 工具执行 → Corrective RAG → 生成回答
 */
async function runAgent(question, recentHistory = []) {
    let q = question.trim();

    // 历史压缩
    recentHistory = await compressHistoryIfNeeded(
        Array.isArray(recentHistory) ? recentHistory.slice(-MAX_HISTORY * 2) : []
    );

    // 短追问扩写：把"以色列呢"还原成"以色列的数字经济发展情况"再走检索
    q = expandShortFollowup(q, recentHistory);

    const lastMethod = getLastMethodSummary(recentHistory);
    const latestYear = getLatestYear(rawDataCache.province);

    // ── 平台事实类问题：直接从数据源返回，不走LLM ──────
    // 这类问题LLM无法准确回答，必须从真实数据读取

    const metaAnswer = answerMetaQuery(q, recentHistory);
    if (metaAnswer) return metaAnswer;

    const allMetricDetails = answerAllMetricDetails(q, buildMetricDetailEntitiesWithContext(q, recentHistory));
    if (allMetricDetails) return allMetricDetails;

    const correlationAnalysis = answerCorrelationAnalysis(q, extractEntities(q));
    if (correlationAnalysis) return correlationAnalysis;

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
    // 排除上下文引用型问句（"这是哪一年" "刚才那个" 等，应走 LLM + history 回答）
    const isContextRef = /^(这|那|刚才|上面|之前|上一个|它|该).{0,8}(哪|什么|几)/.test(q) || /^(是|在)哪/.test(q);
    if (!isContextRef && /(最新.*年|覆盖.*年|数据.*年份|年份.*数据|最近.*年份|到.*哪年|数据.*到|截止|最新数据|平台.*年|数据.*范围|年份.*范围)/.test(q) && !/(趋势|近\d)/.test(q)) {
        const allYears = [...new Set([...rawDataCache.national, ...rawDataCache.province].map(r => r['年份']).filter(Boolean))].sort();
        const minYear = allYears[0], maxYear = allYears[allYears.length - 1];
        return {
            answer: `平台数据覆盖 **${minYear}–${maxYear}** 年，共 ${allYears.length} 个年份，最新数据为 **${maxYear}** 年。\n\n全国数据：${rawDataCache.national.length} 条\n省份数据：${rawDataCache.province.length} 条\n地级市数据：${rawDataCache.city.length} 条`,
            chart: null, citations: [],
            reasoning: ['意图: 年份覆盖查询', '直接从数据源返回'],
            confidence: 1.0,
            suggestions: [`${maxYear}年各省工业机器人密度排名`, `近10年全国普通高校数量趋势`, `江苏和浙江科学支出水平对比`]
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
            answer: `**平台核心功能：**\n\n| 功能 | 说明 | 示例 |\n|------|------|------|\n| 趋势分析 | 查看指标历年变化 | 近10年工业机器人密度趋势 |\n| 排名 | 省份横向排名 | 2024年各省发明专利前10 |\n| 地区对比 | 两省指标对比 | 江苏和浙江R&D投入对比 |\n| 年度对比 | 同指标不同年份 | 2020和2024年科学支出对比 |\n| 单点查询 | 精确查某年某省值 | 2023年广东普通高校数量 |\n| 开放分析 | 原因/建议/评价 | 为什么广东机器人密度高 |\n\n**数据范围：** ${metricNameList.length} 个指标，覆盖全国+31省份+200+地级市，最新到 **${latestYear}** 年。`,
            chart: null, citations: [],
            reasoning: ['意图: 功能查询', '直接返回平台能力说明'],
            confidence: 1.0,
            suggestions: ['有哪些指标', '覆盖哪些省份', '近10年工业机器人密度趋势', `${latestYear}年各省发明专利排名`]
        };
    }

    // 6. 某指标是否存在 / 有没有XXX数据
    if (/(有没有|能查|支持查询|有.*的数据)/.test(q) && !/(趋势|排名|对比|分析)/.test(q)) {
        const entities = extractEntities(q);
        const metric = entities.metrics[0];
        const region = entities.regions[0];
        if (metric) {
            return {
                answer: `有的，平台包含 **${cleanMetricName(metric)}** 指标，覆盖${region ? `**${region}**及` : ''}全国31个省份，最新到 **${latestYear}** 年。\n\n你可以直接问我：\n- "${region || '广东省'}近10年${cleanMetricName(metric)}趋势"\n- "${latestYear}年各省${cleanMetricName(metric)}排名"\n- "江苏和浙江${cleanMetricName(metric)}对比"`,
                chart: null, citations: [],
                reasoning: ['意图: 指标存在性查询', `命中指标: ${metric}`],
                confidence: 1.0,
                suggestions: [`${region || '全国'}近10年${cleanMetricName(metric)}趋势`, `${latestYear}年各省${cleanMetricName(metric)}排名`, `江苏和浙江${cleanMetricName(metric)}对比`]
            };
        }
    }

    // 7. 打招呼
    const greetings = ['你好','嗨','hello','hi','在吗','早上好','下午好','晚上好','您好'];
    if (greetings.some(g => q.toLowerCase() === g || q.toLowerCase().startsWith(g))) {
        return answerGeneralChat(q, recentHistory);
    }

    // ── 上下文问题压缩（主流RAG做法，替代原硬编码扩展逻辑）──
    if (recentHistory.length > 0) {
        q = await condenseQuestion(q, recentHistory);
    }

    // ── 早期拦截：全球话题 / 报告查询 → 直接走 evidence_chat ──
    // 必须在 llmDecideAction 之前，否则 LLM 可能误路由到结构化数据工具
    const GLOBAL_QUERY_RE = GLOBAL_COUNTRIES_RE;
    const REPORT_QUERY_RE = /报告|白皮书|文献|指数报告|研究报告|调研|发布的|根据.*报|按照.*报|第\d+页/;
    if (GLOBAL_QUERY_RE.test(q) || REPORT_QUERY_RE.test(q)) {
        console.log('🌐 全球话题/报告查询，跳过LLM路由直接走 evidence_chat:', q);
        const entities = await extractEntitiesAsync(q, recentHistory);
        return answerEvidenceChat(q, entities, recentHistory);
    }

    // ── Step 1: LLM 决策 ──────────────────────────────
    const llmDecision = await llmDecideAction(q, recentHistory, lastMethod);

    // LLM 要求追问——先做 ChromaDB 向量探针，有结果则走 evidence_chat，无结果再追问
    if (llmDecision?.action === 'ask_clarification') {
        const clarification = llmDecision.clarification || '请补充更多信息，例如具体地区、年份或指标。';
        // 用向量相似度探测知识文档，不依赖关键词
        const probeEntities = await extractEntitiesAsync(q, recentHistory, llmDecision);
        const probeHits = await retrieveChromaEvidence(q, probeEntities, 3).catch(() => []);
        const hasChromaHit = probeHits.some(d =>
            (d.metadata?.table === 'knowledge' || d.source === 'ChromaDB') && (d.distance == null || d.distance < 0.55)
        );
        // Ollama 不可用时向量探针返回空，改用 BM25 兜底（allDocuments 仅含知识文档，有命中即为知识命中）
        const hasBM25Hit = !hasChromaHit && retrieveBM25Evidence(q, probeEntities, 1).length > 0;
        const hasKnowledgeHit = hasChromaHit || hasBM25Hit;
        if (hasKnowledgeHit) {
            console.log('🔄 ask_clarification 转 evidence_chat（' + (hasChromaHit ? 'ChromaDB 向量' : 'BM25') + '命中）:', q);
            return answerEvidenceChat(q, probeEntities, recentHistory);
        }
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

    // LLM 决定直接聊天——先做 ChromaDB 向量探针，有结果则走 evidence_chat
    if (llmDecision?.action === 'answer_directly' || llmDecision?.tool === 'chat') {
        const probeEntities = await extractEntitiesAsync(q, recentHistory, llmDecision);
        const probeHits = await retrieveChromaEvidence(q, probeEntities, 3).catch(() => []);
        const hasChromaHit = probeHits.some(d =>
            (d.metadata?.table === 'knowledge' || d.source === 'ChromaDB') && (d.distance == null || d.distance < 0.55)
        );
        // Ollama 不可用时向量探针返回空，改用 BM25 兜底
        const hasBM25Hit = !hasChromaHit && retrieveBM25Evidence(q, probeEntities, 1).length > 0;
        const hasKnowledgeHit = hasChromaHit || hasBM25Hit;
        if (hasKnowledgeHit) {
            console.log('🔄 chat 转 evidence_chat（' + (hasChromaHit ? 'ChromaDB 向量' : 'BM25') + '命中）:', q);
            return answerEvidenceChat(q, probeEntities, recentHistory);
        }
        return answerGeneralChat(q, recentHistory);
    }

    // LLM 决定调用 evidence_chat
    if (llmDecision?.tool === 'evidence_chat') {
        // 复用 llmDecision.entities，跳过额外 LLM 提取
        const entities = await extractEntitiesAsync(q, recentHistory, llmDecision);
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
    let toolDecision = normalizeLLMDecision({ ...llmDecision, _originalQuestion: q }, lastMethod, recentHistory);

    // LLM决策失败，降级到规则
    if (!toolDecision) {
        console.warn('⚠️ LLM决策无效，降级到规则');
        const entities = await extractEntitiesAsync(q, recentHistory, null);
        // 补全实体继承
        if (!entities.metrics.length && lastMethod?.params?.metric) {
            entities.metrics = [lastMethod.params.metric];
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
    if (llmDecision?.regions?.length >= 2 && toolDecision.tool === 'compare') {
        toolDecision.params.regionA = llmDecision.regions[0];
        toolDecision.params.regionB = llmDecision.regions[1];
    }

    // ── Step 5: 执行工具 + 并联 ChromaDB 检索（方案B）────────
    // 复用 llmDecision.entities（若有）跳过额外 LLM 调用
    const entities = await extractEntitiesAsync(q, recentHistory, llmDecision);
    const explicitlyNational = /(全国|国家|中国整体|国内整体|全国整体|全国范围|全国层面)/.test(q);
    const inheritedRegion = lastMethod?.params?.region || lastMethod?.regions?.[0] || '';
    if (toolDecision.params?.region === '全国' && !explicitlyNational && inheritedRegion !== '全国') {
        toolDecision.params.region = '';
    }
    if (!toolDecision.params?.region && explicitlyNational && ['trend_analysis', 'point_query'].includes(toolDecision.tool)) {
        toolDecision.params.region = '全国';
    }
    if (toolDecision.tool === 'compare'
        && !explicitlyNational
        && !inheritedRegion
        && (!toolDecision.params?.regionA || !toolDecision.params?.regionB
            || (toolDecision.params.regionA === '全国' && toolDecision.params.regionB === '全国'))) {
        return {
            answer: '请先指定要对比的地区，例如“山东省2020年和2024年科学支出水平对比”，或“江苏省和浙江省R&D投入对比”。',
            citations: [],
            reasoning: ['意图: 需要澄清', '缺失: 对比地区'],
            suggestions: buildClarificationSuggestions(q, lastMethod),
            toolTrace: [{ tool: 'clarification', normalizedTool: 'clarification', params: { missing: 'region' }, success: true, type: 'clarification' }]
        };
    }
    if (['trend_analysis', 'point_query'].includes(toolDecision.tool)
        && !toolDecision.params?.region
        && !entities.regions.length
        && !explicitlyNational
        && !inheritedRegion) {
        return {
            answer: '请先指定要查询的地区，例如“全国”“山东省”或“济南市”。',
            citations: [],
            reasoning: ['意图: 需要澄清', '缺失: 地区'],
            suggestions: buildClarificationSuggestions(q, lastMethod),
            toolTrace: [{ tool: 'clarification', normalizedTool: 'clarification', params: { missing: 'region' }, success: true, type: 'clarification' }]
        };
    }
    const [result, reportEvidence] = await Promise.all([
        executeTool(toolDecision, entities),
        retrieveChromaEvidence(q, entities, 4).catch(() => [])
    ]);

    // ── Step 5.5: 指标找不到 → 给出候选提示，不展示空结果 ──
    const reqMetric = toolDecision.params?.metric;
    // 只有真正字段缺失才触发（年份降级不算缺失）
    const hasNoData = result.success &&
        ((result.type === 'ranking' && (!Array.isArray(result.data) || result.data.length === 0) && !result.data?._yearFallback) ||
         (result.type === 'point'   && result.data.value === undefined) ||
         (result.type === 'trend'   && (!result.data.chartData?.length || result.data.chartData.every(d => !d.value))));

    if (hasNoData && reqMetric) {
        const candidates = findFuzzyMetrics(reqMetric, 0.5).filter(m => m !== reqMetric).slice(0, 3);
        const candidateHint = candidates.length
            ? `\n\n平台中最接近的指标：\n${candidates.map((m, i) => `${i+1}. **${cleanMetricName(m)}**`).join('\n')}\n\n可以告诉我您想查的是哪个？`
            : '\n\n请确认指标名称，或使用"有哪些指标"查看完整列表。';
        return {
            answer: `未找到指标「**${reqMetric}**」的数据。${candidateHint}`,
            citations: [],
            reasoning: [`指标未匹配: ${reqMetric}`, `候选: ${candidates.join('、') || '无'}`],
            suggestions: candidates.length ? candidates.slice(0,2).map(m => `查看 ${cleanMetricName(m)} 数据`) : buildContextualSuggestions(q),
            toolTrace: [{ tool: toolDecision.tool, params: toolDecision.params, success: false }],
            confidence: 0.2
        };
    }

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
        methodSummary,
        reportEvidence
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
        `${latestYear}年各省${cleanMetric}排名`,
        `广东省${cleanMetric}近10年趋势`,
        `山东省${cleanMetric}近10年趋势`,
        `江苏和浙江${cleanMetric}对比`
    ].filter(Boolean).slice(0, 4);
}


// ========== API 路由 ==========
function splitCompoundQuestions(question) {
    const text = String(question || '').trim();
    if (!text) return [];
    if (text.length <= 18) return [text];
    // 长文本且无问号 → 视为单一上下文输入（如粘贴的报告段落），不拆分
    if (text.length > 300 && !/[？?]/.test(text)) return [text];

    const numbered = text
        .replace(/(^|[\n\r。；;！？?])\s*(?:第?\d+\s*[\.、，,)]|[（(]\d+[）)])/g, '$1||')
        .replace(/\s+(?=\d+\s*[\.、，,)]\s*[\u4e00-\u9fa5])/g, '||')
        .replace(/([。；;！？?])\s*(?=\d+\s*[\.、，,)]\s*)/g, '$1||');

    const hardParts = numbered
        .split(/\|\||[\n\r]+|[\uFF1F?;\uFF1B。]+/g)
        .map(s => s.trim())
        .filter(Boolean);
    const baseParts = hardParts.length > 1 ? hardParts : [text];
    const intentPattern = /(排名|前\d+|最高|最低|趋势|走势|变化|对比|比较|比对|vs|多少|是多少|评价|分析|说明|建议|怎么看)/i;
    const splitters = /(?:另外|还有|并且|同时|顺便|再帮我|再看|再查|再分析|以及)/g;
    const result = [];

    for (const part of baseParts) {
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
    // ── dedup：重叠度 > 60% 的 task 视为重复，保留先出现的 ──
    const deduped = [];
    for (const q of cleaned) {
        const isDup = deduped.some(existing => {
            const shorter = q.length < existing.length ? q : existing;
            const longer  = q.length < existing.length ? existing : q;
            // 计算短串在长串中的字符重叠比例
            let overlap = 0;
            for (const ch of shorter) { if (longer.includes(ch)) overlap++; }
            return overlap / Math.max(shorter.length, 1) > 0.6;
        });
        if (!isDup) deduped.push(q);
    }
    return deduped.slice(0, 6);
}

function looksLikeCompoundQuestion(question) {
    const q = String(question || '');
    if (!q.trim()) return false;
    // 长文本（>200字）且无问号 → 粘贴的段落内容，不拆分
    if (q.length > 200 && !/[？?]/.test(q)) return false;
    // 明显的编号列表结构 → 拆分
    if (/(^|[。；;！？?\n\r])\s*(?:第?\d+\s*[\.、，,)]|[（(]\d+[）)])/.test(q)) return true;
    // 显式连接词 → 强信号，直接拆分
    if (/另外|还有|顺便|再帮我|再看|再查|再分析/.test(q)) return true;
    // intent 词命中 ≥ 3（避免"趋势分析"之类的单意图问题触发）
    // 去掉过于泛化的词："分析"、"多少"、"是多少"
    const intentHits = (q.match(/趋势|走势|排名|前\d+|对比|比较|比对|评价/g) || []).length;
    const metricHits = extractEntities(q).metrics.length;
    // 需要 intentHits >= 3，或 intentHits >= 2 且 metricHits >= 2（不同指标不同意图）
    return (intentHits >= 3) || (intentHits >= 2 && metricHits >= 2);
}

async function planCompoundQuestions(question, history = []) {
    // 追问前缀不参与复合问题检测，只取实际问题部分
    const raw = String(question || '').trim();
    const followupMatch = raw.match(/^（追问(?:关于之前的回答：「[\s\S]*?」|上下文：[\s\S]*?)）\n?([\s\S]+)$/);
    const text = followupMatch ? followupMatch[1].trim() : raw;
    const fallback = splitCompoundQuestions(text);
    if (!looksLikeCompoundQuestion(text)) return fallback;

    const metricHints = metricNameList.slice(0, 40).join('、');
    const historyHint = Array.isArray(history)
        ? history.slice(-8).map(h => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.content || '').slice(0, 120)}`).join('\n')
        : '';
    const prompt = `你是科研教育人才数据平台的”问题任务规划器”。请把用户的一次输入拆成可以独立执行的数据分析子任务，只返回严格 JSON。

要求：
1. 不要回答问题，只做任务拆解。
2. 如果是单一指标、单一意图的问题（例如”近5年杰青数量趋势”、”山东AI人才趋势分析”），必须保留为 1 个 task，不得拆分。
3. 如果一句话包含不同意图或不同指标，例如”山东高校数量排名。给我广东机器人密度趋势”，必须拆成多个 task。
4. task.question 必须是用户原意的自然语言短句，不要补造数据，不要合并不同指标。
5. 最多 6 个任务。拿不准时宁可少拆，不可过拆。

可用指标示例：${metricHints}
最近上下文：
${historyHint || '无'}

用户输入：${text}

返回格式：
{"tasks":[{"question":"...","intent":"trend|ranking|compare|point|chat","regions":[],"metric":"","years":[]}]}`

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
    if (isPredictionOrFutureText(question)) {
        return buildUnsupportedPredictionResponse(question);
    }
    const metricDetails = answerAllMetricDetails(question.trim(), buildMetricDetailEntitiesWithContext(question.trim(), history));
    if (metricDetails) return metricDetails;
    const correlationAnalysis = answerCorrelationAnalysis(question.trim(), extractEntities(question.trim()));
    if (correlationAnalysis) return correlationAnalysis;
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
        return `【问题${index + 1}】${item.question}\n\n${item.result.answer || '未生成回答'}`;
    }).join('\n\n' + '─'.repeat(20) + '\n\n');
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
            methodReason: '用户一次输入中包含多个独立意图时，系统先拆成子问题，再逐个调用检索、排名、趋势或对比工具，最后合并为完整回答。',
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
        const result = sanitizeAgentResult(await runAgentBatch(question.trim(), history));
        pushSessionHistory(cleanSessionId, 'user', question.trim());
        pushSessionHistory(cleanSessionId, 'assistant', result.answer, {
            methodSummary: result.methodSummary || null,
            toolTrace: result.toolTrace || [],
            confidenceInterval: result.confidenceInterval || null,
            citations: result.citations || []
        });
        res.json(sanitizeAgentResult(result));
    } catch (err) {
        console.error('Agent 错误:', err);
        res.status(500).json({ error: err.message, answer: '抱歉，出现错误，请稍后再试。', citations: [], reasoning: ['处理异常', err.message] });
    }
});

// ── 流式 SSE 端点 ──────────────────────────────────────────────
app.post('/api/agent/stream', async (req, res) => {
    const { question, sessionId, followupContext } = req.body || {};
    const questionError = validateQuestion(question);
    if (questionError) return res.status(400).json({ error: questionError });
    const cleanSessionId = sanitizeSessionId(sessionId);
    if (!cleanSessionId) return res.status(400).json({ error: 'sessionId格式不合法' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const send = (obj) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // 进度状态事件（在 runAgentBatch 运行期间驱动进度条）
    const steps = ['正在分析问题…', '查找数据中…', '调用数据工具…', '组织回复…'];
    let stepIdx = 0;
    send({ type: 'status', step: stepIdx, text: steps[stepIdx] });
    const statusTimer = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, steps.length - 1);
        send({ type: 'status', step: stepIdx, text: steps[stepIdx] });
    }, 1400);

    try {
        const history = getSessionHistory(cleanSessionId);
        // 若用户追问的是历史某条回答，把该 Q+A 追加到 history 末尾作为临时锚点
        // 这样 expandShortFollowup 能正确理解"那上海呢"指的是哪个话题
        // 追问锚点：直接把原始 Q+A 拼到当前问题前面，确保 LLM 理解指代的是哪条回答
        // 不作为 assistant 消息注入（会被最近的上下文压权重），而是改写 question 本身
        let effectiveQuestion = question.trim();
        if (followupContext && typeof followupContext === 'string') {
            const anchor = followupContext.slice(0, 300);
            effectiveQuestion = `（以下是用户想追问的原始对话：${anchor}）\n\n基于上述对话，用户的新问题是：${effectiveQuestion}`;
        }
        const result = sanitizeAgentResult(await runAgentBatch(effectiveQuestion, history));
        clearInterval(statusTimer);

        // 流式推送答案文字（4字一批，10ms 间隔 ≈ 400字/秒，视觉流畅）
        const answer = String(result.answer || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const chunks = answer.match(/[\s\S]{1,4}/g) || [];
        for (const chunk of chunks) {
            send({ type: 'token', text: chunk });
            await new Promise(r => setTimeout(r, 8));
        }

        // 推送元数据（reasoning/citations/suggestions/chart 等）
        send({
            type: 'done',
            reasoning:    result.reasoning    || [],
            citations:    result.citations    || [],
            suggestions:  result.suggestions  || [],
            toolTrace:    result.toolTrace    || [],
            chart:        result.chart        || null,
            hasData:      !!result.data,
            confidence:   result.confidence   || null,
            wantsTable:   result.wantsTable   || false,
            wantsScatter: result.wantsScatter || false,
            tableSheet:   result.tableSheet   || null,
            methodSummary: result.methodSummary || null,
            confidenceInterval: result.confidenceInterval || null
        });

        pushSessionHistory(cleanSessionId, 'user', question.trim());
        pushSessionHistory(cleanSessionId, 'assistant', result.answer, {
            methodSummary: result.methodSummary || null,
            toolTrace: result.toolTrace || [],
            confidenceInterval: result.confidenceInterval || null,
            citations: result.citations || []
        });
    } catch (err) {
        clearInterval(statusTimer);
        console.error('Stream Agent 错误:', err);
        send({ type: 'error', text: err.message || '生成失败，请重试' });
    } finally {
        if (!res.writableEnded) res.end();
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
        console.error('[/api/scatter 500]', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== BM25 & ChromaDB ==========
async function buildBM25Index() {
    if (!collection) return;
    try {
        // 只索引知识文档（table=knowledge），避免把 51476 条结构化数据也拉进来
        const BATCH = 200;
        let docs = [], offset = 0;
        while (true) {
            const batch = await collection.get({
                where: { table: { '$eq': 'knowledge' } },
                limit: BATCH,
                offset,
                include: ['documents']
            });
            if (!batch.documents?.length) break;
            docs.push(...batch.documents);
            offset += batch.documents.length;
            if (batch.documents.length < BATCH) break;
        }

        if (!docs.length) {
            console.log('⚠️ BM25：知识文档为空，跳过索引构建');
            return;
        }
        bm25Index = new FlexSearch.Index({ tokenize: 'full' });
        docs.forEach((doc, idx) => { bm25Index.add(idx, doc); });
        allDocuments = docs;
        console.log(`✅ BM25 索引构建完成 (${docs.length} 条知识文档)`);
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
