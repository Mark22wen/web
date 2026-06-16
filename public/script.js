// 自动检测部署子路径：本地开发为空，部署在 /ett2/ 时自动加前缀
// 取 pathname 第一段作为前缀（如 /ett2），根路径部署时为空字符串
const API_BASE = (() => {
    const seg = window.location.pathname.split('/').filter(Boolean)[0];
    return seg ? '/' + seg : '';
})();

const _origFetch = window.fetch;
window.fetch = (url, opts = {}) => {
    opts.headers = { ...(opts.headers || {}), 'ngrok-skip-browser-warning': 'true' };
    return _origFetch(url, opts);
};
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
    return String(str).replace(/[&<>"']/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        if (m === "'") return '&#39;';
        return m;
    });
}

function getLatestClientDataYear() {
    const years = [];
    if (window.workbook && typeof window.workbook === 'object') {
        Object.values(window.workbook).forEach(rows => {
            if (!Array.isArray(rows)) return;
            rows.forEach(row => {
                const year = Number(row?.['年份'] ?? row?.['时间']);
                if (Number.isFinite(year)) years.push(year);
            });
        });
    }
    return years.length ? Math.max(...years) : 2024;
}

function isUnsupportedPredictionText(text) {
    const value = String(text || '');
    if (/(预测|预估|预计|推测|forecast|predict|projection|明年|后年|下一年|下年|未来)/i.test(value)) return true;
    const latestYear = getLatestClientDataYear();
    const years = (value.match(/20\d{2}/g) || []).map(y => parseInt(y, 10)).filter(Number.isFinite);
    return years.some(year => year > latestYear) && !/(报告|白皮书|文献|资料|发布|出版|全球智数化人才指数报告)/.test(value);
}

function filterRagSuggestions(suggestions) {
    return (suggestions || []).map(s => String(s || '').trim()).filter(s => s && !isUnsupportedPredictionText(s));
}

function sanitizeRagSuggestionHtml(html) {
    if (!html || !/(rag-suggestion|预测|forecast|predict|未来|明年|后年)/i.test(String(html))) return html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('.rag-suggestion').forEach(btn => {
        const text = btn.dataset.question || btn.textContent || '';
        if (isUnsupportedPredictionText(text)) btn.remove();
    });
    tmp.querySelectorAll('.rag-suggestions').forEach(box => {
        if (!box.querySelector('.rag-suggestion')) box.remove();
    });
    return tmp.innerHTML;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Y 轴大数缩写，避免长数字与轴标题重叠
function fmtAxisNum(v) {
    if (typeof v !== 'number') return v;
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 1 : 2).replace(/\.?0+$/, '') + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 1 : 2).replace(/\.?0+$/, '') + '万';
    return v;
}
// 根据数据最大值动态计算 nameGap（轴标题到刻度的距离）
function calcYNameGap(maxVal) {
    const a = Math.abs(maxVal || 0);
    if (a >= 1e8) return 52;   // "1.23亿" ≈ 5~6字符
    if (a >= 1e4) return 56;   // "2100万" ≈ 5~6字符
    if (a >= 1e3) return 52;   // "9,999" ≈ 5字符
    return 44;
}

// ======================= Landing Page & RAG 全屏界面 =======================

let ragReturnPage = 'dashboard';
let pendingSheetSwitchTimer = null;

function showLanding() {
    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    const rag = document.getElementById('rag-fullscreen');
    const fab = document.getElementById('chat-float-btn');
    document.body.classList.remove('rag-open');
    
    if (dp) { dp.style.opacity = '0'; dp.style.transform = 'translateY(12px)'; }
    
    setTimeout(() => {
        if (lp) { lp.style.display = 'block'; lp.style.opacity = '0'; lp.style.transform = 'scale(1)'; requestAnimationFrame(() => { lp.style.transition = 'opacity 0.35s ease'; lp.style.opacity = '1'; }); }
        if (dp) dp.style.display = 'none';
        if (rag) rag.style.display = 'none';
        if (fab) fab.style.display = 'none';
    }, 50);
}

function enterSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover) return;
    cover.classList.add('slide-out');
    setTimeout(() => {
        cover.style.display = 'none';
        document.body.classList.remove('sdufe-cover-active');
        document.body.classList.add('sdufe-cover-seen');
        // 封面退出后直接进入平台，不经过 hero 页
        enterDashboard();
    }, 420);
}

// ===== 用户中心 =====
function toggleUserMenu() {
    const dd = document.getElementById("user-dropdown");
    if (!dd) return;
    const isOpen = dd.style.display !== 'none';
    dd.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        // 点击外部关闭
        setTimeout(() => {
            document.addEventListener("click", closeUserMenuOutside, { once: true });
        }, 0);
    }
}
function closeUserMenuOutside(e) {
    const wrap = document.getElementById("user-center-wrap");
    if (wrap && !wrap.contains(e.target)) {
        const dd = document.getElementById("user-dropdown");
        if (dd) dd.style.display = 'none';
    }
}
function handleLogout() {
    const dd = document.getElementById("user-dropdown");
    if (dd) dd.style.display = 'none';
    returnToSdufeCover();
}

function returnToSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover) return;
    // 隐藏 dashboard，显示 landing（封面是 landing 的子元素）
    const dp = document.getElementById('dashboard-page');
    const lp = document.getElementById('landing-page');
    const rag = document.getElementById('rag-fullscreen');
    const fab = document.getElementById('chat-float-btn');
    if (dp) dp.style.display = 'none';
    if (rag) rag.style.display = 'none';
    if (fab) fab.style.display = 'none';
    document.body.classList.remove('rag-open');
    // 先让 landing-page 可见（封面在其内部）
    if (lp) { lp.style.display = 'block'; lp.style.opacity = '1'; lp.style.transform = 'none'; }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.body.classList.add('sdufe-cover-active');
    document.body.classList.remove('sdufe-cover-seen');
    cover.style.display = 'flex';
    cover.classList.remove('slide-out');
}

function initSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover || cover._bound) return;
    cover._bound = true;
    restoreCoverBgFromCache();
    document.body.classList.add('sdufe-cover-active');

    const seal = document.getElementById('relief-seal-el') || cover.querySelector('.relief-seal');
    let cursor = cover.querySelector('.sdufe-cover-cursor');
    if (!cursor) {
        cursor = document.createElement('div');
        cursor.className = 'sdufe-cover-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        cover.appendChild(cursor);
    }
    let brushRadius = 0;
    let targetRadius = 0;
    let rafId = null;
    let autoPausedUntil = 0;
    let calibrationProgress = 0;
    let lastProbeAt = 0;
    const probe = {
        x: 50, y: 48, tx: 50, ty: 48,
        px: 50, py: 48, angle: 0, stretch: 1,
        visible: 0, targetVisible: 0
    };
    let meter = cover.querySelector('.sdufe-calibration-meter');
    if (!meter) {
        meter = document.createElement('div');
        meter.className = 'sdufe-calibration-meter';
        meter.setAttribute('aria-hidden', 'true');
        meter.innerHTML = '';
        cover.appendChild(meter);
    }

    function setCalibrationProgress(next) {
        calibrationProgress = Math.max(0, Math.min(1, next));
        const rest = 1 - calibrationProgress;
        cover.style.setProperty('--cal', calibrationProgress.toFixed(3));
        cover.style.setProperty('--cal-width', `${(calibrationProgress * 100).toFixed(1)}%`);
        cover.style.setProperty('--cal-blur', `${(rest * 1.4).toFixed(2)}px`);
        cover.style.setProperty('--cal-title-blur', `${(rest * 0.9).toFixed(2)}px`);
        cover.style.setProperty('--cal-shift', `${(rest * -8).toFixed(2)}px`);
        cover.style.setProperty('--cal-enter-y', `${(rest * 5).toFixed(2)}px`);
        cover.style.setProperty('--cal-text-opacity', (0.58 + calibrationProgress * 0.34).toFixed(3));
        cover.style.setProperty('--cal-enter-opacity', (0.64 + calibrationProgress * 0.36).toFixed(3));
        cover.style.setProperty('--cal-shadow-alpha', (0.10 + calibrationProgress * 0.12).toFixed(3));
        cover.style.setProperty('--cal-border-alpha', (0.12 + calibrationProgress * 0.18).toFixed(3));
        cover.style.setProperty('--cal-saturate', (0.82 + calibrationProgress * 0.28).toFixed(3));
        cover.style.setProperty('--cal-ghost-a', (rest * 0.16).toFixed(3));
        cover.style.setProperty('--cal-ghost-b', (rest * 0.38).toFixed(3));
        cover.style.setProperty('--cal-ghost-x', `${(rest * 8).toFixed(2)}px`);
        cover.style.setProperty('--cal-ghost-y', `${(rest * -5).toFixed(2)}px`);
        cover.classList.toggle('calibrated', calibrationProgress >= 0.72);
        cover.classList.toggle('calibrating', calibrationProgress > 0.04 && calibrationProgress < 0.72);
        if (meter) meter.style.setProperty('--cal', calibrationProgress.toFixed(3));
    }
    setCalibrationProgress(0.12);

    const coverVisible = () => document.body.classList.contains('sdufe-cover-active')
        && cover.offsetParent !== null
        && getComputedStyle(cover).display !== 'none';

    function animateProbe() {
        if (!coverVisible()) {
            setTimeout(() => requestAnimationFrame(animateProbe), 500);
            return;
        }
        probe.px = probe.x;
        probe.py = probe.y;
        probe.x += (probe.tx - probe.x) * 0.14;
        probe.y += (probe.ty - probe.y) * 0.14;
        const vx = probe.x - probe.px;
        const vy = probe.y - probe.py;
        const speed = Math.min(1, Math.sqrt(vx * vx + vy * vy) / 2.8);
        probe.angle += ((Math.atan2(vy, vx) * 180 / Math.PI || probe.angle) - probe.angle) * 0.16;
        probe.stretch += ((1 + speed * 0.38) - probe.stretch) * 0.18;
        probe.visible += (probe.targetVisible - probe.visible) * 0.16;
        cover.style.setProperty('--probe-x', `${probe.x.toFixed(2)}%`);
        cover.style.setProperty('--probe-y', `${probe.y.toFixed(2)}%`);
        cover.style.setProperty('--probe-angle', `${probe.angle.toFixed(2)}deg`);
        cover.style.setProperty('--probe-stretch', probe.stretch.toFixed(3));
        cover.style.setProperty('--probe-squash', (1 / Math.sqrt(probe.stretch)).toFixed(3));
        cover.style.setProperty('--cursor-opacity', probe.visible.toFixed(3));
        cover.style.setProperty('--cursor-scale', (0.72 + probe.visible * 0.28).toFixed(3));
        requestAnimationFrame(animateProbe);
    }
    requestAnimationFrame(animateProbe);

    function animateBrush() {
        brushRadius += (targetRadius - brushRadius) * 0.10;
        const diff = Math.abs(targetRadius - brushRadius);
        if (seal) {
            seal.style.setProperty('--br', `${brushRadius.toFixed(1)}px`);
        }
        // activate class when brush is meaningfully open
        if (brushRadius > 8) {
            seal?.classList.add('brush-active');
        } else {
            seal?.classList.remove('brush-active');
        }
        if (diff > 0.4) {
            rafId = requestAnimationFrame(animateBrush);
        } else {
            brushRadius = targetRadius;
            if (seal) seal.style.setProperty('--br', `${brushRadius.toFixed(1)}px`);
            rafId = null;
        }
    }

    const update = (clientX, clientY) => {
        autoPausedUntil = Date.now() + 1800;
        const now = Date.now();
        if (now - lastProbeAt > 48) {
            setCalibrationProgress(calibrationProgress + 0.018);
            lastProbeAt = now;
        }
        // Update parallax vars on cover
        const rect = cover.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width * 100).toFixed(2);
        const y = ((clientY - rect.top) / rect.height * 100).toFixed(2);
        cover.style.setProperty('--mx', `${x}%`);
        cover.style.setProperty('--my', `${y}%`);
        probe.tx = Number(x);
        probe.ty = Number(y);
        probe.targetVisible = 1;
        cover.style.setProperty('--move-x', `${((parseFloat(x) - 50) * 0.18).toFixed(2)}px`);
        cover.style.setProperty('--move-y', `${((parseFloat(y) - 50) * 0.14).toFixed(2)}px`);
        const moveX = (parseFloat(x) - 50) * 0.18;
        const moveY = (parseFloat(y) - 50) * 0.14;
        cover.style.setProperty('--bgword-move-x', `${(moveX * -0.25).toFixed(2)}px`);
        cover.style.setProperty('--bgword-move-y', `${(moveY * -0.18).toFixed(2)}px`);
        cover.style.setProperty('--seal-move-x', `${(moveX * 0.22).toFixed(2)}px`);
        cover.style.setProperty('--seal-move-y', `${(moveY * 0.18).toFixed(2)}px`);
        cover.classList.add('is-probing');

        if (!seal) return;
        const sealRect = seal.getBoundingClientRect();
        const cx = sealRect.left + sealRect.width / 2;
        const cy = sealRect.top + sealRect.height / 2;
        const dist = Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2);
        const pad = Math.min(22, Math.max(10, sealRect.width * 0.05));
        const insideSealField = clientX >= sealRect.left - pad
            && clientX <= sealRect.right + pad
            && clientY >= sealRect.top - pad
            && clientY <= sealRect.bottom + pad;
        const triggerDist = Math.max(sealRect.width, sealRect.height) * 0.72;

        if (insideSealField) {
            // Brush center follows mouse relative to seal
            const bx = ((clientX - sealRect.left) / sealRect.width * 100).toFixed(1);
            const by = ((clientY - sealRect.top) / sealRect.height * 100).toFixed(1);
            seal.style.setProperty('--mx', `${bx}%`);
            seal.style.setProperty('--my', `${by}%`);
            seal.style.setProperty('--bx', `${bx}%`);
            seal.style.setProperty('--by', `${by}%`);
            const prox = 1 - Math.min(dist / triggerDist, 1);
            targetRadius = 34 + prox * 150;
            setCalibrationProgress(calibrationProgress + 0.028 + prox * 0.018);
        } else {
            targetRadius = 0;
        }
        if (!rafId) rafId = requestAnimationFrame(animateBrush);
    };

    cover.addEventListener('mousemove', e => update(e.clientX, e.clientY));
    cover.addEventListener('mouseleave', () => {
        autoPausedUntil = Date.now() + 700;
        targetRadius = 0;
        cover.classList.remove('is-probing');
        probe.targetVisible = 0;
        cover.style.setProperty('--move-x', '0px');
        cover.style.setProperty('--move-y', '0px');
        cover.style.setProperty('--bgword-move-x', '0px');
        cover.style.setProperty('--bgword-move-y', '0px');
        cover.style.setProperty('--seal-move-x', '0px');
        cover.style.setProperty('--seal-move-y', '0px');
        if (!rafId) rafId = requestAnimationFrame(animateBrush);
    });
    cover.addEventListener('touchmove', e => {
        autoPausedUntil = Date.now() + 2200;
        if (e.touches?.[0]) update(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    const autoSweep = () => {
        if (!coverVisible()) {
            setTimeout(() => requestAnimationFrame(autoSweep), 500);
            return;
        }
        if (seal && Date.now() > autoPausedUntil) {
            const phase = (Date.now() % 5200) / 5200;
            const active = phase > 0.18 && phase < 0.74;
            if (active) {
                const p = (phase - 0.18) / 0.56;
                const eased = 0.5 - Math.cos(p * Math.PI) / 2;
                const bx = 18 + eased * 64;
                const by = 48 + Math.sin(p * Math.PI * 2) * 8;
                seal.style.setProperty('--mx', `${bx.toFixed(1)}%`);
                seal.style.setProperty('--my', `${by.toFixed(1)}%`);
                seal.style.setProperty('--bx', `${bx.toFixed(1)}%`);
                seal.style.setProperty('--by', `${by.toFixed(1)}%`);
                targetRadius = 74 + Math.sin(p * Math.PI) * 38;
                setCalibrationProgress(calibrationProgress + 0.0032);
            } else {
                targetRadius = 0;
                if (calibrationProgress > 0.08 && calibrationProgress < 0.72) {
                    setCalibrationProgress(calibrationProgress - 0.0008);
                }
            }
            if (!rafId) rafId = requestAnimationFrame(animateBrush);
        }
        requestAnimationFrame(autoSweep);
    };
    requestAnimationFrame(autoSweep);
}

function forceResizeAllCharts() {
    // Defer to next animation frames so containers have measurable dimensions
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            [mainChart, pieChart, advancedChart, rankChart].forEach(c => {
                try { if (c && !c.isDisposed?.()) c.resize(); } catch(e) {}
            });
            // Re-render main chart to recompute layout with new container size
            try { if (typeof renderMainChart === 'function' && mainChart && !mainChart.isDisposed?.()) renderMainChart(); } catch(e) {}
            try { if (typeof renderPieChart === 'function' && pieChart && !pieChart.isDisposed?.() && pieAvailableMetrics?.length) renderPieChart(); } catch(e) {}
            try { if (typeof renderAdvancedChart === 'function' && rankChart && !rankChart.isDisposed?.() && advMetrics?.length) renderAdvancedChart(); } catch(e) {}
        });
    });
    // Extra safety: one more resize after ~250ms for charts that initialize slowly
    setTimeout(() => {
        [mainChart, pieChart, advancedChart, rankChart].forEach(c => {
            try { if (c && !c.isDisposed?.()) c.resize(); } catch(e) {}
        });
    }, 250);
}

function resizeActiveAnalysisChart() {
    const panel = document.getElementById('analysis-panel');
    const chartDom = document.getElementById('analysis-chart');
    if (!panel?.classList.contains('open') || !chartDom) return;
    // 动画进行中：跳过 resize，避免移动端地址栏收缩→innerHeight 变化→高度抖动循环
    if (panel._animating) return;
    const chart = window.echarts ? echarts.getInstanceByDom(chartDom) : null;
    if (!chart) return;
    // 蝴蝶图：以 chartDom 当前 inline height 为准，不覆盖（其高度由 loadChart 按行数计算）
    if (activeChart === 'butterfly') {
        const inlineH = parseInt(chartDom.style.height);
        if (inlineH > 0) {
            try { chart.resize({ height: inlineH }); } catch(e) {}
        }
        return;
    }
    // 散点/气泡图：用 viewport 自适应高度
    const nextH = fitAnalysisPanelToViewport();
    try { chart.resize({ height: nextH }); } catch(e) {}
}

function enterDashboard(tab) {
    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    const fab = document.getElementById('chat-float-btn');

    if (tab === 'rag') {
        const fromDashboard = dp && dp.style.display !== 'none';
        ragReturnPage = fromDashboard ? 'dashboard' : 'landing';
        if (lp) {
            lp.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
            lp.style.opacity = '0';
            lp.style.transform = 'scale(0.99)';
        }
        setTimeout(() => {
            if (lp) lp.style.display = 'none';
            if (dp && !fromDashboard) dp.style.display = 'none';
            if (fab) fab.style.display = 'none';
            openRagFullscreen({ returnPage: ragReturnPage });
        }, 180);
        return;
    }
    
    if (lp) {
        lp.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        lp.style.opacity = '0';
        lp.style.transform = 'scale(0.98)';
    }
    
    setTimeout(() => {
        if (lp) {
            lp.style.display = 'none';
        }
        if (dp) {
            dp.style.display = 'block';
            dp.style.opacity = '0';
            dp.style.transform = 'translateY(14px)';
            requestAnimationFrame(() => {
                dp.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.4,0,0.2,1)';
                dp.style.opacity = '1';
                dp.style.transform = 'translateY(0)';
            });
            // Critical: charts were initialized when dashboard was hidden (0×0). Resize now.
            forceResizeAllCharts();
        }
        if (fab) {
            fab.style.display = 'flex'; fab.style.opacity = '0';
            setTimeout(() => { fab.style.transition = 'opacity 0.3s'; fab.style.opacity = '1'; }, 200);
        }
        
        // Route to specific section based on tab
        if (tab === 'pie') {
            setTimeout(() => {
                const av = document.getElementById('section-analysis-view');
                if (av) av.scrollIntoView({behavior:'smooth',block:'start'});
                forceResizeAllCharts();
            }, 400);
        } else if (tab === 'scatter') {
            setTimeout(() => {
                const sc = document.getElementById('section-scatter');
                if (sc) { sc.style.display = 'block'; openAnalysisPanel('scatter'); }
                forceResizeAllCharts();
            }, 400);
        } else if (tab === 'table') {
            setTimeout(() => {
                toggleTableSection(true); // 点击明细查询时自动展开
                const t = document.getElementById('section-table');
                if (t) t.scrollIntoView({behavior:'smooth',block:'start'});
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

function initHeroPreview() {
    const card = document.querySelector('.hero-preview-card');
    if (!card || card._bound) return;
    card._bound = true;

    const tabs = [...card.querySelectorAll('.preview-tab')];
    const panels = [...card.querySelectorAll('.preview-panel')];
    const activate = (name) => {
        tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.preview === name));
        panels.forEach(panel => panel.classList.toggle('active', panel.dataset.previewPanel === name));
    };

    let previewIndex = Math.max(0, tabs.findIndex(tab => tab.classList.contains('active')));
    let previewPaused = false;

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            previewIndex = index;
            activate(tab.dataset.preview);
        });
    });

    card.addEventListener('mouseenter', () => { previewPaused = true; });
    card.addEventListener('mouseleave', () => {
        previewPaused = false;
        card.style.removeProperty('--px');
        card.style.removeProperty('--py');
        card.style.removeProperty('--tilt-x');
        card.style.removeProperty('--tilt-y');
    });
    card.addEventListener('mousemove', (event) => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        card.style.setProperty('--px', `${(x * 100).toFixed(2)}%`);
        card.style.setProperty('--py', `${(y * 100).toFixed(2)}%`);
        card.style.setProperty('--tilt-x', `${((0.5 - y) * 3).toFixed(2)}deg`);
        card.style.setProperty('--tilt-y', `${((x - 0.5) * 3).toFixed(2)}deg`);
    });

    setInterval(() => {
        if (previewPaused || tabs.length < 2 || document.body.classList.contains('sdufe-cover-active')) return;
        previewIndex = (previewIndex + 1) % tabs.length;
        activate(tabs[previewIndex].dataset.preview);
    }, 3400);

    card.querySelectorAll('.preview-action').forEach(btn => {
        btn.addEventListener('click', () => {
            const query = btn.dataset.query || '';
            if (query) setLandingQuery(query);
            enterDashboardWithQuery();
        });
    });
}

// ======================= RAG 全屏界面 =======================

function refineRagCapabilityBadges() {
    const caps = document.querySelector('.rag-caps');
    if (!caps || refineRagCapabilityBadges._done) return;
    refineRagCapabilityBadges._done = true;
    caps.innerHTML = ['多问题拆解', '数据检索', '趋势分析', '方法解释']
        .map(text => `<span class="rag-cap-chip">${escapeHtml(text)}</span>`)
        .join('');
}


function ensureDashboardAnalysisVisible() {
    const sc = document.getElementById('section-scatter');
    if (sc) sc.style.display = 'block';
}

function initPaginationGuide() {
    const bar = document.querySelector('.pagination-bar');
    const input = document.getElementById('page-goto');
    const btn = document.getElementById('page-go');
    if (input) {
        input.placeholder = '页码';
        input.title = '输入页码后点击 GO 跳转';
        input.setAttribute('aria-label', '跳转页码');
    }
    if (btn) btn.title = '跳转到输入的页码';
    if (!bar || bar.querySelector('.pagination-guide')) return;
    const guide = document.createElement('span');
    guide.className = 'pagination-guide';
    guide.textContent = '输入页码后点 GO 跳转';
    bar.appendChild(guide);
}

