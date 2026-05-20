// ======================= 工具函数 =======================
// ======================= 工具函数 =======================
function log(...args) {
    console.log("[Platform]", ...args);
}
function findColumn(row, possibleNames) {
    if (!row) return null;
    for (let name of possibleNames) {
        const lowerName = name.toLowerCase();
        for (let key in row) {
            if (key.toLowerCase() === lowerName) return key;
        }
    }
    return null;
}
function formatMissingList(list, maxShow = 3) {
    if (!list.length) return "";
    if (list.length <= maxShow) return list.join("、");
    return list.slice(0, maxShow).join("、") + `等${list.length}省`;
}
function getUnit(metric) {
    const match = metric.match(/[（(]\s*([^）)]+)\s*[）)]/);
    if (match && match[1]) return match[1].trim();
    return "";
}
function formatValue(val) {
    if (val === undefined || val === null) return "无数据";
    if (Number.isInteger(val)) return val.toString();
    return parseFloat(val.toFixed(4)).toString();
}
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// 聊天发送按钮
// ========== 聊天功能（对话式） ==========
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatStop = document.getElementById('chat-stop');

let currentController = null;

// 添加一条消息到聊天区域
function addMessage(role, content, isStreaming = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    messageDiv.innerHTML = `<div class="message-role">${role === 'user' ? '👤 你' : '🤖 助手'}</div><div class="message-content">${content}</div>`;
    chatMessages.appendChild(messageDiv);
    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    if (isStreaming) {
        // 如果是流式消息，返回一个更新函数
        return (newContent) => {
            const contentDiv = messageDiv.querySelector('.message-content');
            contentDiv.innerHTML = formatAnswer(newContent);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        };
    }
    return null;
}

// ========== Agent 图表渲染函数（放在外部，全局可用） ==========
let agentModalChart = null;

function renderAgentChart(config) {
    console.log('渲染Agent图表:', config);
    
    if (!config || !config.metric) {
        console.warn('图表配置无效', config);
        return;
    }
    
    // 确保弹窗容器存在
    let modal = document.getElementById('agent-modal');
    if (!modal) {
        console.error('弹窗容器不存在，请检查 HTML');
        return;
    }
    
    // 显示弹窗
    modal.style.display = 'flex';
    
    // 确保图表容器存在
    const chartDom = document.getElementById('agent-modal-chart');
    if (!chartDom) {
        console.error('图表容器不存在');
        return;
    }
    
    // 初始化图表
    if (agentModalChart) {
        agentModalChart.dispose();
    }
    agentModalChart = echarts.init(chartDom);
    
    // 获取数据...
    const metric = config.metric;
    const chartType = config.type || 'line';
    const years = config.years || [];
    const regions = config.regions || [];
    
    if (!window.workbook || !window.workbook['省份']) {
        console.warn('数据未加载');
        return;
    }
    
    const provinceRows = window.workbook['省份'];
    let filteredRows = provinceRows;
    
    if (years.length) {
        filteredRows = filteredRows.filter(r => years.includes(r['年份']));
    }
    if (regions.length) {
        filteredRows = filteredRows.filter(r => regions.includes(r['地区']));
    }
    
    const series = [];
    const targetRegions = regions.length ? regions : [...new Set(filteredRows.map(r => r['地区']))].slice(0, 5);
    
    targetRegions.forEach(region => {
        const regionRows = filteredRows.filter(r => r['地区'] === region);
        const data = regionRows.map(r => r[metric] || 0);
        if (data.length && data.some(v => v !== 0)) {
            series.push({
                name: region,
                type: chartType,
                data: data,
                smooth: true
            });
        }
    });
    
    const allYears = years.length ? years : [...new Set(filteredRows.map(r => r['年份']))].sort();
    
    agentModalChart.setOption({
        title: { text: config.title || metric, left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { data: series.map(s => s.name), top: 30 },
        xAxis: { type: 'category', data: allYears, name: '年份' },
        yAxis: { type: 'value', name: metric },
        series: series
    });
    
    console.log('✅ Agent 图表弹窗渲染完成');
}

// 关闭弹窗
function closeAgentModal() {
    const modal = document.getElementById('agent-modal');
    if (modal) modal.style.display = 'none';
    if (agentModalChart) {
        agentModalChart.dispose();
        agentModalChart = null;
    }
}

// 绑定关闭事件
document.getElementById('close-agent-modal')?.addEventListener('click', closeAgentModal);
// 点击背景关闭
document.getElementById('agent-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('agent-modal')) {
        closeAgentModal();
    }
});
// 自动生成图表（降级方案）
function autoGenerateChart(question) {
    // 简单提取指标和地区
    let metric = '科学支出水平';
    let region = '广东省';
    
    const provinces = [...new Set(window.workbook['省份'].map(r => r['地区']))];
    for (const p of provinces) {
        if (question.includes(p)) {
            region = p;
            break;
        }
    }
    
    const metrics = getAllMetrics();
    for (const m of metrics) {
        if (question.includes(m) || question.includes(cleanMetricName(m))) {
            metric = m;
            break;
        }
    }
    
    const currentYear = new Date().getFullYear();
    const years = [currentYear-4, currentYear-3, currentYear-2, currentYear-1, currentYear];
    
    renderAgentChart({
        type: 'line',
        metric: metric,
        regions: [region],
        years: years,
        title: `${region} ${metric} 近5年趋势`
    });
}
// ========== 弹窗拖动、缩放 ==========
let modalDrag = false;
let modalOffsetX, modalOffsetY;

const agentModal = document.getElementById('agent-modal');
const modalHeader = document.getElementById('agent-modal-header');
const modalResize = document.getElementById('agent-modal-resize');

// 默认位置和大小
agentModal.style.top = '100px';
agentModal.style.left = '100px';
agentModal.style.width = '800px';

// 拖动
modalHeader.addEventListener('mousedown', (e) => {
    if (e.target === modalResize) return;
    modalDrag = true;
    modalOffsetX = e.clientX - agentModal.offsetLeft;
    modalOffsetY = e.clientY - agentModal.offsetTop;
    agentModal.style.cursor = 'grabbing';
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (modalDrag) {
        let left = e.clientX - modalOffsetX;
        let top = e.clientY - modalOffsetY;
        left = Math.max(0, Math.min(left, window.innerWidth - agentModal.offsetWidth));
        top = Math.max(0, Math.min(top, window.innerHeight - agentModal.offsetHeight));
        agentModal.style.left = left + 'px';
        agentModal.style.top = top + 'px';
    }
});

document.addEventListener('mouseup', () => {
    modalDrag = false;
    agentModal.style.cursor = '';
});

// 缩放
let resizeDrag = false;
let startX, startY, startWidth, startHeight;

modalResize.addEventListener('mousedown', (e) => {
    resizeDrag = true;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = agentModal.offsetWidth;
    startHeight = agentModal.offsetHeight;
    e.stopPropagation();
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (resizeDrag) {
        const newWidth = startWidth + (e.clientX - startX);
        const newHeight = startHeight + (e.clientY - startY);
        agentModal.style.width = Math.max(400, newWidth) + 'px';
        agentModal.style.height = Math.max(300, newHeight) + 'px';
        document.getElementById('agent-modal-chart').style.height = (newHeight - 80) + 'px';
        if (agentModalChart) agentModalChart.resize();
    }
});

document.addEventListener('mouseup', () => {
    resizeDrag = false;
});

// 关闭弹窗
document.getElementById('agent-modal-close').addEventListener('click', () => {
    agentModal.style.display = 'none';
    if (agentModalChart) {
        agentModalChart.dispose();
        agentModalChart = null;
    }
});

// 最小化（简单隐藏）
document.getElementById('agent-modal-minimize')?.addEventListener('click', () => {
    agentModal.style.display = 'none';
});
// ========== 聊天面板拖动 + 缩放 ==========
let chatDrag = false;
let chatOffsetX, chatOffsetY;
let chatResizeDrag = false;
let chatStartX, chatStartY, chatStartWidth, chatStartHeight;

const chatPanel = document.getElementById('chat-panel');
const chatHeader = document.getElementById('chat-header');
const chatResize = document.getElementById('chat-resize');
const chatBody = document.getElementById('chat-body');

// 拖动
if (chatHeader) {
    chatHeader.addEventListener('mousedown', (e) => {
        if (e.target === chatResize) return;
        chatDrag = true;
        chatOffsetX = e.clientX - chatPanel.offsetLeft;
        chatOffsetY = e.clientY - chatPanel.offsetTop;
        chatPanel.style.cursor = 'grabbing';
        e.preventDefault();
    });
}

document.addEventListener('mousemove', (e) => {
    if (chatDrag) {
        let left = e.clientX - chatOffsetX;
        let top = e.clientY - chatOffsetY;
        left = Math.max(0, Math.min(left, window.innerWidth - chatPanel.offsetWidth));
        top = Math.max(0, Math.min(top, window.innerHeight - chatPanel.offsetHeight));
        chatPanel.style.left = left + 'px';
        chatPanel.style.top = top + 'px';
        chatPanel.style.bottom = 'auto';
        chatPanel.style.right = 'auto';
    }
    
    if (chatResizeDrag) {
        const newWidth = chatStartWidth + (e.clientX - chatStartX);
        const newHeight = chatStartHeight + (e.clientY - chatStartY);
        chatPanel.style.width = Math.max(280, newWidth) + 'px';
        chatPanel.style.height = Math.max(350, newHeight) + 'px';
        if (chatMessages) {
            chatMessages.style.maxHeight = (newHeight - 120) + 'px';
        }
    }
});

document.addEventListener('mouseup', () => {
    chatDrag = false;
    chatResizeDrag = false;
    if (chatPanel) chatPanel.style.cursor = '';
});

// 缩放
if (chatResize) {
    chatResize.addEventListener('mousedown', (e) => {
        chatResizeDrag = true;
        chatStartX = e.clientX;
        chatStartY = e.clientY;
        chatStartWidth = chatPanel.offsetWidth;
        chatStartHeight = chatPanel.offsetHeight;
        e.stopPropagation();
        e.preventDefault();
    });
}

// 最小化/恢复
let chatMinimized = false;
const minimizeBtn = document.getElementById('chat-minimize');
if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
        if (chatMinimized) {
            chatBody.style.display = 'flex';
            chatMinimized = false;
            minimizeBtn.textContent = '🗕';
        } else {
            chatBody.style.display = 'none';
            chatMinimized = true;
            minimizeBtn.textContent = '🗗';
        }
    });
}

