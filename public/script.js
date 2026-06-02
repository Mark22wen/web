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

function escapeHtml(str) {
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ======================= Landing Page & RAG 全屏界面 =======================

let threeScene = null;

function initLanding() {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas || threeScene) return;
    
    const scene = new THREE.Scene();
    threeScene = scene;
    
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    // ---- 多层粒子系统 ----
    const particlesCount = 2200;
    const posArray = new Float32Array(particlesCount * 3);
    const colorArray = new Float32Array(particlesCount * 3);
    const speedArray = new Float32Array(particlesCount); // individual drift speeds
    const sizeArray = new Float32Array(particlesCount);

    const palette = [
        [0.79, 0.66, 0.30],  // academic gold
        [0.85, 0.75, 0.38],  // bright gold
        [0.70, 0.50, 0.18],  // amber
        [0.90, 0.82, 0.50],  // light gold
    ];
    
    for (let i = 0; i < particlesCount; i++) {
        const i3 = i * 3;
        // Distribute in a wider, flatter space
        posArray[i3]   = (Math.random() - 0.5) * 60;
        posArray[i3+1] = (Math.random() - 0.5) * 40;
        posArray[i3+2] = (Math.random() - 0.5) * 30;
        
        const col = palette[Math.floor(Math.random() * palette.length)];
        colorArray[i3]   = col[0] + Math.random() * 0.15;
        colorArray[i3+1] = col[1] + Math.random() * 0.15;
        colorArray[i3+2] = col[2] + Math.random() * 0.08;
        
        speedArray[i] = 0.3 + Math.random() * 0.7;
        sizeArray[i] = 0.05 + Math.random() * 0.1;
    }
    
    const particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    particlesGeometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    
    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.07,
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    
    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);
    
    // ---- Connection lines system (LineSegments) ----
    const MAX_LINES = 800;
    const linePositions = new Float32Array(MAX_LINES * 6); // 2 points * xyz
    const lineColors = new Float32Array(MAX_LINES * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const linesMesh = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(linesMesh);
    
    // ---- Floating rings (orbit decorators) ----
    function makeRing(radius, color, tilt) {
        const pts = [];
        for (let i = 0; i <= 128; i++) {
            const a = (i / 128) * Math.PI * 2;
            pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.3, 0));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending });
        const ring = new THREE.Line(geo, mat);
        ring.rotation.x = tilt;
        scene.add(ring);
        return ring;
    }
    const rings = [
        makeRing(12, 0x667eea, 0.4),
        makeRing(18, 0x764ba2, -0.3),
        makeRing(24, 0x4facfe, 0.6),
    ];
    
    camera.position.z = 5;
    
    let mouseX = 0, mouseY = 0;
    let targetMouseX = 0, targetMouseY = 0;
    document.addEventListener('mousemove', (e) => {
        targetMouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        targetMouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    });
    
    let clock = new THREE.Clock();
    let animationId = null;
    
    function updateConnectionLines(pos, count) {
        let lineIdx = 0;
        const CONNECT_DIST = 8.0;
        const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
        // Only check subset for performance
        const step = Math.max(1, Math.floor(count / 300));
        
        for (let i = 0; i < count && lineIdx < MAX_LINES; i += step) {
            const ax = pos[i*3], ay = pos[i*3+1], az = pos[i*3+2];
            for (let j = i + step; j < count && lineIdx < MAX_LINES; j += step) {
                const dx = ax - pos[j*3], dy = ay - pos[j*3+1], dz = az - pos[j*3+2];
                const distSq = dx*dx + dy*dy + dz*dz;
                if (distSq < CONNECT_DIST_SQ) {
                    const alpha = 1 - distSq / CONNECT_DIST_SQ;
                    const l6 = lineIdx * 6;
                    linePositions[l6]   = ax; linePositions[l6+1] = ay; linePositions[l6+2] = az;
                    linePositions[l6+3] = pos[j*3]; linePositions[l6+4] = pos[j*3+1]; linePositions[l6+5] = pos[j*3+2];
                    const c = alpha * 0.5;
                    lineColors[l6]=0.79*c; lineColors[l6+1]=0.66*c; lineColors[l6+2]=0.30*c;
                    lineColors[l6+3]=0.79*c; lineColors[l6+4]=0.66*c; lineColors[l6+5]=0.30*c;
                    lineIdx++;
                }
            }
        }
        // Clear unused lines
        for (let k = lineIdx; k < MAX_LINES; k++) {
            const l6 = k * 6;
            linePositions[l6] = linePositions[l6+1] = linePositions[l6+2] = 0;
            linePositions[l6+3] = linePositions[l6+4] = linePositions[l6+5] = 0;
        }
        lineGeo.attributes.position.needsUpdate = true;
        lineGeo.attributes.color.needsUpdate = true;
    }
    
    let lineTimer = 0;
    
    function animate() {
        animationId = requestAnimationFrame(animate);
        const elapsed = clock.getElapsedTime();
        const delta = clock.getDelta ? 0.016 : 0.016;
        
        // Smooth mouse follow
        mouseX += (targetMouseX - mouseX) * 0.04;
        mouseY += (targetMouseY - mouseY) * 0.04;
        
        // Particle drift + wave
        const pos = particlesGeometry.attributes.position.array;
        for (let i = 0; i < particlesCount; i++) {
            const i3 = i * 3;
            // Gentle vertical drift
            pos[i3+1] += Math.sin(elapsed * speedArray[i] * 0.4 + i * 0.02) * 0.002;
            // Horizontal wave
            pos[i3]   += Math.cos(elapsed * speedArray[i] * 0.2 + i * 0.015) * 0.001;
            // Wrap bounds
            if (pos[i3+1] > 20) pos[i3+1] = -20;
            if (pos[i3+1] < -20) pos[i3+1] = 20;
            if (pos[i3] > 30) pos[i3] = -30;
            if (pos[i3] < -30) pos[i3] = 30;
        }
        particlesGeometry.attributes.position.needsUpdate = true;
        
        // Slow rotation + mouse parallax
        particlesMesh.rotation.y = elapsed * 0.04 + mouseX * 0.12;
        particlesMesh.rotation.x = elapsed * 0.015 + mouseY * 0.08;
        
        // Ring animations
        rings[0].rotation.z = elapsed * 0.08;
        rings[1].rotation.z = -elapsed * 0.06;
        rings[2].rotation.z = elapsed * 0.05;
        rings.forEach(r => { r.rotation.y = mouseX * 0.3; r.rotation.x = mouseY * 0.2; });
        
        // Update connection lines every ~6 frames for perf
        lineTimer++;
        if (lineTimer % 6 === 0) {
            updateConnectionLines(pos, Math.min(particlesCount, 800));
            linesMesh.rotation.copy(particlesMesh.rotation);
        }
        
        renderer.render(scene, camera);
    }
    animate();
    
    window.addEventListener('resize', () => {
        if (document.getElementById('landing-page')?.style.display === 'none') return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
    
    const observer = new MutationObserver(() => {
        const landing = document.getElementById('landing-page');
        if (landing && landing.style.display === 'none' && animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    });
    observer.observe(document.body, { attributes: true, subtree: true });
}

function showLanding() {
    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    const rag = document.getElementById('rag-fullscreen');
    const fab = document.getElementById('chat-float-btn');
    
    if (dp) { dp.style.opacity = '0'; dp.style.transform = 'translateY(12px)'; }
    
    setTimeout(() => {
        if (lp) { lp.style.display = 'block'; lp.style.opacity = '0'; requestAnimationFrame(() => { lp.style.transition = 'opacity 0.35s ease'; lp.style.opacity = '1'; }); }
        if (dp) dp.style.display = 'none';
        if (rag) rag.style.display = 'none';
        if (fab) fab.style.display = 'none';
    }, 50);
    
    initLanding();
}

function scrollToFeatures() {
    const el = document.getElementById('features-section');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function enterDashboard(tab) {
    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    const fab = document.getElementById('chat-float-btn');
    
    if (lp) {
        lp.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        lp.style.opacity = '0';
        lp.style.transform = 'scale(0.98)';
    }
    
    setTimeout(() => {
        if (lp) lp.style.display = 'none';
        if (dp) {
            dp.style.display = 'block';
            dp.style.opacity = '0';
            dp.style.transform = 'translateY(14px)';
            requestAnimationFrame(() => {
                dp.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.4,0,0.2,1)';
                dp.style.opacity = '1';
                dp.style.transform = 'translateY(0)';
            });
        }
        if (fab) {
            fab.style.display = 'flex'; fab.style.opacity = '0';
            setTimeout(() => { fab.style.transition = 'opacity 0.3s'; fab.style.opacity = '1'; }, 200);
        }
        
        // Route to specific section based on tab
        if (tab === 'rag') {
            setTimeout(openRagFullscreen, 300);
        } else if (tab === 'pie') {
            // Make sure pie card is visible and scroll to it
            setTimeout(() => {
                const pie = document.getElementById('section-pie');
                if (pie) { pie.style.display = 'block'; pie.scrollIntoView({behavior:'smooth',block:'start'}); }
            }, 400);
        } else if (tab === 'scatter') {
            setTimeout(() => {
                const sc = document.getElementById('section-scatter');
                if (sc) { sc.style.display = 'block'; sc.scrollIntoView({behavior:'smooth',block:'start'}); openAnalysisPanel('scatter'); }
            }, 400);
        }
        // 'rank' and default just show dashboard normally
    }, 280);
}

function enterDashboardWithQuery() {
    const query = document.getElementById('landing-query')?.value.trim();
    if (query) {
        sessionStorage.setItem('rag_initial_query', query);
        enterDashboard('rag');
    }
}

function setLandingQuery(q) {
    const input = document.getElementById('landing-query');
    if (input) input.value = q;
}

// ======================= RAG 全屏界面 =======================

function openRagFullscreen() {
    const rag = document.getElementById('rag-fullscreen');
    if (!rag) return;
    
    rag.style.display = 'flex';
    document.getElementById('chat-float-btn').style.display = 'none';
    
    // Init session if needed
    if (!currentSessionId) {
        if (sessions.length) {
            switchSession(sessions[0].id);
        } else {
            startNewSession();
        }
    } else {
        renderSessionList();
    }
    
    // 检查初始查询
    const initialQuery = sessionStorage.getItem('rag_initial_query');
    if (initialQuery) {
        sessionStorage.removeItem('rag_initial_query');
        const input = document.getElementById('rag-input');
        if (input) {
            input.value = initialQuery;
            setTimeout(sendRagMessage, 200);
        }
    }
    
    setTimeout(() => document.getElementById('rag-input')?.focus(), 100);
}

function closeRagFullscreen() {
    const rag = document.getElementById('rag-fullscreen');
    if (rag) rag.style.display = 'none';
    document.getElementById('chat-float-btn').style.display = 'flex';
}

function sendRagQuick(question) {
    const input = document.getElementById('rag-input');
    if (input) {
        input.value = question;
        sendRagMessage();
    }
}

let isRagStreaming = false;

// ===== Multi-session conversation management =====
let sessions = JSON.parse(localStorage.getItem('rag_sessions') || '[]');
let currentSessionId = null;

function createSession(title) {
    const id = 'sess_' + Date.now();
    const session = { id, title: title || '新对话', messages: [], createdAt: Date.now() };
    sessions.unshift(session);
    if (sessions.length > 20) sessions = sessions.slice(0, 20); // max 20 sessions
    saveSessions();
    return session;
}

function saveSessions() {
    try { localStorage.setItem('rag_sessions', JSON.stringify(sessions)); } catch(e) {}
}

function getCurrentSession() {
    return sessions.find(s => s.id === currentSessionId);
}

function switchSession(id) {
    currentSessionId = id;
    const session = getCurrentSession();
    if (!session) return;
    
    // Render messages
    const container = document.getElementById('rag-messages');
    if (!container) return;
    container.innerHTML = '';
    
    if (!session.messages.length) {
        container.innerHTML = `<div class="rag-welcome">
            <div class="rag-welcome-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><use href="#ico-brain"/></svg></div>
            <h2>我是你的数据分析助手</h2>
            <p>查询数据 · 分析趋势 · 对比地区 · 预测未来</p>
        </div>`;
    } else {
        session.messages.forEach(msg => {
            const div = document.createElement('div');
            div.className = 'rag-message ' + msg.role;
            const avatarHtml = msg.role === 'user' 
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-user"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-brain"/></svg>';
            div.innerHTML = '<div class="rag-avatar">' + avatarHtml + '</div><div class="rag-bubble">' + (msg.role === 'user' ? escapeHtml(msg.content) : msg.html || escapeHtml(msg.content)) + '</div>';
            container.appendChild(div);
        });
        container.scrollTop = container.scrollHeight;
    }
    
    renderSessionList();
}

function renderSessionList() {
    const list = document.getElementById('rag-session-list');
    if (!list) return;
    
    if (!sessions.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px 0;">暂无对话</div>';
        return;
    }
    
    list.innerHTML = sessions.map(s => {
        const isActive = s.id === currentSessionId;
        const msgCount = s.messages.filter(m => m.role === 'user').length;
        const shortTitle = s.title.length > 22 ? s.title.slice(0,20) + '…' : s.title;
        return '<div class="session-item' + (isActive ? ' active' : '') + '" data-session-id="' + s.id + '">'
            + '<div class="session-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-msg"/></svg></div>'
            + '<div class="session-title">' + escapeHtml(shortTitle) + '</div>'
            + '<div class="session-meta">' + msgCount + ' 条</div>'
            + '<button class="session-delete" data-delete-id="' + s.id + '" title="删除">×</button>'
            + '</div>';
    }).join('');
}

// Session event delegation
document.addEventListener('click', function(e) {
    const item = e.target.closest('.session-item[data-session-id]');
    const del = e.target.closest('.session-delete[data-delete-id]');
    
    if (del) {
        e.stopPropagation();
        const id = del.dataset.deleteId;
        sessions = sessions.filter(s => s.id !== id);
        saveSessions();
        if (currentSessionId === id) {
            if (sessions.length) switchSession(sessions[0].id);
            else { currentSessionId = null; renderSessionList(); }
        } else {
            renderSessionList();
        }
        return;
    }
    
    if (item) {
        const id = item.dataset.sessionId;
        if (id !== currentSessionId) switchSession(id);
    }
});

function startNewSession() {
    const session = createSession('新对话');
    switchSession(session.id);
}

// Compat: legacy ragHistory alias
Object.defineProperty(window, 'ragHistory', {
    get() { const s = getCurrentSession(); return s ? s.messages : []; }
});

async function sendRagMessage() {
    const input = document.getElementById('rag-input');
    const question = input?.value.trim();
    if (!question || isRagStreaming) return;
    
    // 添加用户消息
    addRagMessage('user', question);
    input.value = '';
    input.style.height = 'auto';
    
    // 添加助手占位
    const assistantBubble = addRagMessage('assistant', '', true);
    isRagStreaming = true;
    
    const sendBtn = document.getElementById('rag-send');
    if (sendBtn) sendBtn.disabled = true;
    
    // 更新上下文提示
    const hint = document.getElementById('rag-context-hint');
    if (hint) hint.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-search"/></svg><span>正在检索数据...</span>';
    
    try {
        const response = await fetch('/api/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question })
        });
        
        const data = await response.json();
        
        if (hint) {
            const citationCount = data.citations?.length || 0;
            hint.textContent = citationCount > 0 
                ? `基于 ${citationCount} 个数据源生成回答` 
                : '回答生成完成';
        }
        
        // 构建HTML
        let html = '';
        
        // 思维链
        if (data.reasoning && data.reasoning.length > 0) {
            html += `<div class="rag-reasoning">
                <div class="rag-reasoning-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><use href="#ico-brain"/></svg> 分析过程</div>
                ${data.reasoning.slice(0, 4).map(r => `<div style="margin-bottom:4px;">· ${escapeHtml(String(r))}</div>`).join('')}
            </div>`;
        }
        
        // 主回答
        html += `<div class="rag-answer-content">${formatAnswer(data.answer || '无回答')}</div>`;
        
        // 引用
        if (data.citations && data.citations.length > 0) {
            html += `<div class="rag-citations">
                <div style="font-size:.73rem;color:var(--c-muted);margin-bottom:6px;display:flex;align-items:center;gap:5px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-src"/></svg>数据来源：</div>
                ${data.citations.map(c => `<span class="rag-citation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><use href="#ico-src"/></svg>${escapeHtml(c)}</span>`).join('')}
            </div>`;
        }
        
        assistantBubble.innerHTML = html;
        assistantBubble.classList.remove('streaming-cursor');
        
        // 图表：直接渲染在当前气泡内（内联显示，html设置后再渲染）
        if (data.chart && data.chart.metric) {
            setTimeout(() => renderAgentChart(data.chart, assistantBubble), 80);
        }
        
        // 保存到当前 session
        const session = getCurrentSession();
        if (session) {
            // Auto-title from first message
            if (session.messages.length === 0) {
                session.title = question.slice(0, 30);
            }
            session.messages.push({ role: 'user', content: question });
            session.messages.push({ role: 'assistant', content: data.answer || '', html: html });
            saveSessions();
            renderSessionList();
        }
        
    } catch (err) {
        console.error('RAG错误:', err);
        if (hint) hint.textContent = '连接失败';
        assistantBubble.innerHTML = `<div style="color: var(--danger);">
            <div style="font-weight:600;margin-bottom:8px;color:var(--c-danger)">连接失败</div>
            <div>请确保后端服务已启动（node server.js）</div>
            <div style="font-size:0.8rem;margin-top:8px;color:var(--text-muted);">错误: ${escapeHtml(err.message)}</div>
        </div>`;
        assistantBubble.classList.remove('streaming-cursor');
    } finally {
        isRagStreaming = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}



// 事件委托：图表按钮点击（全局，不依赖 inline onclick）
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.rag-chart-btn[data-chart-id]');
    if (!btn) return;
    const chartId = btn.dataset.chartId;
    const config = window._chartConfigs && window._chartConfigs[chartId];
    if (config) renderAgentChart(config);
});

function addRagMessage(role, content, isPlaceholder = false) {
    const container = document.getElementById('rag-messages');
    if (!container) return null;
    
    // 移除欢迎语
    const welcome = container.querySelector('.rag-welcome');
    if (welcome) welcome.remove();
    
    const div = document.createElement('div');
    div.className = `rag-message ${role}`;
    
    const avatarHtml = role === 'user' 
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-user"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-brain"/></svg>';
    const bubbleClass = isPlaceholder ? ' streaming-cursor' : '';
    
    div.innerHTML = `
        <div class="rag-avatar">${avatarHtml}</div>
        <div class="rag-bubble${bubbleClass}">${content}</div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    return div.querySelector('.rag-bubble');
}

function updateRagHistory() {
    // Now handled by renderSessionList()
    const session = getCurrentSession();
    if (session) renderSessionList();
}

// 事件委托：历史记录点击（全局只注册一次）
(function(){
    let _histDelegateReady = false;
    function setupHistDelegate() {
        if (_histDelegateReady) return;
        _histDelegateReady = true;
        document.addEventListener('click', function(e) {
            const item = e.target.closest('#rag-history-list [data-hidx]');
            if (!item) return;
            const list = document.getElementById('rag-history-list');
            const idx = parseInt(item.dataset.hidx);
            if (list && list._msgs && list._msgs[idx]) {
                sendRagQuick(list._msgs[idx].content);
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupHistDelegate);
    } else {
        setupHistDelegate();
    }
})();

function renderAgentChartFromRag(configStr) {
    try {
        const config = JSON.parse(configStr.replace(/&quot;/g, '"'));
        renderAgentChart(config);
    } catch (e) {
        console.error('图表配置解析失败:', e);
    }
}

// ======================= 原有聊天面板兼容（隐藏，用新版替代）=======================

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatStop = document.getElementById('chat-stop');

let currentController = null;

function addMessage(role, content, isStreaming = false) {
    if (!chatMessages) return null;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    messageDiv.innerHTML = `<div class="message-role">${role === 'user' ? '👤 你' : '🤖 助手'}</div><div class="message-content">${content}</div>`;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    if (isStreaming) {
        return (newContent) => {
            const contentDiv = messageDiv.querySelector('.message-content');
            if (contentDiv) {
                contentDiv.innerHTML = formatAnswer(newContent);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        };
    }
    return null;
}

// ======================= Agent 内联图表渲染（在对话气泡中直接显示）=======================

// Chart instance registry: chartId → echarts instance
const _inlineChartInstances = {};

/* ─── Chart Modal System ──────────────────────────────── */

let _chartModalInstance = null;  // active ECharts instance in modal

function _getOrCreateModal() {
    if (document.getElementById('chart-modal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'chart-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div id="chart-modal-panel">
        <div id="chart-modal-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-chart-bar"/></svg>
          <span id="chart-modal-title">图表详情</span>
          <button id="chart-modal-close" title="关闭 (Esc)">✕</button>
        </div>
        <div id="chart-modal-body">
          <div id="chart-modal-chart"></div>
        </div>
        <div id="chart-modal-footer">
          <span id="chart-modal-meta"></span>
          <div class="chart-modal-export-row">
            <button class="mini-btn" id="cme-png">PNG</button>
            <button class="mini-btn" id="cme-jpg">JPG</button>
            <button class="mini-btn" id="cme-svg">SVG</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Close handlers
    overlay.addEventListener('click', e => { if (e.target === overlay) closeChartModal(); });
    document.getElementById('chart-modal-close').addEventListener('click', closeChartModal);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartModal(); });

    // Export handlers
    const exportChart = (type) => {
        if (!_chartModalInstance) return;
        const url = _chartModalInstance.getDataURL({ type: type === 'svg' ? 'svg' : 'png', pixelRatio: 2, backgroundColor: getComputedStyle(document.body).getPropertyValue('--c-card').trim() || '#ffffff' });
        const a = document.createElement('a'); a.href = url; a.download = 'chart.' + type; a.click();
    };
    document.getElementById('cme-png').onclick = () => exportChart('png');
    document.getElementById('cme-jpg').onclick = () => exportChart('jpeg');
    document.getElementById('cme-svg').onclick = () => exportChart('svg');
}

function openChartModal(config) {
    _getOrCreateModal();
    const overlay = document.getElementById('chart-modal-overlay');
    const title   = document.getElementById('chart-modal-title');
    const meta    = document.getElementById('chart-modal-meta');
    const chartEl = document.getElementById('chart-modal-chart');

    overlay.classList.remove('closing');
    overlay.style.display = 'flex';
    title.textContent = config.title || (config.metric + ' 数据图表');

    const regions = (config.regions || []).join('、') || '全国';
    const years   = config.years ? config.years[0] + '–' + config.years[config.years.length-1] : '';
    meta.textContent = `${config.metric}  ·  ${regions}${years ? '  ·  ' + years : ''}`;

    // Destroy old instance
    if (_chartModalInstance) { _chartModalInstance.dispose(); _chartModalInstance = null; }

    // Chart div reset
    chartEl.style.height = '500px';

    // Render after layout
    requestAnimationFrame(() => requestAnimationFrame(() => {
        setTimeout(() => {
            const chartId = 'modal-chart-' + Date.now();
            chartEl.id = chartId;
            _doRenderInlineChart(chartId, config, /* isModal= */ true);
            // Store instance reference
            setTimeout(() => { _chartModalInstance = echarts.getInstanceByDom(chartEl); }, 150);
        }, 30);
    }));
}

function closeChartModal() {
    const overlay = document.getElementById('chart-modal-overlay');
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.add('closing');
    setTimeout(() => {
        overlay.style.display = 'none';
        overlay.classList.remove('closing');
        if (_chartModalInstance) { _chartModalInstance.dispose(); _chartModalInstance = null; }
    }, 200);
}

/* ─── renderAgentChart — now creates a trigger button ─── */

function renderAgentChart(config, targetBubble) {
    if (!config || !config.metric) { console.warn('图表配置无效', config); return; }
    if (!window.workbook || !window.workbook['省份']) { console.warn('数据未加载'); return; }

    const doInsert = (bubble) => {
        // Remove any previous trigger in this bubble
        const old = bubble.querySelector('.rag-chart-trigger');
        if (old) old.remove();

        const btn = document.createElement('button');
        btn.className = 'rag-chart-trigger';
        const regionStr = (config.regions||[]).length ? config.regions.join('、') : '全国';
        btn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-chart-bar"/></svg>
          <span class="ctr-label">${config.title || config.metric + ' 图表'}</span>
          <span class="ctr-hint">点击查看 · ${regionStr}</span>`;
        btn.addEventListener('click', () => openChartModal(config));
        bubble.appendChild(btn);

        // Scroll chat to bottom
        const msgs = document.getElementById('rag-messages');
        if (msgs) setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 80);
    };

    if (targetBubble) {
        doInsert(targetBubble);
    } else {
        const bubbles = document.querySelectorAll('#rag-messages .rag-message.assistant .rag-bubble');
        const last = bubbles[bubbles.length - 1];
        if (last) doInsert(last);
    }
}

function _doRenderInlineChart(chartId, config, isModal) {
    const chartDom = document.getElementById(chartId);
    if (!chartDom) return;
    // In modal: bigger chart, richer grid padding
    if (isModal) {
        chartDom.style.height = '500px';
    }
    // Dispose previous if any
    if (_inlineChartInstances[chartId]) {
        try { 
            if (_inlineChartInstances[chartId]._ro) _inlineChartInstances[chartId]._ro.disconnect();
            _inlineChartInstances[chartId].dispose(); 
        } catch(e) {}
        delete _inlineChartInstances[chartId];
    }
    
    // CRITICAL: never set inline width - that causes bubble to stretch to full page width.
    // CSS width:100% on .rag-inline-chart handles width correctly.
    // Only ensure height is explicit.
    chartDom.style.height = '280px';
    
    // Read the actual rendered width from the wrap container (not chartDiv itself)
    const wrapEl = chartDom.closest('.rag-inline-chart-wrap');
    const measuredW = wrapEl ? wrapEl.clientWidth : (chartDom.clientWidth || 480);
    const measuredH = 280;
    
    // Init echarts - pass explicit height, let width be measured
    const chart = echarts.init(chartDom, null, { 
        width: measuredW > 20 ? measuredW : 480, 
        height: measuredH,
        renderer: 'canvas' 
    });
    _inlineChartInstances[chartId] = chart;
    
    // ResizeObserver on the WRAP container (stable width reference)
    if (window.ResizeObserver && wrapEl) {
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                const newW = Math.floor(entry.contentRect.width);
                if (newW > 20 && !chart.isDisposed()) {
                    chart.resize({ width: newW, height: measuredH });
                }
            }
        });
        ro.observe(wrapEl);
        chart._ro = ro;
    }
    
    const metric = config.metric;
    const chartType = config.type || 'line';
    let years = config.years || [];
    const regions = config.regions || [];
    
    const provinceRows = window.workbook['省份'];
    const nationalRows = window.workbook['全国'] || [];
    
    // Fuzzy field matching
    const sampleRow = provinceRows[0] || {};
    const cleanTarget = metric.replace(/[（(].*?[）)]/g, '').trim();
    const realMetric = Object.keys(sampleRow).find(k => {
        const cleanK = k.replace(/[（(].*?[）)]/g, '').trim();
        return k === metric || cleanK === cleanTarget || k.includes(cleanTarget) || cleanTarget.includes(cleanK);
    }) || metric;
    
    let filteredRows = provinceRows;
    
    // Fix: treat regions:['全国'] as national data
    const NATIONAL_NAMES = ['全国', '全国平均', '全国总计', '全国合计'];
    const useNational = (!regions.length || regions.every(r => NATIONAL_NAMES.includes(r)))
                        && nationalRows.length > 0;
    
    if (!years.length) {
        const baseRows = useNational ? nationalRows : (regions.length ? provinceRows.filter(r => regions.includes(r['地区'])) : provinceRows);
        years = [...new Set(baseRows.map(r => r['年份']))].sort();
        if (years.length > 10) years = years.slice(-10); // cap at 10 years
    }
    
    const series = [];
    const isDark = document.body.classList.contains('dark-mode');
    
    if (useNational) {
        // National trend
        const natMetric = Object.keys(nationalRows[0] || {}).find(k => {
            const cleanK = k.replace(/[（(].*?[）)]/g, '').trim();
            return k === metric || cleanK === cleanTarget || k.includes(cleanTarget) || cleanTarget.includes(cleanK);
        }) || metric;
        const data = years.map(y => {
            const row = nationalRows.find(r => r['年份'] === y);
            return row ? (row[natMetric] || null) : null;
        });
        series.push({ name: '全国', type: chartType, data, smooth: true, color: COLORS[0], areaStyle: chartType === 'line' ? { opacity: 0.12 } : undefined });
    } else {
        if (years.length) filteredRows = filteredRows.filter(r => years.includes(r['年份']));
        if (regions.length) filteredRows = filteredRows.filter(r => regions.includes(r['地区']));
        const targetRegions = regions.length ? regions : [...new Set(filteredRows.map(r => r['地区']))].slice(0, 5);
        
        targetRegions.forEach((region, idx) => {
            const regionRows = filteredRows.filter(r => r['地区'] === region);
            const data = years.map(y => {
                const row = regionRows.find(r => r['年份'] === y);
                return row ? (row[realMetric] || null) : null;
            });
            if (data.some(v => v !== null)) {
                series.push({ name: region, type: chartType, data, smooth: true, color: COLORS[idx % COLORS.length], areaStyle: chartType === 'line' ? { opacity: 0.1 } : undefined });
            }
        });
    }
    
    const textColor = isDark ? '#8fa6c8' : '#4a5568';
    const gridColor = isDark ? '#2a3a58' : '#e8edf5';
    const titleColor = isDark ? '#edf2ff' : '#1a202c';
    
    chart.setOption({
        backgroundColor: 'transparent',
        title: { text: config.title || `${metric}`, left: 'center', top: 6, textStyle: { color: titleColor, fontSize: 13, fontWeight: 700 } },
        tooltip: {
            trigger: 'axis', backgroundColor: isDark ? 'rgba(19,25,41,.95)' : 'rgba(255,255,255,.97)',
            borderColor: '#667eea', textStyle: { color: isDark ? '#edf2ff' : '#1a202c', fontSize: 12 },
            extraCssText: 'box-shadow:0 4px 20px rgba(102,126,234,.2);border-radius:10px;'
        },
        legend: { data: series.map(s => s.name), top: 30, textStyle: { color: textColor, fontSize: 11 } },
        grid: { left: '8%', right: '5%', bottom: '14%', top: series.length > 1 ? '22%' : '18%' },
        xAxis: { type: 'category', data: years, axisLine: { lineStyle: { color: gridColor } }, axisLabel: { color: textColor, fontSize: 11 }, splitLine: { show: false } },
        yAxis: { type: 'value', axisLine: { show: false }, axisLabel: { color: textColor, fontSize: 11 }, splitLine: { lineStyle: { color: gridColor, type: 'dashed' } } },
        series,
    });
    
    // Auto-resize on window resize
    const resizeFn = () => chart.resize();
    window.addEventListener('resize', resizeFn);
    // Cleanup on dispose
    chart._resizeFn = resizeFn;
    
    console.log('✅ 内联图表渲染完成:', chartId);
}

// Legacy compat - keep closeAgentModal doing nothing (modal removed)
function closeAgentModal() {}

// Auto-generate chart - now renders inline
function autoGenerateChart(question, targetBubble) {
    let metric = '科学支出水平';
    let region = null;
    
    if (window.workbook && window.workbook['省份']) {
        const provinces = [...new Set(window.workbook['省份'].map(r => r['地区']))];
        for (const p of provinces) {
            if (question.includes(p)) { region = p; break; }
        }
    }
    
    const metrics = getAllMetrics();
    for (const m of metrics) {
        if (question.includes(m) || question.includes(cleanMetricName(m))) { metric = m; break; }
    }
    
    const currentYear = new Date().getFullYear();
    const years = [currentYear-4, currentYear-3, currentYear-2, currentYear-1, currentYear];
    
    renderAgentChart({
        type: 'line',
        metric,
        regions: region ? [region] : [],
        years,
        title: `${region || '全国'} ${metric} 近5年趋势`
    }, targetBubble);
}

// ======================= 原有聊天功能兼容 =======================

async function sendMessage() {
    if (typeof stopCarousel === 'function') stopCarousel();
    
    const question = chatInput?.value.trim();
    if (!question) return;

    addMessage('user', escapeHtml(question));
    if (chatInput) chatInput.value = '';
    if (chatInput) chatInput.style.height = 'auto';

    if (chatSend) chatSend.disabled = true;
    if (chatStop) chatStop.disabled = false;

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

        const answer = data.answer || '无回答';
        if (updateAssistant) updateAssistant(answer);
        fullAnswer = answer;

        if (data.chart && data.chart.metric) {
            console.log('📊 收到图表配置:', data.chart);
            renderAgentChart(data.chart);
        } else if (/趋势|分析|变化|走势/.test(question)) {
            autoGenerateChart(question);
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            if (updateAssistant) updateAssistant(fullAnswer + '\n\n[已停止生成]');
        } else {
            console.error(err);
            if (updateAssistant) updateAssistant('连接失败，请确保后端已启动');
        }
    } finally {
        if (chatSend) chatSend.disabled = false;
        if (chatStop) chatStop.disabled = true;
        currentController = null;
    }
}

function stopGeneration() {
    if (currentController) {
        currentController.abort();
    }
}

function formatAnswer(text) {
    if (!text) return '';
    
    // Remove bold markers but keep structure
    let cleaned = text.replace(/\*\*/g, '');
    
    // ---- Markdown table → HTML table (robust, handles multiple tables) ----
    if (cleaned.includes('|')) {
        cleaned = cleaned.replace(/((?:\|[^\n]+\n?)+)/g, (tableBlock) => {
            const lines = tableBlock.trim().split('\n').filter(l => l.trim());
            if (lines.length < 2) return tableBlock;
            // Filter out separator rows (|---|---|)
            const dataLines = lines.filter(l => !l.replace(/[|\- ]/g, '').trim() === '');
            const nonSep = lines.filter(l => !/^\s*\|[-|\s]+\|\s*$/.test(l));
            if (!nonSep.length) return tableBlock;
            
            let tableHtml = '<table class="rag-table" style="border-collapse:collapse;width:100%;margin:12px 0;">';
            nonSep.forEach((line, i) => {
                const cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1 || (idx === 0 && c !== '') || (idx === arr.length -1 && c !== ''));
                // re-split properly
                const parts = line.split('|').slice(1, -1).map(c => c.trim());
                if (!parts.length) return;
                const tag = i === 0 ? 'th' : 'td';
                const style = tag === 'th'
                    ? 'padding:8px 12px;border:1px solid var(--border-color);background:var(--bg-hover);font-weight:600;text-align:left;'
                    : 'padding:8px 12px;border:1px solid var(--border-color);';
                tableHtml += '<tr>' + parts.map(c => `<${tag} style="${style}">${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
            });
            tableHtml += '</table>';
            return tableHtml;
        });
    }
    
    // Bold text back (using strong tags)
    // Convert remaining markdown: **text** → <strong>text</strong>
    cleaned = cleaned
        .replace(/【思考】/g, '<div class="thinking-title">🤔 思考过程</div>')
        .replace(/【回答】/g, '<div class="answer-title">📢 最终回答</div>');
    
    // Convert newlines to <br> but don't break table HTML
    let html = cleaned.replace(/\n(?!<\/?(table|tr|th|td))/g, '<br>');
    
    return html;
}

async function clearConversation() {
    try {
        const response = await fetch('/api/clear_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
            if (chatMessages) chatMessages.innerHTML = '';
            const systemMsg = document.createElement('div');
            systemMsg.className = 'chat-message assistant';
            systemMsg.innerHTML = `<div class="message-role">🤖 系统</div><div class="message-content">对话历史已清空。</div>`;
            chatMessages?.appendChild(systemMsg);
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    } catch (err) {
        console.error('清空对话请求错误:', err);
    }
}

// ======================= 数据加载 =======================

async function loadAllData() {
    try {
        const response = await fetch('/api/data');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        for (let sheetName in data) {
            const rows = data[sheetName];
            if (!rows || rows.length === 0) continue;
            const sample = rows[0];
            
            let yearKey = null;
            if (sample.hasOwnProperty("年份")) yearKey = "年份";
            else if (sample.hasOwnProperty("时间")) yearKey = "时间";
            else if (sample.hasOwnProperty("year")) yearKey = "year";
            if (yearKey && yearKey !== "年份") {
                rows.forEach(row => { row["年份"] = row[yearKey]; delete row[yearKey]; });
            }
            
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
            
            rows.forEach(row => { delete row["时间地区"]; delete row["时间"]; });
            
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
        // Update KPI cards on dashboard
        if (typeof window.updateKPI === 'function') {
            try { window.updateKPI(data); } catch(e) {}
        }
        return window.workbook;
    } catch (error) {
        console.error('加载 data.json 失败', error);
        showToast('数据文件加载失败，请确保后端服务已启动（node server.js）', 'error');
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
    '#667eea', '#764ba2', '#f093fb', '#f5576c',
    '#4facfe', '#00f2fe', '#43e97b', '#38f9d7',
    '#fa709a', '#fee140', '#30cfd0', '#330867',
    '#1e466e', '#368bc1', '#5f9d80', '#e68a2e',
    '#b56576', '#6d597a', '#3cba54', '#db4437'
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
        mainChart?.resize();
        pieChart?.resize();
        advancedChart?.resize();
        rankChart?.resize();
        // Also resize any inline chat charts
        Object.values(_inlineChartInstances || {}).forEach(c => {
            try {
                if (!c || c.isDisposed()) return;
                const dom = c.getDom();
                const wrap = dom?.closest('.rag-inline-chart-wrap');
                const newW = wrap ? wrap.clientWidth : 0;
                if (newW > 20) c.resize({ width: newW, height: 280 });
                else c.resize();
            } catch(e) {}
        });
    });
    
    buildSheetSelect();
    bindEvents();
    initColumnSelector();
    switchSheet(currentSheet);
    
    // 绑定RAG事件
    bindRagEvents();
    
    // 默认显示Landing页
    showLanding();
}

// ======================= 夜间模式 =======================

function initDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    
    const applyDark = (dark) => {
        document.body.classList.toggle('dark-mode', dark);
        if (typeof window.updateDarkIcons === 'function') window.updateDarkIcons(dark);
        updateChartsTheme(dark);
    };
    
    if (isDarkMode) applyDark(true);
    
    // Dashboard header toggle
    if (darkModeToggle && !darkModeToggle._dmBound) {
        darkModeToggle._dmBound = true;
        darkModeToggle.addEventListener('click', () => {
            const isNowDark = !document.body.classList.contains('dark-mode');
            localStorage.setItem('darkMode', isNowDark);
            applyDark(isNowDark);
        });
    }
    // RAG page toggle
    const t2 = document.getElementById('darkModeToggle2');
    if (t2 && !t2._dmBound) {
        t2._dmBound = true;
        t2.addEventListener('click', () => {
            const isNowDark = !document.body.classList.contains('dark-mode');
            localStorage.setItem('darkMode', isNowDark);
            applyDark(isNowDark);
        });
    }
}

function updateChartsTheme(isDark) {
    const textColor = isDark ? '#8fa6c8' : '#4a5568';
    const axisColor = isDark ? '#2a3a58' : '#dde3ef';
    const splitColor = isDark ? '#2a3a58' : '#eef1f7';
    const tooltipBg = isDark ? 'rgba(19,25,41,.96)' : 'rgba(255,255,255,.97)';
    
    const optionUpdate = {
        backgroundColor: 'transparent',
        textStyle: { color: textColor },
        xAxis: { axisLabel: { color: textColor }, axisLine: { lineStyle: { color: axisColor } }, axisTick: { lineStyle: { color: axisColor } }, splitLine: { lineStyle: { color: splitColor } } },
        yAxis: { axisLabel: { color: textColor }, axisLine: { lineStyle: { color: axisColor } }, axisTick: { lineStyle: { color: axisColor } }, splitLine: { lineStyle: { color: splitColor } } },
        legend: { textStyle: { color: textColor } },
        tooltip: { backgroundColor: tooltipBg, borderColor: '#667eea', textStyle: { color: isDark ? '#edf2ff' : '#1a202c' } }
    };
    
    [mainChart, pieChart, advancedChart, rankChart].forEach(chart => {
        if (chart && !chart.isDisposed()) try { chart.setOption(optionUpdate, false); } catch(e) {}
    });
    // Update inline chat charts
    Object.values(_inlineChartInstances || {}).forEach(chart => {
        try { if (chart && !chart.isDisposed()) chart.setOption(optionUpdate, false); } catch(e) {}
    });
}

// ======================= RAG 事件绑定 =======================

function bindRagEvents() {
    const ragInput = document.getElementById('rag-input');
    const ragSend = document.getElementById('rag-send');
    
    if (ragInput) {
        ragInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 200) + 'px';
        });
        ragInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isRagStreaming) sendRagMessage();
            }
        });
    }
    
    // Bind rag-send via addEventListener (remove onclick attr reliance)
    if (ragSend) {
        // Remove any stale onclick to avoid double-fire
        ragSend.onclick = null;
        ragSend.addEventListener('click', () => {
            if (!isRagStreaming) sendRagMessage();
        });
    }
    
    // 旧版聊天事件（兼容）
    if (chatSend) chatSend.addEventListener('click', sendMessage);
    if (chatStop) chatStop.addEventListener('click', stopGeneration);
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (chatSend && !chatSend.disabled) sendMessage();
            }
        });
    }
    
    const chatClear = document.getElementById('chat-clear');
    if (chatClear) chatClear.addEventListener('click', clearConversation);
    
    // ---- Landing page Enter key sends query ----
    const landingQuery = document.getElementById('landing-query');
    if (landingQuery) {
        landingQuery.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') enterDashboardWithQuery();
        });
    }
}

