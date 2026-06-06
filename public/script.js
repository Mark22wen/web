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

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ======================= Landing Page & RAG 全屏界面 =======================

let threeScene = null;
let ragReturnPage = 'dashboard';
let pendingSheetSwitchTimer = null;

function disposeLandingScene() {
    if (!threeScene) return;
    const currentScene = threeScene;
    currentScene.disposed = true;
    try {
        if (currentScene.animationId) cancelAnimationFrame(currentScene.animationId);
        if (currentScene.resizeHandler) window.removeEventListener('resize', currentScene.resizeHandler);
        if (currentScene.mouseHandler) document.removeEventListener('mousemove', currentScene.mouseHandler);
        if (currentScene.observer) currentScene.observer.disconnect();
        (currentScene.disposables || []).forEach(item => {
            try {
                if (item.geometry) item.geometry.dispose();
                if (item.material) item.material.dispose();
                if (item.dispose) item.dispose();
            } catch(e) {}
        });
        if (currentScene.renderer) {
            currentScene.renderer.dispose();
        }
    } catch(e) {
        console.warn('Landing scene dispose failed:', e);
    }
    if (threeScene === currentScene) threeScene = null;
}

function initLanding() {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas || threeScene) return;
    if (!window.THREE) {
        canvas.style.display = 'none';
        document.body.classList.add('three-unavailable');
        console.warn('[Platform] ThreeJS 未加载，已启用 CSS 星空降级');
        return;
    }
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    threeScene = { scene, camera, renderer, disposables: [], animationId: null, observer: null, resizeHandler: null, mouseHandler: null, disposed: false };
    const sceneState = threeScene;
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    // ---- 多层粒子系统 ----
    const particlesCount = window.matchMedia('(max-width: 768px)').matches ? 320 : 680;
    const posArray = new Float32Array(particlesCount * 3);
    const colorArray = new Float32Array(particlesCount * 3);
    const speedArray = new Float32Array(particlesCount); // individual drift speeds
    const sizeArray = new Float32Array(particlesCount);

    const palette = [
        [0.18, 0.48, 0.92],
        [0.20, 0.72, 0.88],
        [0.62, 0.80, 1.00],
        [0.86, 0.74, 0.38],
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
        sizeArray[i] = 0.07 + Math.random() * 0.12;
    }
    
    const particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    particlesGeometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    
    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.095,
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    
    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);
    threeScene.disposables.push(particlesMesh);
    
    // ---- Connection lines system (LineSegments) ----
    const MAX_LINES = 980;
    const linePositions = new Float32Array(MAX_LINES * 6); // 2 points * xyz
    const lineColors = new Float32Array(MAX_LINES * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const linesMesh = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(linesMesh);
    threeScene.disposables.push(linesMesh);
    
    // ---- Floating rings (orbit decorators) ----
    function makeRing(radius, color, tilt) {
        const pts = [];
        for (let i = 0; i <= 128; i++) {
            const a = (i / 128) * Math.PI * 2;
            pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.3, 0));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
        const ring = new THREE.Line(geo, mat);
        ring.rotation.x = tilt;
        scene.add(ring);
        threeScene.disposables.push(ring);
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
    const mouseHandler = (e) => {
        targetMouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        targetMouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    document.addEventListener('mousemove', mouseHandler);
    threeScene.mouseHandler = mouseHandler;
    
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
        if (!threeScene || threeScene !== sceneState || sceneState.disposed) return;
        animationId = requestAnimationFrame(animate);
        sceneState.animationId = animationId;
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
        
        if (!sceneState.disposed && threeScene === sceneState) {
            renderer.render(scene, camera);
        }
    }
    animate();
    
    const resizeHandler = () => {
        if (document.getElementById('landing-page')?.style.display === 'none') return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', resizeHandler);
    threeScene.resizeHandler = resizeHandler;
    
    const observer = new MutationObserver(() => {
        const landing = document.getElementById('landing-page');
        if (landing && landing.style.display === 'none' && animationId) {
            disposeLandingScene();
        }
    });
    observer.observe(document.body, { attributes: true, subtree: true });
    if (threeScene) threeScene.observer = observer;
}

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
    
    initLanding();
}

function scrollToFeatures() {
    const el = document.getElementById('features-section');
    if (!el) return;
    el.scrollIntoView({ behavior: 'auto', block: 'start' });
}

function enterSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover) return;
    cover.classList.add('slide-out');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    setTimeout(() => {
        cover.style.display = 'none';
        document.body.classList.remove('sdufe-cover-active');
        document.body.classList.add('sdufe-cover-seen');
        initLanding();
    }, 420);
}

function returnToSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.body.classList.add('sdufe-cover-active');
    cover.style.display = 'flex';
    cover.classList.remove('slide-out');
    document.body.classList.remove('sdufe-cover-seen');
}