// 关闭面板
const closeBtn = document.getElementById('chat-close');
if (closeBtn) {
    closeBtn.addEventListener('click', () => {
        chatPanel.style.display = 'none';
    });
}

// 可选：添加一个浮动按钮恢复显示
const showChatBtn = document.createElement('button');
showChatBtn.textContent = '💬';
showChatBtn.style.position = 'fixed';
showChatBtn.style.bottom = '20px';
showChatBtn.style.right = '20px';
showChatBtn.style.width = '50px';
showChatBtn.style.height = '50px';
showChatBtn.style.borderRadius = '50%';
showChatBtn.style.background = '#1e466e';
showChatBtn.style.color = 'white';
showChatBtn.style.border = 'none';
showChatBtn.style.cursor = 'pointer';
showChatBtn.style.zIndex = '999';
showChatBtn.style.display = 'none';
document.body.appendChild(showChatBtn);

showChatBtn.addEventListener('click', () => {
    chatPanel.style.display = 'flex';
    showChatBtn.style.display = 'none';
});

// 监听关闭按钮隐藏浮动按钮显示
if (closeBtn) {
    closeBtn.addEventListener('click', () => {
        setTimeout(() => {
            if (chatPanel.style.display === 'none') {
                showChatBtn.style.display = 'flex';
            }
        }, 100);
    });
}
// ========== 发送消息 ==========
async function sendMessage() {
    if (typeof stopCarousel === 'function') {
    stopCarousel();
}
    const question = chatInput.value.trim();
    if (!question) return;

    // 添加用户消息
    addMessage('user', escapeHtml(question));
    chatInput.value = '';
    chatInput.style.height = 'auto';

    chatSend.disabled = true;
    chatStop.disabled = false;

    const updateAssistant = addMessage('assistant', '思考中...', true);
    let fullAnswer = '';

    currentController = new AbortController();
    const signal = currentController.signal;

    try {
        const response = await fetch('/api/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
            signal
        });

        const data = await response.json();

        // 显示回答
        const answer = data.answer || '无回答';
        updateAssistant(answer);
        fullAnswer = answer;

        // 如果有图表配置，自动渲染
        if (data.chart && data.chart.metric) {
            console.log('📊 收到图表配置:', data.chart);
            renderAgentChart(data.chart);
        } else if (/趋势|分析|变化|走势/.test(question)) {
            // 降级：自动生成图表
            autoGenerateChart(question);
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            updateAssistant(fullAnswer + '\n\n[已停止生成]');
        } else {
            console.error(err);
            updateAssistant('连接失败，请确保后端已启动');
        }
    } finally {
        chatSend.disabled = false;
        chatStop.disabled = true;
        currentController = null;
    }
}

// 停止生成
function stopGeneration() {
    if (currentController) {
        currentController.abort();
    }
}

// 简单的HTML转义（防止XSS）
function escapeHtml(str) {
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// 绑定事件
chatSend.addEventListener('click', sendMessage);
chatStop.addEventListener('click', stopGeneration);

// 按 Enter 发送（Shift+Enter 换行，如果使用 textarea）
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!chatSend.disabled) sendMessage();
    }
});

// 可选：textarea 自动调整高度
chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// 格式化函数（放在事件函数外部）
function formatAnswer(text) {
    let cleaned = text.replace(/\*\*/g, '');
    // 然后再处理思考/回答区块和换行
    let html = cleaned
        .replace(/【思考】/g, '<div class="thinking-title">🤔 思考过程</div>')
        .replace(/【回答】/g, '<div class="answer-title">📢 最终回答</div>')
        .replace(/\n/g, '<br>');

    // 为思考区域添加背景（简易方法：匹配从【思考】到【回答】之前的内容）
    if (html.includes('<div class="thinking-title">')) {
        const parts = html.split(/(<div class="answer-title">)/);
        if (parts.length >= 2) {
            parts[0] = `<div class="thinking-block">${parts[0]}</div>`;
            html = parts.join('');
        } else {
            html = `<div class="thinking-block">${html}</div>`;
        }
    }
    // 为回答区域添加边框样式
    html = html.replace(/(<div class="answer-title">.*?)(?=<div class="thinking-block|$)/gs, 
        match => `<div class="answer-block">${match}</div>`);
    return html;
}
// 清空对话历史
async function clearConversation() {
    try {
        const response = await fetch('/api/clear_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
            // 清空前端聊天消息区域
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) chatMessages.innerHTML = '';
            // 可选：添加一条系统提示（如“对话已清空”）
            const systemMsg = document.createElement('div');
            systemMsg.className = 'chat-message assistant';
            systemMsg.innerHTML = `<div class="message-role">🤖 系统</div><div class="message-content">对话历史已清空。</div>`;
            chatMessages.appendChild(systemMsg);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        } else {
            console.error('清空对话失败');
        }
    } catch (err) {
        console.error('清空对话请求错误:', err);
    }
}

// 绑定清空按钮事件
const chatClear = document.getElementById('chat-clear');
if (chatClear) {
    chatClear.addEventListener('click', clearConversation);
}
// ======================= 数据加载（强化列名转换与数值清洗） =======================
async function loadAllData() {
    try {
        const response = await fetch('/api/data');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        for (let sheetName in data) {
            const rows = data[sheetName];
            if (!rows || rows.length === 0) continue;
            const sample = rows[0];
            
            // 年份列标准化
            let yearKey = null;
            if (sample.hasOwnProperty("年份")) yearKey = "年份";
            else if (sample.hasOwnProperty("时间")) yearKey = "时间";
            else if (sample.hasOwnProperty("year")) yearKey = "year";
            if (yearKey && yearKey !== "年份") {
                rows.forEach(row => { row["年份"] = row[yearKey]; delete row[yearKey]; });
            }
            
            // 地区列标准化（非全国表）
            if (sheetName !== "全国") {
                let regionKey = null;
                if (sample.hasOwnProperty("地区")) regionKey = "地区";
                else if (sample.hasOwnProperty("省份")) regionKey = "省份";
                else if (sample.hasOwnProperty("省")) regionKey = "省";
                else if (sample.hasOwnProperty("城市")) regionKey = "城市";
                if (regionKey && regionKey !== "地区") {
                    rows.forEach(row => { row["地区"] = row[regionKey]; delete row[regionKey]; });
                }
            }
            
            // 删除冗余列
            rows.forEach(row => { delete row["时间地区"]; delete row["时间"]; });
            
            // 强制将所有数值字段转为数字（避免字符串）
            // 强制将所有数值字段转为数字（避免字符串），并将 null 转为 0
rows.forEach(row => {
    for (let key in row) {
        if (key !== "年份" && key !== "地区") {
            let val = row[key];
            if (val === null) {
                row[key] = 0;
            } else if (typeof val === "string") {
                let num = parseFloat(val);
                row[key] = isNaN(num) ? 0 : num;
            } else if (typeof val !== "number") {
                row[key] = 0;
            }
        }
    }
});
        }
        
        window.workbook = data;
        window.sheetList = Object.keys(window.workbook);
        log("数据加载完成", window.sheetList);
        return window.workbook;
    } catch (error) {
        console.error('加载 data.json 失败', error);
        alert('数据文件加载失败，请检查 data.json 是否与网页在同一目录，并且使用本地服务器运行。');
        throw error;
    }
}

// ======================= 全局变量 =======================
const CAROUSEL_INTERVAL = 5000;
const INACTIVITY_DELAY = 3000;
let mainChart, pieChart, advancedChart;
let currentSheet = "全国";
let originalRows = [], headers = [];
let dimType = "nation";
let valueFields = [];
let currentMetricIndex = 0;
let carouselTimer = null;
let isCarouselPaused = false;
let inactivityTimer = null;
let groupField = "地区";
let selectedGroups = [];
let sortKey = "", sortType = "asc";
let custom = { title: "auto", xName: "auto", yName: "auto", yMax: "auto" };
const COLORS = [
    '#1e466e', '#368bc1', '#5f9d80', '#e68a2e', '#b56576', '#6d597a', '#3cba54', '#db4437', '#f4b400',
    '#0f9d58', '#ff6d00', '#aa00ff', '#00bcd4', '#ff4081', '#7cb342', '#e91e63', '#9c27b0', '#ff9800',
    '#00acc1', '#d32f2f', '#388e3c', '#f57c00', '#8e24aa', '#039be5', '#ffb300', '#c2185b', '#1976d2',
    '#7b1fa2', '#0097a7', '#d81b60', '#4caf50', '#ffa000', '#6a1b9a', '#0288d1', '#fb8c00', '#ad1457',
    '#00897b', '#f4511e', '#5e35b1', '#00b09b'
];
let pageSize = 20;
let currentPage = 1;
let filteredRowsForPage = [];
let totalRecords = 0, totalPages = 1;
let visibleColumns = new Set();

let pieProvinceList = [];
let pieSelectedProvinces = new Set();
let pieHiddenProvinces = new Set();
let pieAvailableYears = [];
let pieAvailableMetrics = [];
let pieCurrentYear = null;
let pieCurrentMetricIndex = 0;
let pieCarouselTimer = null;
let piePaused = false;
let pieCarouselQueue = [];

let advMode = "rank";
let advMetrics = [];
let advCurrentMetricIndex = 0;
let advCarouselTimer = null;
let advPaused = false;
let advYears = [];
let advCurrentYear = null;
let rankFullData = [];
let rankSelectedIndices = new Set();
let rankChart = null;

// 搜索框相关全局变量
let allRegionList = [];
let regionSearchKeyword = "";