// ======================= 列选择器 =======================

function initColumnSelector() {
    const toggleBtn = document.getElementById("toggle-column-panel");
    const panel = document.getElementById("column-panel");
    if (!toggleBtn || !panel) return;
    
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const rect = toggleBtn.getBoundingClientRect();
        const isHidden = panel.style.display === "none" || !panel.style.display;
        if (isHidden) {
            // Position panel below button, clamp to viewport
            let top = rect.bottom + window.scrollY + 6;
            let left = rect.left + window.scrollX;
            // Prevent overflow on right
            if (left + 220 > window.innerWidth) left = window.innerWidth - 230;
            panel.style.top = top + "px";
            panel.style.left = left + "px";
            panel.style.display = "block";
            refreshColumnCheckboxList();
        } else {
            panel.style.display = "none";
        }
    };
    
    document.addEventListener("click", (e) => {
        if (!panel.contains(e.target) && e.target !== toggleBtn) panel.style.display = "none";
    });
    
    document.getElementById("col-select-all")?.addEventListener("click", () => {
        visibleColumns.clear();
        headers.forEach(h => visibleColumns.add(h));
        refreshColumnCheckboxList();
        renderTablePage();
    });
    
    document.getElementById("col-deselect-all")?.addEventListener("click", () => {
        visibleColumns.clear();
        refreshColumnCheckboxList();
        renderTablePage();
    });
    
    document.getElementById("col-reset")?.addEventListener("click", () => {
        visibleColumns.clear();
        headers.forEach(h => visibleColumns.add(h));
        refreshColumnCheckboxList();
        renderTablePage();
    });
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