function openRagFullscreen(options = {}) {
    const rag = document.getElementById('rag-fullscreen');
    if (!rag) return;

    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    const dashboardVisible = dp && getComputedStyle(dp).display !== 'none';
    const landingVisible = lp && getComputedStyle(lp).display !== 'none';
    ragReturnPage = options.returnPage || (dashboardVisible ? 'dashboard' : landingVisible ? 'landing' : 'dashboard');
    
    if (ragReturnPage === 'landing') {
        if (lp) lp.style.display = 'none';
        if (dp) dp.style.display = 'none';
    } else {
        if (lp) lp.style.display = 'none';
        if (dp) dp.style.display = 'block';
    }
    rag.style.display = 'flex';
    document.body.classList.add('rag-open');
    // 恢复侧边栏折叠状态
    try {
        const sidebar = document.getElementById('rag-sidebar');
        if (sidebar && localStorage.getItem('ragSidebarCollapsed') === '1') sidebar.classList.add('collapsed');
        else if (sidebar) sidebar.classList.remove('collapsed');
    } catch(e) {}
    const fab = document.getElementById('chat-float-btn');
    if (fab) fab.style.display = 'none';
    
    // Init session: 复用现有空对话，避免重复建立
    if (ragAutoFreshSessionPending) {
        ragAutoFreshSessionPending = false;
        // 有当前空对话直接复用，否则才新建
        const existingEmpty = sessions.find(s => s.messages.length === 0);
        if (existingEmpty) {
            switchSession(existingEmpty.id);
        } else {
            startNewSession();
        }
    } else if (!currentSessionId) {
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

function toggleRagSidebar() {
    const sidebar = document.getElementById('rag-sidebar');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('collapsed');
    try { localStorage.setItem('ragSidebarCollapsed', collapsed ? '1' : '0'); } catch(e) {}
}

function openRagSidebarMobile() {
    const sidebar = document.getElementById('rag-sidebar');
    if (!sidebar) return;
    sidebar.classList.add('mobile-open');
    // 点击遮罩关闭
    const mask = document.createElement('div');
    mask.id = 'rag-sidebar-mask';
    mask.className = 'rag-sidebar-mask';
    mask.onclick = () => {
        sidebar.classList.remove('mobile-open');
        mask.remove();
    };
    document.getElementById('rag-fullscreen')?.appendChild(mask);
}

function closeRagFullscreen() {
    const rag = document.getElementById('rag-fullscreen');
    if (rag) rag.style.display = 'none';
    document.body.classList.remove('rag-open');
    const lp = document.getElementById('landing-page');
    const dp = document.getElementById('dashboard-page');
    if (lp) lp.style.display = 'none';
    if (dp) {
        dp.style.display = 'block';
        dp.style.opacity = '1';
        dp.style.transform = 'translateY(0)';
        forceResizeAllCharts();
    }
    const fab = document.getElementById('chat-float-btn');
    if (fab) fab.style.display = 'flex';
    ragReturnPage = 'dashboard';
}

function sendRagQuick(question) {
    const input = document.getElementById('rag-input');
    if (input) {
        input.value = question;
        sendRagMessage();
    }
}

let isRagStreaming = false;
let ragController = null;
const ragQueue = [];   // 追问队列
const _loadingSessions = new Set(); // 正在加载回答的会话 ID

function showRagStatusHint(html) {
    const hint = document.getElementById('rag-context-hint');
    if (!hint) return;
    hint.innerHTML = html || '';
    hint.style.display = html ? 'flex' : 'none';
}

function hideRagStatusHint() {
    showRagStatusHint('');
}

function _setSessionLoading(sessionId, on) {
    if (!sessionId) return;
    if (on) _loadingSessions.add(sessionId); else _loadingSessions.delete(sessionId);
    const el = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (el) el.classList.toggle('loading', on);
}

function stopRagGeneration() {
    if (ragController) {
        ragController.abort();
        ragController = null;
    }
    ragQueue.length = 0; // 停止时也清空队列
    _updateQueueBadge();
}

function toggleTableSection(forceOpen) {
    const body = document.getElementById('table-body-section');
    const icon = document.getElementById('table-collapse-icon');
    if (!body) return;
    // 用 class 标记状态，避免依赖 inline style 字符串比较
    const isCollapsed = body.classList.contains('section-collapsed') || body.style.display === 'none';
    const shouldOpen = forceOpen !== undefined ? !!forceOpen : isCollapsed;
    if (shouldOpen) {
        body.classList.remove('section-collapsed');
        body.style.display = 'block';
    } else {
        body.classList.add('section-collapsed');
        body.style.display = 'none';
    }
    if (icon) icon.style.transform = shouldOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function _updateSendBtnMode(inputVal) {
    const btn   = document.getElementById('rag-send');
    const icon  = document.getElementById('rag-send-icon');
    const label = document.getElementById('rag-send-label');
    if (!btn) return;
    const isFollowUp = isRagStreaming && inputVal;
    btn.classList.toggle('follow-up-mode', !!isFollowUp);
    if (icon)  icon.style.display  = isFollowUp ? 'none' : '';
    if (label) label.style.display = isFollowUp ? 'inline' : 'none';
    btn.title = isFollowUp ? '追问（AI 回答完后自动发送）' : '发送';
}

function _updateQueueBadge() {
    const wrap = document.getElementById('rag-queue-badge');
    if (!wrap) return;
    if (ragQueue.length > 0) {
        wrap.querySelector('span').textContent = `${ragQueue.length} 条消息等待中`;
        wrap.style.display = 'inline-flex';
    } else {
        wrap.style.display = 'none';
    }
}

// 处理队列中的追问（用户气泡已显示，直接触发AI回答）
async function _sendRagQueued(question) {
    const thisSessionId = currentSessionId; // 锁定 session，防止用户切换后存错
    const input = document.getElementById('rag-input');
    const sendBtn = document.getElementById('rag-send');
    const stopBtn = document.getElementById('rag-stop');
    const hint = document.getElementById('rag-context-hint');

    const assistantBubble = addRagMessage('assistant', '', true);
    assistantBubble.innerHTML = `
        <div class="rag-live-process">
            <div class="rag-live-title">正在思考与检索...</div>
            <div class="rag-live-steps">
                <span class="active">识别问题</span><span>查找数据</span>
                <span>调用工具</span><span>组织回复</span>
            </div>
        </div>`;
    isRagStreaming = true;
    _setSessionLoading(thisSessionId, true);
    const liveSteps = [...assistantBubble.querySelectorAll('.rag-live-steps span')];
    let liveStepIndex = 0;
    const liveProgressTimer = setInterval(() => {
        liveStepIndex = Math.min(liveStepIndex + 1, liveSteps.length - 1);
        liveSteps.forEach((s, i) => s.classList.toggle('active', i <= liveStepIndex));
    }, 850);

    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.display = 'none'; }
    if (stopBtn) stopBtn.style.display = 'flex';
    ragController = new AbortController();
    showRagStatusHint('<span>正在检索数据...</span>');

    try {
        const sessionId = thisSessionId || 'default';
        const response = await fetch(API_BASE + '/api/agent/stream', {
            signal: ragController.signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, sessionId })
        });
        if (!response.ok) throw new Error(`服务器错误 ${response.status}`);

        // SSE 流式读取（同 sendRagMessage）
        const reader2 = response.body.getReader();
        const decoder2 = new TextDecoder();
        let sseBuffer2 = '', streamText2 = '', textEl2 = null, data = null;
        const liveStepEls2 = [...assistantBubble.querySelectorAll('.rag-live-steps span')];
        while (true) {
            const { done: d2, value: v2 } = await reader2.read();
            if (d2) break;
            sseBuffer2 += decoder2.decode(v2, { stream: true });
            const lines2 = sseBuffer2.split('\n'); sseBuffer2 = lines2.pop();
            for (const ln of lines2) {
                if (!ln.startsWith('data: ')) continue;
                let e; try { e = JSON.parse(ln.slice(6)); } catch { continue; }
                if (e.type === 'status') {
                    liveStepEls2.forEach((s, i) => s.classList.toggle('active', i <= e.step));
                    const t = assistantBubble.querySelector('.rag-live-title'); if (t) t.textContent = e.text;
                } else if (e.type === 'token') {
                    if (!textEl2) { assistantBubble.innerHTML = '<div class="rag-stream-text"></div>'; textEl2 = assistantBubble.querySelector('.rag-stream-text'); }
                    streamText2 += e.text; textEl2.textContent = streamText2;
                    const mb = document.getElementById('rag-messages'); if (mb) mb.scrollTop = mb.scrollHeight;
                } else if (e.type === 'done') { data = e; }
                else if (e.type === 'error') { throw new Error(e.text); }
            }
        }
        if (!data) data = {};
        const finalAnswer2 = streamText2 || data.answer || '无回答';
        data.answer = finalAnswer2; // 供报告导出使用
        let html = '';
        if (data.reasoning?.length) {
            html += `<details class="rag-process-details"><summary>分析过程</summary>
                ${data.reasoning.map(r => `<div class="rag-method-item"><span>${escapeHtml(r)}</span></div>`).join('')}
            </details>`;
        }
        html += `<div class="rag-answer-content">${formatAnswer(finalAnswer2)}</div>`;
        if (data.citations?.length) {
            html += `<div class="rag-citations"><div class="rag-citation-head">数据来源</div>
                <div class="rag-citation-list">${data.citations.slice(0,3).map(c => `<span class="rag-citation">${escapeHtml(c)}</span>`).join('')}</div></div>`;
        }
        const safeSuggestions2 = filterRagSuggestions(data.suggestions || []);
        data.suggestions = safeSuggestions2;
        if (safeSuggestions2.length) {
            html += `<div class="rag-suggestions">${safeSuggestions2.map(s => `<button class="rag-suggestion" type="button" data-question="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`;
        }
        assistantBubble.innerHTML = html;
        assistantBubble.classList.remove('streaming-cursor');
        _appendRegenerateBtn(assistantBubble, question);
        setTimeout(() => executeAgentUiActions(data, question, assistantBubble), 180);
        const session = sessions.find(s => s.id === thisSessionId);
        if (session) {
            session.messages.push({ role: 'user', content: question });
            session.messages.push({ role: 'assistant', content: finalAnswer2, html: sanitizeRagSuggestionHtml(html) });
            saveSessions(); renderSessionList(); syncSessionSelect();
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            if (assistantBubble.textContent.trim() === '')
                assistantBubble.innerHTML = `<span style="color:var(--c-muted);font-size:.85rem;">已停止回答</span>`;
            else
                assistantBubble.innerHTML += `<div style="margin-top:8px;color:var(--c-muted);font-size:.8rem;border-top:1px solid var(--c-border);padding-top:6px;">— 已停止</div>`;
            _appendRegenerateBtn(assistantBubble, question);
            return;
        }
        assistantBubble.innerHTML = `<div style="color:var(--c-danger)">请求失败: ${escapeHtml(err.message)}</div>`;
    } finally {
        clearInterval(liveProgressTimer);
        isRagStreaming = false;
        _setSessionLoading(thisSessionId, false);
        ragController = null;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.style.display = 'flex'; }
        if (stopBtn) stopBtn.style.display = 'none';
        hideRagStatusHint();
        if (ragQueue.length > 0) {
            const next = ragQueue.shift();
            _updateQueueBadge();
            setTimeout(() => _sendRagQueued(next), 120);
        }
    }
}

