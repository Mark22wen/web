const FlexSearch = require('flexsearch');
const express = require('express');
const cors = require('cors');
const { ChromaClient } = require('chromadb');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const ss = require('simple-statistics');


const app = express();
const PORT = 3001;

// ========== 全局变量 ==========
let collection = null;
let bm25Index = null;
let allDocuments = [];
let rawDataCache = { national: [], province: [], city: [] };
let metricNameList = [];
let conversationHistory = [];
const MAX_HISTORY = 6;

// 指标名映射（口语化 → 实际字段名）
const METRIC_ALIAS_MAP = {
    '专利申请数': '实用新型专利申请授权数',
    '专利授权数': '实用新型专利申请授权数',
    '发明专利授权数': '发明专利授予数',
    '发明授权': '发明专利授予数',
    '工业机器人': '工业机器人密度',
    '科学支出': '科学支出水平',
    '人工智能': '人工智能应用水平',
    '互联网普及': '互联网普及度',
    '高校数量': '普通高校数量',
    '专任教师比': '普通高校专任教师数与在校学生数之比',
    '公共图书馆藏书': '每百人公共图书馆藏书',
    '教育支出': '教育支出水平',
    '受教育年限': '人均受教育年限',
    '大学生数': '万人大学生数',
    '人才引入': '人才引入强度',
    '人才新政': '是否实施了人才新政',
};

app.use(cors());
app.use(express.json());
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

async function getEmbedding(text) {
    const response = await axios.post('http://localhost:11434/api/embeddings', {
        model: 'nomic-embed-text',
        prompt: text
    });
    return response.data.embedding;
}

// 同步生成（非流式，用于内部调用）
async function generateSync(prompt) {
    const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'deepseek-r1:1.5b',
            prompt: prompt,
            stream: false
        })
    });
    const data = await response.json();
    return data.response;
}

// 流式生成
async function generateStream(prompt, res) {
    const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'deepseek-r1:7b',
            prompt: prompt,
            stream: true
        })
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.trim() === '') continue;
            try {
                const json = JSON.parse(line);
                if (json.response) {
                    fullAnswer += json.response;
                    res.write(json.response);
                }
            } catch (e) {}
        }
    }
    res.end();
    return fullAnswer;
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
            const val = sampleRow[key];
            return typeof val === 'number';
        });
        console.log(`📊 共加载 ${metricNameList.length} 个指标。`);
    }
    console.log(`📊 数据缓存完成: 全国 ${rawDataCache.national.length} 条, 省份 ${rawDataCache.province.length} 条, 地级市 ${rawDataCache.city.length} 条。`);
}

// ========== 结构化排名查询（模糊匹配字段） ==========
function getRanking(metric, year, order = 'desc', topN = 5, table = 'province') {
    let rows = [];
    if (table === 'national') rows = rawDataCache.national;
    else if (table === 'city') rows = rawDataCache.city;
    else rows = rawDataCache.province;
    if (!rows.length) return [];
    
    // 模糊匹配真实字段名
    const sampleRow = rows[0];
    const realKey = Object.keys(sampleRow).find(key => {
        if (key === '年份' || key === '地区') return false;
        const cleanKey = cleanMetricName(key);
        const cleanMetric = cleanMetricName(metric);
        return key === metric || cleanKey === cleanMetric || key.includes(metric) || metric.includes(key);
    });
    if (!realKey) {
        console.warn(`未找到指标 ${metric} 对应的字段`);
        return [];
    }
    const yearData = rows.filter(row => row['年份'] === year);
    const valid = yearData.map(row => ({
        region: table === 'national' ? '全国' : (row['地区'] || row['城市'] || '未知'),
        value: row[realKey]
    })).filter(item => typeof item.value === 'number' && !isNaN(item.value));
    valid.sort((a, b) => order === 'desc' ? b.value - a.value : a.value - b.value);
    return valid.slice(0, topN);
}

// ========== 预测功能 ==========
// 二次指数平滑（Holt's Linear Trend）
function holtLinearForecast(data, targetYear, alpha = 0.5, beta = 0.5) {
    if (data.length < 2) return null;
    let level = data[0].value;
    let trend = data[1].value - data[0].value;
    for (let i = 1; i < data.length; i++) {
        const prevLevel = level;
        level = alpha * data[i].value + (1 - alpha) * (level + trend);
        trend = beta * (level - prevLevel) + (1 - beta) * trend;
    }
    const steps = targetYear - data[data.length - 1].year;
    if (steps <= 0) return data[data.length - 1].value;
    return level + steps * trend;
}