// ======================= 工作表切换 =======================

function buildSheetSelect() {
    const sel = document.getElementById("sheet-list");
    if (!sel) return;
    sel.innerHTML = "";
    window.sheetList?.forEach(s => {
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
    originalRows = window.workbook[sheetName]?.map(row => ({ ...row })) || [];
    headers = Object.keys(originalRows[0] || {});
    
    log("切换到工作表:", sheetName, headers);
    
    visibleColumns.clear();
    headers.forEach(h => visibleColumns.add(h));
    refreshColumnCheckboxList();
    
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) pageSize = parseInt(pageSizeSelect.value) || 20;

    const searchContainer = document.getElementById("region-search-container");
    const metricContainer = document.getElementById('metric-selector-container');
    const quickJumpContainer = document.getElementById('quick-jump-container');

    if (sheetName === "全国") {
        dimType = "nation";
        valueFields = headers.filter(h => h !== "年份");
        currentMetricIndex = 0;
        selectedGroups = [];
        buildNationPanel();
        document.querySelector(".pie-card") && (document.querySelector(".pie-card").style.display = "block");
        document.querySelector(".advanced-card") && (document.querySelector(".advanced-card").style.display = "none");
        initPieChart();
        if (searchContainer) searchContainer.style.display = "none";
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
        document.querySelector(".pie-card") && (document.querySelector(".pie-card").style.display = "none");
        document.querySelector(".advanced-card") && (document.querySelector(".advanced-card").style.display = "block");
        buildMetricSelector();
        initAdvancedAnalysis();
        if (searchContainer) searchContainer.style.display = "flex";
        if (metricContainer) metricContainer.style.display = 'block';
        if (quickJumpContainer) quickJumpContainer.style.display = 'block';
    } else if (sheetName === "省份") {
        dimType = "province";
        groupField = "地区";
        const firstRow = originalRows[0];
        valueFields = Object.keys(firstRow).filter(key => key !== "年份" && key !== "地区");
        const groups = [...new Set(originalRows.map(r => r[groupField]))].filter(v => v).sort();
        selectedGroups = groups.length ? [groups[0]] : [];
        buildGroupPanel(groups, "省份");
        document.querySelector(".pie-card") && (document.querySelector(".pie-card").style.display = "none");
        document.querySelector(".advanced-card") && (document.querySelector(".advanced-card").style.display = "block");
        buildMetricSelector();
        initAdvancedAnalysis();
        if (searchContainer) searchContainer.style.display = "flex";
        if (metricContainer) metricContainer.style.display = 'block';
        if (quickJumpContainer) quickJumpContainer.style.display = 'block';
    }

    sortKey = "";
    sortType = "asc";
    const sortStatus = document.getElementById("sort-status");
    if (sortStatus) sortStatus.innerHTML = "排序：无（点击表头排序）";
    
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

// ======================= 面板构建 =======================

function buildNationPanel() {
    const panelTitle = document.getElementById("panel-title");
    if (panelTitle) panelTitle.innerHTML = `核心指标（${valueFields.length}个）`;
    
    const container = document.getElementById("indicator-list");
    if (!container) return;
    container.innerHTML = "";
    
    valueFields.forEach((field, idx) => {
        const div = document.createElement("div");
        div.className = `indicator-item ${idx === currentMetricIndex ? 'active' : ''}`;
        div.innerHTML = `<span>${field}</span>`;
        div.onclick = () => {
            pauseCarouselDueToInteraction();
            currentMetricIndex = idx;
            updateNationHighlight();
            renderMainChart();
        };
        container.appendChild(div);
    });
}

function updateNationHighlight() {
    const items = document.querySelectorAll("#indicator-list .indicator-item");
    items.forEach((item, idx) => {
        item.classList.toggle("active", idx === currentMetricIndex);
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
            quickJump.value = '';
        }
    };
}

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
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">未找到匹配地区</div>';
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
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            };
            
            container.appendChild(div);
        });
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
        selectedGroups = allRegionList.length ? [allRegionList[0]] : [];
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
        searchInput.oninput = (e) => {
            regionSearchKeyword = e.target.value;
            renderRegionList();
        };
    }

    const clearSearchBtn = document.getElementById("clear-search-btn");
    if (clearSearchBtn) {
        clearSearchBtn.onclick = () => {
            if (searchInput) searchInput.value = "";
            regionSearchKeyword = "";
            renderRegionList();
        };
    }

    renderRegionList();
    renderMainChart();
    buildQuickJump();
}

