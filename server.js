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

function formatValue(val) {
    if (val === undefined || val === null) return '无数据';
    if (Number.isInteger(val)) return val.toString();
    return parseFloat(val.toFixed(4)).toString();
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
    const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-r1:7b', prompt, stream: false })
    });
    const data = await response.json();
    return data.response || '';
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
    const realKey = findRealKey(rawDataCache.province, metric) || metric;
    const rows = rawDataCache.province.filter(r =>
        r['地区'] === region && typeof r[realKey] === 'number'
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

// ========== 实体提取 ==========
function extractEntities(question) {
    const entities = { regions: [], metrics: [], years: [] };
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
    const years = question.match(/20\d{2}/g);
    if (years) entities.years = [...new Set(years.map(y => parseInt(y)))];
    return entities;
}

function inferMetric(text) {
    if (text.includes('机器人')) return metricNameList.find(m => m.includes('机器人')) || '工业机器人密度';
    if (text.includes('科学') || text.includes('支出')) return metricNameList.find(m => m.includes('科学')) || '科学支出水平';
    if (text.includes('专利')) return metricNameList.find(m => m.includes('专利')) || '实用新型专利申请授权数';
    if (text.includes('互联网') || text.includes('普及')) return metricNameList.find(m => m.includes('互联网')) || '互联网普及度';
    if (text.includes('高校') || text.includes('大学')) return metricNameList.find(m => m.includes('高校')) || '普通高校数量';
    if (text.includes('R&D') || text.includes('研发')) return metricNameList.find(m => m.includes('R&D') || m.includes('研发')) || 'R&D经费投入强度';
    return metricNameList[0] || '科学支出水平';
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
        return { tool: 'forecast', params: { metric, region: region || '广东省', targetYear } };
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
    const prompt = `你是数据分析助手。用户问题: "${question}"
已识别实体: ${JSON.stringify(entities)}

可用工具（只能选一个）：
1. get_ranking  参数: metric, year, order("desc"/"asc"), topN(数字)
2. compare      参数: metric, year, regionA, regionB, compareYear(可选)
3. forecast     参数: metric, region, targetYear
4. point_query  参数: metric, region, year
5. trend_analysis 参数: metric, region(没有省份填null), years(年份数组)

只返回JSON，不要任何解释：
{"tool":"工具名","params":{...}}`;

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
    const { tool, params } = decision;
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
            const region      = params.region || entities.regions[0] || '广东省';
            const targetYear  = params.targetYear || (getLatestYear(rawDataCache.province) + 2);
            const histData    = getHistoricalData(metric, region);
            return { success: true, type: 'forecast', data: { region, metric, year: targetYear, forecastValue: holtLinearForecast(histData, targetYear), history: histData } };
        }

        // ---- point_query ----
        if (tool === 'point_query') {
            const metric  = params.metric || entities.metrics[0] || metricNameList[0];
            const region  = params.region || entities.regions[0] || '广东省';
            const rows    = rawDataCache.province;
            const year    = params.year   || entities.years[0]   || getLatestYear(rows);
            const realKey = findRealKey(rows, metric) || metric;
            const row     = rows.find(r => r['年份'] === year && r['地区'] === region);
            return { success: true, type: 'point', data: { region, metric, year, value: row ? row[realKey] : undefined } };
        }

        // ---- trend_analysis ----
        if (tool === 'trend_analysis') {
            const metric = params.metric || entities.metrics[0] || metricNameList[0];
            
            // 无指定地区且有全国数据 → 优先用全国表
            if (entities._defaultNational && rawDataCache.national && rawDataCache.national.length) {
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
        const { region, metric, year, forecastValue, history } = result.data;
        if (!forecastValue) {
            answer = `⚠️ ${region}的${metric}历史数据不足（${history.length}条），无法预测。`;
            history.slice(-3).forEach(h => { answer += `\n- ${h.year}年: ${formatValue(h.value)}`; });
        } else {
            const last = history[history.length-1];
            answer = `**${metric} 预测结果**\n\n| 项目 | 数值 |\n|------|------|\n`;
            answer += `| 预测地区 | ${region} |\n| 预测年份 | ${year} |\n`;
            answer += `| 预测值 | **${formatValue(forecastValue)}** |\n`;
            answer += `| 趋势 | ${forecastValue > last.value ? '↑ 上升' : '↓ 下降'} |\n`;
            answer += `| 置信度 | 中等（${history.length}年数据） |\n\n**历史参考：**\n`;
            history.slice(-5).forEach(h => { answer += `- ${h.year}年: ${formatValue(h.value)}\n`; });
            citations.push(`[来源: 预测模型/Holt/${history.length}年数据]`);
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

// ========== Agent 主流程 ==========
async function runAgent(question) {
    const q = question.trim();
    // Inject recent conversation into decision context for follow-up awareness
    const greetings = ['你好','嗨','hello','hi','在吗','早上好','下午好'];
    if (greetings.some(g => q.toLowerCase().includes(g))) {
        return { answer: "你好！👋 我是智能分析助手。\n\n可以帮你：\n1. 📊 **数据查询** - 各地区年份指标\n2. 🏆 **排名分析** - 省份排名\n3. 📈 **趋势分析** - 多年走势\n4. ⚖️ **对比分析** - 地区/年度对比\n5. 🔮 **预测** - 基于历史预测\n\n例如：「近5年广东工业机器人密度趋势」", chart: null, citations: [], reasoning: ['用户问候'], confidence: 1.0 };
    }
    if (/(你能做什么|功能|帮助|help)/.test(q)) {
        return { answer: "**核心能力**\n\n| 功能 | 示例 |\n|------|------|\n| 数据查询 | 2023年广东科学支出水平 |\n| 排名 | 2023年各省工业机器人密度前10 |\n| 趋势 | 广东近5年专利数量变化 |\n| 对比 | 江苏和浙江互联网普及度对比 |\n| 年度对比 | 2022和2023年R&D投入对比 |\n| 预测 | 预测2026年北京高校数量 |", chart: null, citations: [], reasoning: ['用户询问功能'], confidence: 1.0 };
    }

    const entities = extractEntities(q);
    
    // ---- 上下文继承逻辑 ----
    const recentHistory = conversationHistory.slice(-6);
    
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
        const explicitRegionFollow = /那|换|改|换成|改成|改为|的话/.test(q);
        
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

    const decision = await agentDecide(q, entities);
    const result   = await executeTool(decision, entities);
    const { text: answer, citations } = await generateAnswer(result, q, result.type);

    const reasoning = [
        `意图: ${decision.tool}`,
        `指标: ${entities.metrics[0] || decision.params?.metric || '默认'}`,
        `地区: ${entities.regions[0] || decision.params?.region || '默认'}`,
        `年份: ${entities.years[0] || '默认'}`,
        `数据: ${result.success ? '✅' : '❌'}`
    ];

    let chart = null;
    if (result.type === 'trend' && result.data.years && result.data.years.length) {
        chart = { type: 'line', metric: result.data.metric, regions: [result.data.region], years: result.data.years, title: `${result.data.region} ${result.data.metric} 趋势图` };
    } else if (result.type === 'ranking' && result.data.length > 0) {
        const rankYear = result.data[0]?.year || entities.years[0] || getLatestYear(rawDataCache.province);
        chart = { type: 'bar', metric: decision.params?.metric || entities.metrics[0] || '', regions: result.data.map(d => d.region), years: [rankYear], title: `${rankYear}年 ${decision.params?.metric || ''} 排名` };
    }

    return { answer, chart, citations, reasoning, confidence: result.success ? 0.9 : 0.5 };
}

// ========== API 路由 ==========
app.post('/api/agent', async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: '请提供问题' });
    try {
        const result = await runAgent(question);
        conversationHistory.push({ role: 'user', content: question });
        conversationHistory.push({ role: 'assistant', content: result.answer.substring(0, 500) }); // trim for memory
        if (conversationHistory.length > MAX_HISTORY * 2) conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
        res.json(result);
    } catch (err) {
        console.error('Agent 错误:', err);
        res.status(500).json({ error: err.message, answer: '抱歉，出现错误，请稍后再试。', citations: [], reasoning: ['处理异常', err.message] });
    }
});

app.post('/api/clear_history', (req, res) => {
    conversationHistory = [];
    res.json({ ok: true });
});

app.post('/api/scatter', async (req, res) => {
    try {
        const { year, xMetric, yMetric, regions } = req.body;
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
    await initVectorStore();
    console.log('✅ 就绪，等待提问...');
});