function initSdufeCover() {
    const cover = document.getElementById('sdufe-cover');
    if (!cover || cover._bound) return;
    cover._bound = true;
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
        meter.innerHTML = '<span>CALIBRATING DATA SURFACE</span><i></i>';
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
            try { if (typeof renderAdvancedChart === 'function' && advancedChart && !advancedChart.isDisposed?.() && advMetrics?.length) renderAdvancedChart(); } catch(e) {}
        });
    });
    // Extra safety: one more resize after ~250ms for charts that initialize slowly
    setTimeout(() => {
        [mainChart, pieChart, advancedChart, rankChart].forEach(c => {
            try { if (c && !c.isDisposed?.()) c.resize(); } catch(e) {}
        });
    }, 250);
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
            if (!fromDashboard) disposeLandingScene();
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
            disposeLandingScene();
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
                const pie = document.getElementById('section-pie');
                if (pie) { pie.style.display = 'block'; pie.scrollIntoView({behavior:'smooth',block:'start'}); }
                forceResizeAllCharts();
            }, 400);
        } else if (tab === 'scatter') {
            setTimeout(() => {
                const sc = document.getElementById('section-scatter');
                if (sc) { sc.style.display = 'block'; sc.scrollIntoView({behavior:'smooth',block:'start'}); openAnalysisPanel('scatter'); }
                forceResizeAllCharts();
            }, 400);
        } else if (tab === 'table') {
            setTimeout(() => {
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

function initLandingScrollHint() {
    if (initLandingScrollHint._bound) return;
    initLandingScrollHint._bound = true;
    const hint = document.querySelector('.hero-scroll-hint');
    if (hint) hint.style.display = 'none';
    const features = document.getElementById('features-section');
    if (features && !document.querySelector('.landing-section-divider')) {
        const divider = document.createElement('div');
        divider.className = 'landing-section-divider';
        divider.innerHTML = '<span>核心模块</span>';
        features.parentNode.insertBefore(divider, features);
    }
    const update = () => {
        const landing = document.getElementById('landing-page');
        if (!landing) return;
        landing.classList.toggle('landing-scrolled', window.scrollY > 80);
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
}

function refineLandingCapabilities() {
    if (refineLandingCapabilities._done) return;
    refineLandingCapabilities._done = true;
    const section = document.querySelector('.capability-grid-section');
    if (!section) return;
    const eyebrow = section.querySelector('.section-eyebrow');
    const title = section.querySelector('.section-title');
    const sub = section.querySelector('.section-sub');
    if (eyebrow) eyebrow.textContent = 'AI 助手增强能力';
    if (title) title.textContent = '让数据分析更像一次专业协作';
    if (sub) sub.textContent = '上方是核心功能入口，这里展示 AI 助手能额外完成的研究辅助任务。';

    const cards = [...section.querySelectorAll('.cap-card')];
    const copy = [
        {
            title: '多问题一次回答',
            desc: '一次输入排名、趋势、对比、预测等多个问题，助手会自动拆解成子任务，逐项分析后合并为完整答复。',
            tags: ['自动拆题', '顺序执行', '结果合并', '上下文继承']
        },
        { title: '异常与短板发现', desc: '围绕某个指标自动提示高低值、离群地区和可能需要重点关注的变化方向。' },
        { title: '方法解释与可信度', desc: '对预测、排名、对比结果补充方法说明、样本年份、回测误差和置信区间。' },
        { title: '研究口径整理', desc: '把地区、年份、指标和数据来源整理成可复用的分析口径，减少重复筛选。' },
        { title: '报告摘要生成', desc: '把图表发现归纳为适合汇报使用的结论、建议和下一步追问方向。' }
    ];

    cards.forEach((card, index) => {
        const item = copy[index];
        if (!item) return;
        const h3 = card.querySelector('h3');
        const p = card.querySelector('p');
        if (h3) h3.textContent = item.title;
        if (p) p.textContent = item.desc;
        const tagRow = card.querySelector('.cap-tag-row');
        if (tagRow && item.tags) {
            tagRow.innerHTML = item.tags.map(tag => `<span class="cap-tag">${escapeHtml(tag)}</span>`).join('');
        }
    });
}

function refineRagCapabilityBadges() {
    const caps = document.querySelector('.rag-caps');
    if (!caps || refineRagCapabilityBadges._done) return;
    refineRagCapabilityBadges._done = true;
    caps.innerHTML = ['多问题拆解', '数据检索', '趋势预测', '方法解释']
        .map(text => `<span class="rag-cap-chip">${escapeHtml(text)}</span>`)
        .join('');
}

function initSheetSwitchGuide() {
    const toolbar = document.querySelector('.dash-toolbar-card');
    const select = document.getElementById('sheet-list');
    if (!toolbar || !select || toolbar.querySelector('.sheet-switch-guide')) return;
    if (!select.parentElement?.classList.contains('sheet-select-wrap')) {
        const wrap = document.createElement('span');
        wrap.className = 'sheet-select-wrap';
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
    }
    const guide = document.createElement('div');
    guide.className = 'sheet-switch-guide';
    guide.innerHTML = `
        <span class="guide-pulse-dot"></span>
        <span>在这里切换全国、省份和地级市数据表</span>
    `;
    toolbar.appendChild(guide);
    select.title = '切换全国、省份、地级市工作表';
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
        disposeLandingScene();
    }
    rag.style.display = 'flex';
    document.body.classList.add('rag-open');
    const fab = document.getElementById('chat-float-btn');
    if (fab) fab.style.display = 'none';
    
    // Init session: each page visit starts with a fresh chat, while history remains available.
    if (ragAutoFreshSessionPending) {
        ragAutoFreshSessionPending = false;
        startNewSession();
        const hint = document.getElementById('rag-context-hint');
        if (hint) hint.innerHTML = '<span>新对话已开启，左侧可切换历史对话。</span>';
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

// ===== Multi-session conversation management =====
let sessions = JSON.parse(localStorage.getItem('rag_sessions') || '[]');
let currentSessionId = null;
let ragAutoFreshSessionPending = true;

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
    const titleEl = document.getElementById('rag-session-title');
    if (titleEl) titleEl.textContent = session.title || 'AI 分析助手';
    
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
    
    if (!sessions.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px 0;">暂无对话</div>';
        return;
    }
    
    const renameHint = '<div class="session-rename-tip">提示：双击对话名称可重命名</div>';
    list.innerHTML = renameHint + sessions.map(s => {
        const isActive = s.id === currentSessionId;
        const msgCount = s.messages.filter(m => m.role === 'user').length;
        const shortTitle = s.title.length > 22 ? s.title.slice(0,20) + '…' : s.title;
        return '<div class="session-item' + (isActive ? ' active' : '') + '" data-session-id="' + s.id + '" title="单击切换，双击重命名">'
            + '<div class="session-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-msg"/></svg></div>'
            + '<div class="session-title">' + escapeHtml(shortTitle) + '</div>'
            + '<div class="session-meta">' + msgCount + ' 条</div>'
            + '<button class="session-delete" data-delete-id="' + s.id + '" title="删除">×</button>'
            + '</div>';
    }).join('');
}

// Session event delegation
document.addEventListener('click', function(e) {
    const suggestion = e.target.closest('.rag-suggestion');
    if (suggestion) {
        const q = suggestion.textContent.trim();
        if (q) sendRagQuick(q);
        return;
    }

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
    const question = input?.value.trim();
    if (!question || isRagStreaming) return;
    
    // 添加用户消息
    addRagMessage('user', question);
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
    const liveSteps = [...assistantBubble.querySelectorAll('.rag-live-steps span')];
    let liveStepIndex = 0;
    const liveProgressTimer = setInterval(() => {
        if (!liveSteps.length) return;
        liveStepIndex = Math.min(liveStepIndex + 1, liveSteps.length - 1);
        liveSteps.forEach((step, index) => step.classList.toggle('active', index <= liveStepIndex));
    }, 850);
    
    const sendBtn = document.getElementById('rag-send');
    if (sendBtn) sendBtn.disabled = true;
    
    // 更新上下文提示
    const hint = document.getElementById('rag-context-hint');
    if (hint) hint.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-search"/></svg><span>正在检索数据...</span>';
    
    try {
        const response = await fetch('/api/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                sessionId: currentSessionId || 'default',
                history: (getCurrentSession()?.messages || []).slice(-8).map(m => ({ role: m.role, content: m.content }))
            })
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '请求失败');
        
        if (hint) {
            const citationCount = data.citations?.length || 0;
            hint.textContent = citationCount > 0 
                ? `基于 ${citationCount} 个数据源生成回答` 
                : '回答生成完成';
        }
        
        // 构建HTML
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
                forecast: '预测推断',
                rank: '排名计算',
                point: '定点查询',
                query_trend: '趋势分析',
                compare_regions: '地区对比',
                predict_future: '预测推断',
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
                <summary>已完成思考过程</summary>
                ${processHtml}
            </details>`;
        }
        
        // 主回答
        html += `<div class="rag-answer-content">${formatAnswer(data.answer || '无回答')}</div>`;
        if (hasPotentialMissingValueProcessingFromText(data.answer || '')) {
            html += dataProcessingNoticeHtml();
        }
        
        // 引用
        if (data.citations && data.citations.length > 0) {
            const visibleCitations = data.citations.slice(0, 3);
            const hiddenCitations = data.citations.slice(3);
            html += `<div class="rag-citations">
                <div class="rag-citation-head"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-src"/></svg>数据来源</div>
                <div class="rag-citation-list">
                    ${visibleCitations.map(c => `<span class="rag-citation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><use href="#ico-src"/></svg>${escapeHtml(c)}</span>`).join('')}
                </div>
                ${hiddenCitations.length ? `<details class="rag-more-citations"><summary>查看其余 ${hiddenCitations.length} 条来源</summary><div class="rag-citation-list">${hiddenCitations.map(c => `<span class="rag-citation">${escapeHtml(c)}</span>`).join('')}</div></details>` : ''}
            </div>`;
        }
        if (data.suggestions && data.suggestions.length) {
            html += `<div class="rag-suggestions">${data.suggestions.map(s => `<button class="rag-suggestion" type="button" data-question="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`;
        }
        
        assistantBubble.innerHTML = html;
        assistantBubble.classList.remove('streaming-cursor');
        
        // 图表：直接渲染在当前气泡内（内联显示，html设置后再渲染）
        // Chart actions are now shown as chat-bubble buttons; no auto modal trigger.
        
        // 保存到当前 session
        setTimeout(() => executeAgentUiActions(data, question, assistantBubble), 180);
        const session = getCurrentSession();
        if (session) {
            // Auto-title from first message
            if (session.messages.length === 0) {
                session.title = question.slice(0, 30);
                const titleEl = document.getElementById('rag-session-title');
                if (titleEl) titleEl.textContent = session.title;
            }
            session.messages.push({ role: 'user', content: question });
            session.messages.push({ role: 'assistant', content: data.answer || '', html: html });
            saveSessions();
            renderSessionList();
            syncSessionSelect();
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
        clearInterval(liveProgressTimer);
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

function agentGenerateReportDeprecatedHtml(data, question) {
    const now = new Date().toLocaleString();
    const title = String(question || 'AI 数据分析报告').slice(0, 80);
    const reasoning = (data.reasoning || []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
    const citations = (data.citations || []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
    const trace = (data.toolTrace || []).map(t => `<li>${escapeHtml(t.normalizedTool || t.tool || 'tool')}：${escapeHtml(JSON.stringify(t.params || {}))}</li>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.75;color:#172033;margin:42px;background:#f6f9fc}main{max-width:920px;margin:auto;background:white;border-radius:18px;padding:34px 42px;box-shadow:0 18px 55px rgba(30,60,100,.12)}h1{color:#0f4f97;margin-top:0}h2{margin-top:30px;color:#12345f}.meta{color:#667085}.answer{white-space:pre-wrap}li{margin:6px 0}</style></head><body><main>
<h1>${escapeHtml(title)}</h1><div class="meta">生成时间：${escapeHtml(now)} · 来源：山东财经大学科研教育人才数据平台 Agent</div>
<h2>分析结论</h2><div class="answer">${formatAnswer(data.answer || '')}</div>
${reasoning ? `<h2>分析过程</h2><ul>${reasoning}</ul>` : ''}
${trace ? `<h2>工具调用</h2><ul>${trace}</ul>` : ''}
${citations ? `<h2>数据来源</h2><ul>${citations}</ul>` : ''}
</main></body></html>`;
    agentDownload(`agent_report_${Date.now()}.html`, 'text/html;charset=utf-8', html);
    showToast?.('分析报告已生成并下载', 'success');
}

function agentQuestionIntent(question) {
    const q = String(question || '');
    return {
        wantsReport: /报告|分析稿|总结文档|生成总结|生成分析/.test(q),
        wantsExport: /导出|下载|保存|生成文件/.test(q),
        wantsTable: /数据表|表格|明细|Excel|CSV/i.test(q),
        wantsScatter: /散点|相关|关联/.test(q),
        wantsRank: /排名|排行|前\d+|最高|最低/.test(q),
        wantsChart: /图表|趋势图|柱状图|折线图|看板|切换|展示|查看/.test(q)
    };
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

function executeAgentUiActionsDeprecated(data, question, sourceBubble) {
    const intent = agentQuestionIntent(question);
    const hasChart = !!(data?.chart && data.chart.metric);
    if (intent.wantsReport) agentGenerateReport(data, question);
    if (!hasChart && !intent.wantsExport && !intent.wantsTable && !intent.wantsScatter && !intent.wantsRank && !intent.wantsChart) return;

    const targetTab = intent.wantsScatter ? 'scatter' : intent.wantsTable ? 'table' : undefined;
    agentFocusDashboard(targetTab);

    setTimeout(() => {
        const chart = data.chart || {};
        const trace = Array.isArray(data.toolTrace) ? data.toolTrace.find(t => t?.params) : null;
        const params = trace?.params || {};
        const metric = chart.metric || params.metric || data.methodSummary?.metric || '';
        const year = chart.years?.[0] || params.year || params.targetYear || data.methodSummary?.year;
        const sheet = agentInferSheet(data, question);

        if (sheet && currentSheet !== sheet && typeof requestSwitchSheet === 'function') {
            requestSwitchSheet(sheet);
        }

        setTimeout(() => {
            if (intent.wantsTable) {
                if (typeof setTableSheet === 'function') setTableSheet(sheet || tableSheet || currentSheet, { independent: false });
                document.getElementById('section-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (intent.wantsScatter) {
                const scatterSection = document.getElementById('section-scatter');
                if (scatterSection) scatterSection.style.display = 'block';
                scatterSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                if (typeof openAnalysisPanel === 'function') openAnalysisPanel('scatter');
            } else if (intent.wantsRank || chart.type === 'bar') {
                const advancedSection = document.getElementById('section-advanced');
                if (advancedSection) advancedSection.style.display = 'block';
                advancedSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                agentSelectAdvancedMetric(metric, year);
            } else {
                if (metric) agentSelectMainMetric(metric);
                const chartType = document.getElementById('chart-type');
                if (chartType && chart.type) chartType.value = chart.type === 'bar' ? 'bar' : chart.type === 'line' ? 'line' : chartType.value;
                try { renderMainChart?.(); } catch(e) {}
                document.getElementById('section-chart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            if (intent.wantsExport) {
                setTimeout(() => {
                    const q = String(question || '');
                    if (/Excel|xlsx/i.test(q)) exportData?.('xlsx');
                    else if (/CSV/i.test(q)) exportData?.('csv');
                    else if (intent.wantsTable) exportData?.(/CSV/i.test(q) ? 'csv' : 'xlsx');
                    else if (intent.wantsScatter) exportAnalysisChart?.(/jpg|jpeg/i.test(q) ? 'jpg' : 'png');
                    else if (intent.wantsRank) exportChart?.(advancedChart, /jpg|jpeg/i.test(q) ? 'jpg' : 'png', 'agent_rank_chart');
                    else exportChart?.(mainChart, /jpg|jpeg/i.test(q) ? 'jpg' : 'png', 'agent_main_chart');
                }, 520);
            }

            if (sourceBubble && !sourceBubble.querySelector('.agent-ui-action-note')) {
                const note = document.createElement('div');
                note.className = 'agent-ui-action-note';
                note.textContent = intent.wantsExport ? 'Agent 已执行页面切换并触发导出。' : 'Agent 已根据问题切换到对应数据视图。';
                sourceBubble.appendChild(note);
            }
        }, 360);
    }, 260);
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
            <div class="chart-fallback-text">当前浏览器未能加载 ECharts。数据表和智能问答仍可使用；恢复网络或改用本地静态库后图表会自动恢复。</div>
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
          <div class="chart-modal-export-row">
            <button class="mini-btn" id="cme-png">PNG</button>
            <button class="mini-btn" id="cme-jpg">JPG</button>
          </div>
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

    // Export handlers
    const exportModalChart = (type) => {
        if (!_chartModalInstance) return;
        const isDark = document.body.classList.contains('dark-mode');
        try {
            if (type === 'svg') {
                const svgStr = getChartSVGString(_chartModalInstance);
                if (!svgStr) { showToast('SVG 导出失败', 'error'); return; }
                const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = blobUrl; a.download = 'chart.svg';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                return;
            }
            const url = _chartModalInstance.getDataURL({
                type: type === 'jpg' ? 'jpeg' : 'png',
                pixelRatio: 2,
                backgroundColor: isDark ? '#ffffff' : '#ffffff'
            });
            const a = document.createElement('a'); a.href = url; a.download = 'chart.' + type; a.click();
        } catch(e) {
            console.error(e);
            showToast('图表导出失败', 'error');
        }
    };
    document.getElementById('cme-png').onclick = () => exportModalChart('png');
    document.getElementById('cme-jpg').onclick = () => exportModalChart('jpg');
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
    if (!window.echarts) {
        showChartUnavailable(chartDom, '聊天图表暂不可用');
        return;
    }
    // In modal: bigger chart, richer grid padding
    if (isModal) {
        chartDom.style.height = '500px';
    }
    // Dispose previous if any
    if (_inlineChartInstances[chartId]) {
        _inlineChartInstances[chartId] = disposeChartInstance(_inlineChartInstances[chartId]);
        delete _inlineChartInstances[chartId];
    }
    
    // CRITICAL: never set inline width - that causes bubble to stretch to full page width.
    // CSS width:100% on .rag-inline-chart handles width correctly.
    // Only ensure height is explicit.
    chartDom.style.height = isModal ? '500px' : '280px';
    
    // Read the actual rendered width from the wrap container (not chartDiv itself)
    const wrapEl = isModal ? chartDom.parentElement : chartDom.closest('.rag-inline-chart-wrap');
    const measuredW = wrapEl ? wrapEl.clientWidth : (chartDom.clientWidth || 480);
    const measuredH = isModal ? 500 : 280;
    
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
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#edf2ff' : '#17233d';
        const mutedColor = isDark ? '#a8b7d4' : '#52637c';
        const gridColor = isDark ? '#31415f' : '#e1e8f2';
        const titleColor = isDark ? '#f8fbff' : '#10213f';
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
                backgroundColor: isDark ? 'rgba(15,23,42,.96)' : 'rgba(255,255,255,.98)',
                borderColor: isDark ? '#475569' : '#c9d8ee',
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
                    areaStyle: { opacity: isDark ? 0.08 : 0.1 }
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
                    areaStyle: { opacity: isDark ? 0.06 : 0.08 }
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
                        textBorderColor: isDark ? 'rgba(2,6,23,.85)' : 'rgba(255,255,255,.95)',
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
        if (years.length > 20) years = years.slice(-20); // cap at 20 years for very long ranges
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
    
    const textColor = isDark ? '#dbeafe' : '#263b59';
    const gridColor = isDark ? '#2a3a58' : '#e8edf5';
    const titleColor = isDark ? '#edf2ff' : '#1a202c';

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
                backgroundColor: isDark ? 'rgba(19,25,41,.96)' : 'rgba(255,255,255,.98)',
                borderColor: '#93c5fd',
                textStyle: { color: isDark ? '#edf2ff' : '#1a202c', fontSize: 12 },
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
            body: JSON.stringify({ question, sessionId: currentSessionId || 'legacy_chat' }),
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
        setTimeout(() => executeAgentUiActions(data, question, null), 180);

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

async function clearConversation() {
    // Clear current RAG session (new multi-session system)
    if (currentSessionId) {
        try {
            await fetch('/api/clear_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: currentSessionId })
            });
        } catch(err) {
            console.warn('清空服务端历史失败(非致命):', err);
        }
        // Clear current session messages in memory
        const session = getCurrentSession();
        if (session) {
            session.messages = [];
            saveSessions();
        }
        // Reset the chat UI to welcome screen
        const container = document.getElementById('rag-messages');
        if (container) {
            container.innerHTML = `<div class="rag-welcome">
                <div class="rag-welcome-avatar">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-brain"/></svg>
                </div>
                <h2>我是你的数据分析助手</h2>
                <p>查询数据 · 分析趋势 · 对比地区 · 预测未来<br>所有回答均基于平台数据，附带来源溯源。</p>
                <div class="rag-welcome-hints">
                    <button class="rag-hint-btn" onclick="sendRagQuick('近5年长江学者数量趋势')">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-trend"/></svg>
                        近5年长江学者趋势
                    </button>
                    <button class="rag-hint-btn" onclick="sendRagQuick('2023年各省杰青数量前10排名')">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-chart-bar"/></svg>
                        2023年各省杰青排名
                    </button>
                    <button class="rag-hint-btn" onclick="sendRagQuick('预测2026年全国普通高校数量')">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-star"/></svg>
                        预测2026年高校数量
                    </button>
                    <button class="rag-hint-btn" onclick="sendRagQuick('江苏和浙江R&D投入强度对比')">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-scatter"/></svg>
                        江苏vs浙江R&D投入对比
                    </button>
                </div>
            </div>`;
        }
        // Update hint bar
        const hint = document.getElementById('rag-context-hint');
        if (hint) hint.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><use href="#ico-brain"/></svg><span>支持上下文追问 · 无地区时默认全国数据</span>';
        renderSessionList();
        showToast('对话已清空', 'success', 2000);
        return;
    }
    // Legacy chat fallback
    try {
        const response = await fetch('/api/clear_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'legacy_chat' })
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
let tableSheet = "全国";
let tableRows = [], tableHeaders = [];
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
let scatterTableMode = 'province';

let allRegionList = [];
let regionSearchKeyword = "";
let rankRegionSearchTerm = "";

// ======================= 初始化 =======================

async function init() {
    if (window._platformInitStarted) return;
    window._platformInitStarted = true;
    await loadAllData();
    
    mainChart = initEChartSafe(document.getElementById("main-chart"));
    if (mainChart) {
        mainChart.getDom().addEventListener('mouseenter', () => { isCarouselPaused = true; });
        mainChart.getDom().addEventListener('mouseleave', () => { isCarouselPaused = false; });
    } else {
        showChartUnavailable(document.getElementById("main-chart"));
    }
    
    pieChart = initEChartSafe(document.getElementById("pie-chart"));
    if (pieChart) {
        pieChart.getDom().addEventListener('mouseenter', () => { piePaused = true; });
        pieChart.getDom().addEventListener('mouseleave', () => { piePaused = false; });
    } else {
        showChartUnavailable(document.getElementById("pie-chart"));
    }
    
    advancedChart = initEChartSafe(document.getElementById("advanced-content"));
    if (advancedChart) {
        advancedChart.getDom().addEventListener('mouseenter', () => { advPaused = true; });
        advancedChart.getDom().addEventListener('mouseleave', () => { advPaused = false; });
    } else {
        showChartUnavailable(document.getElementById("advanced-content"));
    }
    
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
                const wrap = isModalChart ? dom?.parentElement : dom?.closest('.rag-inline-chart-wrap');
                const newW = wrap ? wrap.clientWidth : 0;
                if (newW > 20) c.resize({ width: newW, height: isModalChart ? 500 : 280 });
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
    initPageEnhancements();
    initHeroPreview();
    
    // 绑定RAG事件
    bindRagEvents();
    
    // 默认显示Landing页
    showLanding();
}

// ======================= 夜间模式 =======================

function initDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    const landingToggle = document.getElementById('darkModeToggleLanding');
    const coverToggle = document.getElementById('darkModeToggleCover');
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    
    const applyDark = (dark) => {
        document.body.classList.toggle('dark-mode', dark);
        if (typeof window.updateDarkIcons === 'function') window.updateDarkIcons(dark);
        updateChartsTheme(dark);
    };
    
    if (isDarkMode) applyDark(true);

    if (landingToggle && !landingToggle._dmBound) {
        landingToggle._dmBound = true;
        landingToggle.addEventListener('click', () => {
            const isNowDark = !document.body.classList.contains('dark-mode');
            localStorage.setItem('darkMode', isNowDark);
            applyDark(isNowDark);
        });
    }
    if (coverToggle && !coverToggle._dmBound) {
        coverToggle._dmBound = true;
        coverToggle.addEventListener('click', () => {
            const isNowDark = !document.body.classList.contains('dark-mode');
            localStorage.setItem('darkMode', isNowDark);
            applyDark(isNowDark);
        });
    }
    
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
    const textColor = isDark ? '#dbeafe' : '#263b59';
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
    setTimeout(() => {
        try {
            const scatterPanelOpen = document.getElementById('analysis-panel')?.classList.contains('open');
            const scatterDom = document.getElementById('analysis-chart');
            if (scatterPanelOpen && scatterDom && window._lastScatterOption && typeof loadChart === 'function') {
                loadChart('scatter');
            }
        } catch (e) {}
    }, 0);
}

// ======================= RAG 事件绑定 =======================

function bindRagEvents() {
    if (bindRagEvents._bound) return;
    bindRagEvents._bound = true;
    const ragInput = document.getElementById('rag-input');
    const ragSend = document.getElementById('rag-send');
    const sessionSelect = document.getElementById('rag-session-select');
    const newTop = document.getElementById('rag-new-top');
    const delTop = document.getElementById('rag-delete-top');
    
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

    if (sessionSelect) {
        sessionSelect.addEventListener('change', e => {
            if (e.target.value) switchSession(e.target.value);
        });
    }
    if (newTop) newTop.addEventListener('click', startNewSession);
    if (delTop) delTop.addEventListener('click', deleteCurrentSession);
    
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
    const mainSelect = document.getElementById("sheet-list");
    const tableSelect = document.getElementById("sheet-list-table");
    [mainSelect, tableSelect].filter(Boolean).forEach(sel => {
        sel.innerHTML = "";
        window.sheetList?.forEach(s => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = s;
            if (s === (sel === tableSelect ? tableSheet : currentSheet)) opt.selected = true;
            sel.appendChild(opt);
        });
    });
    if (mainSelect) mainSelect.onchange = (e) => requestSwitchSheet(e.target.value);
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
    const main = document.getElementById("sheet-list");
    const table = document.getElementById("sheet-list-table");
    if (main) main.value = sheetName;
    if (table) table.value = tableSheet || sheetName;
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
    applyFilterAndSort();
    renderTablePage();
    if (options.independent) showToast(`明细表已切换到：${tableSheet}`, 'success', 1600);
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
    const quickJumpContainer = document.getElementById('quick-jump-container');
    const setPanelVisible = (el, visible, display = 'block') => {
        if (!el) return;
        el.hidden = !visible;
        el.style.display = visible ? display : 'none';
    };

    if (sheetName === "全国") {
        dimType = "nation";
        scatterTableMode = 'province';
        valueFields = headers.filter(h => h !== "年份");
        currentMetricIndex = 0;
        selectedGroups = [];
        regionSearchKeyword = "";
        const regionSearch = document.getElementById("region-search");
        if (regionSearch) regionSearch.value = "";
        const quickJump = document.getElementById("quick-jump-region");
        if (quickJump) quickJump.value = "";
        buildNationPanel();
        document.querySelector(".pie-card") && (document.querySelector(".pie-card").style.display = "block");
        document.querySelector(".advanced-card") && (document.querySelector(".advanced-card").style.display = "none");
        initPieChart();
        setPanelVisible(searchContainer, false, 'flex');
        setPanelVisible(metricContainer, false);
        setPanelVisible(quickJumpContainer, false);
        // National data is single-metric per chart; hide bulk-select buttons that don't apply
        const groupActions = document.getElementById('group-actions');
        if (groupActions) groupActions.style.display = 'none';
    } else if (sheetName === "地级市") {
        dimType = "city";
        scatterTableMode = 'city';
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
        setPanelVisible(searchContainer, true, 'flex');
        setPanelVisible(metricContainer, true);
        setPanelVisible(quickJumpContainer, true);
        const groupActions = document.getElementById('group-actions');
        if (groupActions) groupActions.style.display = '';
    } else if (sheetName === "省份") {
        dimType = "province";
        scatterTableMode = 'province';
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
        setPanelVisible(searchContainer, true, 'flex');
        setPanelVisible(metricContainer, true);
        setPanelVisible(quickJumpContainer, true);
        const groupActions = document.getElementById('group-actions');
        if (groupActions) groupActions.style.display = '';
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
    if (chartType === "auto") chartType = (dimType === "nation" ? "area" : "bar");
    const isArea = chartType === "area" || chartType === "area-stack";
    const isStack = chartType === "area-stack";
    const echartsType = isArea ? "line" : chartType;
    
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
                textStyle: { color: isDark ? '#dbeafe' : '#263b59' }
            },
            xAxis: { 
                type: "category", 
                data: years, 
                name: custom.xName !== "auto" ? custom.xName : "年份",
                axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
                axisLabel: { color: isDark ? '#dbeafe' : '#263b59' }
            },
            yAxis: { 
                name: custom.yName !== "auto" ? custom.yName : metric, 
                min: 0, 
                max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
                axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
                axisLabel: { color: isDark ? '#dbeafe' : '#263b59' },
                splitLine: { lineStyle: { color: isDark ? '#334766' : '#d8e1ec', type: 'dashed' } }
            },
            series: [{
                name: metric,
                type: echartsType || chartType,
                data,
                smooth: true,
                color: COLORS[0],
                areaStyle: isArea ? {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(102,126,234,0.45)' },
                        { offset: 1, color: 'rgba(102,126,234,0.03)' }
                    ])
                } : {
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
            type: echartsType || chartType,
            data,
            smooth: true,
            color: COLORS[idx % COLORS.length],
            stack: isStack ? 'total' : undefined,
            areaStyle: isArea ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: COLORS[idx % COLORS.length].replace(')', ',0.4)').replace('rgb', 'rgba') },
                    { offset: 1, color: COLORS[idx % COLORS.length].replace(')', ',0.02)').replace('rgb', 'rgba') }
                ]),
                opacity: isStack ? 0.8 : 0.35
            } : (chartType === 'line' ? { opacity: 0.1 } : undefined)
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
            textStyle: { color: isDark ? '#dbeafe' : '#263b59' }
        },
        xAxis: { 
            type: "category", 
            data: years, 
            name: "年份",
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
            axisLabel: { color: isDark ? '#dbeafe' : '#263b59' }
        },
        yAxis: { 
            name: custom.yName !== "auto" ? custom.yName : metric, 
            min: 0, 
            max: custom.yMax !== "auto" ? Number(custom.yMax) : null,
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
            axisLabel: { color: isDark ? '#dbeafe' : '#263b59' },
            splitLine: { lineStyle: { color: isDark ? '#334766' : '#d8e1ec', type: 'dashed' } }
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
    const resetHiddenBtn = document.getElementById("pie-reset-hidden");
    if (selectAllBtn) selectAllBtn.onclick = () => applyPieProvinceSelection(pieProvinceList);
    if (invertBtn) invertBtn.onclick = () => {
        const inverted = pieProvinceList.filter(p => !pieSelectedProvinces.has(p));
        applyPieProvinceSelection(inverted);
    };
    if (resetBtn) resetBtn.onclick = () => applyPieProvinceSelection(pieProvinceList);
    if (clearBtn) clearBtn.onclick = () => applyPieProvinceSelection([]);
    if (resetHiddenBtn) resetHiddenBtn.onclick = () => applyPieProvinceSelection(pieProvinceList);
    syncPieProvinceCheckboxes();
    
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
    if (!pieChart || !window.echarts) {
        showChartUnavailable(document.getElementById("pie-chart"));
        return;
    }
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
    const isDark = document.body.classList.contains('dark-mode');
    
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
                itemStyle: { color: isDark ? '#94a3b8' : '#718096' }
            });
        }
    }
    
    if (otherValue > 0) {
        let otherPercent = (otherValue / total) * 100;
        pieSeriesData.push({
            name: "其他（非省份部分）",
            value: otherPercent,
            originalVal: otherValue,
            itemStyle: { color: isDark ? '#c7d2fe' : '#64748b' }
        });
    }
    
    const allProvinceSet = new Set(provinceRows.map(r => r["地区"]));
    const neverExist = pieProvinceList.filter(p => !allProvinceSet.has(p));
    if (neverExist.length > 0) {
        pieSeriesData.push({
            name: `数据缺失省份 (${neverExist.length}省)`,
            value: 0,
            originalVal: 0,
            itemStyle: { color: isDark ? '#475569' : '#cbd5e0' }
        });
    }
    
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
            textStyle: { color: isDark ? '#dbeafe' : '#263b59' },
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
                color: isDark ? '#dbeafe' : '#263b59',
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
        <div class="tool-pill"><label>指标</label><select id="adv-metric-select"></select></div>
        <div class="tool-pill"><label>年份</label><select id="adv-year-select"></select></div>
        <button id="adv-pause-carousel" class="action-btn ghost" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            暂停轮播
        </button>
        <button id="adv-refresh" class="action-btn" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><use href="#ico-refresh"/></svg>
            刷新
        </button>
        <span class="help-dot" title="排名对比图：左侧勾选地区，右侧柱状图对比。">?</span>
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
    if (btn) {
        if (advPaused) {
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="6 4 20 12 6 20 6 4"/></svg>开始轮播';
        } else {
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>暂停轮播';
        }
    }
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
        listPanel.innerHTML = `
            <div class="rank-region-search">
                <input id="rank-region-search-input" type="text" placeholder="搜索地区" value="${escapeHtml(rankRegionSearchTerm)}">
                <button id="rank-region-search-clear" class="mini-btn" type="button">清除</button>
            </div>
            <div class="rank-region-meta" id="rank-region-meta"></div>
            <div class="rank-region-list" id="rank-region-list"></div>
        `;
        const listBody = document.getElementById("rank-region-list");
        const meta = document.getElementById("rank-region-meta");
        const renderFilteredRankList = () => {
            if (!listBody) return;
            const keyword = rankRegionSearchTerm.trim().toLowerCase();
            const indexed = regionData.map((item, idx) => ({ item, idx }));
            const filtered = keyword
                ? indexed.filter(({ item }) => String(item.name || '').toLowerCase().includes(keyword))
                : indexed;
            if (meta) meta.textContent = keyword ? `显示 ${filtered.length} / ${regionData.length} 个地区` : `共 ${regionData.length} 个地区`;
            listBody.innerHTML = "";
            if (!filtered.length) {
                listBody.innerHTML = '<div class="rank-empty">未找到匹配地区</div>';
                return;
            }
            filtered.forEach(({ item, idx }) => {
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
                listBody.appendChild(div);
            });
        };
        const search = document.getElementById("rank-region-search-input");
        const clear = document.getElementById("rank-region-search-clear");
        if (search) {
            search.oninput = (e) => {
                rankRegionSearchTerm = e.target.value;
                renderFilteredRankList();
            };
        }
        if (clear) {
            clear.onclick = () => {
                rankRegionSearchTerm = "";
                if (search) search.value = "";
                renderFilteredRankList();
            };
        }
        renderFilteredRankList();
    }
    
    const chartPanel = document.getElementById("rank-chart-panel");
    if (chartPanel) {
        rankChart = disposeChartInstance(rankChart);
        rankChart = initEChartSafe(chartPanel);
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
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
            axisLabel: { color: isDark ? '#dbeafe' : '#263b59' },
            splitLine: { lineStyle: { color: isDark ? '#334766' : '#d8e1ec', type: 'dashed' } }
        },
        yAxis: { 
            type: "category", 
            data: selectedData.map(d => d.name), 
            axisLabel: { fontSize: 11, color: isDark ? '#dbeafe' : '#263b59' },
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } }
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
            label: { show: true, position: "right", color: isDark ? '#dbeafe' : '#263b59' }
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
            axisLabel: { rotate: 30, color: isDark ? '#dbeafe' : '#263b59' },
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } }
        },
        yAxis: { 
            type: "value", 
            name: "出现次数",
            axisLine: { lineStyle: { color: isDark ? '#8aa4c8' : '#9fb1c8' } },
            axisLabel: { color: isDark ? '#dbeafe' : '#263b59' },
            splitLine: { lineStyle: { color: isDark ? '#334766' : '#d8e1ec', type: 'dashed' } }
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
    let filtered = [...tableRows];
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
    const visible = tableHeaders.filter(h => visibleColumns.has(h));
    const isYearLikeColumn = h => h === '\u5e74\u4efd' || h === '\u65f6\u95f4';
    const isRegionLikeColumn = h => h === '\u5730\u533a';
    
    // 计算统计值
    const stats = {};
    const numericFields = tableHeaders.filter(h => {
        if (isYearLikeColumn(h) || isRegionLikeColumn(h)) return false;
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
        th.textContent = getTableHeaderLabel(h) + arrow;
        headerRow.appendChild(th);
        
        const td = document.createElement('td');
        td.style.fontSize = '11px';
        td.style.fontWeight = 'normal';
        td.style.backgroundColor = 'var(--bg-hover)';
        td.style.borderBottom = '1px solid var(--border-color)';
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
    
    // 计算每列数值范围（用于热力图着色）
    const colRange = {};
    visible.forEach(h => {
        if (isYearLikeColumn(h) || isRegionLikeColumn(h)) return;
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
    updateTableDataProcessingNotice(filteredRowsForPage, visible);
}

function updateTableDataProcessingNotice(rows, headers) {
    const section = document.getElementById('section-table');
    const toolbar = section?.querySelector('.table-toolbar');
    if (!section || !toolbar) return;
    let notice = section.querySelector('.data-processing-notice.table-data-notice');
    const shouldShow = hasPotentialMissingValueProcessingFromRows(rows, headers);
    if (!shouldShow) {
        notice?.remove();
        return;
    }
    if (!notice) {
        notice = document.createElement('div');
        notice.className = 'data-processing-notice table-data-notice';
        toolbar.insertAdjacentElement('afterend', notice);
    }
    notice.innerHTML = '<span>数据提示</span>当前表格中存在较高重复值，可能经过缺失值处理，请结合数据口径谨慎解读。';
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
    const isDark = document.body.classList.contains('dark-mode');
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
        // PNG/JPG — for pie charts in dark mode use white background to avoid invisible slices
        const isPie = filename && filename.includes('pie');
        const bgColor = (isDark && !isPie) ? '#1a1f2e' : '#ffffff';
        const url = chartInstance.getDataURL({
            type: type === 'jpg' ? 'jpeg' : 'png',
            pixelRatio: 2,
            backgroundColor: bgColor
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
        
        const defaultRegions = currentTable === 'city' ? regions.slice(0, 50) : regions.slice(0, 6);
        const regionDiv = document.createElement('div');
        regionDiv.className = 'scatter-region-section scatter-region-control';
        regionDiv.innerHTML = `
            <div class="scatter-region-header">
                <span class="scatter-region-label">地区</span>
                <div class="scatter-region-actions">
                    <input id="scatter-region-search" class="scatter-search-input" type="text" placeholder="搜索地区">
                    <button type="button" class="scatter-tag-action" id="scatter-select-all">全选</button>
                    <button type="button" class="scatter-tag-action ghost" id="scatter-clear-all">清空地区</button>
                    <button type="button" class="scatter-tag-action ghost" id="scatter-select-visible">选择搜索结果</button>
                </div>
            </div>
            <div id="scatter-region-chips" class="scatter-region-chips"></div>
            <select id="scatter-regions" multiple hidden>
                ${regions.map(r => `<option value="${r}" ${defaultRegions.includes(r) ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
            <div id="scatter-selected-summary" class="scatter-selected-summary">已选择 ${defaultRegions.length} 个地区</div>
        `;
        container.appendChild(regionDiv);
        
        const btn = document.createElement('button');
        btn.innerText = '生成散点图';
        btn.className = 'analysis-run-btn';
        btn.onclick = () => loadChart(type);
        container.appendChild(btn);

        const modalBtn = document.createElement('button');
        modalBtn.innerText = '查看大图';
        modalBtn.className = 'analysis-run-btn scatter-modal-btn';
        modalBtn.onclick = () => openScatterChartModal();
        container.appendChild(modalBtn);
        
        setTimeout(() => {
            const tableEl = document.getElementById('scatter-table');
            const selectAll = document.getElementById('scatter-select-all');
            const clearAll = document.getElementById('scatter-clear-all');
            const selectVisible = document.getElementById('scatter-select-visible');
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
            if (selectVisible) selectVisible.onclick = () => {
                const selected = getSelected();
                chipsEl?.querySelectorAll('.region-chip').forEach(chip => selected.add(chip.dataset.region));
                syncHiddenSelect(selected);
                renderScatterRegionOptions();
            };
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
    if (clearAll) clearAll.textContent = '清空地区';
    const selectVisible = document.getElementById('scatter-select-visible');
    if (selectVisible) selectVisible.textContent = '选择搜索结果';
    const run = document.querySelector('#analysis-controls .analysis-run-btn:not(.scatter-modal-btn)');
    if (run) run.textContent = '生成散点图';
    const modal = document.querySelector('#analysis-controls .scatter-modal-btn');
    if (modal) modal.textContent = '查看大图';
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

function hasPotentialMissingValueProcessingFromRows(rows, headers) {
    if (!Array.isArray(rows) || rows.length < 8 || !Array.isArray(headers)) return false;
    return headers.some(header => {
        if (/年份|地区|省份|城市|名称|name|region|year/i.test(String(header))) return false;
        const values = rows.map(row => row?.[header]).filter(v => typeof v === 'number' && Number.isFinite(v));
        if (values.length < 8) return false;
        const counts = new Map();
        values.forEach(v => counts.set(String(v), (counts.get(String(v)) || 0) + 1));
        const maxRepeat = Math.max(0, ...counts.values());
        return maxRepeat >= 8 && maxRepeat / values.length >= 0.45;
    });
}

function dataProcessingNoticeHtml() {
    return `<div class="data-processing-notice">
        <span>数据提示</span>
        当前结果中存在较高重复值，可能经过缺失值处理，请结合数据口径谨慎解读。
    </div>`;
}

// ── 查看大图辅助 ──────────────────────────────────────
function _addViewFullBtn(chartDom, onClick) {
    const old = chartDom.parentElement?.querySelector('.view-full-btn');
    if (old) old.remove();
    const btn = document.createElement('button');
    btn.className = 'view-full-btn';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg> 查看大图`;
    btn.style.cssText = 'margin:6px 0 0 auto;display:flex;align-items:center;gap:4px;font-size:.78rem;color:var(--c-muted);background:none;border:1px solid var(--c-border);border-radius:4px;padding:3px 10px;cursor:pointer;float:right;';
    btn.onclick = onClick;
    chartDom.insertAdjacentElement('afterend', btn);
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
        <div class="scatter-region-section" style="flex:1 1 100%;margin-top:6px;">
            <div class="scatter-region-header" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span class="scatter-region-label">地区</span>
                <input id="bubble-region-search" class="scatter-search-input" type="text" placeholder="搜索省份">
                <button type="button" class="scatter-tag-action" id="bubble-select-all">全选</button>
                <button type="button" class="scatter-tag-action ghost" id="bubble-clear-all">清空</button>
            </div>
            <div class="scatter-region-chips" id="bubble-region-chips"></div>
            <select id="bubble-regions" multiple style="display:none"></select>
            <div class="scatter-selected-summary" id="bubble-region-summary"></div>
        </div>
        <button class="action-btn" onclick="loadChart('bubble')" style="margin-top:8px">生成气泡图</button>`;

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

    container.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
                <div class="control-group"><span>年份：</span>
                    <select id="butterfly-year">${years.map(y=>`<option value="${y}"${y===defYear?' selected':''}>${y}</option>`).join('')}</select>
                </div>
                <div class="control-group"><span>省份A（左）：</span>
                    <select id="butterfly-a">${regions.map(r=>`<option value="${r}"${r===defA?' selected':''}>${r}</option>`).join('')}</select>
                </div>
                <div class="control-group"><span>省份B（右）：</span>
                    <select id="butterfly-b">${regions.map(r=>`<option value="${r}"${r===defB?' selected':''}>${r}</option>`).join('')}</select>
                </div>
                <button class="action-btn" onclick="loadChart('butterfly')">生成蝴蝶图</button>
            </div>
            <div style="flex:1 1 100%;margin-top:4px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span style="font-size:.82rem;color:var(--c-text2);font-weight:600;">选择对比指标</span>
                    <button type="button" class="scatter-tag-action" id="bf-select-all">全选</button>
                    <button type="button" class="scatter-tag-action ghost" id="bf-clear-all">清空</button>
                    <button type="button" class="scatter-tag-action ghost" id="bf-top10">差异最大前10</button>
                </div>
                <div class="scatter-region-chips" id="butterfly-metric-chips" style="max-height:160px;"></div>
                <select id="butterfly-metrics" multiple style="display:none"></select>
            </div>
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
            btn.onclick = () => { selectedBF.has(m)?selectedBF.delete(m):selectedBF.add(m); btn.classList.toggle('active',selectedBF.has(m)); syncBFHidden(); };
            chips.appendChild(btn);
        });
        syncBFHidden();
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

function dataProcessingNoticeHtml() {
    return `<div class="data-processing-notice">
        <span>数据提示</span>
        当前结果中存在较高重复值，可能经过缺失值处理，请结合数据口径谨慎解读。
    </div>`;
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
        const isDark = document.body.classList.contains('dark-mode');
        chartDom.style.height = '500px';
        currentChartInstance = initEChartSafe(chartDom);
        const bubbleOption = {
            backgroundColor: 'transparent',
            title: { text: `${year}年  ${xMetric} · ${yMetric} · ${sMetric}`, left: 'center', textStyle: { color: isDark?'#f7fafc':'#1f2b48', fontSize: 13 } },
            tooltip: { formatter: p => `<b>${p.data[3]}</b><br/>${xMetric}: ${(+p.data[0])?.toFixed(4)}<br/>${yMetric}: ${(+p.data[1])?.toFixed(4)}<br/>${sMetric}: ${(+p.data[2])?.toFixed(4)}` },
            xAxis: { name: xMetric, nameLocation: 'middle', nameGap: 30, axisLabel: { color: isDark?'#dbeafe':'#263b59' }, splitLine: { lineStyle: { color: isDark?'#334766':'#d8e1ec', type:'dashed' } } },
            yAxis: { name: yMetric, nameLocation: 'middle', nameGap: 44, axisLabel: { color: isDark?'#dbeafe':'#263b59' }, splitLine: { lineStyle: { color: isDark?'#334766':'#d8e1ec', type:'dashed' } } },
            series: [{
                type: 'scatter',
                data: points.map(p => [p.x, p.y, p.s, p.name]),
                symbolSize: val => { const r = sMax===sMin ? 0.5 : (val[2]-sMin)/(sMax-sMin); return 14 + r*50; },
                itemStyle: { color: p => COLORS[p.dataIndex % COLORS.length], opacity: 0.82 },
                label: { show: true, formatter: p => p.data[3], position: 'top', fontSize: 11, color: isDark?'#dbeafe':'#263b59' }
            }]
        };
        currentChartInstance.setOption(bubbleOption, true);
        // 查看大图按钮
        _addViewFullBtn(chartDom, () => _openRawEchartsModal(bubbleOption, `气泡图 · ${year}年`));
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
        const labels = pairs.map(p => p.m.length > 14 ? p.m.slice(0,14)+'…' : p.m);
        const isDark = document.body.classList.contains('dark-mode');
        // 动态高度：每行 36px，最少 400px
        const chartH = Math.max(400, pairs.length * 36 + 120);
        chartDom.style.height = chartH + 'px';
        currentChartInstance = initEChartSafe(chartDom);
        const bfOption = {
            backgroundColor: 'transparent',
            title: { text: `${year}年  ${regA} vs ${regB}  指标对比`, left: 'center', textStyle: { color: isDark?'#f7fafc':'#1f2b48', fontSize: 13 } },
            tooltip: {
                trigger: 'axis', axisPointer: { type: 'shadow' },
                formatter: params => {
                    const i = params[0]?.dataIndex, p = pairs[i];
                    return p ? `<b>${p.m}</b><br/>${regA}: ${p.rawA?.toFixed(4)}<br/>${regB}: ${p.rawB?.toFixed(4)}` : '';
                }
            },
            legend: { data: [regA, regB], top: 28, textStyle: { color: isDark?'#dbeafe':'#263b59' } },
            grid: { left: 20, right: 20, top: 62, bottom: 16, containLabel: true },
            xAxis: {
                type: 'value',
                axisLabel: { formatter: v => Math.abs(v).toFixed(2), color: isDark?'#dbeafe':'#263b59', fontSize: 11 },
                splitLine: { lineStyle: { color: isDark?'#334766':'#d8e1ec', type:'dashed' } }
            },
            yAxis: { type: 'category', data: labels, axisLabel: { color: isDark?'#dbeafe':'#263b59', fontSize: 11, width: 110, overflow:'truncate' } },
            series: [
                {
                    name: regA, type: 'bar', stack: 'total',
                    data: pairs.map(p => -Math.abs(p.a)),
                    itemStyle: { color: COLORS[0], opacity: 0.85 },
                    label: { show: true, position: 'insideLeft', formatter: p => pairs[p.dataIndex]?.rawA?.toFixed(3), color: '#fff', fontSize: 10 }
                },
                {
                    name: regB, type: 'bar', stack: 'total',
                    data: pairs.map(p => Math.abs(p.b)),
                    itemStyle: { color: COLORS[2], opacity: 0.85 },
                    label: { show: true, position: 'insideRight', formatter: p => pairs[p.dataIndex]?.rawB?.toFixed(3), color: '#fff', fontSize: 10 }
                }
            ]
        };
        currentChartInstance.setOption(bfOption, true);
        // 查看大图按钮
        _addViewFullBtn(chartDom, () => _openRawEchartsModal(bfOption, `蝴蝶图 · ${year}年 ${regA} vs ${regB}`, Math.max(600, chartH)));
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
            const res = await fetch('/api/scatter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table, year, xMetric, yMetric, regions })
            });
            const data = await res.json();
            if (!res.ok || !Array.isArray(data.data) || !data.data.length) {
                const message = data?.error || '当前筛选条件下没有可绘制的散点数据';
                chartDom.innerHTML = `<div class="chart-empty-state"><strong>无法生成散点图</strong><span>${escapeHtml(message)}</span></div>`;
                window._lastScatterOption = null;
                showToast(message, 'warn');
                return;
            }
            
            const isDark = document.body.classList.contains('dark-mode');
            const isCityScatter = table === 'city';
            const scatterText = {
                title: isDark ? '#f8fbff' : '#10213f',
                axis: isDark ? '#f1f5ff' : '#17233d',
                axisName: isDark ? '#f8fbff' : '#0f1f3a',
                axisLine: isDark ? '#9fb7dc' : '#60789d',
                splitLine: isDark ? '#405576' : '#c7d4e5',
                label: isDark ? '#ffffff' : '#0f1f3a',
                labelBorder: isDark ? 'rgba(2,6,23,.86)' : 'rgba(255,255,255,.96)',
                tooltip: isDark ? '#f8fbff' : '#10213f'
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
                    backgroundColor: isDark ? 'rgba(15,23,42,.94)' : 'rgba(255,255,255,.96)',
                    borderColor: isDark ? '#334155' : '#d8e4f2',
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
                            backgroundColor: isDark ? 'rgba(15,23,42,.86)' : 'rgba(255,255,255,.9)',
                            borderColor: isDark ? '#475569' : '#d8e4f2',
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
                        color: new echarts.graphic.RadialGradient(0.4, 0.3, 1, [
                            { offset: 0, color: '#667eea' },
                            { offset: 1, color: '#764ba2' }
                        ])
                    }
                }]
            };
            
            option.tooltip.formatter = p => {
                const item = p.data || [];
                return `<strong>${escapeHtml(item[2] || '')}</strong><br>${escapeHtml(data.xName || xMetric)}：${escapeHtml(item[0] ?? '')}<br>${escapeHtml(data.yName || yMetric)}：${escapeHtml(item[1] ?? '')}`;
            };
            option.title.text = `${table === 'city' ? '地级市' : '省份'} ${xMetric} vs ${yMetric} (${year}年)`;
            const fitHeight = fitScatterPanelToViewport();
            currentChartInstance = initEChartSafe(chartDom);
            currentChartInstance.setOption(option);
            window._lastScatterOption = option;
            ensureScatterInteractionHint(table);
            setTimeout(() => currentChartInstance.resize({ height: fitHeight }), 100);
        } catch (e) {
            console.error('散点图加载失败:', e);
        }
    }
}

function ensureScatterInteractionHint(table) {
    const chartDom = document.getElementById('analysis-chart');
    if (!chartDom) return;
    const old = document.getElementById('scatter-interaction-hint');
    if (old) old.remove();
    const hint = document.createElement('div');
    hint.id = 'scatter-interaction-hint';
    hint.className = 'scatter-interaction-hint';
    hint.textContent = table === 'city'
        ? '地级市点位较密：滚轮缩放、拖动平移，悬停查看城市名称'
        : '悬停点位查看数据，点击“查看大图”进入沉浸式查看';
    chartDom.insertAdjacentElement('afterend', hint);
}

function fitScatterPanelToViewport() {
    const section = document.getElementById('section-scatter');
    const panel = document.getElementById('analysis-panel');
    const chartDom = document.getElementById('analysis-chart');
    if (!section || !panel || !chartDom) return 520;

    section.classList.add('scatter-fit-mode');
    panel.style.maxHeight = 'none';
    panel.style.overflow = 'visible';

    const viewportH = window.innerHeight || document.documentElement.clientHeight || 760;
    const chartH = Math.max(360, Math.min(470, Math.floor(viewportH * 0.42)));

    section.style.setProperty('--scatter-chart-h', `${chartH}px`);
    chartDom.style.height = `${chartH}px`;
    chartDom.style.minHeight = `${chartH}px`;

    requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    if (!window._scatterFitResizeBound) {
        window._scatterFitResizeBound = true;
        window.addEventListener('resize', debounce(() => {
            const openPanel = document.getElementById('analysis-panel');
            if (!openPanel?.classList.contains('open') || activeChart !== 'scatter') return;
            const nextH = fitScatterPanelToViewport();
            const chart = echarts.getInstanceByDom(document.getElementById('analysis-chart'));
            if (chart) chart.resize({ height: nextH });
        }, 120));
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
    panel.style.maxHeight = '0';
    panel.classList.remove('open');
    setTimeout(() => {
        if (!panel.classList.contains('open')) panel.style.display = 'none';
    }, 240);
    updateAnalysisPanelUI(activeChart, false);
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
    const titleMap = {
        scatter:   '散点图 — 双指标关联分析',
        bubble:    '气泡图 — 三维联合分析',
        butterfly: '蝴蝶图 — 双省指标对比'
    };
    const titleEl = document.getElementById('panel-title');
    if (titleEl) titleEl.innerText = titleMap[type] || type;
    
    // Animate open
    panel.style.display = 'block';
    panel.style.maxHeight = '0';
    panel.style.overflow = 'visible';
    panel.style.transition = 'max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.24s ease';
    requestAnimationFrame(() => {
        panel.classList.add('open');
        panel.style.maxHeight = Math.max(panel.scrollHeight + 80, 980) + 'px';
    });
    
    // Highlight active card
    updateAnalysisPanelUI(type, true);
    
    renderControls(type);
    
    setTimeout(() => {
        loadChart(type);
        bindExportEvents();
        panel.style.maxHeight = 'none';
        panel.style.overflow = 'visible';
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 150);
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
    const isDark = document.body.classList.contains('dark-mode');
    const bg = isDark ? '#1a2236' : '#ffffff';
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
    let url;
    if (format === 'png') url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg });
    else if (format === 'jpg') url = chart.getDataURL({ type: 'jpeg', pixelRatio: 2, backgroundColor: bg });
    const link = document.createElement('a');
    link.download = `scatter_${activeChart}_${Date.now()}.${format === 'jpg' ? 'jpg' : format}`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function bindExportEvents() {
    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (!el || el._exportBound) return;
        el._exportBound = true;
        el.addEventListener('click', fn);
    };
    bind('export-chart-png', () => exportAnalysisChart('png'));
    bind('export-chart-jpg', () => exportAnalysisChart('jpg'));
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
        if (btn._toggleBound) return;
        btn._toggleBound = true;
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            openAnalysisPanel(btn.dataset.chart);
        });
    });
    
    const closeBtn = document.getElementById('close-panel');
    if (closeBtn && !closeBtn._closeBound) {
        closeBtn._closeBound = true;
        closeBtn.addEventListener('click', closeAnalysisPanel);
    }
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
    document.getElementById("export-pie-png")?.addEventListener("click", () => exportChart(pieChart, 'png', 'pie_chart'));
    document.getElementById("export-pie-jpg")?.addEventListener("click", () => exportChart(pieChart, 'jpg', 'pie_chart'));
    document.getElementById("export-adv-png")?.addEventListener("click", () => exportChart(advancedChart, 'png', 'advanced_chart'));
    document.getElementById("export-adv-jpg")?.addEventListener("click", () => exportChart(advancedChart, 'jpg', 'advanced_chart'));
    
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
    actions.push({ id: 'open-data-table', label: '跳转明细表' });
    if (hasChart) actions.push({ id: 'inline-chart', label: '展开图表' });
    if (hasChart) actions.push({ id: 'export-inline-chart', label: '导出图表 PNG' });
    if (wantsExport) actions.push({ id: 'export-chat-table', label: '导出回答 CSV' });
    actions.push({ id: 'report-html', label: '生成报告 DOCX' });

    const box = document.createElement('div');
    box.className = 'agent-ui-actions';
    box._agentData = data;
    box._agentQuestion = question || '';
    box.innerHTML = `
        <div class="agent-ui-action-title">可执行操作</div>
        <div class="agent-ui-action-row">
            ${actions.map(action => `<button type="button" class="agent-action-btn" data-agent-action="${action.id}">${escapeHtml(action.label)}</button>`).join('')}
        </div>
    `;
    sourceBubble.appendChild(box);
}

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
    const chartId = 'agent_inline_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    chartEl.id = chartId;
    chartEl.style.height = '360px';
    chartEl.style.width = '100%';
    requestAnimationFrame(() => _doRenderInlineChart(chartId, config, false));
    return chartId;
}

function exportNearestAgentChart(bubble, config) {
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
        link.download = `agent_chart_${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }, 260);
}

function exportAnswerAsCsv(data) {
    const lines = String(data?.answer || '').split('\n').map(line => line.trim()).filter(Boolean);
    const csv = '\ufeff内容\n' + lines.map(line => `"${line.replace(/"/g, '""')}"`).join('\n');
    agentDownload(`agent_answer_${Date.now()}.csv`, 'text/csv;charset=utf-8', csv);
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
    if (action === 'export-inline-chart') exportNearestAgentChart(bubble, data.chart);
    if (action === 'export-chat-table') exportAnswerAsCsv(data);
    if (action === 'report-html') agentGenerateReport(data, question);
    if (action === 'open-data-table') jumpToDataTableFromAgent();
});

function jumpToDataTableFromAgent() {
    closeRagFullscreen();
    setTimeout(() => {
        const table = document.getElementById('section-table');
        if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 260);
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
        agentDocxParagraph(`生成时间：${now} · 来源：山东财经大学科研教育人才一体化数据平台 Agent`),
        agentDocxParagraph('分析结论', 'Heading1'),
        agentDocxParagraph(agentPlainText(data.answer || '')),
        reasoning.length ? agentDocxParagraph('思考摘要', 'Heading1') + reasoning.map(x => agentDocxParagraph(`- ${x}`)).join('') : '',
        trace.length ? agentDocxParagraph('工具调用', 'Heading1') + trace.map(x => agentDocxParagraph(`- ${x}`)).join('') : '',
        citations.length ? agentDocxParagraph('数据来源', 'Heading1') + citations.map(x => agentDocxParagraph(`- ${x}`)).join('') : ''
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
    agentDownloadBlob(`agent_report_${Date.now()}.docx`, docx);
    showToast?.('分析报告 DOCX 已生成并下载', 'success');
}

function openScatterChartModal() {
    const option = window._lastScatterOption;
    if (!option) {
        showToast?.('请先生成散点图', 'warn');
        return;
    }
    const old = document.getElementById('scatter-chart-modal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'scatter-chart-modal';
    modal.className = 'scatter-chart-modal';
    modal.innerHTML = `
        <div class="scatter-modal-shell">
            <div class="scatter-modal-head">
                <span class="scatter-modal-hint">滚轮缩放 · 拖动平移 · 悬停查看名称与数值</span>
                <strong>散点图交互查看</strong>
                <button type="button" class="scatter-modal-close" aria-label="关闭">×</button>
            </div>
            <div id="scatter-modal-chart" class="scatter-modal-chart"></div>
        </div>`;
    document.body.appendChild(modal);
    const modalHead = modal.querySelector('.scatter-modal-head');
    const modalTitle = modalHead?.querySelector('strong');
    const modalHint = modalHead?.querySelector('.scatter-modal-hint');
    const modalClose = modalHead?.querySelector('.scatter-modal-close');
    if (modalTitle) modalTitle.textContent = '散点图交互查看';
    if (modalHint) modalHint.textContent = '滚轮缩放 · 拖动平移 · 悬停查看名称与数值';
    if (modalClose) {
        modalClose.textContent = '×';
        modalClose.setAttribute('aria-label', '关闭');
    }
    const close = () => {
        const chart = echarts.getInstanceByDom(document.getElementById('scatter-modal-chart'));
        if (chart) chart.dispose();
        modal.remove();
    };
    modal.querySelector('.scatter-modal-close').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    const chart = initEChartSafe(document.getElementById('scatter-modal-chart'));
    chart.setOption(option);
    setTimeout(() => chart.resize(), 60);
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
    actions.push({ id: 'open-data-table', label: '查看明细', icon: 'table' });
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
initLandingScrollHint();
initSdufeCover();
refineLandingCapabilities();
refineRagCapabilityBadges();
initSheetSwitchGuide();
initPaginationGuide();
ensureDashboardAnalysisVisible();
init();