// ======================= 主图表渲染 =======================

function renderMainChart() {
    if (!mainChart || !valueFields.length) return;
    
    let chartType = document.getElementById("chart-type")?.value || "auto";
    if (chartType === "auto") chartType = (dimType === "nation" ? "line" : "bar");
    
    const metric = valueFields[currentMetricIndex];
    if (!metric) return;
    
    const isDark = document.body.classList.contains('dark-mode');
    
    if (dimType === "nation") {
        const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
        const data = years.map(y => originalRows.find(r => r["年份"] === y)?.[metric] ?? 0);
        
        mainChart.setOption({
            backgroundColor: 'transparent',
            title: { 
                text: custom.title !== "auto" ? custom.title : `${metric} 时序趋势`, 
                left: "center",
                textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
            },
            tooltip: { 
                trigger: "axis",
                backgroundColor: isDark ? 'rgba(26,31,46,0.95)' : 'rgba(255,255,255,0.95)',
                borderColor: '#667eea',
                textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
            },
            legend: { 
                data: [metric], 
                top: 30,
                textStyle: { color: isDark ? '#a0aec0' : '#5a6e8a' }
            },
            xAxis: { 
                type: "category", 
                data: years, 
                name: custom.xName !== "auto" ? custom.xName : "年份",
                axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
                axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' }
            },
            yAxis: { 
                name: custom.yName !== "auto" ? custom.yName : metric, 
                min: 0, 
                max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
                axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
                axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
                splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
            },
            series: [{ 
                name: metric, 
                type: chartType, 
                data, 
                smooth: true, 
                color: COLORS[0],
                areaStyle: { 
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(102,126,234,0.3)' },
                        { offset: 1, color: 'rgba(102,126,234,0.05)' }
                    ])
                }
            }]
        }, true);
        return;
    }
    
    const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
    const series = [];
    
    selectedGroups.forEach((grp, idx) => {
        const data = years.map(y => {
            let row = originalRows.find(r => r["年份"] === y && r["地区"] === grp);
            return row ? row[metric] : 0;
        });
        series.push({ 
            name: grp, 
            type: chartType, 
            data, 
            smooth: true, 
            color: COLORS[idx % COLORS.length],
            areaStyle: chartType === 'line' ? { opacity: 0.1 } : undefined
        });
    });
    
    mainChart.setOption({
        backgroundColor: 'transparent',
        title: { 
            text: custom.title !== "auto" ? custom.title : `${metric} 区域对比`, 
            left: "center",
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        tooltip: { 
            trigger: "axis",
            backgroundColor: isDark ? 'rgba(26,31,46,0.95)' : 'rgba(255,255,255,0.95)',
            borderColor: '#667eea',
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        legend: (dimType === "city") ? { show: false } : { 
            data: selectedGroups, 
            top: 30, 
            type: "scroll",
            textStyle: { color: isDark ? '#a0aec0' : '#5a6e8a' }
        },
        xAxis: { 
            type: "category", 
            data: years, 
            name: "年份",
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
            axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' }
        },
        yAxis: { 
            name: custom.yName !== "auto" ? custom.yName : metric, 
            min: 0, 
            max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
            axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
            splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
        },
        series: series
    }, true);
}

// ======================= 轮播控制 =======================

function startCarousel() {
    stopCarousel();
    if (valueFields.length <= 1) return;
    carouselTimer = setInterval(() => {
        if (isCarouselPaused) return;
        currentMetricIndex = (currentMetricIndex + 1) % valueFields.length;
        if (dimType === "nation") {
            updateNationHighlight();
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
        pieChart?.setOption({ 
            title: { text: "省份表为空", left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
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
    
    document.getElementById("pie-year-prev")?.addEventListener("click", () => {
        let idx = pieAvailableYears.indexOf(pieCurrentYear);
        if (idx > 0) {
            pieCurrentYear = pieAvailableYears[idx-1];
            if (yearSel) yearSel.value = pieCurrentYear;
            renderPieChart();
        }
    });
    
    document.getElementById("pie-year-next")?.addEventListener("click", () => {
        let idx = pieAvailableYears.indexOf(pieCurrentYear);
        if (idx < pieAvailableYears.length-1) {
            pieCurrentYear = pieAvailableYears[idx+1];
            if (yearSel) yearSel.value = pieCurrentYear;
            renderPieChart();
        }
    });
    
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
    const provinceRows = window.workbook["省份"]?.filter(r => r["年份"] === year) || [];
    
    if (provinceRows.length === 0 || provinceRows.every(r => r[metric] === undefined || r[metric] === 0)) {
        pieChart?.clear();
        pieChart?.setOption({ 
            title: { text: `无有效数据（${year}年 ${metric}）`, left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
        const status = document.getElementById("pie-status");
        if (status) status.innerHTML = `无有效数据，请切换年份或指标`;
        return;
    }
    
    const nationRow = window.workbook["全国"]?.find(r => r["年份"] === year);
    let total = null;
    let totalSource = "national";
    
    if (nationRow && nationRow[metric] !== undefined && nationRow[metric] !== 0) {
        total = nationRow[metric];
    } else {
        total = provinceRows.reduce((sum, row) => sum + (row[metric] || 0), 0);
        totalSource = "province_sum";
    }
    
    if (!total || total === 0) {
        pieChart?.clear();
        pieChart?.setOption({ 
            title: { text: `总量无效，无法计算占比`, left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
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
    if (totalSource === "national" && total > provinceSum) {
        otherValue = total - provinceSum;
    }
    
    let pieSeriesData = [];
    const colorPalette = [...COLORS];
    
    normalData.forEach((item, idx) => {
        let percent = (item.value / total) * 100;
        if (percent > 0.01 || item.value === 0) {
            pieSeriesData.push({ 
                name: item.name, 
                value: percent, 
                originalVal: item.value, 
                itemStyle: { color: colorPalette[idx % colorPalette.length] } 
            });
        }
    });
    
    if (hiddenSum > 0 && hiddenNames.length > 0) {
        let hiddenPercent = (hiddenSum / total) * 100;
        if (hiddenPercent > 0.01) {
            pieSeriesData.push({
                name: `已隐藏省份 (${hiddenNames.length}省)`,
                value: hiddenPercent,
                originalVal: hiddenSum,
                itemStyle: { color: '#718096' }
            });
        }
    }
    
    if (otherValue > 0) {
        let otherPercent = (otherValue / total) * 100;
        pieSeriesData.push({
            name: "其他（非省份部分）",
            value: otherPercent,
            originalVal: otherValue,
            itemStyle: { color: '#4a5568' }
        });
    }
    
    const allProvinceSet = new Set(provinceRows.map(r => r["地区"]));
    const neverExist = pieProvinceList.filter(p => !allProvinceSet.has(p));
    if (neverExist.length > 0) {
        pieSeriesData.push({
            name: `数据缺失省份 (${neverExist.length}省)`,
            value: 0,
            originalVal: 0,
            itemStyle: { color: '#2d3748' }
        });
    }
    
    const isDark = document.body.classList.contains('dark-mode');
    const totalNote = totalSource === "province_sum" ? `（基于${provinceRows.length}省数值总和${formatValue(total)}计算）` : "";
    const unit = getUnit(metric);
    
    pieChart?.setOption({
        backgroundColor: 'transparent',
        title: { 
            text: `${year}年 ${metric}${unit ? `(${unit})` : ''} 各省份占比${totalNote}`, 
            left: "center", 
            top: 0,
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48', fontSize: 14 }
        },
        tooltip: {
            trigger: "item",
            backgroundColor: isDark ? 'rgba(26,31,46,0.95)' : 'rgba(255,255,255,0.95)',
            borderColor: '#667eea',
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' },
            formatter: (params) => {
                if (params.name.startsWith("数据缺失省份")) {
                    return `${params.name}<br/>缺失名单: ${neverExist.join("、")}`;
                }
                if (params.name === "其他（非省份部分）") {
                    return `${params.name}<br/>占比: ${params.percent.toFixed(2)}%<br/>数值: ${formatValue(otherValue)} ${unit}`;
                }
                let tip = `${params.name}<br/>占比: ${params.percent.toFixed(2)}%`;
                if (params.data?.originalVal !== undefined && params.name !== "其他（非省份部分）") {
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
            textStyle: { color: isDark ? '#a0aec0' : '#5a6e8a' },
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
                color: isDark ? '#a0aec0' : '#5a6e8a',
                avoidLabelOverlap: true,
                labelLine: {
                    show: true,
                    length: 8,
                    length2: 6,
                    smooth: true
                }
            },
            minAngle: 1,
            emphasis: { 
                scale: true,
                itemStyle: {
                    shadowBlur: 20,
                    shadowColor: 'rgba(102,126,234,0.5)'
                }
            }
        }]
    }, true);
    
    pieChart?.off('legendselectchanged');
    pieChart?.on('legendselectchanged', (params) => {
        const clickedName = params.name;
        if (clickedName.startsWith("已隐藏省份") || clickedName === "其他（非省份部分）" || clickedName.startsWith("数据缺失省份")) return;
        const targetItem = Array.from(document.querySelectorAll("#pie-province-list .indicator-item")).find(item => item.querySelector("span")?.innerText === clickedName);
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
    if (otherValue > 0) statusMsg += ` | 非省份部分占比: ${((otherValue/total)*100).toFixed(2)}%`;
    
    const status = document.getElementById("pie-status");
    if (status) status.innerHTML = statusMsg;
}

// ======================= 高级分析（排名对比图）=======================

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
    
    document.getElementById("adv-pause-carousel")?.addEventListener("click", toggleAdvCarousel);
    document.getElementById("adv-refresh")?.addEventListener("click", () => renderAdvancedChart());
    
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
        advancedChart.setOption({ 
            title: { text: "无可用指标或年份", left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
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
    if (!container) return;
    
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

function updateRankChart() {
    const selectedData = Array.from(rankSelectedIndices)
        .map(idx => rankFullData[idx])
        .filter(d => d && typeof d.value === 'number' && !isNaN(d.value));
    selectedData.sort((a, b) => b.value - a.value);
    
    const isDark = document.body.classList.contains('dark-mode');
    
    const option = {
        backgroundColor: 'transparent',
        title: { 
            text: `${advMetrics[advCurrentMetricIndex]} 对比`, 
            left: "center",
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        tooltip: { 
            trigger: "axis", 
            axisPointer: { type: "shadow" },
            backgroundColor: isDark ? 'rgba(26,31,46,0.95)' : 'rgba(255,255,255,0.95)',
            borderColor: '#667eea',
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        grid: { containLabel: true, left: "15%" },
        xAxis: { 
            type: "value", 
            name: advMetrics[advCurrentMetricIndex],
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
            axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
            splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
        },
        yAxis: { 
            type: "category", 
            data: selectedData.map(d => d.name), 
            axisLabel: { fontSize: 11, color: isDark ? '#a0aec0' : '#5a6e8a' },
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } }
        },
        series: [{
            type: "bar",
            data: selectedData.map(d => d.value),
            itemStyle: { 
                color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: '#667eea' },
                    { offset: 1, color: '#764ba2' }
                ]),
                borderRadius: [0, 4, 4, 0]
            },
            label: { show: true, position: "right", color: isDark ? '#a0aec0' : '#5a6e8a' }
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
        advancedChart?.setOption({ 
            title: { text: `无有效分类数据 (${metric})`, left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
        return;
    }
    
    const sorted = Array.from(freqMap.entries()).sort((a,b) => b[1] - a[1]);
    const isDark = document.body.classList.contains('dark-mode');
    
    advancedChart?.setOption({
        backgroundColor: 'transparent',
        title: { 
            text: `${metric} 分类频次统计 (${year}年)`, 
            left: "center",
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        tooltip: { 
            trigger: "axis", 
            axisPointer: { type: "shadow" },
            backgroundColor: isDark ? 'rgba(26,31,46,0.95)' : 'rgba(255,255,255,0.95)',
            textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
        },
        xAxis: { 
            type: "category", 
            data: sorted.map(s => s[0]), 
            axisLabel: { rotate: 30, color: isDark ? '#a0aec0' : '#5a6e8a' },
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } }
        },
        yAxis: { 
            type: "value", 
            name: "出现次数",
            axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
            axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
            splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
        },
        series: [{ 
            type: "bar", 
            data: sorted.map(s => s[1]), 
            itemStyle: { 
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: '#667eea' },
                    { offset: 1, color: '#764ba2' }
                ])
            } 
        }]
    }, true);
}

// ======================= 表格分页 + 排序 + 搜索 =======================

let currentSearchTerm = "";

function applyFilterAndSort() {
    let filtered = [...originalRows];
    const searchVal = document.getElementById("search-input")?.value.trim() || "";
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
    totalPages = Math.ceil(totalRecords / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages || 1;
    
    const totalRecordsEl = document.getElementById("total-records");
    const pageTotalEl = document.getElementById("page-total");
    if (totalRecordsEl) totalRecordsEl.innerText = totalRecords;
    if (pageTotalEl) pageTotalEl.innerText = totalPages;
    
    let sortMsg = sortKey ? `当前排序：${sortKey} ${sortType === "asc" ? "↑ 升序" : "↓ 降序"}` : "无";
    const sortStatus = document.getElementById("sort-status");
    if (sortStatus) sortStatus.innerHTML = `${sortMsg}（点击表头排序）`;
}

function renderTablePage() {
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const pageData = filteredRowsForPage.slice(start, end);
    const searchVal = currentSearchTerm;
    const visible = headers.filter(h => visibleColumns.has(h));
    
    // 计算统计值
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
        stats[field] = { 
            sum: sum.toFixed(2), 
            avg: avg.toFixed(2), 
            median: median.toFixed(2), 
            min: min.toFixed(2), 
            max: max.toFixed(2) 
        };
    });
    
    // 构建表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const statsRow = document.createElement('tr');
    statsRow.className = 'stats-row';
    
    visible.forEach(h => {
        const th = document.createElement('th');
        if (searchVal && h.toLowerCase().includes(searchVal.toLowerCase())) th.classList.add('highlight-red');
        if (sortKey === h) th.classList.add('sort-active');
        th.onclick = () => { sortTable(h); };
        const arrow = sortKey === h ? (sortType === 'asc' ? ' ↑' : ' ↓') : '';
        th.innerHTML = h + arrow;
        headerRow.appendChild(th);
        
        const td = document.createElement('td');
        td.style.fontSize = '11px';
        td.style.fontWeight = 'normal';
        td.style.backgroundColor = 'var(--bg-hover)';
        td.style.borderBottom = '1px solid var(--border-color)';
        
        if (h === '年份') {
            td.innerHTML = '年份范围';
        } else if (h === '地区') {
            td.innerHTML = '地区列表';
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
    
    // 计算每列数值范围（用于热力图着色）
    const colRange = {};
    visible.forEach(h => {
        if (h === '年份' || h === '地区') return;
        const vals = filteredRowsForPage.map(r => r[h]).filter(v => typeof v === 'number' && !isNaN(v));
        if (vals.length) {
            const mn = Math.min(...vals), mx = Math.max(...vals);
            colRange[h] = { min: mn, max: mx, range: mx - mn };
        }
    });
    
    // 构建数据行
    const tbody = document.createElement('tbody');
    pageData.forEach(row => {
        const tr = document.createElement('tr');
        visible.forEach(h => {
            const td = document.createElement('td');
            let val = row[h] ?? '';
            let txt = val;
            if (searchVal) {
                const regex = new RegExp(`(${escapeRegex(searchVal)})`, 'gi');
                txt = String(txt).replace(regex, `<span class="highlight-red">$1</span>`);
            }
            td.innerHTML = txt;
            // 热力图着色：数值列根据相对大小着色
            if (colRange[h] && colRange[h].range > 0 && typeof val === 'number') {
                const ratio = (val - colRange[h].min) / colRange[h].range;
                const isDark = document.body.classList.contains('dark-mode');
                if (isDark) {
                    td.style.background = `rgba(102,126,234,${ratio * 0.4})`;
                } else {
                    td.style.background = `rgba(102,126,234,${ratio * 0.18})`;
                }
                td.title = `数值: ${val} | 排位: ${Math.round(ratio*100)}%`;
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    
    const table = document.getElementById('data-table');
    if (table) {
        table.innerHTML = '';
        table.appendChild(thead);
        table.appendChild(tbody);
        
        const pageCurrent = document.getElementById('page-current');
        const pageGoto = document.getElementById('page-goto');
        if (pageCurrent) pageCurrent.innerText = currentPage;
        if (pageGoto) pageGoto.max = totalPages;
        
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) tableContainer.scrollTop = 0;
    }
}

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
function goToPage() { 
    let p = parseInt(document.getElementById("page-goto")?.value); 
    if (!isNaN(p) && p>=1 && p<=totalPages) { currentPage = p; renderTablePage(); } 
}

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
    try {
        if (type === 'png') url = chartInstance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: document.body.classList.contains('dark-mode') ? '#1a1f2e' : '#ffffff' });
        else if (type === 'jpg') url = chartInstance.getDataURL({ type: 'jpeg', pixelRatio: 2, backgroundColor: document.body.classList.contains('dark-mode') ? '#1a1f2e' : '#ffffff' });
        else if (type === 'svg') { url = chartInstance.getDataURL({ type: 'svg' }); }
        else return;
    } catch(e) { console.error('Export failed:', e); showToast('图表导出失败，请稍后重试', 'error'); return; }
    const link = document.createElement('a');
    link.download = `${filename}.${type === 'jpg' ? 'jpg' : type}`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ======================= 高级图表模块（卡片式）=======================

let activeChart = null;
let currentChartInstance = null;

function getYears(table = 'province') {
    if (!window.workbook) return [];
    if (table === 'province') {
        return [...new Set(window.workbook['省份']?.map(r => r['年份']))].sort();
    }
    return [...new Set(window.workbook['地级市']?.map(r => r['时间']))].sort();
}

function cleanMetricName(key) {
    return key.replace(/[（(].*?[）)]/g, '').trim();
}

function getAllMetrics(table = 'province') {
    if (!window.workbook) return [];
    let sample = null;
    if (table === 'province') sample = window.workbook['省份']?.[0];
    else sample = window.workbook['地级市']?.[0];
    if (!sample) return [];
    return Object.keys(sample).filter(k => k !== '年份' && k !== '地区' && k !== '时间地区' && typeof sample[k] === 'number');
}

function getAllRegions(table = 'province') {
    if (!window.workbook) return [];
    if (table === 'province') {
        return [...new Set(window.workbook['省份']?.map(r => r['地区']))].sort();
    } else if (table === 'city') {
        return [...new Set(window.workbook['地级市']?.map(r => r['地区']))].sort();
    }
    return [];
}

function renderControls(type) {
    const container = document.getElementById('analysis-controls');
    if (!container) return;
    container.innerHTML = '';
    
    if (type === 'scatter') {
        const years = getYears();
        const metrics = getAllMetrics();
        const regions = getAllRegions();
        
        const defaultYear = years.includes(2023) ? 2023 : years[years.length - 1];
        const yearDiv = document.createElement('div');
        yearDiv.className = 'control-group';
        yearDiv.innerHTML = `<span>年份：</span><select id="scatter-year">${years.map(y => `<option value="${y}" ${y === defaultYear ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
        container.appendChild(yearDiv);
        
        const defaultX = metrics[0];
        const xDiv = document.createElement('div');
        xDiv.className = 'control-group';
        xDiv.innerHTML = `<span>X轴指标：</span><select id="scatter-x">${metrics.map(m => `<option value="${m}" ${m === defaultX ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
        container.appendChild(xDiv);
        
        const defaultY = metrics[1] || metrics[0];
        const yDiv = document.createElement('div');
        yDiv.className = 'control-group';
        yDiv.innerHTML = `<span>Y轴指标：</span><select id="scatter-y">${metrics.map(m => `<option value="${m}" ${m === defaultY ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
        container.appendChild(yDiv);
        
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
            <span style="font-size: 11px; color: var(--text-muted); margin-left: 8px;">💡 按住 Ctrl 可多选</span>
        `;
        container.appendChild(regionDiv);
        
        const btn = document.createElement('button');
        btn.innerText = '生成散点图';
        btn.className = 'btn-sm';
        btn.onclick = () => loadChart(type);
        container.appendChild(btn);
        
        setTimeout(() => {
            const selectAll = document.getElementById('scatter-select-all');
            const clearAll = document.getElementById('scatter-clear-all');
            const selectEl = document.getElementById('scatter-regions');
            if (selectAll) selectAll.onclick = () => { Array.from(selectEl?.options || []).forEach(opt => opt.selected = true); };
            if (clearAll) clearAll.onclick = () => { Array.from(selectEl?.options || []).forEach(opt => opt.selected = false); };
        }, 50);
    }
}

async function loadChart(type) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    if (currentChartInstance) currentChartInstance.dispose();
    
    if (type === 'scatter') {
        const year = parseInt(document.getElementById('scatter-year')?.value) || 2023;
        const xMetric = document.getElementById('scatter-x')?.value;
        const yMetric = document.getElementById('scatter-y')?.value;
        const regions = Array.from(document.getElementById('scatter-regions')?.selectedOptions || []).map(o => o.value);
        
        if (!xMetric || !yMetric) { showToast('请选择 X 和 Y 轴指标', 'warn'); return; }
        if (!regions.length) { showToast('请至少选择一个地区', 'warn'); return; }
        
        try {
            const res = await fetch('/api/scatter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ year, xMetric, yMetric, regions })
            });
            const data = await res.json();
            
            const isDark = document.body.classList.contains('dark-mode');
            
            const option = {
                backgroundColor: 'transparent',
                title: { 
                    text: `${xMetric} vs ${yMetric} (${year}年)`, 
                    left: 'center',
                    textStyle: { color: isDark ? '#f7fafc' : '#1f2b48' }
                },
                xAxis: { 
                    name: data.xName, 
                    nameLocation: 'middle', 
                    nameGap: 35,
                    axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
                    axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
                    splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
                },
                yAxis: { 
                    name: data.yName, 
                    nameLocation: 'middle', 
                    nameGap: 35,
                    axisLine: { lineStyle: { color: isDark ? '#4a5568' : '#dce5ef' } },
                    axisLabel: { color: isDark ? '#a0aec0' : '#5a6e8a' },
                    splitLine: { lineStyle: { color: isDark ? '#2d3748' : '#f0f2f6', type: 'dashed' } }
                },
                series: [{
                    type: 'scatter',
                    data: data.data,
                    symbolSize: 12,
                    label: { 
                        show: true, 
                        formatter: p => p.data[2], 
                        position: 'top', 
                        offset: [0, -8], 
                        fontSize: 10,
                        color: isDark ? '#a0aec0' : '#5a6e8a'
                    },
                    itemStyle: { 
                        color: new echarts.graphic.RadialGradient(0.4, 0.3, 1, [
                            { offset: 0, color: '#667eea' },
                            { offset: 1, color: '#764ba2' }
                        ])
                    }
                }]
            };
            
            currentChartInstance = echarts.init(chartDom);
            currentChartInstance.setOption(option);
            setTimeout(() => currentChartInstance.resize(), 100);
        } catch (e) {
            console.error('散点图加载失败:', e);
        }
    }
}

function openAnalysisPanel(type) {
    const panel = document.getElementById('analysis-panel');
    if (!panel) return;
    
    // Toggle: if same chart already open, close it
    if (activeChart === type && panel.style.display !== 'none') {
        panel.style.display = 'none';
        panel.style.maxHeight = '0';
        activeChart = null;
        if (currentChartInstance) { currentChartInstance.dispose(); currentChartInstance = null; }
        // Reset card active states
        document.querySelectorAll('.card-item').forEach(c => c.classList.remove('active'));
        return;
    }
    
    activeChart = type;
    const titleMap = { scatter: '散点图 — 双指标关联分析' };
    const titleEl = document.getElementById('panel-title');
    if (titleEl) titleEl.innerText = titleMap[type] || type;
    
    // Animate open
    panel.style.display = 'block';
    panel.style.maxHeight = '0';
    panel.style.overflow = 'hidden';
    panel.style.transition = 'max-height 0.4s cubic-bezier(0.4,0,0.2,1)';
    requestAnimationFrame(() => {
        panel.style.maxHeight = '800px';
    });
    
    // Highlight active card
    document.querySelectorAll('.card-item').forEach(c => {
        c.classList.toggle('active', c.dataset.chart === type);
    });
    
    renderControls(type);
    
    setTimeout(() => {
        loadChart(type);
        bindExportEvents();
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 150);
}

function exportAnalysisChart(format) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    const chart = echarts.getInstanceByDom(chartDom);
    if (!chart) {
        // Try to re-render instead of alert
        console.warn('散点图未加载，请先展开分析面板');
        return;
    }
    const isDark = document.body.classList.contains('dark-mode');
    const bg = isDark ? '#1a2236' : '#ffffff';
    let url;
    if (format === 'png') url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg });
    else if (format === 'jpg') url = chart.getDataURL({ type: 'jpeg', pixelRatio: 2, backgroundColor: bg });
    else url = chart.getDataURL({ type: 'svg' });
    const link = document.createElement('a');
    link.download = `scatter_${activeChart}_${Date.now()}.${format === 'jpg' ? 'jpg' : format}`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function bindExportEvents() {
    document.getElementById('export-chart-png')?.addEventListener('click', () => exportAnalysisChart('png'));
    document.getElementById('export-chart-jpg')?.addEventListener('click', () => exportAnalysisChart('jpg'));
    document.getElementById('export-chart-svg')?.addEventListener('click', () => exportAnalysisChart('svg'));
}

function initAnalysisCards() {
    const cards = document.querySelectorAll('.card-item');
    cards.forEach(card => {
        card.removeEventListener('click', card._clickHandler);
        const handler = () => openAnalysisPanel(card.dataset.chart);
        card.addEventListener('click', handler);
        card._clickHandler = handler;
    });
    
    document.getElementById('close-panel')?.addEventListener('click', () => {
        const panel = document.getElementById('analysis-panel');
        if (panel) panel.style.display = 'none';
        if (currentChartInstance) { currentChartInstance.dispose(); currentChartInstance = null; }
    });
}

function waitForWorkbook() {
    if (window.workbook && window.workbook['省份'] && window.workbook['省份'].length) {
        initAnalysisCards();
    } else {
        setTimeout(waitForWorkbook, 300);
    }
}

function updateTableStats(rows) {
    if (!rows || !rows.length) {
        document.querySelectorAll('#table-stats span[id^="stat-"]').forEach(el => el.innerText = '-');
        return;
    }
    const statCount = document.getElementById('stat-count');
    const statYear = document.getElementById('stat-year');
    const statMetrics = document.getElementById('stat-metrics');
    const statScience = document.getElementById('stat-science');
    const statRobot = document.getElementById('stat-robot');
    const statUniv = document.getElementById('stat-univ');
    
    if (statCount) statCount.innerText = rows.length;
    
    const years = rows.map(r => r['年份']).filter(v => v);
    if (years.length && statYear) {
        statYear.innerText = `${Math.min(...years)} - ${Math.max(...years)}`;
    }
    
    const sample = rows[0];
    const numMetrics = Object.keys(sample).filter(k => k !== '年份' && k !== '地区' && typeof sample[k] === 'number').length;
    if (statMetrics) statMetrics.innerText = numMetrics;
    
    const scienceSum = rows.reduce((s, r) => s + (r['科学支出水平'] || 0), 0);
    if (statScience) statScience.innerText = scienceSum.toFixed(2);
    
    const robotVals = rows.map(r => r['工业机器人密度']).filter(v => typeof v === 'number');
    const robotAvg = robotVals.length ? (robotVals.reduce((a,b) => a+b,0) / robotVals.length).toFixed(2) : '-';
    if (statRobot) statRobot.innerText = robotAvg;
    
    const univVals = rows.map(r => r['普通高校数量']).filter(v => typeof v === 'number').sort((a,b) => a-b);
    let univMedian = '-';
    if (univVals.length) {
        const mid = Math.floor(univVals.length / 2);
        univMedian = univVals.length % 2 === 0 ? ((univVals[mid-1] + univVals[mid]) / 2).toFixed(0) : univVals[mid].toFixed(0);
    }
    if (statUniv) statUniv.innerText = univMedian;
}

// ======================= 事件绑定 =======================

function bindEvents() {
    document.getElementById("chart-type")?.addEventListener("change", () => renderMainChart());
    
    document.getElementById("apply-set")?.addEventListener("click", () => {
        custom.title = document.getElementById("chart-title")?.value || "auto";
        custom.xName = document.getElementById("x-name")?.value || "auto";
        custom.yName = document.getElementById("y-name")?.value || "auto";
        custom.yMax = document.getElementById("y-max")?.value || "auto";
        renderMainChart();
    });
    
    document.getElementById("reset-set")?.addEventListener("click", () => {
        custom = { title: "auto", xName: "auto", yName: "auto", yMax: "auto" };
        const chartTitle = document.getElementById("chart-title");
        const xName = document.getElementById("x-name");
        const yName = document.getElementById("y-name");
        const yMax = document.getElementById("y-max");
        if (chartTitle) chartTitle.value = "";
        if (xName) xName.value = "";
        if (yName) yName.value = "";
        if (yMax) yMax.value = "";
        renderMainChart();
    });
    
    document.getElementById("export-csv")?.addEventListener("click", () => exportData("csv"));
    document.getElementById("export-excel")?.addEventListener("click", () => exportData("xlsx"));
    document.getElementById("print-table")?.addEventListener("click", printTable);
    
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", debounce(() => {
            currentPage = 1;
            applyFilterAndSort();
            renderTablePage();
        }, 200));
    }
    
    const scaleInput = document.getElementById("table-scale");
    if (scaleInput) {
        scaleInput.addEventListener("input", () => {
            const scale = parseFloat(scaleInput.value);
            const tableWrap = document.querySelector(".table-wrap");
            if (tableWrap) tableWrap.style.transform = `scale(${scale})`;
            const scaleText = document.getElementById("scale-text");
            if (scaleText) scaleText.innerText = `${Math.round(scale * 100)}%`;
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
        });
    }
    
    document.getElementById("page-first")?.addEventListener("click", goFirstPage);
    document.getElementById("page-prev")?.addEventListener("click", goPrevPage);
    document.getElementById("page-next")?.addEventListener("click", goNextPage);
    document.getElementById("page-last")?.addEventListener("click", goLastPage);
    document.getElementById("page-go")?.addEventListener("click", goToPage);
    
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) {
        pageSizeSelect.addEventListener("change", (e) => {
            pageSize = parseInt(e.target.value);
            currentPage = 1;
            applyFilterAndSort();
            renderTablePage();
        });
    }
    
    document.getElementById("clear-sort")?.addEventListener("click", () => {
        sortKey = "";
        sortType = "asc";
        currentPage = 1;
        applyFilterAndSort();
        renderTablePage();
    });
    
    document.getElementById("reset-table")?.addEventListener("click", () => {
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
    });
    
    document.getElementById("export-main-png")?.addEventListener("click", () => exportChart(mainChart, 'png', 'main_chart'));
    document.getElementById("export-main-jpg")?.addEventListener("click", () => exportChart(mainChart, 'jpg', 'main_chart'));
    document.getElementById("export-main-svg")?.addEventListener("click", () => exportChart(mainChart, 'svg', 'main_chart'));
    document.getElementById("export-pie-png")?.addEventListener("click", () => exportChart(pieChart, 'png', 'pie_chart'));
    document.getElementById("export-pie-jpg")?.addEventListener("click", () => exportChart(pieChart, 'jpg', 'pie_chart'));
    document.getElementById("export-pie-svg")?.addEventListener("click", () => exportChart(pieChart, 'svg', 'pie_chart'));
    document.getElementById("export-adv-png")?.addEventListener("click", () => exportChart(advancedChart, 'png', 'advanced_chart'));
    document.getElementById("export-adv-jpg")?.addEventListener("click", () => exportChart(advancedChart, 'jpg', 'advanced_chart'));
    document.getElementById("export-adv-svg")?.addEventListener("click", () => exportChart(advancedChart, 'svg', 'advanced_chart'));
    
    // 夜间模式
    initDarkMode();
}

// ======================= Toast 通知系统（替代 alert）=======================

let _toastContainer = null;

function showToast(message, type = 'info', duration = 3500) {
    if (!_toastContainer) {
        _toastContainer = document.createElement('div');
        _toastContainer.id = 'toast-container';
        Object.assign(_toastContainer.style, {
            position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '99999', display: 'flex', flexDirection: 'column', gap: '8px',
            alignItems: 'center', pointerEvents: 'none'
        });
        document.body.appendChild(_toastContainer);
    }
    
    const colors = {
        info:  { bg: 'rgba(102,126,234,.95)', icon: 'ℹ' },
        warn:  { bg: 'rgba(237,137,54,.95)',  icon: '!' },
        error: { bg: 'rgba(245,101,101,.95)', icon: '✕' },
        success: { bg: 'rgba(72,187,120,.95)', icon: '✓' },
    };
    const c = colors[type] || colors.info;
    
    const toast = document.createElement('div');
    Object.assign(toast.style, {
        background: c.bg,
        color: '#fff',
        padding: '10px 20px',
        borderRadius: '12px',
        fontSize: '.88rem',
        fontWeight: '500',
        boxShadow: '0 6px 24px rgba(0,0,0,.22)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        maxWidth: '420px',
        textAlign: 'center',
        animation: 'toastIn .25s cubic-bezier(.4,0,.2,1)',
        pointerEvents: 'auto',
        cursor: 'pointer',
    });
    toast.innerHTML = `<span style="font-weight:700;font-size:1rem;line-height:1">${c.icon}</span><span>${message}</span>`;
    toast.onclick = () => dismissToast(toast);
    _toastContainer.appendChild(toast);
    
    // Inject keyframes once
    if (!document.getElementById('toast-keyframes')) {
        const style = document.createElement('style');
        style.id = 'toast-keyframes';
        style.textContent = `@keyframes toastIn{from{opacity:0;transform:translateY(12px) scale(.95);}to{opacity:1;transform:translateY(0) scale(1);}}
        @keyframes toastOut{from{opacity:1;transform:scale(1);}to{opacity:0;transform:scale(.9);}}`;
        document.head.appendChild(style);
    }
    
    const timer = setTimeout(() => dismissToast(toast), duration);
    toast._timer = timer;
}

function dismissToast(toast) {
    clearTimeout(toast._timer);
    toast.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => toast.remove(), 200);
}

// ======================= 启动 =======================

waitForWorkbook();
bindEvents();
init();