function _appendRegenerateBtn(bubble, question) {
    if (!question || !bubble) return;
    if (bubble.querySelector('.rag-regen-bar')) return; // 防止重复添加
    const bar = document.createElement('div');
    bar.className = 'rag-regen-bar';
    bar.innerHTML = `
        <button class="rag-regen-btn" title="重新生成">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
            </svg>
            重新生成
        </button>
        <button class="rag-copy-btn" title="复制回答">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            复制
        </button>
        <button class="rag-followup-btn" title="追问此回答">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="13" y2="14"/>
            </svg>
            追问此回答
        </button>`;
    bar.querySelector('.rag-copy-btn').onclick = function() {
        const answerEl = bubble.querySelector('.rag-answer-content');
        const text = answerEl ? (answerEl.innerText || answerEl.textContent) : bubble.innerText;
        navigator.clipboard.writeText(text).then(() => {
            this.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
            setTimeout(() => { this.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`; }, 2000);
        });
    };

    bar.querySelector('.rag-followup-btn').onclick = function() {
        // 取该气泡的回答文字摘要（前100字）
        const answerEl = bubble.querySelector('.rag-answer-content');
        const answerExcerpt = (answerEl ? (answerEl.innerText || answerEl.textContent) : bubble.innerText)
            .replace(/\s+/g, ' ').trim().slice(0, 100);
        // 同时记录触发该回答的用户问题（前60字）
        const questionExcerpt = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const input = document.getElementById('rag-input');
        if (!input) return;

        // 注入追问前缀标记（包含 Q+A 对，让 server 端 LLM 理解完整上下文）
        window._ragFollowupContext = questionExcerpt
            ? `问：${questionExcerpt} → 答：${answerExcerpt}`
            : answerExcerpt;
        input.value = '';
        input.focus();

        // 在输入框上方显示追问标记（只显示问题部分，更简洁）
        const badgeLabel = questionExcerpt || answerExcerpt;
        let badge = document.getElementById('rag-followup-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'rag-followup-badge';
            badge.className = 'rag-followup-badge';
            input.parentNode.insertBefore(badge, input);
        }
        badge.innerHTML = `<span>追问：「${badgeLabel.slice(0, 40)}${badgeLabel.length > 40 ? '…' : ''}」</span>
            <button onclick="clearFollowupContext()" title="取消">×</button>`;

        // 气泡高亮
        document.querySelectorAll('.rag-message.followup-target').forEach(el => el.classList.remove('followup-target'));
        bubble.closest('.rag-message')?.classList.add('followup-target');
    };
    bar.querySelector('.rag-regen-btn').onclick = () => {
        // 删除当前AI气泡和对应的用户消息气泡
        const msgWrap = bubble.closest('.rag-message');
        const userWrap = msgWrap?.previousElementSibling;
        msgWrap?.remove();
        if (userWrap?.classList.contains('rag-message')) userWrap.remove();
        // 重新发送
        const input = document.getElementById('rag-input');
        if (input) { input.value = question; }
        sendRagMessage();
    };
    bubble.appendChild(bar);
}

// ===== Multi-session conversation management =====
let sessions = JSON.parse(localStorage.getItem('rag_sessions') || '[]');
let currentSessionId = null;
let ragAutoFreshSessionPending = true;

let _sessionsSanitized = false;
sessions.forEach(session => {
    (session.messages || []).forEach(message => {
        if (message.role === 'assistant' && message.html) {
            const cleaned = sanitizeRagSuggestionHtml(message.html);
            if (cleaned !== message.html) {
                message.html = cleaned;
                _sessionsSanitized = true;
            }
        }
    });
});
if (_sessionsSanitized) {
    try { localStorage.setItem('rag_sessions', JSON.stringify(sessions)); } catch(e) {}
}

function createSession(title) {
    const id = 'sess_' + Date.now();
    const session = { id, title: title || '新对话', messages: [], createdAt: Date.now() };
    sessions.unshift(session);
    if (sessions.length > 20) sessions = sessions.slice(0, 20); // max 20 sessions
    saveSessions();
    return session;
}

function saveSessions() {
    // 保存前清理多余的空对话（最多保留 1 个）
    const emptyOnes = sessions.filter(s => s.messages.length === 0);
    if (emptyOnes.length > 1) {
        const keepId = currentSessionId || emptyOnes[0].id;
        sessions = sessions.filter(s => s.messages.length > 0 || s.id === keepId);
    }
    try { localStorage.setItem('rag_sessions', JSON.stringify(sessions)); } catch(e) {
        console.warn('Session save failed (storage full?):', e);
        // 存储满时尝试只保留最近 5 条对话
        try {
            const trimmed = sessions.slice(-5);
            localStorage.setItem('rag_sessions', JSON.stringify(trimmed));
            sessions = trimmed;
        } catch(e2) { console.error('Session save failed even after trim:', e2); }
    }
}

function clearFollowupContext() {
    window._ragFollowupContext = null;
    const badge = document.getElementById('rag-followup-badge');
    if (badge) badge.remove();
    document.querySelectorAll('.rag-message.followup-target').forEach(el => el.classList.remove('followup-target'));
}

function getCurrentSession() {
    return sessions.find(s => s.id === currentSessionId);
}

function switchSession(id) {
    currentSessionId = id;
    const session = getCurrentSession();
    if (!session) return;
    const titleEl = document.getElementById('rag-session-title');
    if (titleEl) titleEl.textContent = session.title || 'AI 分析助手';
    
    // Render messages
    const container = document.getElementById('rag-messages');
    if (!container) return;
    container.innerHTML = '';
    
    const isThisSessionLoading = _loadingSessions.has(id);

    if (!session.messages.length && !isThisSessionLoading) {
        container.innerHTML = `<div class="rag-welcome">
            <div class="rag-welcome-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><use href="#ico-brain"/></svg></div>
            <h2>教育科技人才一体化平台智能助手</h2>
            <p>查询数据 · 分析趋势 · 了解人才体系 · 查阅报告内容</p>
        </div>`;
    } else {
        // 配对 user/assistant 消息，以便恢复时为 assistant 气泡挂上重新生成/追问按钮
        const msgs = session.messages;
        msgs.forEach((msg, idx) => {
            const div = document.createElement('div');
            div.className = 'rag-message ' + msg.role;
            const avatarHtml = msg.role === 'user'
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-user"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-brain"/></svg>';
            const messageHtml = msg.role === 'user'
                ? escapeHtml(msg.content)
                : sanitizeRagSuggestionHtml(msg.html || escapeHtml(msg.content));
            div.innerHTML = '<div class="rag-avatar">' + avatarHtml + '</div><div class="rag-bubble">' + messageHtml + '</div>';
            container.appendChild(div);
            // 恢复 assistant 气泡的重新生成/追问按钮
            if (msg.role === 'assistant') {
                const bubble = div.querySelector('.rag-bubble');
                // 找对应的 user 问题（前一条或更前面的 user 消息）
                const userMsg = msgs.slice(0, idx).reverse().find(m => m.role === 'user');
                if (bubble && userMsg) _appendRegenerateBtn(bubble, userMsg.content);
            }
        });
        container.scrollTop = container.scrollHeight;
    }

    // 若该会话正在加载回复，补显"正在回答"占位气泡
    if (isThisSessionLoading) {
        const ph = document.createElement('div');
        ph.className = 'rag-message assistant';
        ph.innerHTML = '<div class="rag-avatar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-brain"/></svg></div>'
            + '<div class="rag-bubble streaming-cursor"><div class="rag-live-process">'
            + '<div class="rag-live-title">正在思考与检索...</div>'
            + '<div class="rag-live-steps"><span class="active">识别问题</span><span>查找数据</span><span>调用工具</span><span>组织回复</span></div>'
            + '</div></div>';
        container.appendChild(ph);
        container.scrollTop = container.scrollHeight;
    }

    renderSessionList();
    updateDeleteBtn();
}

function syncSessionSelect() {
    const sel = document.getElementById('rag-session-select');
    if (!sel) return;
    sel.innerHTML = sessions.map(s => {
        const title = s.title || '新对话';
        return `<option value="${escapeHtml(s.id)}"${s.id === currentSessionId ? ' selected' : ''}>${escapeHtml(title)}</option>`;
    }).join('');
    sel.disabled = !sessions.length;
}

function renderSessionList() {
    const list = document.getElementById('rag-session-list');
    if (!list) return;
    syncSessionSelect();

    // 只展示有用户消息的会话
    const visible = sessions.filter(s => s.messages.some(m => m.role === 'user'));

    if (!visible.length) {
        list.innerHTML = '<div class="session-empty-tip">暂无对话</div>';
        updateDeleteBtn();
        return;
    }

    list.innerHTML = visible.map(s => {
        const isActive = s.id === currentSessionId;
        const isLoading = _loadingSessions.has(s.id);
        const shortTitle = s.title.length > 22 ? s.title.slice(0, 20) + '…' : s.title;
        return '<div class="session-item' + (isActive ? ' active' : '') + (isLoading ? ' loading' : '') + '" data-session-id="' + s.id + '" title="单击切换，双击重命名">'
            + '<div class="session-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-msg"/></svg></div>'
            + '<div class="session-title">' + escapeHtml(shortTitle) + '</div>'
            + '<button class="session-delete" data-delete-id="' + s.id + '" title="删除此对话">×</button>'
            + '</div>';
    }).join('');
    updateDeleteBtn();
}

function updateDeleteBtn() {
    const btn = document.getElementById('rag-delete-top');
    if (!btn) return;
    const sess = getCurrentSession();
    const hasMsg = sess && sess.messages.some(m => m.role === 'user');
    btn.disabled = !hasMsg;
    btn.classList.toggle('active-danger', !!hasMsg);
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
        // 小屏：选完对话关闭侧边栏
        const sidebar = document.getElementById('rag-sidebar');
        sidebar?.classList.remove('mobile-open');
        document.getElementById('rag-sidebar-mask')?.remove();
    }
});

document.addEventListener('dblclick', function(e) {
    const item = e.target.closest('.session-item[data-session-id]');
    if (!item || e.target.closest('.session-delete')) return;
    const session = sessions.find(s => s.id === item.dataset.sessionId);
    if (!session) return;
    const nextTitle = prompt('重命名对话', session.title || '新对话');
    if (!nextTitle) return;
    session.title = nextTitle.trim().slice(0, 40) || session.title;
    saveSessions();
    renderSessionList();
    syncSessionSelect();
    if (session.id === currentSessionId) {
        const titleEl = document.getElementById('rag-session-title');
        if (titleEl) titleEl.textContent = session.title;
    }
});

function startNewSession() {
    // 当前会话已是空对话，不重复创建
    const current = getCurrentSession();
    if (current && current.messages.length === 0) return;

    // 清理其他空对话（避免积累）
    sessions = sessions.filter(s => s.messages.length > 0 || s.id === currentSessionId);
    saveSessions();

    const session = createSession('新对话');
    switchSession(session.id);
}

function deleteCurrentSession() {
    if (!currentSessionId) return;
    sessions = sessions.filter(s => s.id !== currentSessionId);
    saveSessions();
    if (sessions.length) switchSession(sessions[0].id);
    else {
        currentSessionId = null;
        startNewSession();
    }
}

// Compat: legacy ragHistory alias
Object.defineProperty(window, 'ragHistory', {
    get() { const s = getCurrentSession(); return s ? s.messages : []; }
});

async function sendRagMessage() {
    const input = document.getElementById('rag-input');
    let question = input?.value.trim();
    if (!question) return;

    // 锁定本次请求的 sessionId，防止用户切换会话后消息存错地方
    const thisSessionId = currentSessionId;

    // 追问：把锚定的 Q+A 作为独立字段传给 server，不污染 question 文本
    const followupContext = window._ragFollowupContext || null;
    if (followupContext) clearFollowupContext();

    // 正在回答时：入队，立即显示用户消息气泡，清空输入框
    if (isRagStreaming) {
        ragQueue.push(question);
        input.value = '';
        input.style.height = 'auto';
        addRagMessage('user', question); // 先显示用户消息
        _updateQueueBadge();
        return;
    }

    // 添加用户消息
    addRagMessage('user', question);
    // 立即存入 session，切换会话后回来还能看到问题
    const _sess0 = sessions.find(s => s.id === thisSessionId);
    if (_sess0) {
        if (_sess0.messages.length === 0) {
            _sess0.title = question.slice(0, 30);
            const titleEl = document.getElementById('rag-session-title');
            if (titleEl && thisSessionId === currentSessionId) titleEl.textContent = _sess0.title;
        }
        _sess0.messages.push({ role: 'user', content: question });
        saveSessions();
        renderSessionList();
        syncSessionSelect();
        updateDeleteBtn();
    }
    input.value = '';
    input.style.height = 'auto';
    
    // 添加助手占位
    const assistantBubble = addRagMessage('assistant', '', true);
        assistantBubble.innerHTML = `
        <div class="rag-live-process">
            <div class="rag-live-title">正在思考与检索...</div>
            <div class="rag-live-steps">
                <span class="active">识别问题</span>
                <span>查找数据</span>
                <span>调用工具</span>
                <span>组织回复</span>
            </div>
        </div>`;
    isRagStreaming = true;
    _setSessionLoading(thisSessionId, true);
    const liveSteps = [...assistantBubble.querySelectorAll('.rag-live-steps span')];
    let liveStepIndex = 0;
    const liveProgressTimer = setInterval(() => {
        if (!liveSteps.length) return;
        liveStepIndex = Math.min(liveStepIndex + 1, liveSteps.length - 1);
        liveSteps.forEach((step, index) => step.classList.toggle('active', index <= liveStepIndex));
    }, 850);
    
    const sendBtn = document.getElementById('rag-send');
    const stopBtn = document.getElementById('rag-stop');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.display = 'none'; }
    if (stopBtn) stopBtn.style.display = 'flex';

    ragController = new AbortController();

    // 更新上下文提示
    const hint = document.getElementById('rag-context-hint');
    showRagStatusHint('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-search"/></svg><span>正在检索数据...</span>');

    try {
        const response = await fetch(API_BASE + '/api/agent/stream', {
            signal: ragController.signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                sessionId: thisSessionId || 'default',
                ...(followupContext ? { followupContext } : {})
            })
        });
        if (!response.ok) throw new Error(`服务器错误 ${response.status}`);

        // ── SSE 流式读取 ──────────────────────────────────────────
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let streamText = '';       // 累积的原始文字（用于最终格式化）
        let textEl = null;         // 流式文字容器
        let data = null;           // done 事件的元数据

        const liveStepEls = [...assistantBubble.querySelectorAll('.rag-live-steps span')];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop(); // 保留不完整行

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt;
                try { evt = JSON.parse(line.slice(6)); } catch { continue; }

                if (evt.type === 'status') {
                    // 同步到进度步骤
                    liveStepEls.forEach((s, i) => s.classList.toggle('active', i <= evt.step));
                    const titleEl = assistantBubble.querySelector('.rag-live-title');
                    if (titleEl) titleEl.textContent = evt.text;

                } else if (evt.type === 'token') {
                    if (!textEl) {
                        // 第一个 token：替换 loading 动画为流式文字区
                        assistantBubble.innerHTML = '<div class="rag-stream-text"></div>';
                        textEl = assistantBubble.querySelector('.rag-stream-text');
                    }
                    streamText += evt.text;
                    textEl.textContent = streamText; // 纯文本快速渲染
                    // 滚动到底
                    const msgBox = document.getElementById('rag-messages');
                    if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;

                } else if (evt.type === 'done') {
                    data = evt;

                } else if (evt.type === 'error') {
                    throw new Error(evt.text);
                }
            }
        }

        if (!data) data = {}; // 防止 done 事件丢失
        
        if (hint) {
            const citationCount = data.citations?.length || 0;
            hint.textContent = citationCount > 0
                ? `基于 ${citationCount} 个数据源生成回答`
                : '回答生成完成';
        }

        let html = '';
        let processHtml = '';
        
        // 思维链
        if (data.reasoning && data.reasoning.length > 0) {
            processHtml += `<div class="rag-reasoning">
                <div class="rag-reasoning-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><use href="#ico-brain"/></svg> 思考摘要</div>
                ${data.reasoning.slice(0, 4).map(r => `<div style="margin-bottom:4px;">· ${escapeHtml(String(r))}</div>`).join('')}
            </div>`;
        }

        if (Array.isArray(data.toolTrace) && data.toolTrace.length > 0) {
            const toolLabels = {
                trend: '趋势分析',
                compare: '地区对比',
                rank: '排名计算',
                point: '定点查询',
                query_trend: '趋势分析',
                compare_regions: '地区对比',
                rank_provinces: '排名计算',
                query_point: '定点查询'
            };
            processHtml += `<div class="rag-method-card">
                <div class="rag-method-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><use href="#ico-db"/></svg>
                    工具轨迹
                </div>
                ${data.toolTrace.slice(0, 3).map(trace => {
                    const toolName = trace.normalizedTool || trace.tool || trace.type || 'analysis';
                    const label = toolLabels[toolName] || toolName;
                    const params = trace.params || {};
                    const paramText = Object.entries(params)
                        .filter(([, value]) => value !== undefined && value !== null && value !== '')
                        .slice(0, 5)
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('、') : value}`)
                        .join(' · ');
                    return `<div class="rag-method-item">
                        <span>${escapeHtml(label)}</span>
                        <small>${escapeHtml(paramText || '基于当前问题自动选择')}</small>
                    </div>`;
                }).join('')}
            </div>`;
        }
        
        if (processHtml) {
            html += `<details class="rag-process-details">
                <summary>分析过程</summary>
                ${processHtml}
            </details>`;
        }
        
        // 主回答（用流式累积的文字做最终格式化）
        const finalAnswer = streamText || data.answer || '无回答';
        data.answer = finalAnswer; // 供报告导出使用
        html += `<div class="rag-answer-content">${formatAnswer(finalAnswer)}</div>`;
        
        // 引用
        if (data.citations && data.citations.length > 0) {
            const visibleCitations = data.citations.slice(0, 3);
            const hiddenCitations = data.citations.slice(3);
            html += `<div class="rag-citations">
                <div class="rag-citation-head">数据来源</div>
                <div class="rag-citation-list">
                    ${visibleCitations.map(c => `<span class="rag-citation">${escapeHtml(c)}</span>`).join('')}
                </div>
                ${hiddenCitations.length ? `<details class="rag-more-citations"><summary>查看其余 ${hiddenCitations.length} 条来源</summary><div class="rag-citation-list">${hiddenCitations.map(c => `<span class="rag-citation">${escapeHtml(c)}</span>`).join('')}</div></details>` : ''}
            </div>`;
        }
        const safeSuggestions = filterRagSuggestions(data.suggestions || []);
        data.suggestions = safeSuggestions;
        if (safeSuggestions.length) {
            html += `<div class="rag-suggestions">${safeSuggestions.map(s => `<button class="rag-suggestion" type="button" data-question="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`;
        }
        
        assistantBubble.innerHTML = html;
        assistantBubble.classList.remove('streaming-cursor');

        // 重新生成按钮
        _appendRegenerateBtn(assistantBubble, question);

        // 图表：直接渲染在当前气泡内（内联显示，html设置后再渲染）
        // Chart actions are now shown as chat-bubble buttons; no auto modal trigger.

        // 保存到本次请求的 session（用 thisSessionId，防止用户切换后存错）
        setTimeout(() => executeAgentUiActions(data, question, assistantBubble), 180);
        const session = sessions.find(s => s.id === thisSessionId);
        if (session) {
            // 用户问题已在发送时存入，只追加 assistant 回复
            // （若因异常未存入则补存，保证配对完整）
            const lastMsg = session.messages[session.messages.length - 1];
            if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== question) {
                session.messages.push({ role: 'user', content: question });
            }
            session.messages.push({ role: 'assistant', content: finalAnswer, html: sanitizeRagSuggestionHtml(html) });
            saveSessions();
            // 只有当前显示的就是本次会话时才更新标题和列表；否则只存数据
            if (thisSessionId === currentSessionId) {
                renderSessionList();
                syncSessionSelect();
            } else {
                renderSessionList(); // 侧边栏条目更新（消息数变化）
            }
        }
        
    } catch (err) {
        if (err.name === 'AbortError') {
            if (hint) hint.textContent = '已停止';
            if (assistantBubble.textContent.trim() === '') {
                assistantBubble.innerHTML = `<span style="color:var(--c-muted);font-size:.85rem;">已停止回答</span>`;
            } else {
                assistantBubble.innerHTML += `<div style="margin-top:8px;color:var(--c-muted);font-size:.8rem;border-top:1px solid var(--c-border);padding-top:6px;">— 已停止</div>`;
            }
            _appendRegenerateBtn(assistantBubble, question);
            return;
        }
        console.error('RAG错误:', err);
        if (hint) hint.textContent = '连接失败';
        assistantBubble.innerHTML = `<div style="color: var(--danger);">
            <div style="font-weight:600;margin-bottom:8px;color:var(--c-danger)">连接失败</div>
            <div>请确保后端服务已启动（node server.js）</div>
            <div style="font-size:0.8rem;margin-top:8px;color:var(--text-muted);">错误: ${escapeHtml(err.message)}</div>
        </div>`;
        assistantBubble.classList.remove('streaming-cursor');
    } finally {
        clearInterval(liveProgressTimer);
        isRagStreaming = false;
        _setSessionLoading(thisSessionId, false);
        ragController = null;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.style.display = 'flex'; }
        if (stopBtn) stopBtn.style.display = 'none';
        hideRagStatusHint();
        _updateSendBtnMode(document.getElementById('rag-input')?.value.trim() || '');

        // 处理追问队列：取出下一条消息继续发送
        if (ragQueue.length > 0) {
            const next = ragQueue.shift();
            _updateQueueBadge();
            // 队列消息的用户气泡已经显示过了，直接用内部方式发送（跳过重复显示）
            setTimeout(() => _sendRagQueued(next), 120);
        }
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

function normalizeAgentText(value) {
    return String(value || '').replace(/[（(].*?[）)]/g, '').replace(/\s+/g, '').toLowerCase();
}

function agentFindWorkbookSheet(name) {
    const keys = Object.keys(window.workbook || {});
    if (!keys.length) return name;
    if (keys.includes(name)) return name;
    const compact = normalizeAgentText(name);
    return keys.find(k => normalizeAgentText(k) === compact || normalizeAgentText(k).includes(compact) || compact.includes(normalizeAgentText(k))) || name;
}

function agentInferSheet(data, question) {
    const q = String(question || '');
    const chart = data?.chart || {};
    const trace = Array.isArray(data?.toolTrace) ? data.toolTrace.find(t => t?.params) : null;
    const table = chart.table || trace?.params?.table || data?.methodSummary?.table || '';
    const region = chart.regions?.[0] || trace?.params?.region || data?.methodSummary?.region || '';
    if (/地级市|城市|市级/.test(q) || /地级市|城市/.test(table)) return agentFindWorkbookSheet('地级市');
    if (/全国表/.test(table) || region === '全国' || /全国/.test(q)) return agentFindWorkbookSheet('全国');
    if (/省份表|省份|省域|各省/.test(table + q) || /省|自治区|直辖市|广东|山东|江苏|浙江|山西/.test(region + q)) return agentFindWorkbookSheet('省份');
    return agentFindWorkbookSheet(currentSheet || '全国');
}

function agentFindMetricIndex(metric, list) {
    const wanted = normalizeAgentText(metric);
    if (!wanted || !Array.isArray(list)) return -1;
    let idx = list.findIndex(m => normalizeAgentText(m) === wanted);
    if (idx >= 0) return idx;
    idx = list.findIndex(m => normalizeAgentText(m).includes(wanted) || wanted.includes(normalizeAgentText(m)));
    if (idx >= 0) return idx;
    return list.findIndex(m => normalizeAgentText(cleanMetricName(m)).includes(wanted) || wanted.includes(normalizeAgentText(cleanMetricName(m))));
}

function agentSelectMainMetric(metric) {
    const idx = agentFindMetricIndex(metric, valueFields);
    if (idx < 0) return false;
    currentMetricIndex = idx;
    const metricSel = document.getElementById('main-metric-select');
    if (metricSel) metricSel.value = String(idx);
    try { updateNationHighlight?.(); } catch(e) {}
    try { renderIndicatorList?.(); } catch(e) {}
    try { renderMainChart?.(); } catch(e) {}
    return true;
}

function agentSelectAdvancedMetric(metric, year) {
    const idx = agentFindMetricIndex(metric, advMetrics);
    if (idx >= 0) {
        advCurrentMetricIndex = idx;
        const metricSel = document.getElementById('adv-metric-select');
        if (metricSel) metricSel.value = String(idx);
    }
    if (year && advYears?.includes?.(Number(year))) {
        advCurrentYear = Number(year);
        const yearSel = document.getElementById('adv-year-select');
        if (yearSel) yearSel.value = String(year);
    }
    try { renderAdvancedChart?.(); } catch(e) {}
}

function extractQuestionSubject(question) {
    if (!question) return '';
    return String(question).trim()
        .replace(/^(请问|请|帮我|给我|查询|查看|展示|显示|告诉我|分析一下|对比)/u, '')
        .replace(/[？?！!。，,、：:；;"'"'「」『』（）()【】\[\]]/g, '')
        .trim()
        .slice(0, 20)
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim() || 'report';
}

function agentDownload(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function agentFocusDashboard(tab) {
    const rag = document.getElementById('rag-fullscreen');
    const dp = document.getElementById('dashboard-page');
    const dashboardVisible = dp && getComputedStyle(dp).display !== 'none';
    if (rag && getComputedStyle(rag).display !== 'none') {
        closeRagFullscreen();
    } else if (!dashboardVisible) {
        enterDashboard(tab);
    }
}

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

// ======================= Agent 内联图表渲染（在对话气泡中直接显示）=======================

// Chart instance registry: chartId → echarts instance
const _inlineChartInstances = {};

function disposeChartInstance(chart) {
    if (!chart) return null;
    try {
        if (chart._ro) chart._ro.disconnect();
        if (chart._resizeFn) window.removeEventListener('resize', chart._resizeFn);
        if (!chart.isDisposed?.()) chart.dispose();
    } catch(e) {}
    return null;
}

function initEChartSafe(dom, opts = {}) {
    if (!dom || !window.echarts) return null;
    const old = echarts.getInstanceByDom(dom);
    if (old) disposeChartInstance(old);
    return echarts.init(dom, null, opts);
}

function showChartUnavailable(dom, title = '图表库未加载') {
    if (!dom) return;
    dom.innerHTML = `
        <div class="chart-fallback">
            <div class="chart-fallback-title">${escapeHtml(title)}</div>
            <div class="chart-fallback-text">当前浏览器未能加载 ECharts。数据表和智能助手仍可使用；恢复网络或改用本地静态库后图表会自动恢复。</div>
        </div>
    `;
}

function resizeVisibleChart(chart, opts) {
    try {
        if (!chart || chart.isDisposed?.()) return;
        const dom = chart.getDom?.();
        if (dom && dom.offsetParent === null) return;
        chart.resize(opts);
    } catch(e) {}
}

function disposeAllCharts() {
    mainChart = disposeChartInstance(mainChart);
    pieChart = disposeChartInstance(pieChart);
    advancedChart = disposeChartInstance(advancedChart);
    rankChart = disposeChartInstance(rankChart);
    currentChartInstance = disposeChartInstance(currentChartInstance);
    _chartModalInstance = disposeChartInstance(_chartModalInstance);
    Object.keys(_inlineChartInstances).forEach(id => {
        _inlineChartInstances[id] = disposeChartInstance(_inlineChartInstances[id]);
        delete _inlineChartInstances[id];
    });
}

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
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Close handlers
    overlay.addEventListener('click', e => { if (e.target === overlay) closeChartModal(); });
    document.getElementById('chart-modal-close').addEventListener('click', closeChartModal);
    if (!document._chartModalEscBound) {
        document._chartModalEscBound = true;
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartModal(); });
    }

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

    _chartModalInstance = disposeChartInstance(_chartModalInstance);

    // Chart div reset
    chartEl.id = 'chart-modal-chart';
    chartEl.innerHTML = '';
    chartEl.style.height = '500px';
    chartEl.style.width = '100%';

    // Render after layout
    requestAnimationFrame(() => requestAnimationFrame(() => {
        setTimeout(() => {
            _doRenderInlineChart('chart-modal-chart', config, true);
            _chartModalInstance = window.echarts ? echarts.getInstanceByDom(chartEl) : null;
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
        _chartModalInstance = disposeChartInstance(_chartModalInstance);
    }, 200);
}

/* ─── renderAgentChart — now creates a trigger button ─── */

function renderAgentChart(config, targetBubble) {
    if (!config || !config.metric) { console.warn('图表配置无效', config); return; }
    if (!window.workbook || !window.workbook['省份']) { console.warn('数据未加载'); return; }

    const doInsert = (bubble) => {
        // Remove any previous trigger row in this bubble
        const old = bubble.querySelector('.rag-chart-trigger-row');
        if (old) old.remove();

        const regionStr = (config.regions||[]).length ? config.regions.join('、') : '全国';

        const row = document.createElement('div');
        row.className = 'rag-chart-trigger-row';

        const chartBtn = document.createElement('button');
        chartBtn.className = 'rag-chart-trigger';
        chartBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-chart-bar"/></svg>
          <span class="ctr-label">${config.title || config.metric + ' 图表'}</span>
          <span class="ctr-hint">点击查看 · ${regionStr}</span>`;
        chartBtn.addEventListener('click', () => openChartModal(config));

        const tableBtn = document.createElement('button');
        tableBtn.className = 'rag-table-trigger';
        tableBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg> 数据明细`;
        tableBtn.addEventListener('click', () => toggleInlineDataTable(bubble, config));

        row.appendChild(chartBtn);
        row.appendChild(tableBtn);
        bubble.appendChild(row);

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
    if (!window.echarts) {
        showChartUnavailable(chartDom, '聊天图表暂不可用');
        return;
    }
    // In modal: bigger chart, richer grid padding
    if (isModal) {
        const fitHeight = fitAnalysisPanelToViewport();
        chartDom.style.height = fitHeight + 'px';
    }
    // Dispose previous if any
    if (_inlineChartInstances[chartId]) {
        _inlineChartInstances[chartId] = disposeChartInstance(_inlineChartInstances[chartId]);
        delete _inlineChartInstances[chartId];
    }
    
    // CRITICAL: never set inline width - that causes bubble to stretch to full page width.
    // CSS width:100% on .agent-inline-chart handles width correctly.
    // Modal height is set explicitly; inline height is controlled by CSS !important (340px).
    if (isModal) chartDom.style.height = '500px';

    // Read the actual rendered width from the chart element itself (content area, excludes wrap padding)
    const wrapEl = isModal ? chartDom.parentElement : chartDom.closest('.agent-inline-chart-wrap');
    const measuredW = chartDom.clientWidth > 20 ? chartDom.clientWidth : (wrapEl ? wrapEl.clientWidth : 480);
    // For inline charts, read the CSS-applied height rather than hardcoding 280
    const measuredH = isModal ? 500 : (chartDom.offsetHeight || 340);
    
    // Init echarts - pass explicit height, let width be measured
    const chart = initEChartSafe(chartDom, { 
        width: measuredW > 20 ? measuredW : 480, 
        height: measuredH,
        renderer: 'canvas' 
    });
    if (!chart) {
        showChartUnavailable(chartDom, '聊天图表暂不可用');
        return;
    }
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

    if (config.type === 'correlation' && Array.isArray(config.trendSeries) && Array.isArray(config.scatterData)) {
        const textColor = '#17233d';
        const mutedColor = '#52637c';
        const gridColor = '#e1e8f2';
        const titleColor = '#10213f';
        const colors = ['#2563eb', '#f97316'];
        const years = config.years || [];
        const names = (config.trendSeries || []).map(s => s.name);
        chartDom.style.height = isModal ? '560px' : '380px';
        chart.resize({ width: measuredW > 20 ? measuredW : 480, height: isModal ? 560 : 380 });
        chart.setOption({
            backgroundColor: 'transparent',
            color: colors,
            title: {
                text: config.title || '双指标相关性分析',
                subtext: config.correlation != null ? `Pearson r = ${config.correlation}` : '',
                left: 'center',
                top: 4,
                textStyle: { color: titleColor, fontSize: isModal ? 16 : 13, fontWeight: 900 },
                subtextStyle: { color: mutedColor, fontWeight: 700 }
            },
            tooltip: {
                trigger: 'axis',
                confine: true,
                backgroundColor: 'rgba(255,255,255,.98)',
                borderColor: '#c9d8ee',
                textStyle: { color: textColor, fontSize: 12 }
            },
            legend: {
                data: names,
                top: isModal ? 48 : 42,
                textStyle: { color: textColor, fontWeight: 700 }
            },
            grid: [
                { left: 58, right: 58, top: isModal ? 82 : 72, height: isModal ? 210 : 135, containLabel: true },
                { left: 58, right: 58, bottom: 42, height: isModal ? 185 : 120, containLabel: true }
            ],
            xAxis: [
                {
                    type: 'category',
                    gridIndex: 0,
                    data: years,
                    axisLabel: { color: textColor, fontWeight: 700 },
                    axisLine: { lineStyle: { color: gridColor } },
                    splitLine: { show: false }
                },
                {
                    type: 'value',
                    gridIndex: 1,
                    name: names[0] || 'X',
                    nameTextStyle: { color: textColor, fontWeight: 800 },
                    axisLabel: { color: textColor, fontWeight: 700 },
                    axisLine: { lineStyle: { color: gridColor } },
                    splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
                }
            ],
            yAxis: [
                {
                    type: 'value',
                    gridIndex: 0,
                    name: names[0] || '',
                    nameTextStyle: { color: colors[0], fontWeight: 800 },
                    axisLabel: { color: textColor, fontWeight: 700 },
                    splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
                },
                {
                    type: 'value',
                    gridIndex: 0,
                    name: names[1] || '',
                    nameTextStyle: { color: colors[1], fontWeight: 800 },
                    axisLabel: { color: textColor, fontWeight: 700 },
                    splitLine: { show: false }
                },
                {
                    type: 'value',
                    gridIndex: 1,
                    name: names[1] || 'Y',
                    nameTextStyle: { color: textColor, fontWeight: 800 },
                    axisLabel: { color: textColor, fontWeight: 700 },
                    splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
                }
            ],
            series: [
                {
                    name: names[0],
                    type: 'line',
                    xAxisIndex: 0,
                    yAxisIndex: 0,
                    data: config.trendSeries[0]?.data || [],
                    smooth: true,
                    symbolSize: 6,
                    lineStyle: { width: 2.5 },
                    areaStyle: { opacity: 0.1 }
                },
                {
                    name: names[1],
                    type: 'line',
                    xAxisIndex: 0,
                    yAxisIndex: 1,
                    data: config.trendSeries[1]?.data || [],
                    smooth: true,
                    symbolSize: 6,
                    lineStyle: { width: 2.5 },
                    areaStyle: { opacity: 0.08 }
                },
                {
                    name: '年度散点',
                    type: 'scatter',
                    xAxisIndex: 1,
                    yAxisIndex: 2,
                    data: config.scatterData,
                    symbolSize: isModal ? 11 : 8,
                    tooltip: {
                        trigger: 'item',
                        formatter: p => {
                            const d = p.data || [];
                            return `<strong>${d[2]}年</strong><br>${names[0]}：${d[0]}<br>${names[1]}：${d[1]}`;
                        }
                    },
                    label: {
                        show: isModal,
                        formatter: p => p.data?.[2] || '',
                        position: 'top',
                        color: textColor,
                        fontWeight: 800,
                        textBorderColor: 'rgba(255,255,255,.95)',
                        textBorderWidth: 2
                    },
                    itemStyle: { color: '#7c3aed', shadowBlur: 8, shadowColor: 'rgba(124,58,237,.28)' }
                }
            ]
        });
        const resizeFn = () => chart.resize();
        window.addEventListener('resize', resizeFn);
        chart._resizeFn = resizeFn;
        return;
    }
    
    const metric = config.metric;
    const chartType = config.type || 'line';
    let years = config.years || [];
    const regions = config.regions || [];

    const provinceRows = window.workbook['省份'] || [];
    const cityRows     = window.workbook['地级市'] || [];
    const nationalRows = window.workbook['全国'] || [];

    // Determine data source: national / city / province
    const NATIONAL_NAMES = ['全国', '全国平均', '全国总计', '全国合计'];
    const useNational = (!regions.length || regions.every(r => NATIONAL_NAMES.includes(r)))
                        && nationalRows.length > 0;
    const firstRegion = regions.find(r => !NATIONAL_NAMES.includes(r));
    const useCity = !useNational && !!firstRegion
                    && cityRows.some(r => r['地区'] === firstRegion)
                    && !provinceRows.some(r => r['地区'] === firstRegion);

    // Fuzzy field matching against the right sheet
    const baseSheet = useNational ? nationalRows : (useCity ? cityRows : provinceRows);
    const sampleRow = baseSheet[0] || {};
    const cleanTarget = metric.replace(/[（(].*?[）)]/g, '').trim();
    const realMetric = Object.keys(sampleRow).find(k => {
        const cleanK = k.replace(/[（(].*?[）)]/g, '').trim();
        return k === metric || cleanK === cleanTarget || k.includes(cleanTarget) || cleanTarget.includes(cleanK);
    }) || metric;

    let filteredRows = useCity ? cityRows : provinceRows;

    if (!years.length) {
        const baseRows = useNational ? nationalRows : (regions.length ? filteredRows.filter(r => regions.includes(r['地区'])) : filteredRows);
        years = [...new Set(baseRows.map(r => r['年份']))].sort();
        if (years.length > 20) years = years.slice(-20); // cap at 20 years for very long ranges
    }
    
    const series = [];

    if (useNational) {
        // National trend
        const natMetric = Object.keys(nationalRows[0] || {}).find(k => {
            const cleanK = k.replace(/[（(].*?[）)]/g, '').trim();
            return k === metric || cleanK === cleanTarget || k.includes(cleanTarget) || cleanTarget.includes(cleanK);
        }) || metric;
        const data = years.map(y => {
            const row = nationalRows.find(r => r['年份'] === y);
            return row ? (row[natMetric] ?? null) : null;
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
                return row ? (row[realMetric] ?? null) : null;
            });
            if (data.some(v => v !== null)) {
                series.push({ name: region, type: chartType, data, smooth: true, color: COLORS[idx % COLORS.length], areaStyle: chartType === 'line' ? { opacity: 0.1 } : undefined });
            }
        });
    }
    
    const textColor = '#263b59';
    const gridColor = '#e8edf5';
    const titleColor = '#1a202c';

    if (chartType === 'bar' && regions.length > 3 && years.length === 1 && !useNational) {
        const year = years[0];
        const barRows = regions.map(region => {
            const row = provinceRows.find(r => r['地区'] === region && r['年份'] === year);
            return { region, value: row ? (row[realMetric] ?? null) : null };
        }).filter(item => typeof item.value === 'number');

        chart.setOption({
            backgroundColor: 'transparent',
            title: { text: config.title || `${year}年 ${metric} 排名`, left: 'center', top: 8, textStyle: { color: titleColor, fontSize: 14, fontWeight: 800 } },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: 'rgba(255,255,255,.98)',
                borderColor: '#93c5fd',
                textStyle: { color: '#1a202c', fontSize: 12 },
                extraCssText: 'box-shadow:0 8px 24px rgba(37,99,235,.16);border-radius:10px;'
            },
            grid: { left: 58, right: 26, top: 58, bottom: 72, containLabel: true },
            dataZoom: [{ type: 'inside', start: 0, end: Math.min(100, Math.max(35, 10 / Math.max(1, barRows.length) * 100)) }],
            xAxis: {
                type: 'category',
                data: barRows.map(item => item.region),
                axisLine: { lineStyle: { color: gridColor } },
                axisLabel: { color: textColor, fontSize: 10, interval: 0, rotate: 35 },
                splitLine: { show: false }
            },
            yAxis: {
                type: 'value',
                axisLine: { show: false },
                axisLabel: { color: textColor, fontSize: 11 },
                splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
            },
            series: [{
                name: cleanMetricName(realMetric),
                type: 'bar',
                data: barRows.map(item => item.value),
                barMaxWidth: 18,
                itemStyle: { color: '#2563eb', borderRadius: [5, 5, 0, 0] }
            }]
        });

        const resizeFn = () => chart.resize();
        window.addEventListener('resize', resizeFn);
        chart._resizeFn = resizeFn;
        return;
    }
    
    chart.setOption({
        backgroundColor: 'transparent',
        title: { text: config.title || `${metric}`, left: 'center', top: 6, textStyle: { color: titleColor, fontSize: 13, fontWeight: 700 } },
        tooltip: {
            trigger: 'axis', backgroundColor: 'rgba(255,255,255,.97)',
            borderColor: '#667eea', textStyle: { color: '#1a202c', fontSize: 12 },
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


// Auto-generate chart - now renders inline
function autoGenerateChart(question, targetBubble) {
    let metric = metricNameList[0] || '科学支出水平';
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

function formatAnswer(text) {
    if (!text) return '';
    let t = escapeHtml(text);

    // 1. 去除 think 标签
    t = t.replace(/&lt;think&gt;[\s\S]*?&lt;\/think&gt;/gi, '');

    // 2. Markdown 表格 → HTML table（表格内容安全转义）
    t = t.replace(/((?:\|[^\n]+\|\s*\n?)+)/g, (block) => {
        const lines = block.trim().split('\n').filter(l => l.trim());
        if (lines.length < 2) return block;
        const nonSep = lines.filter(l => !/^\s*\|[\s\-:|]+\|\s*$/.test(l));
        if (!nonSep.length) return block;
        let html = '<table class="rag-table">';
        nonSep.forEach((line, i) => {
            const parts = line.split('|').slice(1, -1).map(c => c.trim());
            if (!parts.length) return;
            const tag = i === 0 ? 'th' : 'td';
            html += '<tr>' + parts.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
        });
        return html + '</table>';
    });

    // 3. 标题 ### ## # → <h3> <h2> <h1>
    t = t.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
    t = t.replace(/^## (.+)$/gm,  '<h2 class="md-h2">$1</h2>');
    t = t.replace(/^# (.+)$/gm,   '<h1 class="md-h1">$1</h1>');

    // 4. 加粗 **text** → <strong>（API 有时返回 HTML 有时返回 markdown，两种都处理）
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 5. 分隔线 --- → <hr>
    t = t.replace(/^\s*[-]{3,}\s*$/gm, '<hr class="md-hr">');

    // 6. 无序列表（支持 - 和 * 开头）
    t = t.replace(/((?:^[\*\-•] .+\n?)+)/gm, (block) => {
        const items = block.trim().split('\n')
            .map(l => l.replace(/^[\*\-•] /, '').trim())
            .filter(Boolean)
            .map(l => `<li>${l}</li>`)
            .join('');
        return `<ul class="md-ul">${items}</ul>`;
    });

    // 7. 有序列表
    t = t.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
        const items = block.trim().split('\n')
            .map(l => l.replace(/^\d+\. /, '').trim())
            .filter(Boolean)
            .map(l => `<li>${l}</li>`)
            .join('');
        return `<ol class="md-ol">${items}</ol>`;
    });

    // 8. 引用块
    t = t.replace(/^> (.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

    // 9. 特殊标记
    t = t.replace(/【思考】/g, '<div class="thinking-title">🤔 思考过程</div>');
    t = t.replace(/【回答】/g, '<div class="answer-title">📢 最终回答</div>');

    // 10. 换行处理（跳过块级 HTML 标签前后）
    t = t.replace(/\n(?!<)/g, '<br>');
    t = t.replace(/<br>(<\/?(?:table|tr|th|td|ul|ol|li|h[1-6]|hr|blockquote))/g, '$1');
    t = t.replace(/(<\/(?:table|ul|ol|h[1-6]|blockquote)>)<br>/g, '$1');

    return t;
}

// ======================= 数据加载 =======================

async function loadAllData() {
    try {
        const response = await fetch(API_BASE + '/api/data');
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
                        if (val === null || val === undefined) {
                            row[key] = null;          // 保留缺失值语义，不填 0
                        } else if (typeof val === "string") {
                            let num = parseFloat(val);
                            row[key] = isNaN(num) ? null : num;   // 无法解析的字符串也为 null
                        } else if (typeof val !== "number") {
                            row[key] = null;
                        }
                        // typeof val === "number" 时保持原值（含真实的 0）
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
        // 用实际最新年份初始化快捷提问按钮
        try { initQuickButtons(data); } catch(e) {}
        return window.workbook;
    } catch (error) {
        console.error('加载 data.json 失败', error);
        showToast('数据文件加载失败，请确保后端服务已启动（node server.js）', 'error');
        throw error;
    }
}

// ======================= KPI 卡更新 =======================

window.updateKPI = function(data) {
    const national  = data['全国']  || [];
    const province  = data['省份']  || [];
    const city      = data['地级市'] || [];

    // 总记录数
    const recEl = document.getElementById('kpi-records');
    if (recEl) recEl.textContent = '100,000+';

    // 年份长度
    const yearEl = document.getElementById('kpi-years');
    if (yearEl) yearEl.textContent = '20年以上';

    // 核心指标数
    const metEl = document.getElementById('kpi-metrics');
    if (metEl) metEl.textContent = '100+';

    // 覆盖省份/城市数
    const provinces = new Set(province.map(r => r['地区']).filter(Boolean));
    const cities    = new Set(city.map(r => r['地区']).filter(Boolean));
    const regEl = document.getElementById('kpi-regions');
    if (regEl) regEl.textContent = (provinces.size + cities.size) + '+';
};

// ======================= 快捷提问动态初始化 =======================

function initQuickButtons(data) {
    const province = data['省份'] || data['province'] || [];
    const years = [...new Set(province.map(r => r['年份']).filter(Boolean))].sort((a, b) => b - a);
    const ly = years[0] || new Date().getFullYear() - 1; // latestYear
    // 侧边栏快捷提问：4个不同维度（趋势/排名/报告/城市）
    const sq = {
        'sq-trend':    { q: `近10年工业机器人密度趋势`,           label: '机器人密度近10年趋势' },
        'sq-edu-rank': { q: `${ly}年各省普通高校数量排名`,          label: `${ly}年高校数量排名` },
        'sq-report':   { q: `根据全球智数化人才指数报告，中国的智数化人才排名情况`, label: '报告：中国人才排名' },
        'sq-city':     { q: `济南市近5年科学支出水平趋势`,          label: '济南市科学支出趋势' }
    };
    for (const [id, cfg] of Object.entries(sq)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.textContent = cfg.label;
        btn.onclick = () => sendRagQuick(cfg.q);
    }

    // 欢迎区 hint：4个入门级问题，维度差异化
    const hints = {
        'hint-ranking':  { q: `${ly}年各省杰青数量前10排名`,        label: `${ly}年各省杰青排名` },
        'hint-trend':    { q: `近5年全国长江学者数量趋势`,            label: '近5年长江学者趋势' },
        'hint-knowledge': { q: `杰青和优青有什么区别？`,               label: '杰青与优青的区别' },
        'hint-compare':  { q: `四大青年人才包括哪些称号？`,            label: '四大青人才称号' }
    };
    for (const [id, cfg] of Object.entries(hints)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.textContent = cfg.label;
        btn.onclick = () => sendRagQuick(cfg.q);
    }
}

// ======================= 全局变量 =======================

const CAROUSEL_INTERVAL = 5000;
const INACTIVITY_DELAY = 3000;
let mainChart, pieChart, advancedChart;
let currentSheet = "全国";
let originalRows = [], headers = [];
let tableSheet = "全国";
let advSheet = "省份";
let advRows = [];
let analysisSheet = "省份";
let tableRows = [], tableHeaders = [];
let dimType = "nation";
let valueFields = [];
let currentMetricIndex = 0;
let carouselTimer = null;
let isCarouselPaused = false;
let mainCarouselManualPaused = false; // 用户点按钮手动暂停，hover 不覆盖
let isMouseOverMainChart = false;     // 鼠标是否悬浮在主图表卡片上
let isMouseOverAnalysis = false;      // 鼠标是否悬浮在分析卡片上
let inactivityTimer = null;
let groupField = "地区";
let selectedGroups = [];
let sortKey = "", sortType = "asc";
let custom = { title: "auto", xName: "auto", yName: "auto", yMax: "auto" };
const COLORS = [
    '#2563a8', '#e05c2b', '#2a9a58', '#c0392b', '#8e44ad',
    '#d4a017', '#1a8f8f', '#e91e8c', '#1976d2', '#43a047',
    '#ff6f00', '#5c6bc0', '#00838f', '#7cb342', '#6d4c41',
    '#f06292', '#0288d1', '#e53935', '#00897b', '#7b1fa2',
    '#fb8c00', '#0097a7', '#c62828', '#00acc1', '#827717',
    '#ad1457', '#039be5', '#2e7d32', '#6a1b9a', '#4e342e',
    '#558b2f'
];
const SCATTER_COLORS = [
    '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
    '#06B6D4', '#F97316', '#EC4899', '#14B8A6', '#84CC16',
    '#6366F1', '#FB923C', '#A855F7', '#4ADE80', '#FBBF24',
    '#38BDF8', '#F43F5E', '#2DD4BF', '#C084FC', '#FCD34D',
    '#67E8F9', '#86EFAC', '#FCA5A5', '#C4B5FD', '#FF6B6B',
    '#4ECDC4', '#FFE66D', '#A8E6CF', '#FF8B94', '#7ED3F4',
    '#818CF8'
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
let pieManualPaused = false; // 用户点按钮手动暂停，hover 不覆盖
let pieCarouselQueue = [];

let advMode = "rank";
let advMetrics = [];
let advCurrentMetricIndex = 0;
let advCarouselTimer = null;
let advPaused = false;
let advManualPaused = false; // 用户点按钮手动暂停，hover 不覆盖
let advYears = [];
let advCurrentYear = null;
let rankFullData = [];
let rankSelectedNames = new Set(); // 存地区名称，不存索引，避免重排序后错位
let rankChart = null;
let scatterTableMode = 'province';

let allRegionList = [];
let regionSearchKeyword = "";
let rankRegionSearchTerm = "";

// ======================= 初始化 =======================


const _CBISlots = [
    'cbi-1','cbi-2','cbi-3','cbi-4','cbi-10',
    'cbi-l2a','cbi-l2b','cbi-l2c','cbi-l2d',
    'cbi-l3a','cbi-l3b','cbi-l3c','cbi-l3d',
    'cbi-r3a','cbi-r3b','cbi-r3c','cbi-r3d',
    'cbi-r2a','cbi-r2b','cbi-r2c','cbi-r2d',
    'cbi-5','cbi-6','cbi-7','cbi-8','cbi-9'
];
function _applyCoverBgNames(names) {
    const n = _CBISlots.length;
    _CBISlots.forEach((cls, i) => {
        const el = document.querySelector('.' + cls);
        if (!el) return;
        const idx = names.length <= n
            ? i % names.length
            : Math.round(i * (names.length - 1) / (n - 1));
        el.textContent = names[idx];
    });
}
function restoreCoverBgFromCache() {
    try {
        const cached = localStorage.getItem('cbi_names');
        if (cached) _applyCoverBgNames(JSON.parse(cached));
    } catch(e) {}
}
function initCoverBgIndicators() {
    const metrics = getAllMetrics('province');
    if (!metrics.length) return;
    const names = metrics.map(m => cleanMetricName(m) + '指数');
    _applyCoverBgNames(names);
    try { localStorage.setItem('cbi_names', JSON.stringify(names)); } catch(e) {}
}

async function init() {
    if (window._platformInitStarted) return;
    window._platformInitStarted = true;
    await loadAllData();
    try { initCoverBgIndicators(); } catch(e) {}


    mainChart = initEChartSafe(document.getElementById("main-chart"));
    if (mainChart) {
        // 暂停由 section-chart 卡片级别统一控制，见 bindEvents
    } else {
        showChartUnavailable(document.getElementById("main-chart"));
    }
    
    pieChart = initEChartSafe(document.getElementById("pie-chart"));
    if (pieChart) {
        // 暂停由 avCard mouseenter/mouseleave 统一控制，不在 canvas 级别重复绑定
    } else {
        showChartUnavailable(document.getElementById("pie-chart"));
    }
    
    // advancedChart pre-init removed; rankChart is initialized lazily in renderRankCompareChart
    
    if (!window._platformResizeBound) {
    window._platformResizeBound = true;
    let resizeRaf = null;
    window.addEventListener("resize", () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
        resizeVisibleChart(mainChart);
        resizeVisibleChart(pieChart);
        resizeVisibleChart(advancedChart);
        resizeVisibleChart(rankChart);
        // Also resize any inline chat charts
        Object.entries(_inlineChartInstances || {}).forEach(([id, c]) => {
            try {
                if (!c || c.isDisposed()) return;
                const dom = c.getDom();
                const isModalChart = id === 'chart-modal-chart';
                const wrap = isModalChart ? dom?.parentElement : dom?.closest('.agent-inline-chart-wrap, .rag-inline-chart-wrap');
                const newW = wrap ? wrap.clientWidth : 0;
                const newH = isModalChart ? 500 : (dom?.offsetHeight || 340);
                if (newW > 20) c.resize({ width: newW, height: newH });
                else c.resize();
            } catch(e) {}
        });
        });
    });
    }
    
    buildSheetSelect();
    bindEvents();
    initColumnSelector();
    switchSheet(currentSheet);
    switchAnalysisView(analysisSheet);
    initPageEnhancements();
    initHeroPreview();
    
    // 绑定RAG事件
    bindRagEvents();
    
    // 默认显示Landing页
    showLanding();
}


// ======================= RAG 事件绑定 =======================

function bindRagEvents() {
    if (bindRagEvents._bound) return;
    bindRagEvents._bound = true;
    const ragInput = document.getElementById('rag-input');
    const ragSend = document.getElementById('rag-send');
    const delTop = document.getElementById('rag-delete-top');
    const sessionSelect = document.getElementById('rag-session-select');

    if (ragInput) {
        ragInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 200) + 'px';
            _updateSendBtnMode(this.value.trim());
        });
        ragInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendRagMessage();
            }
        });
    }

    if (ragSend) {
        ragSend.onclick = null;
        ragSend.addEventListener('click', () => {
            if (!isRagStreaming) sendRagMessage();
        });
    }

    if (delTop) delTop.addEventListener('click', () => {
        if (!delTop.disabled) deleteCurrentSession();
    });

    if (sessionSelect) {
        sessionSelect.addEventListener('change', () => {
            if (sessionSelect.value) switchSession(sessionSelect.value);
        });
    }
    
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
    if (initColumnSelector._bound) return;
    initColumnSelector._bound = true;
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
        tableHeaders.forEach(h => visibleColumns.add(h));
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
        tableHeaders.forEach(h => visibleColumns.add(h));
        refreshColumnCheckboxList();
        renderTablePage();
    });
}

function refreshColumnCheckboxList() {
    const container = document.getElementById("column-checkbox-list");
    if (!container) return;
    container.innerHTML = "";
    tableHeaders.forEach(h => {
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
        label.appendChild(document.createTextNode(getTableHeaderLabel(h)));
        container.appendChild(label);
    });
}

function isCityDetailSheet(sheetName) {
    return sheetName === '\u5730\u7ea7\u5e02';
}

function getTableHeaderLabel(header) {
    if (isCityDetailSheet(tableSheet) && header === '\u65f6\u95f4') return '\u5e74\u4efd';
    return header;
}

function orderTableHeadersForSheet(headers, sheetName) {
    const hasCityShape = headers.includes('\u5730\u533a')
        && (headers.includes('\u5e74\u4efd') || headers.includes('\u65f6\u95f4') || headers.includes('\u65f6\u95f4\u5730\u533a'));
    if (!isCityDetailSheet(sheetName) && !hasCityShape) return headers;
    const firstColumns = ['\u5730\u533a', '\u5e74\u4efd', '\u65f6\u95f4'];
    const trailingColumns = ['\u65f6\u95f4\u5730\u533a'];
    const first = firstColumns.filter(h => headers.includes(h));
    const trailing = trailingColumns.filter(h => headers.includes(h));
    const rest = headers.filter(h => !first.includes(h) && !trailing.includes(h));
    return [...first, ...rest, ...trailing];
}

// ======================= 工作表切换 =======================

function buildSheetSelect() {
    const mainSelect  = document.getElementById("sheet-list");
    const avSelect    = document.getElementById("sheet-list-av");
    const tableSelect = document.getElementById("sheet-list-table");

    // main and table selects: use raw sheet names
    [mainSelect, tableSelect].forEach((sel, idx) => {
        if (!sel) return;
        const activeSheet = idx === 0 ? currentSheet : tableSheet;
        sel.innerHTML = "";
        window.sheetList?.forEach(s => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = s;
            if (s === activeSheet) opt.selected = true;
            sel.appendChild(opt);
        });
    });

    // av select: descriptive view labels
    if (avSelect) {
        const avViewLabels = {
            "全国": "省份占比饼图",
            "省份": "省份排名对比",
            "地级市": "地级市排名对比",
        };
        avSelect.innerHTML = "";
        window.sheetList?.forEach(s => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = avViewLabels[s] || s;
            if (s === analysisSheet) opt.selected = true;
            avSelect.appendChild(opt);
        });
        avSelect.onchange = (e) => switchAnalysisView(e.target.value);
    }

    if (mainSelect)  mainSelect.onchange  = (e) => requestSwitchSheet(e.target.value);
    if (tableSelect) tableSelect.onchange = (e) => setTableSheet(e.target.value, { independent: true });
}

function initPageEnhancements() {
    if (initPageEnhancements._bound) return;
    initPageEnhancements._bound = true;
    const nav = document.querySelector('.landing-nav');
    const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const targets = document.querySelectorAll('.kpi-card,.dash-card,.cap-card,.analysis-card-entry');
    targets.forEach(el => el.classList.add('reveal-on-scroll'));
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view');
                    io.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12 });
        targets.forEach(el => io.observe(el));
    } else {
        targets.forEach(el => el.classList.add('in-view'));
    }
}