// ======================= 初始化 =======================
async function init() {
    await loadAllData();
    mainChart = echarts.init(document.getElementById("main-chart"));
    mainChart.getDom().addEventListener('mouseenter', () => { isCarouselPaused = true; });
    mainChart.getDom().addEventListener('mouseleave', () => { isCarouselPaused = false; });
    pieChart = echarts.init(document.getElementById("pie-chart"));
    if (pieChart) {
        pieChart.getDom().addEventListener('mouseenter', () => { piePaused = true; });
        pieChart.getDom().addEventListener('mouseleave', () => { piePaused = false; });
    }
    advancedChart = echarts.init(document.getElementById("advanced-content"));
    if (advancedChart) {
        advancedChart.getDom().addEventListener('mouseenter', () => { advPaused = true; });
        advancedChart.getDom().addEventListener('mouseleave', () => { advPaused = false; });
    }
    window.addEventListener("resize", () => {
        mainChart.resize();
        pieChart.resize();
        advancedChart.resize();
        if (rankChart) rankChart.resize();
    });
    buildSheetSelect();
    bindEvents();
    initColumnSelector();
    switchSheet(currentSheet);
}
// 夜间模式切换
const darkModeToggle = document.getElementById('darkModeToggle');
if (darkModeToggle) {
    // 检查 localStorage 中是否保存了夜间模式偏好
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        darkModeToggle.textContent = '☀️ 日间模式';
    }
    darkModeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        const isNowDark = document.body.classList.contains('dark-mode');
        localStorage.setItem('darkMode', isNowDark);
        darkModeToggle.textContent = isNowDark ? '☀️ 日间模式' : '🌙 夜间模式';
        updateChartsTheme(isNowDark);// 可选：重新触发 ECharts 的 resize，使图表适应（如果图表背景需要重绘）
        if (mainChart) mainChart.resize();
        if (pieChart) pieChart.resize();
        if (advancedChart) advancedChart.resize();
        if (rankChart) rankChart && rankChart.resize();
    });
}
function updateChartsTheme(isDark) {
    const textColor = isDark ? '#ffffff' : '#333333';
    const axisLineColor = isDark ? '#666666' : '#cccccc';
    const tooltipBg = isDark ? 'rgba(30, 30, 40, 0.9)' : 'rgba(255, 255, 255, 0.9)';
    const tooltipBorder = isDark ? '#4a5070' : '#cccccc';
    const labelColor = isDark ? '#ffffff' : '#000000';
    
    const optionUpdate = {
        // 背景透明（让容器背景透出）
        backgroundColor: 'transparent',
        // 全局文字颜色
        textStyle: { color: textColor },
        // 坐标轴样式
        xAxis: {
            axisLabel: { color: textColor },
            axisLine: { lineStyle: { color: axisLineColor } },
            axisTick: { lineStyle: { color: axisLineColor } },
            nameTextStyle: { color: textColor }
        },
        yAxis: {
            axisLabel: { color: textColor },
            axisLine: { lineStyle: { color: axisLineColor } },
            axisTick: { lineStyle: { color: axisLineColor } },
            nameTextStyle: { color: textColor }
        },
        // 图例文字
        legend: { textStyle: { color: textColor } },
        // 提示框样式
        tooltip: {
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            textStyle: { color: textColor, fontSize: 12 }
        },
        // 数据系列标签（如果开启 label 显示）
        series: {
            label: { color: labelColor },
            itemStyle: { borderColor: isDark ? '#2a2f3f' : '#ffffff' }
        }
    };
    
    // 应用到所有图表实例
    if (mainChart) mainChart.setOption(optionUpdate, false);
    if (pieChart) pieChart.setOption(optionUpdate, false);
    if (advancedChart) advancedChart.setOption(optionUpdate, false);
    if (rankChart) rankChart.setOption(optionUpdate, false);
}
// 列选择器
function initColumnSelector() {
    const toggleBtn = document.getElementById("toggle-column-panel");
    const panel = document.getElementById("column-panel");
    if (!toggleBtn || !panel) return;
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const rect = toggleBtn.getBoundingClientRect();
        panel.style.top = rect.bottom + 5 + "px";
        panel.style.left = rect.left + "px";
        panel.style.display = panel.style.display === "none" ? "block" : "none";
        if (panel.style.display === "block") refreshColumnCheckboxList();
    };
    document.addEventListener("click", (e) => {
        if (!panel.contains(e.target) && e.target !== toggleBtn) panel.style.display = "none";
    });
    document.getElementById("col-select-all").onclick = () => {
        visibleColumns.clear();
        headers.forEach(h => visibleColumns.add(h));
        refreshColumnCheckboxList();
        renderTablePage();
    };
    document.getElementById("col-deselect-all").onclick = () => {
        visibleColumns.clear();
        refreshColumnCheckboxList();
        renderTablePage();
    };
    document.getElementById("col-reset").onclick = () => {
        visibleColumns.clear();
        headers.forEach(h => visibleColumns.add(h));
        refreshColumnCheckboxList();
        renderTablePage();
    };
}
function refreshColumnCheckboxList() {
    const container = document.getElementById("column-checkbox-list");
    if (!container) return;
    container.innerHTML = "";
    headers.forEach(h => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = visibleColumns.has(h);
        cb.onchange = (e) => {
            if (e.target.checked) visibleColumns.add(h);
            else visibleColumns.delete(h);
            renderTablePage();
        };
        label.appendChild(cb);
        label.appendChild(document.createTextNode(h));
        container.appendChild(label);
    });
}

function buildSheetSelect() {
    const sel = document.getElementById("sheet-list");
    if (!sel) return;
    sel.innerHTML = "";
    sheetList.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        if (s === currentSheet) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.onchange = (e) => switchSheet(e.target.value);
}