function getHistoricalData(metric, region, yearsBack = 10) {
    if (!rawDataCache.province) return [];
    const rows = rawDataCache.province.filter(row => 
        row['地区'] === region && 
        row[metric] !== undefined && 
        typeof row[metric] === 'number'
    );
    rows.sort((a,b) => a['年份'] - b['年份']);
    if (yearsBack && rows.length > yearsBack) {
        return rows.slice(-yearsBack).map(row => ({ year: row['年份'], value: row[metric] }));
    }
    return rows.map(row => ({ year: row['年份'], value: row[metric] }));
}

// ========== 提取指标、年份、表名 ==========
function extractMetricAndYear(question) {
    let table = 'province';
    if (/全国|国家|整体/.test(question)) table = 'national';
    else if (/地级市|城市|市级/.test(question)) table = 'city';
    
    let matchedMetric = null;
    for (const metric of metricNameList) {
        const cleanMetric = cleanMetricName(metric);
        if (question.includes(metric) || question.includes(cleanMetric)) {
            matchedMetric = metric;
            break;
        }
    }
    if (!matchedMetric) return null;
    
    const yearMatch = question.match(/20\d{2}/);
    const year = yearMatch ? parseInt(yearMatch[0]) : 2023;
    
    // 提取地区：省份或城市
    let region = null;
    if (table === 'province') {
        // 匹配省份名称（可从 allRegionList 或正则）
        const provinceMatch = question.match(/(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆)/);
        if (provinceMatch) region = provinceMatch[1] + '省'; // 简单补全省字，实际要匹配原样
    } else if (table === 'city') {
        const cityMatch = question.match(/([^，,、]+市)/);
        if (cityMatch) region = cityMatch[1];
    }
    
    return { metric: matchedMetric, year, table, region };
}

// ========== 闲聊检测 ==========
function isChitchat(question) {
    const yearMatch = question.match(/20\d{2}/);
    const hasYear = !!yearMatch;
    const hasRegion = /省|市|区|县|北京|上海|广东|浙江|江苏|山东|四川|湖北|湖南|安徽|福建|河南|河北|天津|重庆|辽宁|吉林|黑龙江|内蒙古|新疆|西藏|宁夏|广西|甘肃|陕西|云南|贵州|海南|青海|江西|山西|台湾|香港|澳门/.test(question);
    let hasMetric = false;
    for (const metric of metricNameList) {
        if (question.includes(metric) || question.includes(cleanMetricName(metric))) {
            hasMetric = true;
            break;
        }
    }
   const noDataEntities = !hasYear && !hasRegion && !hasMetric;
    
    // 额外增加：常见问候短语（即使包含数据特征，也强制视为闲聊，但通常不包含）
    const greetingPhrases = ['介绍一下你自己', '你是谁', '你能做什么', '你叫什么', '你好', '嗨', 'hello', 'hi'];
    const isGreeting = greetingPhrases.some(phrase => question.includes(phrase));
    
    // 保留原有逻辑，但如果是问候语且原判断为 false？实际上问候语不会有数据特征，所以不会冲突。
    // 但为了兼容性，如果原逻辑已判定为 true 则直接返回 true，否则若为问候语也返回 true。
    return noDataEntities || isGreeting;
}

// ========== 意图识别 ==========
const INTENT_PATTERNS = {
    rank: /(最高|最大|最低|最小|排名|第[一二三四五六七八九十\d]+|排第|前[一二三四五\d]+)/,
    compare: /(比|对比|vs|比较|和|与).*(和|与|vs|比)/,
    trend: /(趋势|变化|增长|下降|走势|逐年|历年来)/,
};

function detectIntent(question) {
    for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
        if (pattern.test(question)) return intent;
    }
    return 'point';
}

// ========== 指标名规范化（口语化 -> 实际字段名） ==========
function normalizeMetrics(question) {
    let normalized = question;
    for (const [alias, real] of Object.entries(METRIC_ALIAS_MAP)) {
        const regex = new RegExp(`\\b${alias}\\b`, 'g');
        if (regex.test(normalized)) {
            normalized = normalized.replace(regex, real);
        }
    }
    return normalized;
}

// ========== RRF 融合 ==========
function reciprocalRankFusion(results, k = 60) {
    const scores = new Map();
    for (const list of results) {
        list.forEach((doc, idx) => {
            const score = 1 / (k + idx + 1);
            scores.set(doc, (scores.get(doc) || 0) + score);
        });
    }
    return Array.from(scores.entries()).sort((a,b) => b[1] - a[1]).map(([doc]) => doc);
}