function syncSheetSelects(sheetName = currentSheet) {
    const main  = document.getElementById("sheet-list");
    const table = document.getElementById("sheet-list-table");
    const av    = document.getElementById("sheet-list-av");
    if (main)  main.value  = sheetName;
    if (table) table.value = tableSheet || sheetName;
    if (av)    av.value    = analysisSheet;
}

function requestSwitchSheet(sheetName) {
    currentSheet = sheetName;
    tableSheet = sheetName;
    syncSheetSelects(sheetName);
    if (pendingSheetSwitchTimer) clearTimeout(pendingSheetSwitchTimer);
    pendingSheetSwitchTimer = null;
    document.body.classList.remove('sheet-switching');
    hideSheetSwitchOverlay();
    switchSheet(sheetName);
    requestAnimationFrame(() => forceResizeAllCharts());
}

function showSheetSwitchOverlay(sheetName) {
    let overlay = document.getElementById('sheet-switch-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sheet-switch-overlay';
        overlay.innerHTML = `
            <div class="sso-card">
                <div class="sso-spinner"></div>
                <div class="sso-text">正在切换到 <strong id="sso-name">—</strong></div>
                <div class="sso-sub">重建图表与指标面板…</div>
            </div>`;
        document.body.appendChild(overlay);
    }
    const nameEl = document.getElementById('sso-name');
    if (nameEl) nameEl.textContent = sheetName || '数据表';
    requestAnimationFrame(() => overlay.classList.add('show'));
}

function hideSheetSwitchOverlay() {
    const overlay = document.getElementById('sheet-switch-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
}

function setTableSheet(sheetName, options = {}) {
    tableSheet = sheetName || currentSheet;
    tableRows = window.workbook?.[tableSheet]?.map(row => ({ ...row })) || [];
    tableHeaders = orderTableHeadersForSheet(Object.keys(tableRows[0] || {}), tableSheet);
    visibleColumns.clear();
    tableHeaders.forEach(h => visibleColumns.add(h));
    sortKey = "";
    sortType = "asc";
    currentPage = 1;
    const tableSelect = document.getElementById("sheet-list-table");
    if (tableSelect) tableSelect.value = tableSheet;
    const tableSearch = document.getElementById("search-input");
    if (tableSearch && options.independent) tableSearch.value = "";
    refreshColumnCheckboxList();
    initTableSmartFilters();   // 切换工作表后重建年份/指标下拉
    applyFilterAndSort();
    renderTablePage();
    if (options.independent) showToast(`明细表已切换到：${tableSheet}`, 'success', 1600);
}

function switchAnalysisView(sheetName) {
    analysisSheet = sheetName;
    const sel = document.getElementById("sheet-list-av");
    if (sel) sel.value = sheetName;
    if (sheetName === "全国") {
        stopPieCarousel?.();
        initPieChart();
    } else {
        stopPieCarousel(); // 切换到排名图时停止饼图轮播
        advSheet = sheetName;
        switchAdvSheet(sheetName);
    }
}

function switchAdvSheet(sheetName) {
    advSheet = sheetName;
    const rows = window.workbook?.[sheetName]?.map(r => ({...r})) || [];
    advRows = rows;
    const sample = advRows[0] || {};
    const fields = Object.keys(sample).filter(k =>
        k !== '年份' && k !== '地区' && k !== '时间地区' && typeof sample[k] === 'number'
    );
    advMetrics = [...fields];
    advCurrentMetricIndex = 0;
    advYears = [...new Set(advRows.map(r => r["年份"]))].filter(Boolean).sort();
    advCurrentYear = advYears.length ? advYears[advYears.length - 1] : null;
    rankSelectedNames.clear();
    renderRankUI();
}

function switchSheet(sheetName) {
    currentSheet = sheetName;
    syncSheetSelects();
    originalRows = window.workbook[sheetName]?.map(row => ({ ...row })) || [];
    headers = Object.keys(originalRows[0] || {});
    
    log("切换到工作表:", sheetName, headers);
    setTableSheet(sheetName);
    
    const pageSizeSelect = document.getElementById("page-size-select");
    if (pageSizeSelect) pageSize = parseInt(pageSizeSelect.value) || 20;

    const searchContainer = document.getElementById("region-search-container");
    const metricContainer = document.getElementById('metric-selector-container');
    const groupActions = document.getElementById('group-actions');
    const setPanelVisible = (el, visible) => {
        if (!el) return;
        el.hidden = !visible;
        el.style.display = visible ? '' : 'none';
    };

    const chartMetricBar = document.getElementById('chart-metric-bar');
    // 把指标选择器归位到左侧面板（切全国时隐藏，切其他表时再移出去）
    const panelSection = document.getElementById('dynamic-panel');
    const regionSearchContainer = document.getElementById('region-search-container');
    if (metricContainer && panelSection && metricContainer.parentElement !== panelSection) {
        panelSection.insertBefore(metricContainer, regionSearchContainer || null);
    }

    if (sheetName === "全国") {
        dimType = "nation";
        scatterTableMode = 'province';
        valueFields = headers.filter(h => h !== "年份");
        currentMetricIndex = 0;
        selectedGroups = [];
        regionSearchKeyword = "";
        const regionSearch = document.getElementById("region-search");
        if (regionSearch) regionSearch.value = "";
        buildNationPanel();
        setPanelVisible(searchContainer, false);
        setPanelVisible(metricContainer, false);
        setPanelVisible(groupActions, false);
        if (chartMetricBar) chartMetricBar.style.display = 'none';
    } else if (sheetName === "地级市") {
        dimType = "city";
        scatterTableMode = 'city';
        groupField = "地区";
        const firstRow = originalRows[0];
        valueFields = Object.keys(firstRow).filter(key => key !== "年份" && key !== "地区" && key !== "时间地区");
        const groups = [...new Set(originalRows.map(r => r[groupField]))].filter(v => v).sort();
        selectedGroups = groups.slice(0, 3);
        buildGroupPanel(groups, "地级市");
        buildMetricSelector();
        setPanelVisible(searchContainer, true);
        setPanelVisible(metricContainer, false);
        if (chartMetricBar) {
            chartMetricBar.style.display = 'flex';
            chartMetricBar.appendChild(metricContainer);
        }
        setPanelVisible(groupActions, true);
    } else if (sheetName === "省份") {
        dimType = "province";
        scatterTableMode = 'province';
        groupField = "地区";
        const firstRow = originalRows[0];
        valueFields = Object.keys(firstRow).filter(key => key !== "年份" && key !== "地区");
        const groups = [...new Set(originalRows.map(r => r[groupField]))].filter(v => v).sort();
        selectedGroups = groups.slice(0, 3);
        buildGroupPanel(groups, "省份");
        buildMetricSelector();
        setPanelVisible(searchContainer, true);
        setPanelVisible(metricContainer, false);
        if (chartMetricBar) {
            chartMetricBar.style.display = 'flex';
            chartMetricBar.appendChild(metricContainer);
        }
        setPanelVisible(groupActions, true);
    }

    sortKey = "";
    sortType = "asc";
    const tableSearch = document.getElementById("search-input");
    if (tableSearch) tableSearch.value = "";
    regionSearchKeyword = "";
    rankRegionSearchTerm = "";
    const sortStatus = document.getElementById("sort-status");
    if (sortStatus) sortStatus.innerHTML = "排序：无（点击表头排序）";
    
    currentPage = 1;
    applyFilterAndSort();
    ensureDashboardAnalysisVisible();
    renderTablePage();
    // 切换工作表时按智能推荐逻辑设置默认图类型（全国→面积，省份/城市→柱状）
    const chartTypeEl = document.getElementById("chart-type");
    if (chartTypeEl) {
        const mixedOpt = chartTypeEl.querySelector('option[value="mixed"]');
        if (mixedOpt) mixedOpt.style.display = dimType === "nation" ? "" : "none";
        chartTypeEl.value = dimType === "nation" ? "mixed" : "bar";
    }
    // 切换工作表时重置手动暂停状态，并更新按钮文字
    mainCarouselManualPaused = false;
    isCarouselPaused = false;
    const pauseBtn = document.getElementById("main-pause-carousel");
    if (pauseBtn) pauseBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>暂停轮播';
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
    if (panelTitle) panelTitle.innerHTML = `核心指标`;
    
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

// buildQuickJump 已移除（快速跳转下拉框已删除）

function buildGroupPanel(groups, type) {
    allRegionList = groups;
    const titleMap = { "省份": "省份", "地级市": "地区" };
    const panelTitle = document.getElementById("panel-title");
    if (panelTitle) panelTitle.innerHTML = `${titleMap[type]}`;
    
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
                    selectedGroups = selectedGroups.filter(s => s !== g);
                }
                // 始终按 allRegionList 原始顺序排列，保证颜色与列表位置一致
                selectedGroups = allRegionList.filter(r => selectedGroups.includes(r));
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
        selectedGroups = allRegionList.slice(0, 3);
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
        searchInput.onkeydown = (e) => {
            if ((e.key === 'Enter' || e.key === 'Escape') && searchInput.value.trim()) {
                e.preventDefault();
                searchInput.value = "";
                regionSearchKeyword = "";
                renderRegionList();
            }
        };
    }

    renderRegionList();
    renderMainChart();
}

// ======================= 主图表渲染 =======================