function switchSheet(sheetName) {
    currentSheet = sheetName;
    originalRows = window.workbook[sheetName].map(row => ({ ...row }));
    headers = Object.keys(originalRows[0] || {});
    log("切换到工作表:", sheetName, headers);
    visibleColumns.clear();
    headers.forEach(h => visibleColumns.add(h));
    refreshColumnCheckboxList();
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) pageSize = parseInt(pageSizeSelect.value);

    // 获取搜索容器（放在最前面）
    const searchContainer = document.getElementById("region-search-container");

    if (sheetName === "全国") {
        dimType = "nation";
        valueFields = headers.filter(h => h !== "年份");
        currentMetricIndex = 0;
        selectedGroups = [];
        buildNationPanel();
        document.querySelector(".pie-card").style.display = "block";
        document.querySelector(".advanced-card").style.display = "none";
        initPieChart();
        if (searchContainer) searchContainer.style.display = "none";
        // 隐藏指标下拉框容器和快速跳转容器
const metricContainer = document.getElementById('metric-selector-container');
const quickJumpContainer = document.getElementById('quick-jump-container');
if (metricContainer) metricContainer.style.display = 'none';
if (quickJumpContainer) quickJumpContainer.style.display = 'none';
    } else if (sheetName === "地级市") {
    dimType = "city";
    groupField = "地区";
    const firstRow = originalRows[0];
    valueFields = Object.keys(firstRow).filter(key => key !== "年份" && key !== "地区" && key !== "时间地区");
    const groups = [...new Set(originalRows.map(r => r[groupField]))].filter(v => v).sort();
    selectedGroups = groups.length ? [groups[0]] : [];
    buildGroupPanel(groups, "地级市");
    document.querySelector(".pie-card").style.display = "none";
    document.querySelector(".advanced-card").style.display = "block";
    buildMetricSelector();
    initAdvancedAnalysis();
    if (searchContainer) searchContainer.style.display = "flex";
    const metricContainer = document.getElementById('metric-selector-container');
    const quickJumpContainer = document.getElementById('quick-jump-container');
    if (metricContainer) metricContainer.style.display = 'block';
    if (quickJumpContainer) quickJumpContainer.style.display = 'block';
}else if (sheetName === "省份") {
    dimType = "province";
    groupField = "地区";
    // 直接从第一行获取所有键，排除年份和地区
    const firstRow = originalRows[0];
    valueFields = Object.keys(firstRow).filter(key => key !== "年份" && key !== "地区");
    console.log("省份视图 valueFields:", valueFields); // 调试
    const groups = [...new Set(originalRows.map(r => r[groupField]))].filter(v => v).sort();
    selectedGroups = groups.length ? [groups[0]] : [];
    buildGroupPanel(groups, "省份");
    document.querySelector(".pie-card").style.display = "none";
    document.querySelector(".advanced-card").style.display = "block";
    buildMetricSelector();      // 填充指标下拉框
    initAdvancedAnalysis();
    if (searchContainer) searchContainer.style.display = "flex";
    // 显示指标和快速跳转容器
    const metricContainer = document.getElementById('metric-selector-container');
    const quickJumpContainer = document.getElementById('quick-jump-container');
    if (metricContainer) metricContainer.style.display = 'block';
    if (quickJumpContainer) quickJumpContainer.style.display = 'block';
}

    sortKey = "";
    sortType = "asc";
    document.getElementById("sort-status").innerHTML = "⚡ 当前排序：无（点击表头排序）";
    currentPage = 1;
    applyFilterAndSort();
    renderTablePage();
    stopCarousel();
    startCarousel();
    renderMainChart();
}
function buildMetricSelector() {
    const sel = document.getElementById("main-metric-select");
    if (!sel) return;
    sel.innerHTML = "";
    valueFields.forEach((v, idx) => {
        const opt = document.createElement("option");
        opt.value = idx;
        opt.text = v;
        if (idx === currentMetricIndex) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.onchange = (e) => {
        const newIdx = parseInt(e.target.value);
        if (newIdx !== currentMetricIndex) {
            pauseCarouselDueToInteraction();
            currentMetricIndex = newIdx;
            renderMainChart();
        }
    };
}

function buildNationPanel() {
    const panelTitle = document.getElementById("panel-title");
    if (panelTitle) panelTitle.innerHTML = `📈 核心指标（${valueFields.length}个）`;
    const container = document.getElementById("indicator-list");
    if (!container) return;
    container.innerHTML = "";
    valueFields.forEach((field, idx) => {
        const div = document.createElement("div");
        div.className = `indicator-item ${idx === currentMetricIndex ? 'active' : ''}`;
        div.innerHTML = `<span>📊 ${field}</span>`;
        div.onclick = () => {
            pauseCarouselDueToInteraction();
            currentMetricIndex = idx;
            updateNationHighlight();
            renderMainChart();
        };
        container.appendChild(div);
    });
    if (!document.getElementById("indicator-select")) {
        let sel = document.createElement("select");
        sel.id = "indicator-select";
        sel.style.display = "none";
        document.body.appendChild(sel);
    }
    let sel = document.getElementById("indicator-select");
    if (sel) {
        sel.innerHTML = "";
        valueFields.forEach(v => {
            let opt = document.createElement("option");
            opt.value = v;
            opt.text = v;
            sel.appendChild(opt);
        });
        sel.value = valueFields[currentMetricIndex];
        sel.onchange = (e) => {
            pauseCarouselDueToInteraction();
            currentMetricIndex = valueFields.indexOf(e.target.value);
            updateNationHighlight();
            renderMainChart();
        };
    }
}

function updateNationHighlight() {
    const items = document.querySelectorAll("#indicator-list .indicator-item");
    items.forEach((item, idx) => {
        if (idx === currentMetricIndex) item.classList.add("active");
        else item.classList.remove("active");
    });
}
function buildQuickJump() {
    const quickJump = document.getElementById('quick-jump-region');
    if (!quickJump) return;
    if (!allRegionList || allRegionList.length === 0) {
        quickJump.innerHTML = '<option value="">-- 无地区数据 --</option>';
        return;
    }
    quickJump.innerHTML = '<option value="">-- 选择地区 --</option>' + 
        allRegionList.map(r => `<option value="${r}">${r}</option>`).join('');
    quickJump.onchange = (e) => {
        const region = e.target.value;
        if (region) {
            // 找到对应的复选框并勾选
            const items = document.querySelectorAll('#indicator-list .indicator-item');
            for (let item of items) {
                const labelSpan = item.querySelector('span');
                if (labelSpan && labelSpan.innerText === region) {
                    const cb = item.querySelector('input');
                    if (cb && !cb.checked) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    break;
                }
            }
            quickJump.value = ''; // 重置选择
        }
    };
}

// 分组面板（支持搜索框，勾选后图表联动）
function buildGroupPanel(groups, type) {
    allRegionList = groups;
    const titleMap = { "省份": "🏙️ 省份", "地级市": "🏙️ 地区" };
    const panelTitle = document.getElementById("panel-title");
    if (panelTitle) panelTitle.innerHTML = `${titleMap[type]}（${groups.length}个）`;
    const container = document.getElementById("indicator-list");
    if (!container) return;

    function renderRegionList() {
        const keyword = regionSearchKeyword.trim().toLowerCase();
        let filteredGroups = allRegionList;
        if (keyword !== "") {
            filteredGroups = allRegionList.filter(g => g.toLowerCase().includes(keyword));
        }
        if (panelTitle) panelTitle.innerHTML = `${titleMap[type]}（${filteredGroups.length} / ${allRegionList.length}）`;

        container.innerHTML = "";
        if (filteredGroups.length === 0) {
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">未找到匹配地区</div>';
            return;
        }

        filteredGroups.forEach(g => {
            const div = document.createElement("div");
            div.className = "indicator-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selectedGroups.includes(g);
            const labelSpan = document.createElement("span");
            labelSpan.innerText = g;
            div.appendChild(cb);
            div.appendChild(labelSpan);
            cb.onchange = (e) => {
                if (e.target.checked) {
                    if (!selectedGroups.includes(g)) selectedGroups.push(g);
                } else {
                    const idx = selectedGroups.indexOf(g);
                    if (idx !== -1) selectedGroups.splice(idx, 1);
                }
                renderMainChart();
            };
            div.onclick = (e) => {
                if (e.target !== cb) {
                    cb.checked = !cb.checked;
                    const changeEvent = new Event('change', { bubbles: true });
                    cb.dispatchEvent(changeEvent);
                }
            };
            container.appendChild(div);
        });

        const firstItem = container.querySelector('.indicator-item');
        if (firstItem) firstItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const selectAllBtn = document.getElementById("select-all");
    const invertBtn = document.getElementById("invert-select");
    const resetBtn = document.getElementById("reset-select");
    const clearBtn = document.getElementById("clear-select");
    if (selectAllBtn) selectAllBtn.onclick = () => {
        selectedGroups = [...allRegionList];
        renderRegionList();
        renderMainChart();
    };
    if (invertBtn) invertBtn.onclick = () => {
        selectedGroups = allRegionList.filter(g => !selectedGroups.includes(g));
        renderRegionList();
        renderMainChart();
    };
    if (resetBtn) resetBtn.onclick = () => {
        if (type === "地级市") {
            selectedGroups = allRegionList.slice(0, 1);
        } else {
            selectedGroups = allRegionList.length ? [allRegionList[0]] : [];
        }
        renderRegionList();
        renderMainChart();
    };
    if (clearBtn) clearBtn.onclick = () => {
        selectedGroups = [];
        renderRegionList();
        renderMainChart();
    };

    const searchInput = document.getElementById("region-search");
    if (searchInput) {
        searchInput.removeEventListener("input", handleSearch);
        searchInput.addEventListener("input", handleSearch);
        function handleSearch(e) {
            regionSearchKeyword = e.target.value;
            renderRegionList();
        }
    }

    // 清空搜索按钮
    const clearSearchBtn = document.getElementById("clear-search-btn");
    if (clearSearchBtn) {
        clearSearchBtn.onclick = () => {
            if (searchInput) {
                searchInput.value = "";
                regionSearchKeyword = "";
                renderRegionList();
            }
        };
    }

    renderRegionList();
    renderMainChart();
    buildQuickJump();
}

// 主图表渲染
function renderMainChart() {
    if (!mainChart || !valueFields.length) return;
    let chartType = document.getElementById("chart-type").value;
    if (chartType === "auto") chartType = (dimType === "nation" ? "line" : "bar");
    const metric = valueFields[currentMetricIndex];
    if (!metric) return;
    if (dimType === "nation") {
        const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
        const data = years.map(y => originalRows.find(r => r["年份"] === y)?.[metric] ?? 0);
        const option = {
            title: { text: custom.title !== "auto" ? custom.title : `${metric} 时序趋势`, left: "center" },
            tooltip: { trigger: "axis" },
            legend: { data: [metric], top: 30 },
            xAxis: { type: "category", data: years, name: custom.xName !== "auto" ? custom.xName : "年份" },
            yAxis: { name: custom.yName !== "auto" ? custom.yName : metric, min: 0, max: custom.yMax !== "auto" ? Number(custom.yMax) : null },
            series: [{ name: metric, type: chartType, data, smooth: true, color: COLORS[0], areaStyle: { opacity: 0.1 } }]
        };
        mainChart.setOption(option, true);
        return;
    }
    const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
    const series = [];
    selectedGroups.forEach((grp, idx) => {
        const data = years.map(y => {
            let row = originalRows.find(r => r["年份"] === y && r["地区"] === grp);
            return row ? row[metric] : 0;
        });
        series.push({ name: grp, type: chartType, data, smooth: true, color: COLORS[idx % COLORS.length] });
    });
    const isDarkMode = document.body.classList.contains('dark-mode');
    const tooltipStyle = isDarkMode ? {
        backgroundColor: 'rgba(30, 30, 40, 0.9)',
        borderColor: '#4a5070',
        textStyle: { color: '#ffffff' }
    } : {
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
        borderColor: '#cccccc',
        textStyle: { color: '#333333' }
    };
    const option = {
        title: { text: custom.title !== "auto" ? custom.title : `${metric} 区域对比`, left: "center" },
        tooltip: tooltipStyle, 
        legend: (dimType === "city") ? { show: false } : { data: selectedGroups, top: 30, type: "scroll" },
        xAxis: { type: "category", data: years, name: "年份" },
        yAxis: { name: custom.yName !== "auto" ? custom.yName : metric, min: 0, max: custom.yMax !== "auto" ? Number(custom.yMax) : null },
        series: series
    };
    mainChart.setOption(option, true);
}

// 轮播控制
function startCarousel() {
    stopCarousel();
    if (valueFields.length <= 1) return;
    carouselTimer = setInterval(() => {
        if (isCarouselPaused) return;
        currentMetricIndex = (currentMetricIndex + 1) % valueFields.length;
        if (dimType === "nation") {
            updateNationHighlight();
            const sel = document.getElementById("indicator-select");
            if (sel) sel.value = valueFields[currentMetricIndex];
        } else {
            const metricSel = document.getElementById("main-metric-select");
            if (metricSel) metricSel.value = currentMetricIndex;
        }
        renderMainChart();
    }, CAROUSEL_INTERVAL);
}
function stopCarousel() {
    if (carouselTimer) { clearInterval(carouselTimer); carouselTimer = null; }
}
function pauseCarouselDueToInteraction() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    isCarouselPaused = true;
    inactivityTimer = setTimeout(() => {
        isCarouselPaused = false;
        startCarousel();
    }, INACTIVITY_DELAY);
}
// ======================= 饼图 =======================
function initPieChart() {
    const provinceRows = window.workbook["省份"];
    if (!provinceRows || provinceRows.length === 0) {
        pieChart.setOption({ title: { text: "省份表为空", left: "center", top: "center" } });
        return;
    }
    pieProvinceList = [...new Set(provinceRows.map(r => r["地区"]))].sort();
    pieSelectedProvinces = new Set(pieProvinceList);
    pieHiddenProvinces.clear();
    const listContainer = document.getElementById("pie-province-list");
    if (listContainer) {
        listContainer.innerHTML = "";
        pieProvinceList.forEach(prov => {
            const div = document.createElement("div");
            div.className = "indicator-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.onchange = (e) => {
                if (e.target.checked) {
                    pieSelectedProvinces.add(prov);
                    pieHiddenProvinces.delete(prov);
                } else {
                    pieSelectedProvinces.delete(prov);
                    pieHiddenProvinces.add(prov);
                }
                renderPieChart();
            };
            const label = document.createElement("span");
            label.innerText = prov;
            div.appendChild(cb);
            div.appendChild(label);
            listContainer.appendChild(div);
        });
    }
    const selectAll = document.getElementById("pie-select-all");
    const invert = document.getElementById("pie-invert-select");
    const reset = document.getElementById("pie-reset-select");
    const clear = document.getElementById("pie-clear-select");
    const resetHidden = document.getElementById("pie-reset-hidden");
    if (selectAll) selectAll.onclick = () => {
        document.querySelectorAll("#pie-province-list .indicator-item input").forEach(cb => cb.checked = true);
        pieSelectedProvinces = new Set(pieProvinceList);
        pieHiddenProvinces.clear();
        renderPieChart();
    };
    if (invert) invert.onclick = () => {
        document.querySelectorAll("#pie-province-list .indicator-item input").forEach(cb => cb.checked = !cb.checked);
        const newSelected = new Set();
        document.querySelectorAll("#pie-province-list .indicator-item input:checked").forEach(cb => {
            const prov = cb.parentElement.querySelector("span").innerText;
            newSelected.add(prov);
        });
        pieSelectedProvinces = newSelected;
        pieHiddenProvinces = new Set(pieProvinceList.filter(p => !pieSelectedProvinces.has(p)));
        renderPieChart();
    };
    if (reset) reset.onclick = () => {
        document.querySelectorAll("#pie-province-list .indicator-item input").forEach(cb => cb.checked = true);
        pieSelectedProvinces = new Set(pieProvinceList);
        pieHiddenProvinces.clear();
        renderPieChart();
    };
    if (clear) clear.onclick = () => {
        document.querySelectorAll("#pie-province-list .indicator-item input").forEach(cb => cb.checked = false);
        pieSelectedProvinces.clear();
        pieHiddenProvinces = new Set(pieProvinceList);
        renderPieChart();
    };
    if (resetHidden) resetHidden.onclick = () => {
        pieSelectedProvinces = new Set(pieProvinceList);
        pieHiddenProvinces.clear();
        document.querySelectorAll("#pie-province-list .indicator-item input").forEach(cb => cb.checked = true);
        renderPieChart();
    };
    const sample = provinceRows[0];
    pieAvailableMetrics = Object.keys(sample).filter(k => k !== "年份" && k !== "地区" && typeof sample[k] === "number");
    pieAvailableYears = [...new Set(provinceRows.map(r => r["年份"]))].sort();
    pieCurrentYear = pieAvailableYears[pieAvailableYears.length-1];
    pieCurrentMetricIndex = 0;
    const yearSel = document.getElementById("pie-year-select");
    const metricSel = document.getElementById("pie-metric-select");
    if (yearSel) {
        yearSel.innerHTML = "";
        pieAvailableYears.forEach(y => {
            const opt = document.createElement("option");
            opt.value = y;
            opt.text = y;
            if (y === pieCurrentYear) opt.selected = true;
            yearSel.appendChild(opt);
        });
        yearSel.onchange = () => {
            pieCurrentYear = parseInt(yearSel.value);
            renderPieChart();
            if (!piePaused) startPieCarousel();
        };
    }
    if (metricSel) {
        metricSel.innerHTML = "";
        pieAvailableMetrics.forEach((m, idx) => {
            const opt = document.createElement("option");
            opt.value = idx;
            opt.text = m;
            if (idx === pieCurrentMetricIndex) opt.selected = true;
            metricSel.appendChild(opt);
        });
        metricSel.onchange = () => {
            pieCurrentMetricIndex = parseInt(metricSel.value);
            renderPieChart();
            if (!piePaused) startPieCarousel();
        };
    }
    const prevBtn = document.getElementById("pie-year-prev");
    const nextBtn = document.getElementById("pie-year-next");
    if (prevBtn) prevBtn.onclick = () => {
        let idx = pieAvailableYears.indexOf(pieCurrentYear);
        if (idx > 0) {
            pieCurrentYear = pieAvailableYears[idx-1];
            if (yearSel) yearSel.value = pieCurrentYear;
            renderPieChart();
        }
    };
    if (nextBtn) nextBtn.onclick = () => {
        let idx = pieAvailableYears.indexOf(pieCurrentYear);
        if (idx < pieAvailableYears.length-1) {
            pieCurrentYear = pieAvailableYears[idx+1];
            if (yearSel) yearSel.value = pieCurrentYear;
            renderPieChart();
        }
    };
    pieCarouselQueue = [];
    for (let y of pieAvailableYears) {
        for (let i = 0; i < pieAvailableMetrics.length; i++) {
            pieCarouselQueue.push({ year: y, metricIndex: i });
        }
    }
    renderPieChart();
    startPieCarousel();
}
function startPieCarousel() {
    if (pieCarouselTimer) clearInterval(pieCarouselTimer);
    if (pieCarouselQueue.length <= 1) return;
    pieCarouselTimer = setInterval(() => {
        if (piePaused) return;
        let currentIdx = pieCarouselQueue.findIndex(item => item.year === pieCurrentYear && item.metricIndex === pieCurrentMetricIndex);
        let nextIdx = (currentIdx + 1) % pieCarouselQueue.length;
        const next = pieCarouselQueue[nextIdx];
        pieCurrentYear = next.year;
        pieCurrentMetricIndex = next.metricIndex;
        const yearSel = document.getElementById("pie-year-select");
        const metricSel = document.getElementById("pie-metric-select");
        if (yearSel) yearSel.value = pieCurrentYear;
        if (metricSel) metricSel.value = pieCurrentMetricIndex;
        renderPieChart();
    }, 4000);
}
function stopPieCarousel() {
    if (pieCarouselTimer) { clearInterval(pieCarouselTimer); pieCarouselTimer = null; }
}
function renderPieChart() {
    const metric = pieAvailableMetrics[pieCurrentMetricIndex];
    const year = pieCurrentYear;
    const provinceRows = window.workbook["省份"].filter(r => r["年份"] === year);
    if (provinceRows.length === 0 || provinceRows.every(r => r[metric] === undefined || r[metric] === 0)) {
        pieChart.clear();
        pieChart.setOption({ title: { text: `无有效数据（${year}年 ${metric}）`, left: "center", top: "center" } });
        document.getElementById("pie-status").innerHTML = `⚠️ 无有效数据，请切换年份或指标`;
        return;
    }
    const nationRow = window.workbook["全国"].find(r => r["年份"] === year);
    let total = null;
    let totalSource = "national";
    if (nationRow && nationRow[metric] !== undefined && nationRow[metric] !== 0) {
        total = nationRow[metric];
    } else {
        total = provinceRows.reduce((sum, row) => sum + (row[metric] || 0), 0);
        totalSource = "province_sum";
    }
    if (!total || total === 0) {
        pieChart.clear();
        pieChart.setOption({ title: { text: `总量无效，无法计算占比`, left: "center", top: "center" } });
        return;
    }
    let provinceSum = 0;
    let normalData = [];
    let hiddenSum = 0;
    let hiddenNames = [];
    for (let prov of pieProvinceList) {
        const row = provinceRows.find(r => r["地区"] === prov);
        let val = row ? (row[metric] || 0) : 0;
        provinceSum += val;
        if (pieSelectedProvinces.has(prov)) {
            normalData.push({ name: prov, value: val, originalVal: val });
        } else {
            hiddenSum += val;
            hiddenNames.push(prov);
        }
    }
    let otherValue = 0;
    let otherPercent = 0;
    if (totalSource === "national" && total > provinceSum) {
        otherValue = total - provinceSum;
    }
    let pieSeriesData = [];
    const colorPalette = [...COLORS];
    normalData.forEach((item, idx) => {
        let percent = (item.value / total) * 100;
        if (percent > 0.01 || item.value === 0) {
            pieSeriesData.push({ name: item.name, value: percent, originalVal: item.value, itemStyle: { color: colorPalette[idx % colorPalette.length] } });
        }
    });
    if (hiddenSum > 0 && hiddenNames.length > 0) {
        let hiddenPercent = (hiddenSum / total) * 100;
        if (hiddenPercent > 0.01) {
            pieSeriesData.push({
                name: `已隐藏省份 (${hiddenNames.length}省)`,
                value: hiddenPercent,
                originalVal: hiddenSum,
                itemStyle: { color: '#aaaaaa' }
            });
        }
    }
    if (otherValue > 0) {
        otherPercent = (otherValue / total) * 100;
        pieSeriesData.push({
            name: "其他（非省份部分）",
            value: otherPercent,
            originalVal: otherValue,
            itemStyle: { color: '#cccccc' }
        });
    }
    const allProvinceSet = new Set(provinceRows.map(r => r["地区"]));
    const neverExist = pieProvinceList.filter(p => !allProvinceSet.has(p));
    if (neverExist.length > 0) {
        pieSeriesData.push({
            name: `数据缺失省份 (${neverExist.length}省)`,
            value: 0,
            originalVal: 0,
            itemStyle: { color: '#dddddd' }
        });
    }
    const totalNote = totalSource === "province_sum" ? `（因缺少全国总量，占比基于${provinceRows.length}省数值总和${formatValue(total)}计算）` : "";
    const unit = getUnit(metric);
    const option = {
        title: { text: `${year}年 ${metric}${unit ? `(${unit})` : ''} 各省份占比${totalNote}`, left: "center", top: 0 },
        tooltip: {
            trigger: "item",
            formatter: (params) => {
                if (params.name.startsWith("数据缺失省份")) {
                    return `${params.name}<br/>缺失名单: ${neverExist.join("、")}`;
                }
                if (params.name === "其他（非省份部分）") {
                    return `${params.name}<br/>占比: ${params.percent.toFixed(2)}%<br/>数值: ${formatValue(otherValue)} ${unit}<br/>表示全国总量中未分配到具体省份的部分`;
                }
                let tip = `${params.name}<br/>占比: ${params.percent.toFixed(2)}%`;
                if (params.data.originalVal !== undefined && params.name !== "其他（非省份部分）") {
                    tip += `<br/>数值: ${formatValue(params.data.originalVal)} ${unit}`;
                }
                if (params.name.startsWith("已隐藏省份")) {
                    tip += `<br/>包含: ${formatMissingList(hiddenNames, 5)}`;
                }
                return tip;
            }
        },
        legend: {
            orient: "vertical",
            left: "left",
            type: "scroll",
            selectedMode: true,
            formatter: (name) => name.length > 20 ? name.slice(0, 18) + "..." : name
        },
        series: [{
            type: "pie",
            radius: ["35%", "65%"],
            center: ["50%", "50%"],
            data: pieSeriesData,
            label: {
                show: true,
                formatter: (params) => {
                    if (params.name.startsWith("数据缺失省份")) return "";
                    if (params.name === "其他（非省份部分）") return "其他";
                    if (params.percent < 0.5) return "";
                    if (params.percent < 2) return `${params.percent.toFixed(2)}%`;
                    return `${params.name}: ${params.percent.toFixed(2)}%`;
                },
                position: "outside",
                lineHeight: 16,
                fontSize: 10,
                avoidLabelOverlap: true,
                rotate: 0,
                labelLine: {
                    show: true,
                    length: 8,
                    length2: 6,
                    smooth: true
                }
            },
            minAngle: 1,
            emphasis: { scale: true }
        }]
    };
    if (pieSeriesData.length === 0) {
        pieChart.clear();
        pieChart.setOption({ title: { text: `无有效数据（${year}年 ${metric}）`, left: "center", top: "center" } });
        document.getElementById("pie-status").innerHTML = `⚠️ 无有效数据，请切换年份或指标`;
        return;
    }
    pieChart.setOption(option, true);
    pieChart.off('legendselectchanged');
    pieChart.on('legendselectchanged', (params) => {
        const clickedName = params.name;
        if (clickedName.startsWith("已隐藏省份") || clickedName === "其他（非省份部分）" || clickedName.startsWith("数据缺失省份")) return;
        const targetItem = Array.from(document.querySelectorAll("#pie-province-list .indicator-item")).find(item => item.querySelector("span").innerText === clickedName);
        if (targetItem) {
            const cb = targetItem.querySelector('input');
            if (cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            }
        }
    });
    let statusMsg = `💡 总量来源: ${totalSource === "national" ? "全国表" : "省份表数值之和"} | 总值: ${formatValue(total)} ${unit}`;
    if (neverExist.length) statusMsg += ` | 数据缺失省份: ${formatMissingList(neverExist)}`;
    if (hiddenNames.length) statusMsg += ` | 已隐藏 ${hiddenNames.length} 省`;
    if (otherValue > 0) statusMsg += ` | 非省份部分占比: ${otherPercent.toFixed(2)}%`;
    document.getElementById("pie-status").innerHTML = statusMsg;
}

// ======================= 高级分析（仅排名对比图） =======================
function initAdvancedAnalysis() {
    advMetrics = [...valueFields];
    advCurrentMetricIndex = 0;
    advYears = [...new Set(originalRows.map(r => r["年份"]))].sort();
    advCurrentYear = advYears.length ? advYears[advYears.length-1] : null;
    renderRankUI();
}
function renderRankUI() {
    const toolbar = document.getElementById("advanced-toolbar");
    if (!toolbar) return;
    toolbar.innerHTML = `
        <div class="tool-item"><label>指标</label><select id="adv-metric-select"></select></div>
        <div class="tool-item"><label>年份</label><select id="adv-year-select"></select></div>
        <button id="adv-pause-carousel" class="btn-outline">⏸️ 暂停轮播</button>
        <button id="adv-refresh" class="btn-sm">刷新</button>
        <span class="help-icon" title="排名对比图：左侧勾选地区，右侧柱状图对比。">❓</span>
    `;
    const metricSel = document.getElementById("adv-metric-select");
    if (metricSel) {
        metricSel.innerHTML = "";
        advMetrics.forEach((m, idx) => {
            const opt = document.createElement("option");
            opt.value = idx;
            opt.text = m;
            if (idx === advCurrentMetricIndex) opt.selected = true;
            metricSel.appendChild(opt);
        });
        metricSel.onchange = (e) => {
            advCurrentMetricIndex = parseInt(e.target.value);
            if (!advPaused) startAdvCarousel();
            else renderAdvancedChart();
        };
    }
    const yearSel = document.getElementById("adv-year-select");
    if (yearSel) {
        yearSel.innerHTML = "";
        advYears.forEach(y => {
            const opt = document.createElement("option");
            opt.value = y;
            opt.text = y;
            if (y === advCurrentYear) opt.selected = true;
            yearSel.appendChild(opt);
        });
        yearSel.onchange = (e) => {
            advCurrentYear = parseInt(e.target.value);
            renderAdvancedChart();
        };
    }
    const pauseBtn = document.getElementById("adv-pause-carousel");
    if (pauseBtn) pauseBtn.onclick = toggleAdvCarousel;
    const refreshBtn = document.getElementById("adv-refresh");
    if (refreshBtn) refreshBtn.onclick = () => renderAdvancedChart();
    startAdvCarousel();
    renderAdvancedChart();
}
function startAdvCarousel() {
    if (advCarouselTimer) clearInterval(advCarouselTimer);
    if (advMetrics.length <= 1) return;
    advCarouselTimer = setInterval(() => {
        if (advPaused) return;
        advCurrentMetricIndex = (advCurrentMetricIndex + 1) % advMetrics.length;
        const metricSel = document.getElementById("adv-metric-select");
        if (metricSel) metricSel.value = advCurrentMetricIndex;
        renderAdvancedChart();
    }, 5000);
}
function stopAdvCarousel() {
    if (advCarouselTimer) { clearInterval(advCarouselTimer); advCarouselTimer = null; }
}
function toggleAdvCarousel() {
    advPaused = !advPaused;
    const btn = document.getElementById("adv-pause-carousel");
    if (btn) btn.innerText = advPaused ? "▶️ 开始轮播" : "⏸️ 暂停轮播";
    if (!advPaused) startAdvCarousel();
    else stopAdvCarousel();
}
function renderAdvancedChart() {
    if (!advancedChart) return;
    const metric = advMetrics[advCurrentMetricIndex];
    const year = advCurrentYear;
    if (!metric || !year) {
        advancedChart.setOption({ title: { text: "无可用指标或年份", left: "center", top: "center" } });
        return;
    }
    const sampleRow = originalRows.find(r => r["年份"] === year && r[metric] !== undefined);
    const isNumeric = sampleRow && typeof sampleRow[metric] === "number";
    if (!isNumeric) {
        renderCategoryStats(metric, year);
        return;
    }
    renderRankCompareChart(metric, year);
}
function renderRankCompareChart(metric, year) {
    const dataForYear = originalRows.filter(r => r["年份"] === year);
    const allRegions = new Set(originalRows.map(r => r["地区"]));
    const regionData = [];
    for (let region of allRegions) {
        let row = dataForYear.find(r => r["地区"] === region);
        let val = row ? row[metric] : 0;
        if (typeof val !== 'number' || isNaN(val)) val = 0;
        regionData.push({ name: region, value: val });
    }
    regionData.sort((a,b) => {
        const aValid = (a.value !== undefined && a.value !== null && !isNaN(a.value));
        const bValid = (b.value !== undefined && b.value !== null && !isNaN(b.value));
        if (aValid && !bValid) return -1;
        if (!aValid && bValid) return 1;
        if (aValid && bValid) return b.value - a.value;
        return a.name.localeCompare(b.name, 'zh');
    });
    rankFullData = regionData;
    if (rankSelectedIndices.size === 0) {
        rankSelectedIndices.clear();
        let validCount = 0;
        for (let i = 0; i < regionData.length && validCount < 10; i++) {
            if (typeof regionData[i].value === 'number' && !isNaN(regionData[i].value)) {
                rankSelectedIndices.add(i);
                validCount++;
            }
        }
    }
    const container = document.getElementById("advanced-content");
    if (container) {
        container.innerHTML = `<div class="rank-list-container" id="rank-list-panel"></div><div class="rank-chart-container" id="rank-chart-panel"></div>`;
        const listPanel = document.getElementById("rank-list-panel");
        if (listPanel) {
            listPanel.innerHTML = "";
            regionData.forEach((item, idx) => {
                const div = document.createElement("div");
                div.className = "rank-list-item";
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = rankSelectedIndices.has(idx);
                cb.onchange = (e) => {
                    if (e.target.checked) rankSelectedIndices.add(idx);
                    else rankSelectedIndices.delete(idx);
                    updateRankChart();
                };
                const rankSpan = document.createElement("span");
                rankSpan.className = "rank";
                rankSpan.innerText = `${idx+1}`;
                const nameSpan = document.createElement("span");
                nameSpan.className = "name";
                nameSpan.innerText = item.name;
                const valueSpan = document.createElement("span");
                valueSpan.className = "value";
                let valDisplay = (typeof item.value === 'number' && !isNaN(item.value)) ? item.value.toFixed(2) : "无数据";
                valueSpan.innerText = valDisplay;
                div.appendChild(cb);
                div.appendChild(rankSpan);
                div.appendChild(nameSpan);
                div.appendChild(valueSpan);
                listPanel.appendChild(div);
            });
        }
        const chartPanel = document.getElementById("rank-chart-panel");
        if (chartPanel) {
            if (rankChart) rankChart.dispose();
            rankChart = echarts.init(chartPanel);
            updateRankChart();
        }
    }
}
function updateRankChart() {
    const selectedData = Array.from(rankSelectedIndices)
        .map(idx => rankFullData[idx])
        .filter(d => d && typeof d.value === 'number' && !isNaN(d.value));
    selectedData.sort((a, b) => b.value - a.value);
    const option = {
        title: { text: `${advMetrics[advCurrentMetricIndex]} 对比`, left: "center" },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { containLabel: true, left: "15%" },
        xAxis: { type: "value", name: advMetrics[advCurrentMetricIndex] },
        yAxis: { type: "category", data: selectedData.map(d => d.name), axisLabel: { fontSize: 11 } },
        series: [{
            type: "bar",
            data: selectedData.map(d => d.value),
            itemStyle: { color: COLORS[0] },
            label: { show: true, position: "right" }
        }]
    };
    if (rankChart) rankChart.setOption(option, true);
}
function renderCategoryStats(metric, year) {
    const dataForYear = originalRows.filter(r => r["年份"] === year);
    const freqMap = new Map();
    dataForYear.forEach(row => {
        let val = row[metric];
        if (val !== undefined && val !== null && val !== "") {
            const key = String(val);
            freqMap.set(key, (freqMap.get(key) || 0) + 1);
        }
    });
    if (freqMap.size === 0) {
        advancedChart.setOption({ title: { text: `无有效分类数据 (${metric})`, left: "center", top: "center" } });
        return;
    }
    const sorted = Array.from(freqMap.entries()).sort((a,b) => b[1] - a[1]);
    const option = {
        title: { text: `${metric} 分类频次统计 (${year}年)`, left: "center" },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { type: "category", data: sorted.map(s => s[0]), axisLabel: { rotate: 30 } },
        yAxis: { type: "value", name: "出现次数" },
        series: [{ type: "bar", data: sorted.map(s => s[1]), itemStyle: { color: COLORS[0] } }]
    };
    advancedChart.setOption(option, true);
}

// ======================= 表格分页 + 排序 + 搜索 =======================
let currentSearchTerm = "";
function applyFilterAndSort() {
    let filtered = [...originalRows];
    const searchVal = document.getElementById("search-input").value.trim();
    currentSearchTerm = searchVal;
    if (searchVal) {
        filtered = filtered.filter(row => Object.values(row).some(v => String(v).toLowerCase().includes(searchVal.toLowerCase())));
    }
    if (sortKey) {
        filtered.sort((a,b) => {
            let av = a[sortKey], bv = b[sortKey];
            if (!isNaN(Number(av)) && !isNaN(Number(bv))) return sortType === "asc" ? av - bv : bv - av;
            return sortType === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
    }
    filteredRowsForPage = filtered;
    totalRecords = filteredRowsForPage.length;
    totalPages = Math.ceil(totalRecords / pageSize);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    document.getElementById("total-records").innerText = totalRecords;
    document.getElementById("page-total").innerText = totalPages;
    let sortMsg = sortKey ? `当前排序：${sortKey} ${sortType === "asc" ? "↑ 升序" : "↓ 降序"}` : "无";
    document.getElementById("sort-status").innerHTML = `⚡ ${sortMsg}（点击表头排序）`;
}
function renderTablePage() {
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const pageData = filteredRowsForPage.slice(start, end);
    const searchVal = currentSearchTerm;
    const visible = headers.filter(h => visibleColumns.has(h));
    
    // 计算每个数值列的统计值
    const stats = {};
    const numericFields = headers.filter(h => {
        if (h === '年份' || h === '地区') return false;
        const sample = filteredRowsForPage[0];
        return sample && typeof sample[h] === 'number';
    });
    
    numericFields.forEach(field => {
        const values = filteredRowsForPage.map(row => row[field]).filter(v => typeof v === 'number' && !isNaN(v));
        if (values.length === 0) {
            stats[field] = { sum: '-', avg: '-', median: '-', min: '-', max: '-' };
            return;
        }
        const sum = values.reduce((a,b) => a + b, 0);
        const avg = sum / values.length;
        const sorted = [...values].sort((a,b) => a - b);
        const median = sorted.length % 2 === 0 ? (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2 : sorted[Math.floor(sorted.length/2)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        stats[field] = { sum: sum.toFixed(2), avg: avg.toFixed(2), median: median.toFixed(2), min: min.toFixed(2), max: max.toFixed(2) };
    });
    
    // 构建表头（两行：第一行列名，第二行统计）
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const statsRow = document.createElement('tr');
    statsRow.className = 'stats-row';
    
    visible.forEach(h => {
        // 第一行：列名
        const th = document.createElement('th');
        if (searchVal && h.toLowerCase().includes(searchVal.toLowerCase())) th.classList.add('highlight-red');
        if (sortKey === h) th.classList.add('sort-active');
        th.onclick = () => { sortTable(h); };
        const arrow = sortKey === h ? (sortType === 'asc' ? ' ↑' : ' ↓') : '';
        th.innerHTML = h + arrow;
        headerRow.appendChild(th);
        
        // 第二行：统计值
        const td = document.createElement('td');
        td.style.fontSize = '11px';
        td.style.fontWeight = 'normal';
        td.style.backgroundColor = '#f5f7fc';
        td.style.borderBottom = '1px solid #dce3ec';
        
        if (h === '年份') {
            td.innerHTML = '📅 年份范围';
        } else if (h === '地区') {
            td.innerHTML = '📍 地区列表';
        } else if (stats[h]) {
            td.innerHTML = `<span title="总和">Σ ${stats[h].sum}</span> | <span title="平均值">μ ${stats[h].avg}</span> | <span title="中位数">M ${stats[h].median}</span>`;
            td.title = `最小值: ${stats[h].min} | 最大值: ${stats[h].max}`;
        } else {
            td.innerHTML = '-';
        }
        statsRow.appendChild(td);
    });
    
    thead.appendChild(headerRow);
    thead.appendChild(statsRow);
    
    // 构建数据行
    const tbody = document.createElement('tbody');
    pageData.forEach(row => {
        const tr = document.createElement('tr');
        visible.forEach(h => {
            const td = document.createElement('td');
            let txt = row[h] ?? '';
            if (searchVal) {
                const regex = new RegExp(`(${escapeRegex(searchVal)})`, 'gi');
                txt = String(txt).replace(regex, `<span class="highlight-red">$1</span>`);
            }
            td.innerHTML = txt;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    
    const table = document.getElementById('data-table');
    if (table) {
        table.innerHTML = '';
        table.appendChild(thead);
        table.appendChild(tbody);
        document.getElementById('page-current').innerText = currentPage;
        document.getElementById('page-goto').max = totalPages;
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) tableContainer.scrollTop = 0;
    }
}
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sortTable(key) {
    if (sortKey === key) sortType = sortType === "asc" ? "desc" : "asc";
    else { sortKey = key; sortType = "asc"; }
    currentPage = 1;
    applyFilterAndSort();
    renderTablePage();
}
function goFirstPage() { currentPage = 1; renderTablePage(); }
function goPrevPage() { if (currentPage > 1) { currentPage--; renderTablePage(); } }
function goNextPage() { if (currentPage < totalPages) { currentPage++; renderTablePage(); } }
function goLastPage() { currentPage = totalPages; renderTablePage(); }
function goToPage() { let p = parseInt(document.getElementById("page-goto").value); if (!isNaN(p) && p>=1 && p<=totalPages) { currentPage = p; renderTablePage(); } }
function exportData(type) {
    const ws = XLSX.utils.json_to_sheet(filteredRowsForPage);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, currentSheet);
    XLSX.writeFile(wb, `${currentSheet}_data.${type === "csv" ? "csv" : "xlsx"}`);
}
function printTable() { window.print(); }
function exportChart(chartInstance, type, filename) {
    if (!chartInstance) return;
    let url;
    if (type === 'png') url = chartInstance.getDataURL({ type: 'png', pixelRatio: 2 });
    else if (type === 'jpg') url = chartInstance.getDataURL({ type: 'jpg', pixelRatio: 2 });
    else if (type === 'svg') url = chartInstance.getDataURL({ type: 'svg' });
    else return;
    const link = document.createElement('a');
    link.download = `${filename}.${type}`;
    link.href = url;
    link.click();
}
// ========== 高级图表模块（卡片式） ==========
let activeChart = null;
let currentChartInstance = null;

// 辅助函数（实时从 workbook 读取）
function getYears(table = 'province') {
    if (!window.workbook) return [];
    if (table === 'province') {
        return [...new Set(window.workbook['省份'].map(r => r['年份']))].sort();
    } else {
        return [...new Set(window.workbook['地级市'].map(r => r['时间']))].sort();
    }
}
function cleanMetricName(key) {
    return key.replace(/[（(].*?[）)]/g, '').trim();
}
function getAllMetrics(table = 'province') {
    if (!window.workbook) return [];
    let sample = null;
    if (table === 'province') {
        sample = window.workbook['省份']?.[0];
    } else {
        sample = window.workbook['地级市']?.[0];
    }
    if (!sample) return [];
    return Object.keys(sample).filter(k => k !== '年份' && k !== '地区' && k !== '时间地区' && typeof sample[k] === 'number');
}

function getAllRegions(table = 'province') {
    if (!window.workbook) return [];
    if (table === 'province') {
        return [...new Set(window.workbook['省份'].map(r => r['地区']))].sort();
    } else if (table === 'city') {
        return [...new Set(window.workbook['地级市'].map(r => r['地区']))].sort();
    }
    return [];
}

// 默认配置
const DEFAULT_YEAR = 2023;
const DEFAULT_METRICS = ['科学支出水平', '工业机器人密度', '实用新型专利申请授权数'];
let DEFAULT_REGIONS = [];

function updateDefaultRegions() {
    const all = getAllRegions();
    DEFAULT_REGIONS = all.slice(0, Math.min(10, all.length));
}

// 创建普通下拉组
function createSelectGroup(label, id, options, defaultValue) {
    const div = document.createElement('div');
    div.className = 'control-group';
    div.innerHTML = `<span>${label}:</span><select id="${id}">${options.map(v => `<option value="${v}" ${v === defaultValue ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    return div;
}

// 创建多选下拉组
function createMultiSelectGroup(label, id, options, defaultSelected) {
    const div = document.createElement('div');
    div.className = 'control-group';
    div.innerHTML = `<span>${label}:</span>
        <div class="multi-select-container">
            <select id="${id}" multiple size="4" class="multi-select">
                ${options.map(v => `<option value="${v}" ${defaultSelected.includes(v) ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <div class="multi-select-buttons">
                <button type="button" class="btn-xs select-all">全选</button>
                <button type="button" class="btn-xs clear-all">清空</button>
            </div>
        </div>`;
    const select = div.querySelector('select');
    div.querySelector('.select-all').onclick = () => { Array.from(select.options).forEach(opt => opt.selected = true); };
    div.querySelector('.clear-all').onclick = () => { Array.from(select.options).forEach(opt => opt.selected = false); };
    return div;
}

// 渲染控制栏
function renderControls(type) {
    const container = document.getElementById('analysis-controls');
    if (!container) return;
    container.innerHTML = '';
    
    if (type === 'scatter') {
    const years = getYears();
    const metrics = getAllMetrics();
    const regions = getAllRegions();
    
    // 年份（默认最近一年）
    const defaultYear = years.includes(2023) ? 2023 : years[years.length - 1];
    const yearDiv = document.createElement('div');
    yearDiv.className = 'control-group';
    yearDiv.innerHTML = `<span>年份：</span><select id="scatter-year">${years.map(y => `<option value="${y}" ${y === defaultYear ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
    container.appendChild(yearDiv);
    
    // X轴指标（默认第一个）
    const defaultX = metrics[0];
    const xDiv = document.createElement('div');
    xDiv.className = 'control-group';
    xDiv.innerHTML = `<span>X轴指标：</span><select id="scatter-x">${metrics.map(m => `<option value="${m}" ${m === defaultX ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
    container.appendChild(xDiv);
    
    // Y轴指标（默认第二个，如果有）
    const defaultY = metrics[1] || metrics[0];
    const yDiv = document.createElement('div');
    yDiv.className = 'control-group';
    yDiv.innerHTML = `<span>Y轴指标：</span><select id="scatter-y">${metrics.map(m => `<option value="${m}" ${m === defaultY ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
    container.appendChild(yDiv);
    
    // 地区多选（默认选中前 6 个地区）
    const defaultRegions = regions.slice(0, 6);
    const regionDiv = document.createElement('div');
    regionDiv.className = 'control-group';
    regionDiv.innerHTML = `
        <span>地区：</span>
        <select id="scatter-regions" multiple size="4" style="min-width: 180px;">
            ${regions.map(r => `<option value="${r}" ${defaultRegions.includes(r) ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <button type="button" class="btn-xs" id="scatter-select-all">全选</button>
        <button type="button" class="btn-xs" id="scatter-clear-all">清空</button>
        <span style="font-size: 11px; color: #888; margin-left: 8px;">💡 按住 Ctrl 可多选</span>
    `;
    container.appendChild(regionDiv);
    
    // 生成按钮
    const btn = document.createElement('button');
    btn.innerText = '生成散点图';
    btn.className = 'btn-sm';
    btn.onclick = () => loadChart(type);
    container.appendChild(btn);
    
    // 绑定全选/清空
    setTimeout(() => {
        const selectAll = document.getElementById('scatter-select-all');
        const clearAll = document.getElementById('scatter-clear-all');
        const selectEl = document.getElementById('scatter-regions');
        if (selectAll) selectAll.onclick = () => { Array.from(selectEl.options).forEach(opt => opt.selected = true); };
        if (clearAll) clearAll.onclick = () => { Array.from(selectEl.options).forEach(opt => opt.selected = false); };
    }, 50);
}
}


// 加载图表数据
async function loadChart(type) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    if (currentChartInstance) currentChartInstance.dispose();
    
    if (type === 'scatter') {
        const year = parseInt(document.getElementById('scatter-year')?.value) || 2023;
        const xMetric = document.getElementById('scatter-x')?.value;
        const yMetric = document.getElementById('scatter-y')?.value;
        const regions = Array.from(document.getElementById('scatter-regions')?.selectedOptions || []).map(o => o.value);
        
        if (!xMetric || !yMetric) { alert('请选择 X 和 Y 轴指标'); return; }
        if (!regions.length) { alert('请至少选择一个地区'); return; }
        
        const res = await fetch('/api/scatter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, xMetric, yMetric, regions })
        });
        const data = await res.json();
        
        const option = {
            title: { text: `${xMetric} vs ${yMetric} (${year}年)`, left: 'center' },
            xAxis: { name: data.xName, nameLocation: 'middle', nameGap: 35 },
            yAxis: { name: data.yName, nameLocation: 'middle', nameGap: 35 },
            series: [{
                type: 'scatter',
                data: data.data,
                symbolSize: 12,
                label: { show: true, formatter: p => p.data[2], position: 'top', offset: [0, -8], fontSize: 10 },
                itemStyle: { color: '#ee6666' }
            }]
        };
        
        currentChartInstance = echarts.init(chartDom);
        currentChartInstance.setOption(option);
        setTimeout(() => currentChartInstance.resize(), 100);
    }
}

// 打开分析面板
function openAnalysisPanel(type) {
    activeChart = type;
    const panel = document.getElementById('analysis-panel');
    if (!panel) return;
    const titleMap = {
        scatter: '⚫ 散点图 - 两指标关联分析'
    };
    document.getElementById('panel-title').innerText = titleMap[type] || type;
    panel.style.display = 'block';
    renderControls(type);
    
    // 自动加载默认图表（等待控件渲染完成）
    setTimeout(() => {
        loadChart(type);
        bindExportEvents();
    }, 100);
}

// 导出图表函数
function exportChart(format) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    const chart = echarts.getInstanceByDom(chartDom);
    if (!chart) {
        alert('图表尚未加载完成');
        return;
    }
    let url;
    if (format === 'png') {
        url = chart.getDataURL({ type: 'png', pixelRatio: 2 });
    } else if (format === 'jpg') {
        url = chart.getDataURL({ type: 'jpg', pixelRatio: 2 });
    } else {
        url = chart.getDataURL({ type: 'svg' });
    }
    const link = document.createElement('a');
    link.download = `chart_${activeChart}_${Date.now()}.${format}`;
    link.href = url;
    link.click();
}

function bindExportEvents() {
    const pngBtn = document.getElementById('export-chart-png');
    const jpgBtn = document.getElementById('export-chart-jpg');
    const svgBtn = document.getElementById('export-chart-svg');
    if (pngBtn) pngBtn.onclick = () => exportChart('png');
    if (jpgBtn) jpgBtn.onclick = () => exportChart('jpg');
    if (svgBtn) svgBtn.onclick = () => exportChart('svg');
}

// 初始化卡片事件
function initAnalysisCards() {
    const cards = document.querySelectorAll('.card-item');
    cards.forEach(card => {
        card.removeEventListener('click', card._clickHandler);
        const handler = () => openAnalysisPanel(card.dataset.chart);
        card.addEventListener('click', handler);
        card._clickHandler = handler;
    });
    const closeBtn = document.getElementById('close-panel');
    if (closeBtn) {
        closeBtn.onclick = () => {
            const panel = document.getElementById('analysis-panel');
            if (panel) panel.style.display = 'none';
            if (currentChartInstance) { currentChartInstance.dispose(); currentChartInstance = null; }
        };
    }
}

// 等待数据加载完成后初始化
function waitForWorkbook() {
    if (window.workbook && window.workbook['省份'] && window.workbook['省份'].length) {
        initAnalysisCards();
        updateDefaultRegions();
    } else {
        setTimeout(waitForWorkbook, 300);
    }
}
function updateTableStats(rows) {
    if (!rows || !rows.length) {
        document.querySelectorAll('#table-stats span[id^="stat-"]').forEach(el => el.innerText = '-');
        return;
    }
    // 记录数
    document.getElementById('stat-count').innerText = rows.length;
    // 年份范围
    const years = rows.map(r => r['年份']).filter(v => v);
    if (years.length) {
        document.getElementById('stat-year').innerText = `${Math.min(...years)} - ${Math.max(...years)}`;
    }
    // 数值指标数（从第一行计算）
    const sample = rows[0];
    const numMetrics = Object.keys(sample).filter(k => k !== '年份' && k !== '地区' && typeof sample[k] === 'number').length;
    document.getElementById('stat-metrics').innerText = numMetrics;
    
    // 科学支出水平：总和
    const scienceSum = rows.reduce((s, r) => s + (r['科学支出水平'] || 0), 0);
    document.getElementById('stat-science').innerText = scienceSum.toFixed(2);
    
    // 工业机器人密度：平均值
    const robotVals = rows.map(r => r['工业机器人密度']).filter(v => typeof v === 'number');
    const robotAvg = robotVals.length ? (robotVals.reduce((a,b) => a+b,0) / robotVals.length).toFixed(2) : '-';
    document.getElementById('stat-robot').innerText = robotAvg;
    
    // 普通高校数量：中位数
    const univVals = rows.map(r => r['普通高校数量']).filter(v => typeof v === 'number').sort((a,b) => a-b);
    let univMedian = '-';
    if (univVals.length) {
        const mid = Math.floor(univVals.length / 2);
        univMedian = univVals.length % 2 === 0 ? ((univVals[mid-1] + univVals[mid]) / 2).toFixed(0) : univVals[mid].toFixed(0);
    }
    document.getElementById('stat-univ').innerText = univMedian;
}

// 启动
waitForWorkbook();
function bindEvents() {
    document.getElementById("chart-type").onchange = () => renderMainChart();
    document.getElementById("apply-set").onclick = () => {
        custom.title = document.getElementById("chart-title").value || "auto";
        custom.xName = document.getElementById("x-name").value || "auto";
        custom.yName = document.getElementById("y-name").value || "auto";
        custom.yMax = document.getElementById("y-max").value || "auto";
        renderMainChart();
    };
    document.getElementById("reset-set").onclick = () => {
        custom = { title: "auto", xName: "auto", yName: "auto", yMax: "auto" };
        document.getElementById("chart-title").value = "";
        document.getElementById("x-name").value = "";
        document.getElementById("y-name").value = "";
        document.getElementById("y-max").value = "";
        renderMainChart();
    };
    document.getElementById("export-csv").onclick = () => exportData("csv");
    document.getElementById("export-excel").onclick = () => exportData("xlsx");
    document.getElementById("print-table").onclick = printTable;
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        const debouncedSearch = debounce(() => {
            currentPage = 1;
            applyFilterAndSort();
            renderTablePage();
        }, 200);
        searchInput.addEventListener("input", debouncedSearch);
    }
    const scaleInput = document.getElementById("table-scale");
    if (scaleInput) {
        scaleInput.oninput = () => {
            const scale = parseFloat(scaleInput.value);
            const tableWrap = document.querySelector(".table-wrap");
            if (tableWrap) tableWrap.style.transform = `scale(${scale})`;
            document.getElementById("scale-text").innerText = `${Math.round(scale * 100)}%`;
            let newPageSize = Math.floor(20 + (scale - 0.6) / 0.6 * 80);
            newPageSize = Math.min(100, Math.max(20, newPageSize));
            if (newPageSize !== pageSize) {
                pageSize = newPageSize;
                const pageSizeSelect = document.getElementById("page-size-select");
                if (pageSizeSelect) pageSizeSelect.value = pageSize;
                currentPage = 1;
                applyFilterAndSort();
                renderTablePage();
            }
        };
    }
    document.getElementById("page-first").onclick = goFirstPage;
    document.getElementById("page-prev").onclick = goPrevPage;
    document.getElementById("page-next").onclick = goNextPage;
    document.getElementById("page-last").onclick = goLastPage;
    document.getElementById("page-go").onclick = goToPage;
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) pageSizeSelect.onchange = (e) => {
        pageSize = parseInt(e.target.value);
        currentPage = 1;
        applyFilterAndSort();
        renderTablePage();
    };
    document.getElementById("clear-sort").onclick = () => {
        sortKey = "";
        sortType = "asc";
        currentPage = 1;
        applyFilterAndSort();
        renderTablePage();
    };
    document.getElementById("reset-table").onclick = () => {
        const searchInput = document.getElementById("search-input");
        if (searchInput) searchInput.value = "";
        sortKey = "";
        sortType = "asc";
        currentPage = 1;
        pageSize = 20;
        const pageSizeSelect = document.getElementById("page-size-select");
        if (pageSizeSelect) pageSizeSelect.value = "20";
        applyFilterAndSort();
        renderTablePage();
    };
    document.getElementById("export-main-png").onclick = () => exportChart(mainChart, 'png', 'main_chart');
    document.getElementById("export-main-jpg").onclick = () => exportChart(mainChart, 'jpg', 'main_chart');
    document.getElementById("export-main-svg").onclick = () => exportChart(mainChart, 'svg', 'main_chart');
    document.getElementById("export-pie-png").onclick = () => exportChart(pieChart, 'png', 'pie_chart');
    document.getElementById("export-pie-jpg").onclick = () => exportChart(pieChart, 'jpg', 'pie_chart');
    document.getElementById("export-pie-svg").onclick = () => exportChart(pieChart, 'svg', 'pie_chart');
    document.getElementById("export-adv-png").onclick = () => exportChart(advancedChart, 'png', 'advanced_chart');
    document.getElementById("export-adv-jpg").onclick = () => exportChart(advancedChart, 'jpg', 'advanced_chart');
    document.getElementById("export-adv-svg").onclick = () => exportChart(advancedChart, 'svg', 'advanced_chart');
    const chatInput = document.getElementById('chat-input');
if (chatInput) {
    chatInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault(); // 防止表单提交或换行
            document.getElementById('chat-send').click();
        }
    });}
}

// 启动
init();