// ========== BM25 索引构建 ==========
async function buildBM25Index() {
    if (!collection) return;
    const count = await collection.count();
    if (count === 0) return;
    const allData = await collection.get();
    const docs = allData.documents;
    if (!docs || docs.length === 0) return;
    bm25Index = new FlexSearch.Index({ tokenize: 'full', context: true });
    docs.forEach((doc, idx) => { bm25Index.add(idx, doc); });
    allDocuments = docs;
    console.log(`✅ BM25 索引构建完成，共 ${docs.length} 条文档。`);
}

// ========== 向量库初始化 ==========
async function initVectorStore() {
    const chroma = new ChromaClient({ path: "http://localhost:8000" });
    collection = await chroma.getOrCreateCollection({ name: "patent_knowledge" });
    const count = await collection.count();
    if (count > 0) {
        console.log(`✅ 知识库已存在，包含 ${count} 条数据。`);
        await buildBM25Index();
        return;
    }
    console.log("⚠️ 未找到向量库，请确保已运行过构建脚本。");
}

// ========== 对话历史压缩 ==========
async function compressHistory(history, maxRounds = 4) {
    if (history.length <= maxRounds * 2) return history.map(t => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n');
    const recent = history.slice(-maxRounds * 2);
    const prompt = `将以下对话压缩为一句话摘要（保留关键信息）：\n${recent.map(t => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n')}\n摘要：`;
    try {
        return await generateSync(prompt);
    } catch(e) {
        return recent.map(t => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n');
    }
}

// ========== 查询改写 ==========
async function rewriteQuery(question) {
    const prompt = `将以下用户问题改写成更清晰、更完整的查询语句，保留所有关键信息（年份、地区、指标名称）。只输出改写后的句子。\n原问题：${question}\n改写后：`;
    const rewritten = await generateSync(prompt);
    return rewritten.trim();
}

// ========== 指代消解 ==========
async function resolveCoreference(question, history) {
    if (history.length < 2) return question;
    const lastUser = history.filter(t => t.role === 'user').slice(-1)[0]?.content;
    if (!lastUser) return question;
    const prompt = `上一轮用户问：“${lastUser}”。当前用户问：“${question}”。如果当前问题中存在指代（如“它”、“那个”、“江苏”省略了指标），请补全为完整问题。只输出补全后的问题。\n补全后：`;
    const resolved = await generateSync(prompt);
    return resolved || question;
}
function checkCompleteness(question) {
    const hasMetric = metricNameList.some(m => question.includes(m));
    const hasRegion = /省份|省|市|全国/.test(question);
    const hasYear = /20\d{2}/.test(question);
    const missing = [];
    if (!hasMetric) missing.push('指标（如科学支出水平、工业机器人密度等）');
    if (!hasRegion) missing.push('地区（如山东省、全国）');
    if (!hasYear) missing.push('年份（如2025）');
    return missing;
}


// ========== 主动澄清 ==========
async function askClarification(question) {
    const prompt = `用户问题：“${question}”。该问题缺少明确的指标名称或年份。请生成一句友好的反问，引导用户补充指标、年份或地区。只输出反问句。`;
    return await generateSync(prompt);
}

// ========== RAG 主函数 ==========
async function queryRAGStream(question, res) {
    if (!collection) throw new Error("知识库未初始化");

    // 1. 指代消解
    let resolvedQuestion = await resolveCoreference(question, conversationHistory);
    console.log(`指代消解: ${question} -> ${resolvedQuestion}`);
    
    // 2. 指标名规范化（口语化映射到实际字段）
    let normalizedQuestion = normalizeMetrics(resolvedQuestion);
    if (normalizedQuestion !== resolvedQuestion) {
        console.log(`指标规范化: ${resolvedQuestion} -> ${normalizedQuestion}`);
        resolvedQuestion = normalizedQuestion;
    }
    
   if (isChitchat(resolvedQuestion)) {
    const lower = resolvedQuestion.toLowerCase();
    // 询问身份或能力
    if (lower.includes('介绍你自己') || lower.includes('你是谁') || lower.includes('你能做什么') || 
        lower.includes('你能干什么') || lower.includes('你有什么功能') || lower.includes('举个例子')) {
        
        const introduction = `您好！我是科研教育人才一体化平台的智能问答助手。以下是我的能力范围：

1. 数据查询：查询特定年份、地区的指标数据（如专利授权数、教育支出等）。
2. 数据分析：提供排名、对比、趋势分析（例如最高/最低省份、多指标对比）。
3. 数据可视化：支持折线图、柱状图、饼图等图表展示。
4. 智能问答：基于RAG技术，结合本地数据回答复杂问题。
5. 预测与统计：基于历史数据进行趋势预测和简单统计。
6. 多轮对话：可以记住上下文进行连续问答。

如果您有任何数据问题或分析需求，请随时告诉我！`;
        await generateStream(introduction, res);
        return;
    }
    // 其他闲聊（如“你好”、“谢谢”等）保持原有通用回复
    const prompt = `你是科研教育人才数据分析助手。用户说：“${resolvedQuestion}”。请礼貌简短回复，引导用户提出数据问题。不要编造故事。【回答要求】：
1. 回答末尾必须附带【数据来源】和【得出方法】。
2. 数据来源：指明使用了哪个片段中的哪条数据（例如“来自省份表2023年广东省数据”）。
3. 得出方法：说明你是如何得到这个答案的（例如“直接查询”、“基于二次指数平滑法预测得到”、“排名计算”、“对比分析”等）。`;
    await generateStream(prompt, res);
    return;
}
    
    // 4. 意图识别
    const intent = detectIntent(resolvedQuestion);
    console.log(`意图识别: ${intent}`);

if (/(预测|预计|未来|趋势|预估)/.test(resolvedQuestion)) {
    // 从当前问题提取实体
    let extracted = extractMetricAndYear(resolvedQuestion);
    let hasMetric = extracted && extracted.metric;
    let hasRegion = extracted && extracted.region;
    let hasYear = extracted && extracted.year;
    
    // 从历史对话中补全缺失信息（关键修复）
    if ((!hasMetric || !hasRegion) && conversationHistory.length > 0) {
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
            const msg = conversationHistory[i];
            if (msg.role === 'user') {
                const histExtracted = extractMetricAndYear(msg.content);
                if (histExtracted) {
                    if (!hasMetric && histExtracted.metric) {
                        hasMetric = true;
                        extracted = extracted || {};
                        extracted.metric = histExtracted.metric;
                        console.log(`✅ 从历史补全指标: ${extracted.metric}`);
                    }
                    if (!hasRegion && histExtracted.region) {
                        hasRegion = true;
                        extracted = extracted || {};
                        extracted.region = histExtracted.region;
                        console.log(`✅ 从历史补全地区: ${extracted.region}`);
                    }
                }
                if (hasMetric && hasRegion) break;
            }
        }
    }
    
    // 缺少年份时默认明年
    if (!hasYear) {
        hasYear = true;
        extracted = extracted || {};
        extracted.year = new Date().getFullYear() + 1;
    }
    
    // 仍然缺少关键信息时反问
    if (!hasMetric) {
        res.write("请指定要预测的指标，例如：科学支出水平、工业机器人密度等。");
        res.end();
        return;
    }
    if (!hasRegion) {
        res.write("请指定要预测的地区，例如：山东省、广东省、全国等。");
        res.end();
        return;
    }
    
    // 执行预测
    const history = getHistoricalData(extracted.metric, extracted.region, 10);
    if (history.length >= 2) {
        const forecasts = holtLinearForecast(history, 1);
        if (forecasts && forecasts.length) {
            const answer = `基于${history[0].year}-${history[history.length-1].year}年数据，预测${extracted.year}年${extracted.region}的${extracted.metric}为 ${forecasts[0].toFixed(6)}。`;
            res.write(answer);
            res.end();
            return;
        }
    }
    res.write(`历史数据不足（${history.length}年），无法预测。`);
    res.end();
    return;
}
    if (intent === 'rank' || intent === 'compare') {
        const extracted = extractMetricAndYear(resolvedQuestion);
        if (extracted) {
            let order = 'desc';
            if (/(最低|最小|最少|最差|最后|末尾|最低的)/.test(resolvedQuestion)) order = 'asc';
            let topN = 5;
            const topMatch = resolvedQuestion.match(/前([一二三四五六七八九十\d]+)/);
            if (topMatch) {
                const chnNum = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
                topN = chnNum[topMatch[1]] || parseInt(topMatch[1]) || 5;
            } else {
                const numMatch = resolvedQuestion.match(/(\d+)个/);
                if (numMatch) topN = parseInt(numMatch[1]);
            }
            const rankResult = getRanking(extracted.metric, extracted.year, order, topN, extracted.table);
            if (rankResult.length > 0) {
                const tableName = { national:'全国', province:'省份', city:'地级市' }[extracted.table];
                const rankDesc = order === 'desc' ? '最高' : '最低';
                let answer = `${extracted.year}年 ${tableName} ${extracted.metric} ${rankDesc}前 ${rankResult.length}：\n`;
                answer += `| 排名 | 地区 | 数值 |\n|------|------|------|\n`;
                rankResult.forEach((item, idx) => {
                    answer += `| ${idx+1} | ${item.region} | ${item.value} |\n`;
                });
                res.write(answer);
                res.end();
                return;
            }
        }
    }
    
    // 6. 查询改写（提升召回）
    let searchQuery = resolvedQuestion;
    if (!/(最高|最低|排名|对比)/.test(resolvedQuestion) && resolvedQuestion.length > 10) {
        const rewritten = await rewriteQuery(resolvedQuestion);
        if (rewritten && rewritten !== resolvedQuestion) {
            console.log(`查询改写: ${resolvedQuestion} -> ${rewritten}`);
            searchQuery = rewritten;
        }
    }
    
    // 7. 混合检索 + RRF融合 + 可选重排序
    const queryEmbedding = await getEmbedding(searchQuery);
    const vectorResults = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: 10
    });
    let bm25Results = [];
    if (bm25Index && allDocuments.length) {
        const bm25Ids = bm25Index.search(searchQuery, 10);
        bm25Results = bm25Ids.map(id => allDocuments[id]).filter(doc => doc);
    }
    let fused = reciprocalRankFusion([vectorResults.documents[0], bm25Results]);
        fused = fused.slice(0, 3);
    const context = fused.join('\n\n');
    
    // 8. 主动澄清
    if (!context || context.trim().length < 20) {
        const clarification = await askClarification(resolvedQuestion);
        res.write(clarification);
        res.end();
        return;
    }
    
    // 9. 历史压缩
    const historyText = await compressHistory(conversationHistory, 4);
    
    // 10. 构造提示词
    let prompt = '';
    if (intent === 'compare') {
        prompt = `你是一位数据分析专家。请根据【数据片段】回答对比问题。如果数据不足，请明确说明。回答末尾请标注信息来源。

【数据片段】：
${context}

【对话历史】：
${historyText || "无"}
注意：如果当前问题依赖于历史对话中的信息（例如“它”、“那个”指代之前的实体），请结合历史理解。如果问题与历史无关，忽略历史。

【用户问题】：
${resolvedQuestion}

【回答】：`;
    } else {
        prompt = `你是一位严谨的数据分析与科普助手。请基于【数据片段】回答问题。如果没有相关信息，请说“找不到”。回答末尾请标注信息来源。

【数据片段】：
${context}

【对话历史】：
${historyText || "无"}

【用户问题】：
${resolvedQuestion}

【回答】：`;
    }
    
    // 11. 流式生成
    const fullAnswer = await generateStream(prompt, res);
    conversationHistory.push({ role: 'user', content: resolvedQuestion });
    conversationHistory.push({ role: 'assistant', content: fullAnswer });
    if (conversationHistory.length > MAX_HISTORY * 2) conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
}

// ========== API 路由 ==========
app.post('/api/chat', async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "请提供问题" });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    try {
        await queryRAGStream(question, res);
    } catch (err) {
        console.error(err);
        res.status(500).write("服务器错误");
        res.end();
    }
});

app.post('/api/clear_history', (req, res) => {
    conversationHistory = [];
    res.json({ status: "历史已清空" });
});


// ====================  散点图接口 ====================
app.post('/api/scatter', (req, res) => {
    try {
        const { year, xMetric, yMetric, regions } = req.body;
        const yearData = rawDataCache.province.filter(r => r['年份'] === year);
        const data = regions.map(region => {
            const row = yearData.find(r => r['地区'] === region);
            if (!row) return null;
            return [row[xMetric] ?? 0, row[yMetric] ?? 0, region];
        }).filter(v => v);
        res.json({ data, xName: xMetric, yName: yMetric });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ========== 启动服务器 ==========
app.listen(PORT, async () => {
    console.log(`🚀 服务已启动，访问 http://localhost:${PORT}`);
    await loadDataCache();
    await initVectorStore();
    console.log("✅ 服务就绪，等待提问...");
});