function renderMainChart() {
    if (!mainChart || !valueFields.length) return;
    
    let chartType = document.getElementById("chart-type")?.value || "mixed";
    if (chartType === "auto") chartType = (dimType === "nation" ? "mixed" : "bar");
    // 非全国工作表不支持混合图，退回柱状
    if (chartType === "mixed" && dimType !== "nation") chartType = "bar";
    const isArea = chartType === "area";
    const echartsType = isArea ? "line" : "bar";

    const metric = valueFields[currentMetricIndex];
    if (!metric) return;

    if (dimType === "nation") {
        const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
        const data = years.map(y => originalRows.find(r => r["年份"] === y)?.[metric] ?? 0);

        const isMixed = chartType === "mixed";
        const nationSeries = isMixed ? [
            {
                name: metric,
                type: 'bar',
                data,
                barMaxWidth: 40,
                itemStyle: {
                    borderRadius: [5, 5, 0, 0],
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(139,92,246,0.75)' },
                        { offset: 1, color: 'rgba(96,165,250,0.35)' }
                    ])
                },
                label: { show: false }
            },
            {
                name: ' ',
                type: 'line',
                data,
                smooth: true,
                lineStyle: { width: 3, color: '#6d28d9' },
                symbol: 'circle',
                symbolSize: 7,
                itemStyle: { color: '#6d28d9' },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(109,40,217,0.22)' },
                        { offset: 1, color: 'rgba(109,40,217,0.01)' }
                    ])
                }
            }
        ] : [{
            name: metric,
            type: echartsType,
            data,
            smooth: true,
            color: COLORS[0],
            areaStyle: isArea ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(102,126,234,0.45)' },
                    { offset: 1, color: 'rgba(102,126,234,0.03)' }
                ])
            } : undefined
        }];

        mainChart.setOption({
            backgroundColor: 'transparent',
            title: {
                text: custom.title !== "auto" ? custom.title : `${metric} 时序趋势`,
                left: "center",
                textStyle: { color: '#1f2b48' }
            },
            tooltip: {
                trigger: "axis",
                backgroundColor: 'rgba(255,255,255,0.95)',
                borderColor: '#667eea',
                textStyle: { color: '#1f2b48' },
                formatter: isMixed
                    ? params => `${params[0].axisValue}年<br/>${metric}：<b>${params[0].value}</b>`
                    : undefined
            },
            legend: {
                data: isMixed ? [metric] : [metric],
                top: 30,
                textStyle: { color: '#263b59' }
            },
            grid: {
                top: 70,
                left: '12%',
                right: '4%',
                bottom: '12%',
                containLabel: true
            },
            xAxis: {
                type: "category",
                data: years,
                name: custom.xName !== "auto" ? custom.xName : "年份",
                axisLine: { lineStyle: { color: '#9fb1c8' } },
                axisLabel: { color: '#263b59', hideOverlap: true }
            },
            yAxis: {
                name: custom.yName !== "auto" ? custom.yName : metric,
                nameLocation: 'middle',
                nameGap: 60,
                nameTextStyle: { overflow: 'break', width: 80 },
                min: 0,
                max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
                axisLine: { lineStyle: { color: '#9fb1c8' } },
                axisLabel: { color: '#263b59', formatter: fmtAxisNum },
                splitLine: { lineStyle: { color: '#d8e1ec', type: 'dashed' } }
            },
            series: nationSeries
        }, true);
        return;
    }

    const years = [...new Set(originalRows.map(r => r["年份"]))].sort((a,b)=>a-b);
    const series = [];
    
    selectedGroups.forEach((grp, idx) => {
        const data = years.map(y => {
            let row = originalRows.find(r => r["年份"] === y && r["地区"] === grp);
            return row ? (row[metric] ?? null) : null;   // null 让 ECharts 在折线图中断开
        });
        series.push({
            name: grp,
            type: echartsType,
            data,
            smooth: true,
            color: COLORS[idx % COLORS.length],
            areaStyle: isArea ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: COLORS[idx % COLORS.length].replace(')', ',0.4)').replace('rgb', 'rgba') },
                    { offset: 1, color: COLORS[idx % COLORS.length].replace(')', ',0.02)').replace('rgb', 'rgba') }
                ]),
                opacity: 0.35
            } : undefined
        });
    });
    
    mainChart.setOption({
        backgroundColor: 'transparent',
        title: {
            text: custom.title !== "auto" ? custom.title : `${metric} 区域对比`,
            left: "center",
            textStyle: { color: '#1f2b48' }
        },
        tooltip: {
            trigger: "axis",
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderColor: '#667eea',
            textStyle: { color: '#1f2b48' }
        },
        legend: {
            data: selectedGroups,
            top: 30,
            type: "scroll",
            pageIconSize: 10,
            pageTextStyle: { fontSize: 11, color: '#718096' },
            textStyle: { color: '#263b59', fontSize: 12 },
            formatter: null
        },
        grid: {
            top: 70,
            left: '12%',
            right: '4%',
            bottom: '12%',
            containLabel: true
        },
        xAxis: {
            type: "category",
            data: years,
            name: "年份",
            axisLine: { lineStyle: { color: '#9fb1c8' } },
            axisLabel: { color: '#263b59', hideOverlap: true }
        },
        yAxis: {
            name: custom.yName !== "auto" ? custom.yName : metric,
            nameLocation: 'middle',
            nameGap: 60,
            nameTextStyle: { overflow: 'break', width: 80 },
            min: 0,
            max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
            axisLine: { lineStyle: { color: '#9fb1c8' } },
            axisLabel: { color: '#263b59', formatter: fmtAxisNum },
            splitLine: { lineStyle: { color: '#d8e1ec', type: 'dashed' } }
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
        // 如果鼠标仍在图表卡片上，不恢复轮播，等 mouseleave 时再恢复
        if (isMouseOverMainChart || mainCarouselManualPaused) return;
        isCarouselPaused = false;
        startCarousel();
    }, INACTIVITY_DELAY);
}

function toggleMainCarousel() {
    mainCarouselManualPaused = !mainCarouselManualPaused;
    const btn = document.getElementById("main-pause-carousel");
    if (!btn) return;
    if (mainCarouselManualPaused) {
        isCarouselPaused = true;
        stopCarousel();
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="6 4 20 12 6 20 6 4"/></svg>开始轮播';
    } else {
        // 手动恢复：若鼠标仍在卡片上，保持 hover-pause；否则立即恢复
        isCarouselPaused = isMouseOverMainChart;
        if (!isMouseOverMainChart) startCarousel();
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>暂停轮播';
    }
}

function togglePieCarousel() {
    pieManualPaused = !pieManualPaused;
    const btn = document.getElementById("pie-pause-carousel");
    if (!btn) return;
    if (pieManualPaused) {
        piePaused = true;
        stopPieCarousel();
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="6 4 20 12 6 20 6 4"/></svg>开始轮播';
    } else {
        // 手动恢复：若鼠标仍在卡片上，保持 hover-pause；否则立即恢复
        piePaused = isMouseOverAnalysis;
        if (!isMouseOverAnalysis) startPieCarousel();
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>暂停轮播';
    }
}

// ======================= 饼图 =======================

function initPieChart() {
    stopAdvCarousel(); // 切换到饼图时停止排名图轮播，避免其定时器重新覆盖面板显示状态
    // Switch to pie view: show pie panels, hide adv panels
    const avPieLeft  = document.getElementById("av-pie-left");
    const avAdvLeft  = document.getElementById("av-adv-left");
    const avPieRight = document.getElementById("av-pie-right");
    const avAdvRight = document.getElementById("av-adv-right");
    if (avPieLeft)  avPieLeft.style.display  = '';
    if (avAdvLeft)  avAdvLeft.style.display  = 'none';
    if (avPieRight) avPieRight.style.display = '';
    if (avAdvRight) avAdvRight.style.display = 'none';
    // Swap toolbar
    const pieTb = document.getElementById("av-pie-toolbar");
    const advTb = document.getElementById("advanced-toolbar");
    if (pieTb) pieTb.style.display = 'flex';
    if (advTb) advTb.style.display = 'none';
    // Update titles
    const titleEl = document.getElementById("av-card-title");
    if (titleEl) titleEl.textContent = "总-分结构饼图";
    const leftTitle = document.getElementById("av-left-title");
    if (leftTitle) leftTitle.textContent = "省份列表";

    // 饼图始终用省份数据；选了"全国"工作表时回退到省份表
    const provinceRows = window.workbook["省份"] || window.workbook[analysisSheet];
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
                div.classList.toggle("active", e.target.checked);
                renderPieChart();
                stopPieCarousel();
            };
            const label = document.createElement("span");
            label.innerText = prov;
            div.appendChild(cb);
            div.appendChild(label);
            listContainer.appendChild(div);
        });
    }

    const syncPieProvinceCheckboxes = () => {
        document.querySelectorAll("#pie-province-list .indicator-item").forEach(item => {
            const name = item.querySelector("span")?.innerText;
            const checkbox = item.querySelector("input[type=checkbox]");
            const checked = pieSelectedProvinces.has(name);
            if (checkbox) checkbox.checked = checked;
            item.classList.toggle("active", checked);
        });
    };
    const applyPieProvinceSelection = (nextSelected) => {
        pieSelectedProvinces = new Set(nextSelected);
        pieHiddenProvinces = new Set(pieProvinceList.filter(p => !pieSelectedProvinces.has(p)));
        syncPieProvinceCheckboxes();
        renderPieChart();
        stopPieCarousel();
    };
    const selectAllBtn = document.getElementById("pie-select-all");
    const invertBtn = document.getElementById("pie-invert-select");
    const resetBtn = document.getElementById("pie-reset-select");
    const clearBtn = document.getElementById("pie-clear-select");
    if (selectAllBtn) selectAllBtn.onclick = () => applyPieProvinceSelection(pieProvinceList);
    if (invertBtn) invertBtn.onclick = () => {
        const inverted = pieProvinceList.filter(p => !pieSelectedProvinces.has(p));
        applyPieProvinceSelection(inverted);
    };
    if (resetBtn) resetBtn.onclick = () => applyPieProvinceSelection(pieProvinceList);
    if (clearBtn) clearBtn.onclick = () => applyPieProvinceSelection([]);
    syncPieProvinceCheckboxes();
    
    // 扫描所有行，只要某列在任意一行有数值就纳入指标
    const allMetricKeys = new Set();
    provinceRows.forEach(row => Object.keys(row).forEach(k => allMetricKeys.add(k)));
    pieAvailableMetrics = [...allMetricKeys].filter(k => {
        if (k === "年份" || k === "地区") return false;
        return provinceRows.some(row => {
            const v = row[k];
            return v !== null && v !== undefined && v !== "" && !isNaN(Number(v));
        });
    });
    pieAvailableYears = [...new Set(provinceRows.map(r => String(r["年份"])))].sort();
    pieCurrentYear = String(pieAvailableYears[pieAvailableYears.length-1]);
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
            pieCurrentYear = yearSel.value; // 保持字符串，与数据类型一致
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
    
    
    pieCarouselQueue = [];
    for (let y of pieAvailableYears) {
        for (let i = 0; i < pieAvailableMetrics.length; i++) {
            pieCarouselQueue.push({ year: y, metricIndex: i });
        }
    }
    
    renderPieChart();
    // 延迟 resize，确保容器宽度完全铺开后重绘
    setTimeout(() => { try { pieChart?.resize(); renderPieChart(); } catch(e){} }, 80);
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
    if (!pieChart || !window.echarts) {
        showChartUnavailable(document.getElementById("pie-chart"));
        return;
    }
    const metric = pieAvailableMetrics[pieCurrentMetricIndex];
    const year = pieCurrentYear;
    // 饼图始终用省份表数据；analysisSheet 可能是"全国"，回退到"省份"
    const provinceRows = (window.workbook["省份"] || window.workbook[analysisSheet])?.filter(r => String(r["年份"]) === String(year)) || [];
    
    if (provinceRows.length === 0 || provinceRows.every(r => r[metric] === undefined || r[metric] === null)) {
        pieChart?.clear();
        pieChart?.setOption({ 
            title: { text: `无有效数据（${year}年 ${metric}）`, left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
        const status = document.getElementById("pie-status");
        if (status) status.innerHTML = `无有效数据，请切换年份或指标`;
        return;
    }
    
    // 始终用各省加总作分母：饼图展示"各省在全省合计中的占比"
    // 避免比例型/指数型指标以全国值为分母导致占比失真
    const total = provinceRows.reduce((sum, row) => sum + (Math.abs(Number(row[metric])) || 0), 0);
    const totalSource = "province_sum";

    if (!total || total === 0) {
        pieChart?.clear();
        pieChart?.setOption({
            title: { text: `该指标各省均为0或无数据`, left: "center", top: "center" },
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
        let val = (row && row[metric] !== null && row[metric] !== undefined) ? Number(row[metric]) : 0;
        provinceSum += val;
        if (pieSelectedProvinces.has(prov)) {
            normalData.push({ name: prov, value: val, originalVal: val });
        } else {
            hiddenSum += val;
            hiddenNames.push(prov);
        }
    }
    
    let pieSeriesData = [];
    const colorPalette = [...COLORS];
    
    normalData.forEach((item, idx) => {
        let percent = (item.value / total) * 100;
        if (percent > 0.01 || item.value === 0) {
            // 视觉压缩：用 sqrt(percent) 作为 value，配合 roseType:"area"（area∝value）
            // 最终 radius ∝ percent^0.25，大幅收窄极端值与其他省份的半径差距
            pieSeriesData.push({
                name: item.name,
                value: Math.sqrt(percent),   // 仅用于视觉半径
                realPercent: percent,         // 真实百分比，供 tooltip 显示
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
                value: Math.sqrt(hiddenPercent),
                realPercent: hiddenPercent,
                originalVal: hiddenSum,
                itemStyle: { color: '#718096' }
            });
        }
    }
    
    
    const allProvinceSet = new Set(provinceRows.map(r => r["地区"]));
    const neverExist = pieProvinceList.filter(p => !allProvinceSet.has(p));
    if (neverExist.length > 0) {
        pieSeriesData.push({
            name: `数据缺失省份 (${neverExist.length}省)`,
            value: 0,
            originalVal: 0,
            itemStyle: { color: '#cbd5e0' }
        });
    }
    
    const totalNote = totalSource === "province_sum" ? `（基于${provinceRows.length}省数值总和${formatValue(total)}计算）` : "";
    const unit = getUnit(metric);
    
    // notMerge=true 清除切换图表类型留下的轴线/grid 残留
    pieChart?.setOption({
        backgroundColor: 'transparent',
        // 明确清空可能残留的轴/grid，消灭左侧和下侧边框线
        grid: [],
        xAxis: [],
        yAxis: [],
        title: {
            text: `${year}年  ${metric}${unit ? ` (${unit})` : ''}  各省份占比`,
            subtext: totalNote || '',
            left: "42%",
            textAlign: "center",
            top: 10,
            textStyle: { color: '#1f2b48', fontSize: 15, fontWeight: 700 },
            subtextStyle: { color: '#5a7a9a', fontSize: 11 }
        },
        tooltip: {
            trigger: "item",
            confine: true,
            backgroundColor: 'rgba(255,255,255,0.97)',
            borderColor: 'rgba(90,103,216,0.25)',
            borderWidth: 1,
            padding: [10, 14],
            textStyle: { color: '#1a2540', fontSize: 13 },
            extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);',
            formatter: (params) => {
                if (params.name.startsWith("数据缺失省份")) {
                    return `<b>${params.name}</b><br/><span style="color:#94a3b8">缺失: ${neverExist.join("、")}</span>`;
                }
                const realPct = params.data?.realPercent ?? params.percent;
                const colorDot = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${params.color};margin-right:6px;vertical-align:middle;"></span>`;
                let tip = `${colorDot}<b>${params.name}</b><br/>占比：<b style="color:${params.color}">${realPct.toFixed(2)}%</b>`;
                if (params.data?.originalVal !== undefined) {
                    tip += `<br/>数值：${formatValue(params.data.originalVal)}${unit ? ' ' + unit : ''}`;
                }
                if (params.name.startsWith("已隐藏省份")) {
                    tip += `<br/><span style="color:#94a3b8">含：${formatMissingList(hiddenNames, 5)}</span>`;
                }
                return tip;
            }
        },
        legend: {
            orient: "vertical",
            right: 6,
            top: "middle",
            type: "scroll",
            itemWidth: 10,
            itemHeight: 10,
            itemGap: 7,
            pageIconSize: 10,
            pageTextStyle: { fontSize: 11, color: '#718096' },
            textStyle: { color: '#263b59', fontSize: 11.5 },
            formatter: null
        },
        graphic: [],   // 先清空，rAF 后用实际尺寸精确定位
        series: [{
            type: "pie",
            roseType: "area",
            radius: ["8%", "72%"],
            center: ["42%", "54%"],
            data: pieSeriesData,
            label: { show: false },
            labelLine: { show: false },
            itemStyle: {
                borderRadius: 4,
                borderWidth: 1.5,
                borderColor: 'rgba(255,255,255,0.7)',
                shadowBlur: 0
            },
            minAngle: 1.5,
            emphasis: {
                scale: true,
                scaleSize: 8,
                label: {
                    show: true,
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#1a2540',
                    formatter: (params) => {
                        const pct = (params.data?.realPercent ?? params.percent).toFixed(1);
                        return `${params.name}\n${pct}%`;
                    }
                },
                itemStyle: {
                    shadowBlur: 20,
                    shadowColor: 'rgba(90,103,216,0.5)',
                    borderWidth: 2,
                    borderColor: 'rgba(90,103,216,0.4)'
                }
            }
        }]
    }, true);

    // 花心装饰圆：setOption 后用 rAF 重新读取实际像素坐标，避免 resize 后错位
    requestAnimationFrame(() => {
        if (!pieChart || pieChart.isDisposed?.()) return;
        const _w = pieChart.getWidth(), _h = pieChart.getHeight();
        if (!_w || !_h) return;
        pieChart.setOption({ graphic: [{
            type: 'circle',
            x: _w * 0.42, y: _h * 0.54,
            shape: { r: 28 },
            style: { fill: 'rgba(245,248,255,0.85)', stroke: 'rgba(90,103,216,0.18)', lineWidth: 1.5, shadowBlur: 12, shadowColor: 'rgba(90,103,216,0.15)' }
        }] });
    });

    // 独立 resize 监听：窗口大小变化时（含小屏切大屏）自动同步花心位置
    // 只注册一次；pieChart 是模块变量，闭包里始终拿到最新实例
    if (!window._pieCenterResizeHooked) {
        window._pieCenterResizeHooked = true;
        window.addEventListener('resize', debounce(() => {
            if (!pieChart || pieChart.isDisposed?.()) return;
            const _w = pieChart.getWidth(), _h = pieChart.getHeight();
            if (!_w || !_h) return;
            pieChart.setOption({ graphic: [{ x: _w * 0.42, y: _h * 0.54 }] });
        }, 180));
    }

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
    
    let statusMsg = `💡 总量来源: ${totalSource === "national" ? "全国表" : "省份表数值之和"} | 总值: ${formatValue(total)} ${unit} | * 半径经视觉均衡处理，悬停查看真实占比`;
    if (neverExist.length) statusMsg += ` | 数据缺失省份: ${formatMissingList(neverExist)}`;
    if (hiddenNames.length) statusMsg += ` | 已隐藏 ${hiddenNames.length} 省`;
    
    const status = document.getElementById("pie-status");
    if (status) status.innerHTML = statusMsg;
}

// ======================= 高级分析（排名对比图）=======================

function initAdvancedAnalysis() {
    advRows = originalRows.map(r => ({...r}));
    advSheet = currentSheet;
    const advSel = document.getElementById("sheet-list-adv");
    if (advSel) advSel.value = advSheet;
    advMetrics = [...valueFields];
    advCurrentMetricIndex = 0;
    advYears = [...new Set(advRows.map(r => r["年份"]))].filter(Boolean).sort();
    advCurrentYear = advYears.length ? advYears[advYears.length-1] : null;
    renderRankUI();
}

function renderRankUI() {
    const toolbar = document.getElementById("advanced-toolbar");
    if (!toolbar) return;
    // Show adv toolbar, hide pie toolbar; update card title
    toolbar.style.display = '';
    const pieTb = document.getElementById("av-pie-toolbar");
    if (pieTb) pieTb.style.display = 'none';
    const titleEl = document.getElementById("av-card-title");
    if (titleEl) titleEl.textContent = "指数排名";
    const leftTitle = document.getElementById("av-left-title");
    if (leftTitle) leftTitle.textContent = "地区列表";
    toolbar.innerHTML = `
        <div class="tool-pill"><label>指标</label><select id="adv-metric-select"></select></div>
        <div class="tool-pill"><label>年份</label><select id="adv-year-select"></select></div>
        <button id="adv-pause-carousel" class="action-btn ghost" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            暂停轮播
        </button>
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
        renderAdvancedChart(true); // fromCarousel=true：只更新图表，不重建左侧列表 DOM
    }, 5000);
}

function stopAdvCarousel() {
    if (advCarouselTimer) { clearInterval(advCarouselTimer); advCarouselTimer = null; }
}

function toggleAdvCarousel() {
    advManualPaused = !advManualPaused;
    const btn = document.getElementById("adv-pause-carousel");
    if (advManualPaused) {
        advPaused = true;
        stopAdvCarousel();
        if (btn) btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="6 4 20 12 6 20 6 4"/></svg>开始轮播';
    } else {
        // 手动恢复：若鼠标仍在卡片上，保持 hover-pause；否则立即恢复
        advPaused = isMouseOverAnalysis;
        if (!isMouseOverAnalysis) startAdvCarousel();
        if (btn) btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>暂停轮播';
    }
}

function renderAdvancedChart(fromCarousel = false) {
    if (!advMetrics?.length) return;
    const metric = advMetrics[advCurrentMetricIndex];
    const year = advCurrentYear;
    if (!metric || !year) {
        advancedChart?.setOption({
            title: { text: "无可用指标或年份", left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
        return;
    }
    const sampleRow = advRows.find(r => r["年份"] === year && r[metric] !== undefined);
    const isNumeric = sampleRow && typeof sampleRow[metric] === "number";
    if (!isNumeric) {
        renderCategoryStats(metric, year);
        return;
    }
    renderRankCompareChart(metric, year, fromCarousel);
}

function renderRankCompareChart(metric, year, fromCarousel = false) {
    const dataForYear = advRows.filter(r => r["年份"] === year);
    const allRegions = new Set(advRows.map(r => r["地区"]));
    const regionData = [];
    
    for (let region of allRegions) {
        let row = dataForYear.find(r => r["地区"] === region);
        let val = (row && row[metric] !== null && row[metric] !== undefined) ? row[metric] : null;
        if (typeof val === 'number' && isNaN(val)) val = null;
        regionData.push({ name: region, value: val });   // null 在排名图中会被跳过
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
    if (rankSelectedNames.size === 0 || fromCarousel) {
        rankSelectedNames.clear();
        let validCount = 0;
        for (let i = 0; i < regionData.length && validCount < 10; i++) {
            if (typeof regionData[i].value === 'number' && !isNaN(regionData[i].value)) {
                rankSelectedNames.add(regionData[i].name);
                validCount++;
            }
        }
    }
    
    // Show adv panels, hide pie panels
    const avPieLeft  = document.getElementById("av-pie-left");
    const avAdvLeft  = document.getElementById("av-adv-left");
    const avPieRight = document.getElementById("av-pie-right");
    const avAdvRight = document.getElementById("av-adv-right");
    if (avPieLeft)  avPieLeft.style.display  = 'none';
    if (avAdvLeft)  avAdvLeft.style.display  = 'flex';
    if (avPieRight) avPieRight.style.display = 'none';
    if (avAdvRight) avAdvRight.style.display = '';

    const listPanel = avAdvLeft;
    // 共享的列表渲染函数——无论初建还是用户操作都用同一份逻辑
    const buildRankList = (data) => {
        const listBody = document.getElementById("rank-region-list");
        const meta     = document.getElementById("rank-region-meta");
        if (!listBody) return;
        const keyword  = rankRegionSearchTerm.trim().toLowerCase();
        const indexed  = data.map((item, idx) => ({ item, idx }));
        const filtered = keyword
            ? indexed.filter(({ item }) => String(item.name || '').toLowerCase().includes(keyword))
            : indexed;
        if (meta) meta.textContent = keyword
            ? `显示 ${filtered.length} / ${data.length} 个地区`
            : `共 ${data.length} 个地区`;
        listBody.innerHTML = "";
        if (!filtered.length) {
            listBody.innerHTML = '<div class="rank-empty">未找到匹配地区</div>';
            return;
        }
        filtered.forEach(({ item, idx }) => {
            const div = document.createElement("div");
            const isChecked = rankSelectedNames.has(item.name);
            div.className = "rank-list-item" + (isChecked ? " active" : "");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = isChecked;
            cb.onchange = (e) => {
                if (e.target.checked) { rankSelectedNames.add(item.name); div.classList.add("active"); }
                else { rankSelectedNames.delete(item.name); div.classList.remove("active"); }
                updateRankChart();
            };
            const rankSpan  = document.createElement("span");
            rankSpan.className  = "rank";
            rankSpan.innerText  = `${idx + 1}`;
            const nameSpan  = document.createElement("span");
            nameSpan.className  = "name";
            nameSpan.innerText  = item.name;
            const valueSpan = document.createElement("span");
            valueSpan.className = "value";
            valueSpan.innerText = (typeof item.value === 'number' && !isNaN(item.value))
                ? item.value.toFixed(2) : "无数据";
            div.appendChild(cb);
            div.appendChild(rankSpan);
            div.appendChild(nameSpan);
            div.appendChild(valueSpan);
            listBody.appendChild(div);
        });
    };

    if (listPanel) {
        const alreadyBuilt = !!document.getElementById("rank-region-list");

        if (!alreadyBuilt) {
            // 首次进入排名模式：构建完整面板骨架
            listPanel.innerHTML = `
                <div class="panel-section rank-region-search">
                    <input id="rank-region-search-input" type="text" placeholder="搜索地区，Enter/Esc 清空" value="${escapeHtml(rankRegionSearchTerm)}" style="width:100%;margin-top:4px;">
                </div>
                <div class="rank-region-meta panel-label" id="rank-region-meta" style="padding:4px 12px;"></div>
                <div class="rank-region-list indicator-list" id="rank-region-list"></div>
            `;
            const search = document.getElementById("rank-region-search-input");
            if (search) {
                search.oninput = (e) => {
                    rankRegionSearchTerm = e.target.value;
                    buildRankList(rankFullData);
                };
                search.onkeydown = (e) => {
                    if ((e.key === 'Enter' || e.key === 'Escape') && search.value.trim()) {
                        e.preventDefault();
                        rankRegionSearchTerm = "";
                        search.value = "";
                        buildRankList(rankFullData);
                    }
                };
            }
        }

        // 始终完整重建列表，确保排名顺序和勾选状态与当前指标对应
        buildRankList(regionData);
    }
    
    const chartPanel = document.getElementById("rank-chart-panel");
    if (chartPanel) {
        rankChart = disposeChartInstance(rankChart);
        rankChart = initEChartSafe(chartPanel);
        updateRankChart();
    }
}

function updateRankChart() {
    const selectedData = rankFullData
        .filter(d => rankSelectedNames.has(d.name) && typeof d.value === 'number' && !isNaN(d.value));
    selectedData.sort((a, b) => b.value - a.value);
    
    const option = {
        backgroundColor: 'transparent',
        title: {
            text: `${advMetrics[advCurrentMetricIndex]} 对比`,
            left: "center",
            textStyle: { color: '#1f2b48' }
        },
        tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderColor: '#667eea',
            textStyle: { color: '#1f2b48' }
        },
        grid: { containLabel: true, left: "15%" },
        xAxis: {
            type: "value",
            name: advMetrics[advCurrentMetricIndex],
            axisLine: { lineStyle: { color: '#9fb1c8' } },
            axisLabel: { color: '#263b59' },
            splitLine: { lineStyle: { color: '#d8e1ec', type: 'dashed' } }
        },
        yAxis: {
            type: "category",
            data: selectedData.map(d => d.name),
            axisLabel: { fontSize: 11, color: '#263b59' },
            axisLine: { lineStyle: { color: '#9fb1c8' } }
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
            label: { show: true, position: "right", color: '#263b59' }
        }]
    };
    
    if (rankChart) rankChart.setOption(option, true);

    // 更新排名注释文字
    const annotEl = document.getElementById("rank-annotation");
    if (!annotEl || !rankFullData || rankFullData.length === 0) return;

    const metric = advMetrics[advCurrentMetricIndex];
    const year = advCurrentYear;
    const fmt = v => parseFloat(v.toFixed(4)).toString();

    // 用全量数据判断是否为 0/1 型指标（排除缺失值）
    const allMetricVals = advRows
        .map(r => r[metric])
        .filter(v => typeof v === 'number' && !isNaN(v));
    const isBinary = allMetricVals.length > 0 && allMetricVals.every(v => v === 0 || v === 1);

    // 已勾选城市（含缺失）
    const allSelected = rankFullData.filter(d => rankSelectedNames.has(d.name));
    // 已勾选中有有效数值的
    const selectedValid = allSelected.filter(d => typeof d.value === 'number' && !isNaN(d.value));

    if (allSelected.length === 0) {
        annotEl.textContent = "";
        return;
    }

    if (allSelected.length === 1) {
        // 单城市：直接说明该城市数据
        const d = allSelected[0];
        const hasVal = typeof d.value === 'number' && !isNaN(d.value);
        if (!hasVal) {
            annotEl.textContent = `已选城市中，${year}年${d.name}暂无${metric}数据。`;
        } else if (isBinary) {
            const label = d.value === 1 ? '"是"' : '"否"';
            annotEl.textContent = `已选城市中，${year}年${d.name}的${metric}为${label}。`;
        } else {
            annotEl.textContent = `已选城市中，${year}年${d.name}的${metric}为${fmt(d.value)}。`;
        }
        return;
    }

    if (isBinary) {
        // 0/1 型：按"是"/"否"分组列出
        const yesNames = selectedValid.filter(d => d.value === 1).map(d => d.name);
        const noNames  = selectedValid.filter(d => d.value === 0).map(d => d.name);
        let text = `已选城市中，${metric}为"是"的有：${yesNames.length ? yesNames.join("、") : "无"}；为"否"的有：${noNames.length ? noNames.join("、") : "无"}。`;
        const naNames = allSelected.filter(d => !(typeof d.value === 'number' && !isNaN(d.value))).map(d => d.name);
        if (naNames.length) text += `其中${naNames.join("、")}暂无数据。`;
        annotEl.textContent = text;
        return;
    }

    // 多城市普通数值型：最高/最低
    if (selectedValid.length === 0) { annotEl.textContent = ""; return; }
    const sorted = [...selectedValid].sort((a, b) => b.value - a.value);
    const highest = sorted[0];
    const lowest  = sorted[sorted.length - 1];
    if (highest === lowest) {
        annotEl.textContent = `已选城市中，${year}年${highest.name}的${metric}为${fmt(highest.value)}。`;
    } else {
        annotEl.textContent = `已选城市中，${year}年${highest.name}的${metric}排名最高，为${fmt(highest.value)}；同年${lowest.name}的${metric}排名最低，为${fmt(lowest.value)}。`;
    }
}

function renderCategoryStats(metric, year) {
    const dataForYear = advRows.filter(r => r["年份"] === year);
    const freqMap = new Map();
    dataForYear.forEach(row => {
        let val = row[metric];
        if (val !== undefined && val !== null && val !== "") {
            const key = String(val);
            freqMap.set(key, (freqMap.get(key) || 0) + 1);
        }
    });
    
    if (freqMap.size === 0) {
        const chartPanel = document.getElementById("rank-chart-panel");
        if (chartPanel && (!rankChart || rankChart.isDisposed?.())) rankChart = initEChartSafe(chartPanel);
        rankChart?.setOption({
            title: { text: `无有效分类数据 (${metric})`, left: "center", top: "center" },
            backgroundColor: 'transparent'
        });
        return;
    }

    const sorted = Array.from(freqMap.entries()).sort((a,b) => b[1] - a[1]);
    const chartPanel2 = document.getElementById("rank-chart-panel");
    if (chartPanel2 && (!rankChart || rankChart.isDisposed?.())) rankChart = initEChartSafe(chartPanel2);

    rankChart?.setOption({
        backgroundColor: 'transparent',
        title: {
            text: `${metric} 分类频次统计 (${year}年)`,
            left: "center",
            textStyle: { color: '#1f2b48' }
        },
        tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: 'rgba(255,255,255,0.95)',
            textStyle: { color: '#1f2b48' }
        },
        xAxis: {
            type: "category",
            data: sorted.map(s => s[0]),
            axisLabel: { rotate: 30, color: '#263b59' },
            axisLine: { lineStyle: { color: '#9fb1c8' } }
        },
        yAxis: {
            type: "value",
            name: "出现次数",
            axisLine: { lineStyle: { color: '#9fb1c8' } },
            axisLabel: { color: '#263b59' },
            splitLine: { lineStyle: { color: '#d8e1ec', type: 'dashed' } }
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
let tableActiveMetricFilter = "";  // 当前选中的指标列筛选

// 统计值和热力图范围缓存，仅在 applyFilterAndSort 时重算，renderTablePage 直接复用
let _cachedStats = {};
let _cachedColRange = {};

function applyFilterAndSort() {
    let filtered = [...tableRows];
    const searchVal = (document.getElementById("search-input")?.value || "").trim();
    const yearVal   = (document.getElementById("table-year-filter")?.value || "").trim();
    const regionVal = (document.getElementById("table-region-filter")?.value || "").trim().toLowerCase();
    const metricVal = (document.getElementById("table-metric-filter")?.value || "").trim();
    currentSearchTerm = searchVal;
    tableActiveMetricFilter = metricVal;

    // 年份精确筛选
    if (yearVal) {
        filtered = filtered.filter(r => String(r["年份"] ?? "") === yearVal);
    }
    // 地区模糊匹配
    if (regionVal) {
        filtered = filtered.filter(r => String(r["地区"] ?? "").toLowerCase().includes(regionVal));
    }
    // 指标列有值筛选：只保留该指标不为空/0的行
    if (metricVal) {
        filtered = filtered.filter(r => {
            const v = r[metricVal];
            return v !== null && v !== undefined && v !== "" && Number(v) !== 0;
        });
        // 同步只显示：地区、年份、选中指标列
        visibleColumns.clear();
        ["地区","年份",metricVal].forEach(k => { if(tableHeaders.includes(k)) visibleColumns.add(k); });
    }
    // 关键词全文搜索（在已过滤结果上继续筛）
    if (searchVal) {
        const sv = searchVal.toLowerCase();
        filtered = filtered.filter(row => Object.values(row).some(v => String(v).toLowerCase().includes(sv)));
    }

    if (sortKey) {
        filtered.sort((a,b) => {
            const av = a[sortKey], bv = b[sortKey];
            if (typeof av === 'number' && typeof bv === 'number') return sortType === "asc" ? av - bv : bv - av;
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

    // 过滤/排序后一次性计算统计值和热力图范围，renderTablePage 直接复用，不在每页渲染时重算
    _cachedStats = {};
    _cachedColRange = {};
    const isYearLike = h => h === '年份' || h === '时间';
    const isRegionLike = h => h === '地区';
    const numericFields = tableHeaders.filter(h => {
        if (isYearLike(h) || isRegionLike(h)) return false;
        const sample = filteredRowsForPage[0];
        return sample && typeof sample[h] === 'number';
    });
    numericFields.forEach(field => {
        const values = [];
        for (let i = 0; i < filteredRowsForPage.length; i++) {
            const v = filteredRowsForPage[i][field];
            if (typeof v === 'number' && !isNaN(v)) values.push(v);
        }
        if (values.length === 0) {
            _cachedStats[field] = { sum: '-', avg: '-', median: '-', min: '-', max: '-' };
            return;
        }
        // 单次遍历求 sum/min/max，避免 Math.min(...arr) 展开大数组
        let sum = 0, mn = values[0], mx = values[0];
        for (let i = 0; i < values.length; i++) {
            sum += values[i];
            if (values[i] < mn) mn = values[i];
            if (values[i] > mx) mx = values[i];
        }
        const avg = sum / values.length;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        _cachedStats[field] = {
            sum: sum.toFixed(2), avg: avg.toFixed(2),
            median: median.toFixed(2), min: mn.toFixed(2), max: mx.toFixed(2)
        };
        if (mx > mn) _cachedColRange[field] = { min: mn, range: mx - mn };
    });
}

// 填充年份和指标下拉，并绑定事件
function initTableSmartFilters() {
    const yearSel   = document.getElementById("table-year-filter");
    const metricSel = document.getElementById("table-metric-filter");
    const regionIn  = document.getElementById("table-region-filter");
    const clearBtn  = document.getElementById("table-filter-clear");

    if (yearSel) {
        const years = [...new Set(tableRows.map(r => String(r["年份"] ?? "")).filter(Boolean))].sort();
        yearSel.innerHTML = '<option value="">全部年份</option>' + years.map(y => `<option value="${y}">${y}</option>`).join("");
        yearSel.onchange = () => { currentPage = 1; applyFilterAndSort(); renderTablePage(); };
    }
    if (metricSel) {
        const metrics = tableHeaders.filter(h => h !== "年份" && h !== "地区");
        metricSel.innerHTML = '<option value="">全部指标</option>' + metrics.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
        metricSel.onchange = () => {
            currentPage = 1;
            // 若取消指标筛选，恢复全部列显示
            if (!metricSel.value) { tableHeaders.forEach(h => visibleColumns.add(h)); }
            applyFilterAndSort();
            renderTablePage();
        };
    }
    if (regionIn) {
        regionIn.oninput = debounce(() => { currentPage = 1; applyFilterAndSort(); renderTablePage(); }, 200);
    }
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (yearSel) yearSel.value = "";
            if (metricSel) metricSel.value = "";
            if (regionIn) regionIn.value = "";
            const searchIn = document.getElementById("search-input");
            if (searchIn) searchIn.value = "";
            tableHeaders.forEach(h => visibleColumns.add(h));
            currentPage = 1;
            applyFilterAndSort();
            renderTablePage();
        };
    }
}

let _renderTableRaf = null;
function renderTablePage() {
    if (_renderTableRaf) cancelAnimationFrame(_renderTableRaf);
    _renderTableRaf = requestAnimationFrame(_doRenderTablePage);
}
function _doRenderTablePage() {
    _renderTableRaf = null;
    const start = (currentPage - 1) * pageSize;
    const pageData = filteredRowsForPage.slice(start, start + pageSize);
    const searchVal = currentSearchTerm;
    const visible = tableHeaders.filter(h => visibleColumns.has(h));
    const isYearLikeColumn = h => h === '\u5e74\u4efd' || h === '\u65f6\u95f4';
    const isRegionLikeColumn = h => h === '\u5730\u533a';
    
    // 直接复用 applyFilterAndSort 里已算好的缓存，不重算
    const stats = _cachedStats;
    const colRange = _cachedColRange;
    
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
        th.textContent = getTableHeaderLabel(h) + arrow;
        headerRow.appendChild(th);
        
        const td = document.createElement('td');
        td.className = 'stats-cell';
        if (isYearLikeColumn(h) || isRegionLikeColumn(h)) {
            td.textContent = isYearLikeColumn(h) ? '\u5e74\u4efd\u8303\u56f4' : '\u5730\u533a\u5217\u8868';
            statsRow.appendChild(td);
            return;
        }
        
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

    // 构建数据行（DocumentFragment + for 循环，减少 reflow）
    const hlRegex = searchVal ? new RegExp(`(${escapeRegex(searchVal)})`, 'gi') : null;
    const tbody = document.createElement('tbody');
    const bFrag = document.createDocumentFragment();
    for (let i = 0; i < pageData.length; i++) {
        const row = pageData[i];
        const tr = document.createElement('tr');
        for (let j = 0; j < visible.length; j++) {
            const h = visible[j];
            const td = document.createElement('td');
            const val = row[h] ?? '';
            if (hlRegex) {
                hlRegex.lastIndex = 0;
                td.innerHTML = String(val).replace(hlRegex, '<span class="highlight-red">$1</span>');
            } else {
                td.textContent = val;
            }
            // 热力图着色
            const cr = colRange[h];
            if (cr && typeof val === 'number') {
                const ratio = (val - cr.min) / cr.range;
                td.style.background = `rgba(102,126,234,${(ratio * 0.18).toFixed(3)})`;
                td.title = `数值: ${val} | 排位: ${Math.round(ratio * 100)}%`;
            }
            tr.appendChild(td);
        }
        bFrag.appendChild(tr);
    }
    tbody.appendChild(bFrag);

    const table = document.getElementById('data-table');
    if (table) {
        const tFrag = document.createDocumentFragment();
        tFrag.appendChild(thead);
        tFrag.appendChild(tbody);
        table.innerHTML = '';
        table.appendChild(tFrag);
        
        const pageCurrent = document.getElementById('page-current');
        const pageGoto = document.getElementById('page-goto');
        if (pageCurrent) pageCurrent.innerText = currentPage;
        if (pageGoto) pageGoto.max = totalPages;
        
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) tableContainer.scrollTop = 0;
    }
    updateTableDataProcessingNotice(filteredRowsForPage, visible);
}

function updateTableDataProcessingNotice() {
    // 提示已关闭
    document.querySelector('.data-processing-notice.table-data-notice')?.remove();
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
    if (!window.XLSX) {
        if (type === "csv") {
            const rows = filteredRowsForPage || [];
            if (!rows.length) { alert("当前没有可导出的数据"); return; }
            const headers = Object.keys(rows[0]);
            const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
            const csv = [
                headers.map(escapeCsv).join(","),
                ...rows.map(row => headers.map(h => escapeCsv(row[h])).join(","))
            ].join("\n");
            const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `${tableSheet}_data.csv`;
            link.click();
            URL.revokeObjectURL(link.href);
            return;
        }
        alert("Excel 导出库未加载。请恢复网络后刷新，或先使用 CSV 导出。");
        return;
    }
    const ws = XLSX.utils.json_to_sheet(filteredRowsForPage);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tableSheet);
    XLSX.writeFile(wb, `${tableSheet}_data.${type === "csv" ? "csv" : "xlsx"}`);
}

function printTable() { window.print(); }

// Generate a real SVG string from any ECharts instance (works even if source is canvas-rendered)
function getChartSVGString(chartInstance) {
    if (!chartInstance || !window.echarts) return null;
    let option;
    try { option = chartInstance.getOption(); } catch(e) { return null; }
    if (!option) return null;
    
    const dom = chartInstance.getDom && chartInstance.getDom();
    const w = (dom && dom.offsetWidth) || 800;
    const h = (dom && dom.offsetHeight) || 500;
    
    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = `position:absolute;left:-99999px;top:-99999px;width:${w}px;height:${h}px;`;
    document.body.appendChild(tempDiv);
    
    let svgString = null;
    let tempChart = null;
    try {
        tempChart = echarts.init(tempDiv, null, { renderer: 'svg', width: w, height: h });
        tempChart.setOption(option, true);
        const svgEl = tempDiv.querySelector('svg');
        if (svgEl) {
            // Clone to avoid live DOM references during dispose
            const cloned = svgEl.cloneNode(true);
            if (!cloned.getAttribute('xmlns')) cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            if (!cloned.getAttribute('xmlns:xlink')) cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
            svgString = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + new XMLSerializer().serializeToString(cloned);
        }
    } catch(e) {
        console.error('SVG render failed:', e);
    } finally {
        try { if (tempChart) tempChart.dispose(); } catch(e) {}
        try { if (tempDiv.parentNode) tempDiv.parentNode.removeChild(tempDiv); } catch(e) {}
    }
    return svgString;
}

function exportChart(chartInstance, type, filename) {
    if (!chartInstance) return;
    try {
        if (type === 'svg') {
            const svgStr = getChartSVGString(chartInstance);
            if (!svgStr) {
                showToast('SVG 导出失败：图表内容为空或库未加载', 'error');
                return;
            }
            const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `${filename}.svg`;
            link.href = blobUrl;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
            return;
        }
        const url = chartInstance.getDataURL({
            type: type === 'jpg' ? 'jpeg' : 'png',
            pixelRatio: 2,
            backgroundColor: '#ffffff'
        });
        const link = document.createElement('a');
        link.download = `${filename}.${type}`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch(e) {
        console.error('Export failed:', e);
        showToast('图表导出失败，请稍后重试', 'error');
    }
}

// ======================= 高级图表模块（卡片式）=======================

let activeChart = null;
let currentChartInstance = null;

function getYears(table = 'province') {
    if (!window.workbook) return [];
    if (table === 'province') {
        return [...new Set(window.workbook['省份']?.map(r => r['年份']))].sort();
    }
    return [...new Set(window.workbook['地级市']?.map(r => r['年份'] ?? r['时间']))].filter(v => v !== undefined && v !== null).sort();
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
    return Object.keys(sample).filter(k => {
        const key = String(k);
        if (key === '年份' || key === '时间' || key === '地区' || key === '时间地区') return false;
        return typeof sample[k] === 'number';
    });
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

    if (type === 'bubble') { renderBubbleControls(container); return; }
    if (type === 'butterfly') { renderButterflyControls(container); return; }

    if (type === 'scatter') {
        const currentTable = scatterTableMode || (dimType === 'city' ? 'city' : 'province');
        const years = getYears(currentTable);
        const metrics = getAllMetrics(currentTable);
        const regions = getAllRegions(currentTable);
        
        const defaultYear = years.includes(2023) ? 2023 : years[years.length - 1];
        const tableDiv = document.createElement('div');
        tableDiv.className = 'control-group';
        tableDiv.innerHTML = `
            <span>数据表：</span>
            <select id="scatter-table">
                <option value="province" ${currentTable === 'province' ? 'selected' : ''}>省份</option>
                <option value="city" ${currentTable === 'city' ? 'selected' : ''}>地级市</option>
            </select>`;
        container.appendChild(tableDiv);

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
        
        const defaultRegions = regions;
        const regionDiv = document.createElement('div');
        regionDiv.className = 'scatter-region-section scatter-region-control';
        regionDiv.innerHTML = `
            <div class="scatter-region-header">
                <span class="scatter-region-label">地区</span>
                <div class="scatter-region-actions">
                    <input id="scatter-region-search" class="scatter-search-input" type="text" placeholder="搜索地区">
                    <button type="button" class="scatter-tag-action" id="scatter-select-all">全选</button>
                    <button type="button" class="scatter-tag-action ghost" id="scatter-clear-all">清空所选地区</button>
                </div>
            </div>
            <div id="scatter-region-chips" class="scatter-region-chips"></div>
            <select id="scatter-regions" multiple hidden>
                ${regions.map(r => `<option value="${r}" ${defaultRegions.includes(r) ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
            <div id="scatter-selected-summary" class="scatter-selected-summary">已选择 ${defaultRegions.length} 个地区</div>
        `;
        const btn = document.createElement('button');
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> 生成图表';
        btn.className = 'analysis-run-btn';
        btn.onclick = () => loadChart(type);
        container.appendChild(btn);

        container.appendChild(regionDiv);

        
        setTimeout(() => {
            const tableEl = document.getElementById('scatter-table');
            const selectAll = document.getElementById('scatter-select-all');
            const clearAll = document.getElementById('scatter-clear-all');
            const selectEl = document.getElementById('scatter-regions');
            const searchEl = document.getElementById('scatter-region-search');
            const chipsEl = document.getElementById('scatter-region-chips');
            const summaryEl = document.getElementById('scatter-selected-summary');
            const syncHiddenSelect = (selected) => {
                if (!selectEl) return;
                selectEl.innerHTML = regions.map(r => `<option value="${r}" ${selected.has(r) ? 'selected' : ''}>${r}</option>`).join('');
                if (summaryEl) summaryEl.textContent = `已选择 ${selected.size} 个地区`;
            };
            const getSelected = () => new Set(Array.from(selectEl?.selectedOptions || []).map(opt => opt.value));
            const renderScatterRegionOptions = () => {
                if (!chipsEl || !selectEl) return;
                const keyword = String(searchEl?.value || '').trim().toLowerCase();
                const selected = getSelected();
                const filtered = keyword ? regions.filter(r => String(r).toLowerCase().includes(keyword)) : regions;
                chipsEl.innerHTML = filtered.map(r => `
                    <button type="button" class="region-chip ${selected.has(r) ? 'active' : ''}" data-region="${escapeHtml(r)}">${escapeHtml(r)}</button>
                `).join('');
                chipsEl.querySelectorAll('.region-chip').forEach(chip => {
                    chip.onclick = () => {
                        const next = getSelected();
                        const region = chip.dataset.region;
                        if (next.has(region)) next.delete(region);
                        else next.add(region);
                        syncHiddenSelect(next);
                        renderScatterRegionOptions();
                    };
                });
                syncHiddenSelect(selected);
                normalizeScatterControlText();
            };
            if (tableEl) tableEl.onchange = () => {
                scatterTableMode = tableEl.value;
                renderControls('scatter');
                setTimeout(() => loadChart('scatter'), 180);
            };
            if (searchEl) searchEl.oninput = renderScatterRegionOptions;
            if (selectAll) selectAll.onclick = () => { syncHiddenSelect(new Set(regions)); renderScatterRegionOptions(); };
            if (clearAll) clearAll.onclick = () => { syncHiddenSelect(new Set()); renderScatterRegionOptions(); };
            renderScatterRegionOptions();
            normalizeScatterControlText();
        }, 50);
    }
}

function normalizeScatterControlText() {
    const table = document.getElementById('scatter-table');
    if (table) {
        const labels = { province: '省份', city: '地级市' };
        Array.from(table.options || []).forEach(option => {
            option.textContent = labels[option.value] || option.textContent;
        });
    }
    const labelMap = [
        ['scatter-table', '数据表：'],
        ['scatter-year', '年份：'],
        ['scatter-x', 'X轴指标：'],
        ['scatter-y', 'Y轴指标：']
    ];
    labelMap.forEach(([id, label]) => {
        const el = document.getElementById(id);
        const groupLabel = el?.closest('.control-group')?.querySelector('span');
        if (groupLabel) groupLabel.textContent = label;
    });
    const regionLabel = document.querySelector('.scatter-region-label');
    if (regionLabel) regionLabel.textContent = '地区';
    const search = document.getElementById('scatter-region-search');
    if (search) search.placeholder = '搜索地区';
    const selectAll = document.getElementById('scatter-select-all');
    if (selectAll) selectAll.textContent = '全选';
    const clearAll = document.getElementById('scatter-clear-all');
    if (clearAll) clearAll.textContent = '清空所选地区';
    const run = document.querySelector('#analysis-controls .analysis-run-btn');
    if (run) run.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> 生成图表';
    const selected = document.getElementById('scatter-regions');
    const summary = document.getElementById('scatter-selected-summary');
    if (selected && summary) summary.textContent = `已选择 ${selected.selectedOptions.length} 个地区`;
}

function hasPotentialMissingValueProcessingFromText(text) {
    const matches = String(text || '').match(/(?:^|[：:\s])(-?\d+(?:\.\d+)?)(?=\s*$|\s|[，,。；;])/gm) || [];
    const counts = new Map();
    matches.forEach(raw => {
        const value = raw.replace(/[：:\s]/g, '');
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
    });
    return Array.from(counts.values()).some(count => count >= 8);
}

// ── 查看大图辅助 ──────────────────────────────────────
function _addViewFullBtn(chartDom, onClick) {
    const old = chartDom.querySelector('.view-full-btn');
    if (old) old.remove();
    const btn = document.createElement('button');
    btn.className = 'view-full-btn';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg> 查看大图`;
    btn.style.cssText = 'position:absolute;bottom:10px;right:10px;z-index:10;display:flex;align-items:center;gap:4px;font-size:.78rem;color:var(--c-muted);background:rgba(255,255,255,.88);backdrop-filter:blur(4px);border:1px solid var(--c-border);border-radius:6px;padding:4px 10px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.08);';
    btn.onclick = onClick;
    if (getComputedStyle(chartDom).position === 'static') chartDom.style.position = 'relative';
    chartDom.appendChild(btn);
}

function _openRawEchartsModal(option, title, height = 520) {
    _getOrCreateModal();
    const overlay = document.getElementById('chart-modal-overlay');
    const titleEl = document.getElementById('chart-modal-title');
    const metaEl  = document.getElementById('chart-modal-meta');
    const chartEl = document.getElementById('chart-modal-chart');
    overlay.classList.remove('closing');
    overlay.style.display = 'flex';
    if (titleEl) titleEl.textContent = title || '图表详情';
    if (metaEl)  metaEl.textContent  = '';
    _chartModalInstance = disposeChartInstance(_chartModalInstance);
    chartEl.innerHTML = '';
    chartEl.style.height = height + 'px';
    chartEl.style.width  = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
        _chartModalInstance = echarts.init(chartEl);
        _chartModalInstance.setOption(option, true);
    }, 30)));
}

// ── 气泡图控制器 ──────────────────────────────────────
function renderBubbleControls(container) {
    const table   = 'province';
    const years   = getYears(table);
    const metrics = getAllMetrics(table);
    const regions = getAllRegions(table);
    const defYear = years.includes(2023) ? 2023 : years[years.length - 1];
    // 默认全选所有省份
    const selectedBubble = new Set(regions);

    container.innerHTML = `
        <div class="control-group"><span>年份：</span>
            <select id="bubble-year">${years.map(y=>`<option value="${y}"${y===defYear?' selected':''}>${y}</option>`).join('')}</select>
        </div>
        <div class="control-group"><span>X轴：</span>
            <select id="bubble-x">${metrics.map((m,i)=>`<option value="${m}"${i===0?' selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div class="control-group"><span>Y轴：</span>
            <select id="bubble-y">${metrics.map((m,i)=>`<option value="${m}"${i===1?' selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div class="control-group"><span>气泡大小：</span>
            <select id="bubble-size">${metrics.map((m,i)=>`<option value="${m}"${i===2?' selected':''}>${m}</option>`).join('')}</select>
        </div>
        <button class="analysis-run-btn" onclick="loadChart('bubble')"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> 生成图表</button>
        <div class="scatter-region-section" style="flex:1 1 100%;margin-top:4px;">
            <div class="scatter-region-header" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span class="scatter-region-label">地区</span>
                <input id="bubble-region-search" class="scatter-search-input" type="text" placeholder="搜索省份">
                <button type="button" class="scatter-tag-action" id="bubble-select-all">全选</button>
                <button type="button" class="scatter-tag-action ghost" id="bubble-clear-all">清空所选地区</button>
            </div>
            <div class="scatter-region-chips" id="bubble-region-chips"></div>
            <select id="bubble-regions" multiple style="display:none"></select>
            <div class="scatter-selected-summary" id="bubble-region-summary"></div>
        </div>`;

    // 渲染芯片
    function syncBubbleHidden() {
        const sel = document.getElementById('bubble-regions');
        if (!sel) return;
        sel.innerHTML = [...selectedBubble].map(r=>`<option value="${r}" selected>${r}</option>`).join('');
        const sum = document.getElementById('bubble-region-summary');
        if (sum) sum.textContent = `已选 ${selectedBubble.size} / ${regions.length} 个地区`;
    }
    function renderBubbleChips() {
        const kw = (document.getElementById('bubble-region-search')?.value||'').trim().toLowerCase();
        const chips = document.getElementById('bubble-region-chips');
        if (!chips) return;
        chips.innerHTML = '';
        regions.filter(r => !kw || r.includes(kw)).forEach(r => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'region-chip' + (selectedBubble.has(r) ? ' active' : '');
            btn.textContent = r;
            btn.onclick = () => {
                selectedBubble.has(r) ? selectedBubble.delete(r) : selectedBubble.add(r);
                btn.classList.toggle('active', selectedBubble.has(r));
                syncBubbleHidden();
            };
            chips.appendChild(btn);
        });
        syncBubbleHidden();
    }
    renderBubbleChips();
    document.getElementById('bubble-region-search')?.addEventListener('input', renderBubbleChips);
    document.getElementById('bubble-select-all')?.addEventListener('click', () => { regions.forEach(r=>selectedBubble.add(r)); renderBubbleChips(); });
    document.getElementById('bubble-clear-all')?.addEventListener('click', () => { selectedBubble.clear(); renderBubbleChips(); });
}

// ── 蝴蝶图控制器 ──────────────────────────────────────
function renderButterflyControls(container) {
    const years   = getYears('province');
    const metrics = getAllMetrics('province');
    const regions = getAllRegions('province');
    const defYear = years.includes(2023) ? 2023 : years[years.length - 1];
    const defA = regions[0] || '广东省';
    const defB = regions[1] || '江苏省';

    // 与散点图完全相同结构：控件直接 append 到 container（grid 子项），卡片 grid-column:1/-1
    container.innerHTML = `
        <div class="control-group"><span>年份：</span>
            <select id="butterfly-year">${years.map(y=>`<option value="${y}"${y===defYear?' selected':''}>${y}</option>`).join('')}</select>
        </div>
        <div class="control-group"><span>省份A（左）：</span>
            <select id="butterfly-a">${regions.map(r=>`<option value="${r}"${r===defA?' selected':''}>${r}</option>`).join('')}</select>
        </div>
        <div class="control-group"><span>省份B（右）：</span>
            <select id="butterfly-b">${regions.map(r=>`<option value="${r}"${r===defB?' selected':''}>${r}</option>`).join('')}</select>
        </div>
        <button class="analysis-run-btn" onclick="loadChart('butterfly')"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> 生成图表</button>
        <div class="scatter-region-section scatter-region-control bf-metric-section">
            <div class="scatter-region-header">
                <span class="scatter-region-label">选择对比指标</span>
                <div class="scatter-region-actions">
                    <button type="button" class="scatter-tag-action" id="bf-select-all">全选</button>
                    <button type="button" class="scatter-tag-action ghost" id="bf-clear-all">清空</button>
                    <button type="button" class="scatter-tag-action ghost" id="bf-top10">差异前10</button>
                </div>
            </div>
            <div class="scatter-region-chips" id="butterfly-metric-chips"></div>
            <div class="scatter-selected-summary" id="bf-metric-summary"></div>
            <select id="butterfly-metrics" multiple style="display:none"></select>
        </div>`;

    const selectedBF = new Set(metrics.slice(0, 10));
    function syncBFHidden() {
        const sel = document.getElementById('butterfly-metrics');
        if (sel) sel.innerHTML = [...selectedBF].map(m=>`<option value="${m}" selected>${m}</option>`).join('');
    }
    function renderBFChips() {
        const chips = document.getElementById('butterfly-metric-chips');
        if (!chips) return;
        chips.innerHTML = '';
        metrics.forEach(m => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'region-chip' + (selectedBF.has(m) ? ' active' : '');
            btn.textContent = m;
            btn.title = m;
            btn.onclick = () => {
                selectedBF.has(m) ? selectedBF.delete(m) : selectedBF.add(m);
                btn.classList.toggle('active', selectedBF.has(m));
                syncBFHidden();
                const summary = document.getElementById('bf-metric-summary');
                if (summary) summary.textContent = `已选择 ${selectedBF.size} 个指标`;
            };
            chips.appendChild(btn);
        });
        syncBFHidden();
        const summary = document.getElementById('bf-metric-summary');
        if (summary) summary.textContent = `已选择 ${selectedBF.size} 个指标`;
    }
    renderBFChips();
    document.getElementById('bf-select-all')?.addEventListener('click', () => { metrics.forEach(m=>selectedBF.add(m)); renderBFChips(); });
    document.getElementById('bf-clear-all')?.addEventListener('click', () => { selectedBF.clear(); renderBFChips(); });
    document.getElementById('bf-top10')?.addEventListener('click', () => {
        // 根据当前选择的两省和年份计算差异最大的10个指标
        const year = parseInt(document.getElementById('butterfly-year')?.value)||defYear;
        const regA = document.getElementById('butterfly-a')?.value||defA;
        const regB = document.getElementById('butterfly-b')?.value||defB;
        const rowA = (window.workbook?.['省份']||[]).find(r=>r['年份']===year&&r['地区']===regA);
        const rowB = (window.workbook?.['省份']||[]).find(r=>r['年份']===year&&r['地区']===regB);
        if (rowA && rowB) {
            const ranked = metrics.map(m => {
                const a=rowA[m],b=rowB[m];
                if (a==null||b==null||isNaN(a)||isNaN(b)) return {m,diff:0};
                const mx=Math.max(Math.abs(a),Math.abs(b),1e-9);
                return {m,diff:Math.abs(a/mx-b/mx)};
            }).sort((x,y)=>y.diff-x.diff);
            selectedBF.clear();
            ranked.slice(0,10).forEach(({m})=>selectedBF.add(m));
        } else {
            selectedBF.clear(); metrics.slice(0,10).forEach(m=>selectedBF.add(m));
        }
        renderBFChips();
    });
}

async function loadChart(type) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    currentChartInstance = disposeChartInstance(currentChartInstance);

    // ── 气泡图 ────────────────────────────────────────
    if (type === 'bubble') {
        const year    = parseInt(document.getElementById('bubble-year')?.value) || 2023;
        const xMetric = document.getElementById('bubble-x')?.value;
        const yMetric = document.getElementById('bubble-y')?.value;
        const sMetric = document.getElementById('bubble-size')?.value;
        const selRegs = Array.from(document.getElementById('bubble-regions')?.selectedOptions || []).map(o => o.value);
        if (!xMetric || !yMetric || !sMetric) { showToast('请选择三个指标', 'warn'); return; }
        if (!selRegs.length) { showToast('请至少选择一个地区', 'warn'); return; }
        const rows = (window.workbook?.['省份'] || []).filter(r => r['年份'] === year && selRegs.includes(r['地区']));
        const points = rows.map(r => ({
            name: r['地区'], x: r[xMetric], y: r[yMetric], s: r[sMetric]
        })).filter(p => p.x != null && p.y != null && p.s != null);
        if (!points.length) { showToast('所选条件无数据', 'warn'); return; }
        const sVals = points.map(p => p.s);
        const sMin = Math.min(...sVals), sMax = Math.max(...sVals);
        chartDom.style.height = '500px';
        currentChartInstance = initEChartSafe(chartDom);
        const bubbleOption = {
            backgroundColor: 'transparent',
            title: { text: `${year}年  ${xMetric} · ${yMetric} · ${sMetric}`, left: 'center', textStyle: { color: '#1f2b48', fontSize: 13 } },
            tooltip: { formatter: p => `<b>${p.data[3]}</b><br/>${xMetric}: ${(+p.data[0])?.toFixed(4)}<br/>${yMetric}: ${(+p.data[1])?.toFixed(4)}<br/>${sMetric}: ${(+p.data[2])?.toFixed(4)}` },
            xAxis: { name: xMetric, nameLocation: 'middle', nameGap: 30, axisLabel: { color: '#263b59' }, splitLine: { lineStyle: { color: '#d8e1ec', type:'dashed' } } },
            yAxis: { name: yMetric, nameLocation: 'middle', nameGap: 44, axisLabel: { color: '#263b59' }, splitLine: { lineStyle: { color: '#d8e1ec', type:'dashed' } } },
            series: [{
                type: 'scatter',
                data: points.map(p => [p.x, p.y, p.s, p.name]),
                symbolSize: val => { const r = sMax===sMin ? 0.5 : (val[2]-sMin)/(sMax-sMin); return 14 + r*50; },
                itemStyle: { color: p => COLORS[p.dataIndex % COLORS.length], opacity: 0.82 },
                label: { show: true, formatter: p => p.data[3], position: 'top', fontSize: 11, color: '#263b59' }
            }]
        };
        currentChartInstance.setOption(bubbleOption, true);
        ensureScatterInteractionHint('bubble');
        _addViewFullBtn(chartDom, () => _openRawEchartsModal(bubbleOption, `${year}年`));
        setTimeout(() => { try { currentChartInstance.resize(); } catch(e) {} }, 100);
        return;
    }

    // ── 蝴蝶图 ────────────────────────────────────────
    if (type === 'butterfly') {
        const year  = parseInt(document.getElementById('butterfly-year')?.value) || 2023;
        const regA  = document.getElementById('butterfly-a')?.value;
        const regB  = document.getElementById('butterfly-b')?.value;
        const selMetrics = Array.from(document.getElementById('butterfly-metrics')?.selectedOptions || []).map(o => o.value);
        const rowA  = (window.workbook?.['省份'] || []).find(r => r['年份'] === year && r['地区'] === regA);
        const rowB  = (window.workbook?.['省份'] || []).find(r => r['年份'] === year && r['地区'] === regB);
        if (!rowA || !rowB) { showToast('未找到所选省份数据', 'warn'); return; }
        if (!selMetrics.length) { showToast('请至少选择一个指标', 'warn'); return; }
        const pairs = selMetrics.map(m => {
            const a = rowA[m], b = rowB[m];
            if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
            const mx = Math.max(Math.abs(a), Math.abs(b), 1e-9);
            return { m, a: a/mx, b: b/mx, rawA: a, rawB: b };
        }).filter(Boolean);
        if (!pairs.length) { showToast('所选指标无有效数据', 'warn'); return; }
        const labels = pairs.map(p => p.m);
        const showLabels = pairs.length <= 12; // 超过12个指标时隐藏数值标签，避免重叠
        const _bfMob = window.innerWidth <= 680;
        // 动态高度：每行移动端 28px、桌面 36px，最少 400px
        const fitHeight = fitAnalysisPanelToViewport();
        const chartH = Math.max(fitHeight, pairs.length * (_bfMob ? 28 : 36) + 120);
        chartDom.style.height = chartH + 'px';
        currentChartInstance = initEChartSafe(chartDom);
        const bfOption = {
            backgroundColor: 'transparent',
            title: { text: `${year}年  ${regA} vs ${regB}  指标对比`, left: 'center', textStyle: { color: '#1f2b48', fontSize: _bfMob ? 11 : 13 } },
            tooltip: {
                trigger: 'axis', axisPointer: { type: 'shadow' },
                formatter: params => {
                    const i = params[0]?.dataIndex, p = pairs[i];
                    return p ? `<b>${p.m}</b><br/>${regA}: ${p.rawA?.toFixed(4)}<br/>${regB}: ${p.rawB?.toFixed(4)}` : '';
                }
            },
            legend: { data: [regA, regB], top: 28, textStyle: { color: '#263b59', fontSize: _bfMob ? 10 : 12 } },
            grid: { left: _bfMob ? 4 : 20, right: _bfMob ? 4 : 20, top: 62, bottom: 16, containLabel: true },
            xAxis: {
                type: 'value',
                axisLabel: { formatter: v => Math.abs(v).toFixed(2), color: '#263b59', fontSize: _bfMob ? 9 : 11 },
                splitLine: { lineStyle: { color: '#d8e1ec', type:'dashed' } }
            },
            yAxis: { type: 'category', data: labels, axisLabel: {
                color: '#263b59',
                fontSize: _bfMob ? 9 : 11,
                overflow: 'truncate',
                width: _bfMob ? 72 : 140,
                hideOverlap: false
            } },
            series: [
                {
                    name: regA, type: 'bar', stack: 'total',
                    data: pairs.map(p => -Math.abs(p.a)),
                    itemStyle: { color: COLORS[0], opacity: 0.85 },
                    label: { show: showLabels, position: 'insideLeft', formatter: p => pairs[p.dataIndex]?.rawA?.toFixed(3), color: '#fff', fontSize: 10 }
                },
                {
                    name: regB, type: 'bar', stack: 'total',
                    data: pairs.map(p => Math.abs(p.b)),
                    itemStyle: { color: COLORS[2], opacity: 0.85 },
                    label: { show: showLabels, position: 'insideRight', formatter: p => pairs[p.dataIndex]?.rawB?.toFixed(3), color: '#fff', fontSize: 10 }
                }
            ]
        };
        currentChartInstance.setOption(bfOption, true);
        ensureScatterInteractionHint('butterfly');
        _addViewFullBtn(chartDom, () => _openRawEchartsModal(bfOption, `${year}年 ${regA} vs ${regB}`, Math.max(600, chartH)));
        setTimeout(() => currentChartInstance.resize({ height: chartH }), 100);
        return;
    }

    if (type === 'scatter') {
        const table = document.getElementById('scatter-table')?.value || 'province';
        const year = parseInt(document.getElementById('scatter-year')?.value) || 2023;
        const xMetric = document.getElementById('scatter-x')?.value;
        const yMetric = document.getElementById('scatter-y')?.value;
        const regions = Array.from(document.getElementById('scatter-regions')?.selectedOptions || []).map(o => o.value);
        
        if (!xMetric || !yMetric) { showToast('请选择 X 和 Y 轴指标', 'warn'); return; }
        if (!regions.length) { showToast('请至少选择一个地区', 'warn'); return; }
        
        try {
            const res = await fetch(API_BASE + '/api/scatter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table, year, xMetric, yMetric, regions })
            });
            const rawText = await res.text();
            let data;
            try { data = JSON.parse(rawText); } catch {
                // 服务器返回了 HTML（如 CORS 错误或 Nginx 错误页），直接显示原始内容便于排查
                const preview = rawText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
                chartDom.innerHTML = `<div class="chart-empty-state"><strong>服务器错误 ${res.status}</strong><span style="font-size:11px;word-break:break-all">${escapeHtml(preview)}</span></div>`;
                console.error('[scatter] 服务器返回非 JSON:', rawText.slice(0, 500));
                return;
            }
            if (!res.ok || !Array.isArray(data.data) || !data.data.length) {
                const message = data?.error || '当前筛选条件下没有可绘制的散点数据';
                chartDom.innerHTML = `<div class="chart-empty-state"><strong>无法生成散点图</strong><span>${escapeHtml(message)}</span></div>`;
                window._lastScatterOption = null;
                showToast(message, 'warn');
                return;
            }
            
            const isCityScatter = table === 'city';

            // 计算每个点的局部密度（归一化坐标下半径内的邻居数）
            const pts = data.data;
            const xs = pts.map(d => +d[0]), ys = pts.map(d => +d[1]);
            const xSpan = (Math.max(...xs) - Math.min(...xs)) || 1;
            const ySpan = (Math.max(...ys) - Math.min(...ys)) || 1;
            const densityR = 0.18; // 归一化半径
            const densities = pts.map((p, i) => {
                let cnt = 0;
                pts.forEach((q, j) => {
                    if (i !== j) {
                        const dx = (p[0] - q[0]) / xSpan;
                        const dy = (p[1] - q[1]) / ySpan;
                        if (dx*dx + dy*dy < densityR*densityR) cnt++;
                    }
                });
                return cnt;
            });
            const maxDensity = Math.max(...densities, 1);
            // 密度映射：低 → 浅蓝，高 → 深蓝
            const densityColor = idx => {
                const t = densities[idx] / maxDensity; // 0~1
                const r = Math.round(191 - t * 152); // 191→39
                const g = Math.round(219 - t * 156); // 219→63
                const b = Math.round(254 - t *  54); // 254→200
                return `rgb(${r},${g},${b})`;
            };
            const scatterText = {
                title: '#10213f',
                axis: '#17233d',
                axisName: '#0f1f3a',
                axisLine: '#60789d',
                splitLine: '#c7d4e5',
                label: '#0f1f3a',
                labelBorder: 'rgba(255,255,255,.96)',
                tooltip: '#10213f'
            };
            
            const option = {
                backgroundColor: 'transparent',
                title: { 
                    text: `${table === 'city' ? '地级市' : '省份'} ${xMetric} vs ${yMetric} (${year}年)`, 
                    left: 'center',
                    top: 8,
                    textStyle: { color: scatterText.title, fontSize: 15, fontWeight: 900 }
                },
                tooltip: {
                    trigger: 'item',
                    confine: true,
                    backgroundColor: 'rgba(255,255,255,.96)',
                    borderColor: '#d8e4f2',
                    textStyle: { color: scatterText.tooltip, fontSize: 12, fontWeight: 700 },
                    formatter: p => {
                        const item = p.data || [];
                        return `<strong>${escapeHtml(item[2] || '')}</strong><br>${escapeHtml(data.xName || xMetric)}：${item[0]}<br>${escapeHtml(data.yName || yMetric)}：${item[1]}`;
                    }
                },
                grid: {
                    left: 92,
                    right: 76,
                    top: 74,
                    bottom: 70,
                    containLabel: false
                },
                dataZoom: isCityScatter ? [
                    { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
                    { type: 'inside', yAxisIndex: 0, filterMode: 'none' }
                ] : [],
                xAxis: { 
                    name: data.xName, 
                    nameLocation: 'middle', 
                    nameGap: 44,
                    nameTextStyle: { color: scatterText.axisName, fontSize: 12, fontWeight: 800 },
                    axisLine: { lineStyle: { color: scatterText.axisLine, width: 1.5 } },
                    axisTick: { lineStyle: { color: scatterText.axisLine } },
                    axisLabel: { color: scatterText.axis, fontSize: 11, fontWeight: 700 },
                    splitLine: { lineStyle: { color: scatterText.splitLine, type: 'dashed' } }
                },
                yAxis: { 
                    name: data.yName, 
                    nameLocation: 'middle', 
                    nameGap: 52,
                    nameTextStyle: { color: scatterText.axisName, fontSize: 12, fontWeight: 800 },
                    axisLine: { lineStyle: { color: scatterText.axisLine, width: 1.5 } },
                    axisTick: { lineStyle: { color: scatterText.axisLine } },
                    axisLabel: { color: scatterText.axis, fontSize: 11, fontWeight: 700 },
                    splitLine: { lineStyle: { color: scatterText.splitLine, type: 'dashed' } }
                },
                series: [{
                    type: 'scatter',
                    data: data.data,
                    symbolSize: isCityScatter ? 8 : 12,
                    label: { 
                        show: !isCityScatter, 
                        formatter: p => p.data[2], 
                        position: 'top', 
                        offset: [0, -8], 
                        fontSize: 10,
                        fontWeight: 800,
                        color: scatterText.label,
                        textBorderColor: scatterText.labelBorder,
                        textBorderWidth: 3
                    },
                    emphasis: {
                        focus: 'self',
                        label: {
                            show: true,
                            formatter: p => p.data[2],
                            position: 'top',
                            offset: [0, -8],
                            fontSize: 11,
                            fontWeight: 900,
                            color: scatterText.label,
                            backgroundColor: 'rgba(255,255,255,.9)',
                            borderColor: '#d8e4f2',
                            borderWidth: 1,
                            borderRadius: 6,
                            padding: [3, 6],
                            textBorderColor: scatterText.labelBorder,
                            textBorderWidth: 2
                        },
                        itemStyle: {
                            shadowBlur: 14,
                            shadowColor: 'rgba(99,102,241,.45)'
                        }
                    },
                    itemStyle: {
                        color: p => densityColor(p.dataIndex),
                        opacity: 0.85,
                        borderColor: 'rgba(255,255,255,0.6)',
                        borderWidth: 1
                    }
                }]
            };

            option.tooltip.formatter = p => {
                const item = p.data || [];
                return `<strong>${escapeHtml(item[2] || '')}</strong><br>${escapeHtml(data.xName || xMetric)}：${escapeHtml(item[0] ?? '')}<br>${escapeHtml(data.yName || yMetric)}：${escapeHtml(item[1] ?? '')}`;
            };
            option.title.text = `${table === 'city' ? '地级市' : '省份'} ${xMetric} vs ${yMetric} (${year}年)`;
            const fitHeight = fitAnalysisPanelToViewport();
            currentChartInstance = initEChartSafe(chartDom);
            currentChartInstance.setOption(option);
            window._lastScatterOption = option;
            ensureScatterInteractionHint(table === 'city' ? 'city' : 'province');
            _addViewFullBtn(chartDom, () => _openRawEchartsModal(option, option.title?.text || ''));
            setTimeout(() => currentChartInstance.resize({ height: fitHeight }), 100);
        } catch (e) {
            console.error('散点图加载失败:', e);
        }
    }
}

function ensureScatterInteractionHint(type) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    const old = document.getElementById('scatter-interaction-hint');
    if (old) old.remove();
    const textMap = {
        city:      '地级市点位较密：滚轮缩放、拖动平移，悬停查看城市名称，点击右下角”查看大图”进入沉浸式查看',
        province:  '悬停点位查看数据，点击右下角”查看大图”进入沉浸式查看',
        bubble:    '悬停气泡查看三维数据，气泡大小代表第三指标，点击右下角”查看大图”进入沉浸式查看',
        butterfly: '左右长度代表各省数值大小，悬停查看具体数值，点击右下角”查看大图”进入沉浸式查看',
    };
    const hint = document.createElement('div');
    hint.id = 'scatter-interaction-hint';
    hint.className = 'scatter-interaction-hint';
    hint.textContent = textMap[type] ?? textMap.province;
    chartDom.insertAdjacentElement('afterend', hint);
}

function fitAnalysisPanelToViewport() {
    const section = document.getElementById('section-scatter');
    const panel = document.getElementById('analysis-panel');
    const chartDom = document.getElementById('analysis-chart');
    if (!section || !panel || !chartDom) return 520;

    // scatter-fit-mode 已在 openAnalysisPanel 开始时加上，此处无需重复添加
    // 动画进行中时不解除 max-height，避免数据明细表闪现
    if (!panel._animating) {
        panel.style.maxHeight = 'none';
        panel.style.overflow = 'visible';
    }

    const viewportH = window.innerHeight || document.documentElement.clientHeight || 760;
    const chartH = Math.max(360, Math.min(470, Math.floor(viewportH * 0.42)));

    section.style.setProperty('--scatter-chart-h', `${chartH}px`);
    chartDom.style.height = `${chartH}px`;
    chartDom.style.minHeight = `${chartH}px`;

    if (!window._scatterFitResizeBound) {
        window._scatterFitResizeBound = true;
        window.addEventListener('resize', debounce(() => {
            resizeActiveAnalysisChart();
        }, 120));
        window.addEventListener('orientationchange', () => setTimeout(resizeActiveAnalysisChart, 180));
        document.addEventListener('fullscreenchange', () => setTimeout(resizeActiveAnalysisChart, 180));
        window.visualViewport?.addEventListener('resize', debounce(resizeActiveAnalysisChart, 120));
    }

    return chartH;
}

function updateAnalysisPanelUI(type, isOpen) {
    document.querySelectorAll('.analysis-card-entry').forEach(card => {
        const active = isOpen && card.dataset.chart === type;
        card.classList.toggle('active', active);
        const btn = card.querySelector('.analysis-toggle-btn');
        if (btn) {
            btn.setAttribute('aria-expanded', active ? 'true' : 'false');
            const label = btn.querySelector('span') || btn;
            label.textContent = active ? '收起分析' : '展开分析';
        }
    });
}

function closeAnalysisPanel() {
    const panel = document.getElementById('analysis-panel');
    if (!panel) return;
    panel._animating = false;
    panel.style.overflow = 'hidden';

    // 展开后 maxHeight 是 'none'，CSS 无法从 none→0 过渡（会瞬间跳变）
    // 必须先把 maxHeight 设回当前实际像素高度，强制 reflow，再动画到 0
    panel.style.transition = 'none';
    panel.style.maxHeight = panel.scrollHeight + 'px';
    panel.offsetHeight; // 触发 reflow，让浏览器确认此高度为起点

    panel.style.transition = 'max-height 0.3s cubic-bezier(0.4,0,0.2,1), margin-bottom 0.3s cubic-bezier(0.4,0,0.2,1)';
    panel.style.maxHeight = '0';
    panel.style.marginBottom = '0';
    panel.classList.remove('open');
    const section = document.getElementById('section-scatter');
    setTimeout(() => {
        if (!panel.classList.contains('open')) {
            panel.style.display = 'none';
            // scatter-fit-mode 在动画结束后再移除，避免收起途中按钮突然变大
            section?.classList.remove('scatter-fit-mode');
        }
    }, 320);
    updateAnalysisPanelUI(activeChart, false);
    section?.classList.remove('type-scatter', 'type-bubble', 'type-butterfly');
    document.getElementById('scatter-interaction-hint')?.remove();
    activeChart = null;
    currentChartInstance = disposeChartInstance(currentChartInstance);
}

function openAnalysisPanel(type) {
    const panel = document.getElementById('analysis-panel');
    if (!panel) return;
    
    // Toggle: if same chart already open, close it
    if (activeChart === type && panel.style.display !== 'none') {
        closeAnalysisPanel();
        return;
    }
    
    activeChart = type;
    // 切换类型时清除上次残留的散点图提示
    if (type !== 'scatter') document.getElementById('scatter-interaction-hint')?.remove();
    // 标记当前图表类型（CSS 用此区分 scatter 与其他类型的控件布局）
    const section = document.getElementById('section-scatter');
    if (section) {
        section.classList.toggle('type-scatter',   type === 'scatter');
        section.classList.toggle('type-bubble',    type === 'bubble');
        section.classList.toggle('type-butterfly', type === 'butterfly');
        // scatter-fit-mode 在渲染控件 BEFORE，确保控件以紧凑尺寸渲染，不在动画中途突然缩小
        section.classList.add('scatter-fit-mode');
    }
    const titleMap = {
        scatter:   '双指标关联分析',
        bubble:    '三维联合分析',
        butterfly: '双省指标对比'
    };
    const titleEl = document.getElementById('analysis-panel-title');
    if (titleEl) titleEl.innerText = titleMap[type] || type;

    // Highlight active card & render controls（已处于 scatter-fit-mode，尺寸稳定）
    updateAnalysisPanelUI(type, true);
    renderControls(type);

    // Animate open — overflow:hidden 防止内容在动画期间穿透到下方 section-table
    panel._animating = true;
    panel.style.display = 'block';
    panel.style.overflow = 'hidden';
    panel.style.maxHeight = '0';
    panel.style.marginBottom = '0';
    // margin-bottom 与 max-height 同步过渡，彻底消除下方数据明细表跳动
    panel.style.transition = 'max-height 0.38s cubic-bezier(0.4,0,0.2,1), margin-bottom 0.38s cubic-bezier(0.4,0,0.2,1)';
    requestAnimationFrame(() => {
        panel.classList.add('open');
        // 控件已渲染，scrollHeight 包含控件高度；再加图表占位高度
        const chartPlaceholder = 500;
        const estimatedH = panel.scrollHeight + chartPlaceholder + 60;
        panel.style.maxHeight = Math.max(estimatedH, 1100) + 'px';
        panel.style.marginBottom = '18px';  // 随 max-height 一起平滑出现
    });

    // 图表在动画期间后台加载，不干预 max-height（_animating 标志保护）
    setTimeout(async () => {
        await loadChart(type);
        bindExportEvents();
    }, 150);

    // 动画结束（380ms）后再统一解除 max-height，彻底消除数据明细表闪现
    setTimeout(() => {
        if (!panel.classList.contains('open')) return;
        panel._animating = false;
        panel.style.transition = 'none';
        panel.style.maxHeight = 'none';
        panel.style.overflow = 'visible';
        resizeActiveAnalysisChart();
    }, 420);
}

function exportAnalysisChart(format) {
    if (!window.echarts) {
        alert("图表库未加载，暂时无法导出图表。");
        return;
    }
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    const chart = echarts.getInstanceByDom(chartDom);
    if (!chart) {
        // Try to re-render instead of alert
        console.warn('散点图未加载，请先展开分析面板');
        return;
    }
    const bg = '#ffffff';
    if (format === 'svg') {
        const svgStr = getChartSVGString(chart);
        if (!svgStr) {
            showToast('SVG 导出失败：请先生成图表后重试', 'error');
            return;
        }
        const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `scatter_${activeChart}_${Date.now()}.svg`;
        link.href = blobUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        return;
    }
}

function bindExportEvents() {
    // export buttons removed
}

function initAnalysisCards() {
    const cards = document.querySelectorAll('.analysis-card-entry');
    cards.forEach(card => {
        if (card._clickHandler) card.removeEventListener('click', card._clickHandler);
        const handler = () => openAnalysisPanel(card.dataset.chart);
        card.addEventListener('click', handler);
        card._clickHandler = handler;
    });
    document.querySelectorAll('.analysis-toggle-btn').forEach(btn => {
        // 每次都先移除旧 handler 再重新绑，与卡片的处理方式保持一致
        if (btn._toggleHandler) btn.removeEventListener('click', btn._toggleHandler);
        btn._toggleHandler = (event) => {
            event.stopPropagation();
            openAnalysisPanel(btn.dataset.chart);
        };
        btn.addEventListener('click', btn._toggleHandler);
    });
    
}

function waitForWorkbook() {
    if (window.workbook && window.workbook['省份'] && window.workbook['省份'].length) {
        initAnalysisCards();
        ensureDashboardAnalysisVisible();
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
    if (bindEvents._bound) return;
    bindEvents._bound = true;

    // 鼠标进入主图表卡片时暂停主轮播，离开后恢复（手动暂停时不覆盖）
    const mainCard = document.getElementById("section-chart");
    if (mainCard) {
        const pauseMainCarousel = () => {
            isMouseOverMainChart = true;
            if (!mainCarouselManualPaused) isCarouselPaused = true;
        };
        const resumeMainCarousel = () => {
            isMouseOverMainChart = false;
            if (!mainCarouselManualPaused) {
                isCarouselPaused = false;
                // hover 期间 inactivity timer 可能没有重启 carousel，mouseleave 时补上
                if (!carouselTimer) startCarousel();
            }
        };
        mainCard.addEventListener("mouseenter", pauseMainCarousel);
        mainCard.addEventListener("mouseleave", resumeMainCarousel);
        mainCard.addEventListener("touchstart", pauseMainCarousel, { passive: true });
        mainCard.addEventListener("touchend", () => setTimeout(resumeMainCarousel, 1200), { passive: true });
    }

    // 鼠标进入分析卡片区域时暂停所有轮播，离开后恢复并补启 timer（手动暂停时不覆盖）
    const avCard = document.getElementById("section-analysis-view");
    if (avCard) {
        const pauseAnalysisCarousel = () => {
            isMouseOverAnalysis = true;
            if (!pieManualPaused) piePaused = true;
            if (!advManualPaused) advPaused = true;
        };
        const resumeAnalysisCarousel = () => {
            isMouseOverAnalysis = false;
            if (!pieManualPaused) {
                piePaused = false;
                // timer 可能在 hover 期间被 stop，mouseleave 时补重启
                if (!pieCarouselTimer) startPieCarousel();
            }
            if (!advManualPaused) {
                advPaused = false;
                if (!advCarouselTimer) startAdvCarousel();
            }
        };
        avCard.addEventListener("mouseenter", pauseAnalysisCarousel);
        avCard.addEventListener("mouseleave", resumeAnalysisCarousel);
        avCard.addEventListener("touchstart", pauseAnalysisCarousel, { passive: true });
        avCard.addEventListener("touchend", () => setTimeout(resumeAnalysisCarousel, 1200), { passive: true });
    }

    // 暂停按钮事件绑定
    document.getElementById("main-pause-carousel")?.addEventListener("click", toggleMainCarousel);
    document.getElementById("pie-pause-carousel")?.addEventListener("click", togglePieCarousel);

    document.getElementById("chart-type")?.addEventListener("change", () => renderMainChart());
    
    
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
            const dataTable = document.getElementById("data-table");
            if (dataTable) dataTable.style.setProperty('--table-scale', scale);
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

function renderAgentChartInsideBubble(bubble, config) {
    if (!bubble || !config?.metric) return null;
    let wrap = bubble.querySelector('.agent-inline-chart-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'agent-inline-chart-wrap';
        wrap.innerHTML = '<div class="agent-inline-chart"></div>';
        const actions = bubble.querySelector('.agent-ui-actions');
        bubble.insertBefore(wrap, actions || null);
    }
    const chartEl = wrap.querySelector('.agent-inline-chart');
    // 已有有效实例时只 resize，不重新 init（避免尺寸每次偏移累积）
    if (chartEl.id && window.echarts) {
        const existing = echarts.getInstanceByDom(chartEl);
        if (existing && !existing.isDisposed()) {
            try { existing.resize(); } catch(e) {}
            return chartEl.id;
        }
    }
    const chartId = 'agent_inline_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    chartEl.id = chartId;
    requestAnimationFrame(() => _doRenderInlineChart(chartId, config, false));
    return chartId;
}

function exportNearestAgentChart(bubble, config, question) {
    let chartEl = bubble?.querySelector('.agent-inline-chart');
    if (!window.echarts) {
        showToast('图表库尚未加载，暂时无法导出', 'warn');
        return;
    }
    if (!chartEl || !echarts.getInstanceByDom(chartEl)) {
        renderAgentChartInsideBubble(bubble, config);
    }
    setTimeout(() => {
        chartEl = bubble?.querySelector('.agent-inline-chart');
        const chart = chartEl && echarts.getInstanceByDom(chartEl);
        if (!chart) {
            showToast('图表尚未生成，请先展开图表', 'warn');
            return;
        }
        const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
        const link = document.createElement('a');
        link.href = url;
        link.download = `${extractQuestionSubject(question)}_图表.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }, 260);
}

function exportAnswerAsCsv(data, question) {
    const lines = String(data?.answer || '').split('\n').map(line => line.trim()).filter(Boolean);
    const csv = '\ufeff内容\n' + lines.map(line => `"${line.replace(/"/g, '""')}"`).join('\n');
    agentDownload(`${extractQuestionSubject(question)}_数据.csv`, 'text/csv;charset=utf-8', csv);
}

document.addEventListener('click', function(e) {
    const btn = e.target.closest('.agent-action-btn[data-agent-action]');
    if (!btn) return;
    const box = btn.closest('.agent-ui-actions');
    const bubble = btn.closest('.rag-bubble');
    const data = box?._agentData || {};
    const question = box?._agentQuestion || '';
    const action = btn.dataset.agentAction;
    if (action === 'inline-chart') renderAgentChartInsideBubble(bubble, data.chart);
    if (action === 'export-inline-chart') exportNearestAgentChart(bubble, data.chart, question);
    if (action === 'export-chat-table') exportAnswerAsCsv(data, question);
    if (action === 'report-html') agentGenerateReport(data, question);
    if (action === 'open-data-table') toggleInlineDataTable(bubble, data.chart);
});

/* ── AI 追问建议按钮 ─────────────────────────────────────── */
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.rag-suggestion[data-question]');
    if (!btn) return;
    sendRagQuick(btn.dataset.question);
});

/* ── 内联数据明细表 ─────────────────────────────────────── */
function buildTableRows(config) {
    if (!window.workbook || !config?.metric) return { headers: [], rows: [] };

    const metric   = config.metric;
    const regions  = config.regions || [];
    const years    = config.years   || [];
    const NATIONAL = ['全国', '全国平均', '全国总计', '全国合计'];
    const useNat   = !regions.length || regions.every(r => NATIONAL.includes(r));
    // 判断是否为地级市数据：取第一个非全国地区，看它在哪张表里有记录
    const cityRows     = window.workbook['地级市'] || [];
    const provinceRows = window.workbook['省份']   || [];
    const firstRegion  = regions.find(r => !NATIONAL.includes(r));
    const useCity = !useNat && firstRegion &&
        cityRows.some(r => r['地区'] === firstRegion) &&
        !provinceRows.some(r => r['地区'] === firstRegion);
    const srcRows  = useNat
        ? (window.workbook['全国'] || [])
        : (useCity ? cityRows : provinceRows);

    // 模糊匹配字段名
    const cleanT = metric.replace(/[（(].*?[）)]/g, '').trim();
    const realKey = Object.keys(srcRows[0] || {}).find(k => {
        const c = k.replace(/[（(].*?[）)]/g, '').trim();
        return k === metric || c === cleanT || k.includes(cleanT) || cleanT.includes(c);
    }) || metric;

    const allYears = years.length ? years
        : [...new Set(srcRows.map(r => r['年份']))].sort();

    // 排名图（bar）：横向，列=地区
    if (config.type === 'bar' && allYears.length === 1) {
        const year = allYears[0];
        const targetRegions = regions.length ? regions
            : [...new Set(srcRows.map(r => r['地区']))];
        const rows = targetRegions.map((reg, i) => {
            const row = srcRows.find(r => r['地区'] === reg && r['年份'] === year);
            const val = row ? row[realKey] : null;
            return [i + 1, reg, val == null ? '—' : val];
        }).filter(r => r[2] !== '—');
        return { headers: ['排名', '地区', metric], rows };
    }

    // 趋势图（line）或全国：纵向，行=年份，列=地区
    const targetRegions = useNat ? ['全国']
        : (regions.length ? regions : [...new Set(srcRows.map(r => r['地区']))].slice(0, 6));

    const headers = ['年份', ...targetRegions];
    const rows = allYears.map(yr => {
        const cells = [yr];
        targetRegions.forEach(reg => {
            const r = useNat
                ? srcRows.find(row => row['年份'] === yr)
                : srcRows.find(row => row['地区'] === reg && row['年份'] === yr);
            const v = r ? r[realKey] : null;
            cells.push(v == null ? '—' : v);
        });
        return cells;
    });
    return { headers, rows };
}

function toggleInlineDataTable(bubble, config) {
    if (!bubble || !config?.metric) return;
    let wrap = bubble.querySelector('.inline-data-table-wrap');
    if (wrap) { wrap.remove(); return; }   // 二次点击收起

    const { headers, rows } = buildTableRows(config);
    if (!rows.length) { showToast('当前查询无可展示的明细数据', 'warn'); return; }

    const thHtml  = headers.map(h => `<th>${escapeHtml(String(h))}</th>`).join('');
    const trHtml  = rows.map(r =>
        `<tr>${r.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`
    ).join('');

    wrap = document.createElement('div');
    wrap.className = 'inline-data-table-wrap';
    wrap.innerHTML = `
        <div class="idt-header">
            <span class="idt-title">📋 数据明细 · ${escapeHtml(config.metric)}</span>
            <button class="idt-dl-btn" data-idt-dl>⬇ 下载 Excel</button>
        </div>
        <div class="idt-scroll">
            <table class="idt-table">
                <thead><tr>${thHtml}</tr></thead>
                <tbody>${trHtml}</tbody>
            </table>
        </div>`;

    wrap._idtConfig = config;
    wrap._idtHeaders = headers;
    wrap._idtRows = rows;

    const actions = bubble.querySelector('.agent-ui-actions');
    bubble.insertBefore(wrap, actions || null);

    // 下载 Excel（用 XLSX 库）
    wrap.querySelector('[data-idt-dl]').addEventListener('click', () => {
        if (!window.XLSX) { showToast('Excel 库未加载', 'warn'); return; }
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, config.metric.slice(0, 31));
        XLSX.writeFile(wb, `${config.metric}_明细_${Date.now()}.xlsx`);
    });
}

// Final closeout overrides: DOCX export and fullscreen scatter inspection.
function agentDownloadBlob(filename, blob) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function agentXmlText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function agentPlainText(value) {
    const tmp = document.createElement('div');
    tmp.innerHTML = formatAnswer(String(value || ''));
    return (tmp.textContent || tmp.innerText || String(value || '')).trim();
}

function agentDocxParagraph(text, style) {
    const lines = String(text || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    const pStyle = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
    if (!lines.length) return `<w:p>${pStyle}<w:r><w:t></w:t></w:r></w:p>`;
    return lines.map(line => `<w:p>${pStyle}<w:r><w:t xml:space="preserve">${agentXmlText(line)}</w:t></w:r></w:p>`).join('');
}

function agentCrc32(bytes) {
    if (!window._agentCrcTable) {
        window._agentCrcTable = Array.from({ length: 256 }, (_, n) => {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            return c >>> 0;
        });
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = window._agentCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function agentZipStore(files) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    const u16 = n => [n & 255, (n >>> 8) & 255];
    const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

    files.forEach(file => {
        const nameBytes = enc.encode(file.name);
        const dataBytes = enc.encode(file.content);
        const crc = agentCrc32(dataBytes);
        const localHeader = new Uint8Array([
            ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
            ...u32(crc), ...u32(dataBytes.length), ...u32(dataBytes.length), ...u16(nameBytes.length), ...u16(0)
        ]);
        localParts.push(localHeader, nameBytes, dataBytes);
        const centralHeader = new Uint8Array([
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
            ...u32(crc), ...u32(dataBytes.length), ...u32(dataBytes.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
            ...u16(0), ...u16(0), ...u32(0), ...u32(offset)
        ]);
        centralParts.push(centralHeader, nameBytes);
        offset += localHeader.length + nameBytes.length + dataBytes.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
        ...u32(centralSize), ...u32(offset), ...u16(0)
    ]);
    return new Blob([...localParts, ...centralParts, end], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
}

function agentBuildDocx(data, question) {
    const now = new Date().toLocaleString();
    const title = String(question || 'AI 数据分析报告').slice(0, 80);
    const reasoning = (data.reasoning || []).map(x => String(x)).filter(Boolean);
    const citations = (data.citations || []).map(x => String(x)).filter(Boolean);
    const trace = (data.toolTrace || []).map(t => `${t.normalizedTool || t.tool || 'tool'}: ${JSON.stringify(t.params || {})}`);
    const sections = [
        agentDocxParagraph(title, 'Title'),
        agentDocxParagraph(`生成时间：${now}　来源：山东财经大学教育科技人才一体化平台`),
        agentDocxParagraph('分析结论', 'Heading1'),
        agentDocxParagraph(agentPlainText(data.answer || '（无内容）')),
        citations.length ? agentDocxParagraph('数据来源', 'Heading1') + citations.map(x => agentDocxParagraph(`· ${x}`)).join('') : ''
    ].join('');
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${sections}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="0F4F97"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="12345F"/></w:rPr></w:style>
</w:styles>`;
    return agentZipStore([
        { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
        { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
        { name: 'word/document.xml', content: documentXml },
        { name: 'word/styles.xml', content: stylesXml }
    ]);
}

function agentGenerateReport(data, question) {
    const docx = agentBuildDocx(data, question);
    agentDownloadBlob(`${extractQuestionSubject(question)}_分析报告.docx`, docx);
    showToast?.('分析报告 DOCX 已生成并下载', 'success');
}

function agentActionIcon(type) {
    const href = {
        chart: '#ico-chart-bar',
        expand: '#ico-search',
        table: '#ico-table',
        download: '#ico-src',
        report: '#ico-print'
    }[type] || '#ico-star';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="${href}"/></svg>`;
}

function executeAgentUiActions(data, question, sourceBubble) {
    if (!sourceBubble) return;
    const hasChart = !!(data?.chart && data.chart.metric);
    const hasDataContext = hasChart || (Array.isArray(data?.citations) && data.citations.length > 0) || data?.data || data?.table;
    const q = String(question || '');
    const wantsExport = /导出|下载|保存|生成文件|Excel|CSV|PNG|JPG|SVG/i.test(q);
    const wantsReport = /报告|分析报告|总结文档|生成总结|生成分析/.test(q);
    if (!hasDataContext && !wantsExport && !wantsReport) return;
    if (sourceBubble.querySelector('.agent-ui-actions')) return;

    const actions = [];
    if (hasChart) actions.push({ id: 'inline-chart', label: '展开图表', icon: 'chart' });
    if (hasChart) actions.push({ id: 'chart-modal', label: '大图查看', icon: 'expand' });
    if (hasChart) actions.push({ id: 'open-data-table', label: '数据明细', icon: 'table' });
    if (hasChart) actions.push({ id: 'export-inline-chart', label: '导出 PNG', icon: 'download' });
    if (wantsExport) actions.push({ id: 'export-chat-table', label: '导出 CSV', icon: 'download' });
    actions.push({ id: 'report-html', label: '生成报告', icon: 'report' });

    const box = document.createElement('div');
    box.className = 'agent-ui-actions';
    box._agentData = data;
    box._agentQuestion = question || '';
    box.innerHTML = `
        <div class="agent-ui-action-title">可展开分析</div>
        <div class="agent-ui-action-row">
            ${actions.map(action => `<button type="button" class="agent-action-btn" data-agent-action="${action.id}" title="${escapeHtml(action.label)}">${agentActionIcon(action.icon)}<span>${escapeHtml(action.label)}</span></button>`).join('')}
        </div>
    `;
    sourceBubble.appendChild(box);
}

const renderAgentChartInsideBubbleBase = renderAgentChartInsideBubble;
renderAgentChartInsideBubble = function(bubble, config) {
    const id = renderAgentChartInsideBubbleBase(bubble, config);
    const wrap = bubble?.querySelector('.agent-inline-chart-wrap');
    if (wrap) wrap.classList.add('open');
    const toggle = bubble?.querySelector('.agent-action-btn[data-agent-action="inline-chart"] span');
    if (toggle) toggle.textContent = '刷新图表';
    return id;
};

document.addEventListener('click', function(e) {
    const btn = e.target.closest('.agent-action-btn[data-agent-action="chart-modal"]');
    if (!btn) return;
    const box = btn.closest('.agent-ui-actions');
    const data = box?._agentData || {};
    if (data.chart && typeof openChartModal === 'function') openChartModal(data.chart);
});

const initSdufeCoverBase = initSdufeCover;
initSdufeCover = function() {
    initSdufeCoverBase?.();
    initSdufeLogoBubble();
};

function initSdufeLogoBubble() {
    const cover = document.getElementById('sdufe-cover');
    const seal = cover?.querySelector('.relief-seal');
    if (!cover || !seal || cover._bubbleBound) return;
    cover._bubbleBound = true;

    cover.querySelector('.sdufe-logo-bubble')?.remove();
    seal.classList.add('logo-bubble-active');
    const logo = seal.querySelector('.cover-seal-logo') || cover.querySelector('.cover-seal-logo');
    if (logo) {
        logo.classList.add('cover-logo-bubble');
        if (logo.parentElement !== cover) cover.appendChild(logo);
    }

    const state = { x: 77, y: 64, vx: 0.085, vy: 0.062, last: performance.now() };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const visible = () => document.body.classList.contains('sdufe-cover-active')
        && cover.offsetParent !== null
        && getComputedStyle(cover).display !== 'none';

    function tick(now) {
        if (!visible()) {
            state.last = now;
            requestAnimationFrame(tick);
            return;
        }
        const dt = clamp((now - state.last) / 16.67, 0.35, 2.2);
        state.last = now;
        state.x += state.vx * dt;
        state.y += state.vy * dt;

        const minX = 58;
        const maxX = 92;
        const minY = 45;
        const maxY = 86;
        const diagonal = 132;
        if (state.x < minX) { state.x = minX; state.vx = Math.abs(state.vx); }
        if (state.x > maxX) { state.x = maxX; state.vx = -Math.abs(state.vx); }
        if (state.y < minY) { state.y = minY; state.vy = Math.abs(state.vy); }
        if (state.y > maxY) { state.y = maxY; state.vy = -Math.abs(state.vy); }
        if (state.x + state.y < diagonal) {
            const deficit = diagonal - state.x - state.y;
            state.x += deficit * 0.52;
            state.y += deficit * 0.48;
            const vx = state.vx;
            state.vx = Math.abs(state.vy) * 0.92;
            state.vy = Math.abs(vx) * 0.92;
        }

        seal.style.setProperty('--seal-bubble-x', `${state.x.toFixed(2)}%`);
        seal.style.setProperty('--seal-bubble-y', `${state.y.toFixed(2)}%`);
        if (logo) {
            logo.style.setProperty('--seal-bubble-x', `${state.x.toFixed(2)}%`);
            logo.style.setProperty('--seal-bubble-y', `${state.y.toFixed(2)}%`);
        }
        cover.style.setProperty('--mx', `${state.x.toFixed(2)}%`);
        cover.style.setProperty('--my', `${state.y.toFixed(2)}%`);

        const sealRect = seal.getBoundingClientRect();
        const coverRect = cover.getBoundingClientRect();
        const px = coverRect.left + coverRect.width * state.x / 100;
        const py = coverRect.top + coverRect.height * state.y / 100;
        const bx = clamp((px - sealRect.left) / sealRect.width * 100, 0, 100);
        const by = clamp((py - sealRect.top) / sealRect.height * 100, 0, 100);
        seal.style.setProperty('--bx', `${bx.toFixed(2)}%`);
        seal.style.setProperty('--by', `${by.toFixed(2)}%`);
        seal.style.setProperty('--mx', `${bx.toFixed(2)}%`);
        seal.style.setProperty('--my', `${by.toFixed(2)}%`);
        seal.style.setProperty('--br', `${clamp(Math.min(sealRect.width, sealRect.height) * 0.92, 82, 138).toFixed(1)}px`);
        seal.classList.add('brush-active');
        cover.classList.add('bubble-mode');
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

waitForWorkbook();
bindEvents();
initSdufeCover();
refineRagCapabilityBadges();

initPaginationGuide();
ensureDashboardAnalysisVisible();
init();
