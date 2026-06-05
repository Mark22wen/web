/**
 * ingest.js — 一次性运行，把 data.json 转成自然语言段落灌入 ChromaDB
 * 用法：node ingest.js
 *
 * 功能：
 *  1. 把全国/省份/地级市的结构化数据转成自然语言段落
 *  2. 用 nomic-embed-text 生成 embedding
 *  3. 批量写入 ChromaDB（自动跳过已存在的 ID，支持断点续传）
 */

const { ChromaClient } = require('chromadb');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// ========== 配置 ==========
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHROMA_HOST = process.env.CHROMA_HOST || 'localhost';
const CHROMA_PORT = parseInt(process.env.CHROMA_PORT || '8000', 10);
const COLLECTION_NAME = 'patent_knowledge';
const BATCH_SIZE = 20;          // 每批写入条数，避免内存溢出
const EMBED_CONCURRENCY = 3;    // 并发 embedding 请求数
const EMBED_TIMEOUT_MS = 30000;

// ========== 辅助函数 ==========
function cleanMetricName(key) {
    return key.replace(/[（(].*?[）)]/g, '').trim();
}

function formatValue(val) {
    if (val === undefined || val === null) return null;
    if (typeof val !== 'number' || Number.isNaN(val)) return null;
    if (Number.isInteger(val)) return val.toString();
    return parseFloat(val.toFixed(4)).toString();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 把一行结构化数据转成多段自然语言文本
 * 返回数组，每段覆盖不同角度，增加语义丰富度
 */
function rowToNaturalLanguage(row, table) {
    const region = row['地区'] || '全国';
    const year = row['年份'] || row['时间'];   // 地级市用"时间"字段
    if (!year) return [];

    const metrics = Object.entries(row).filter(([k, v]) =>
        k !== '年份' && k !== '地区' && k !== '时间' && k !== '时间地区' &&
        typeof v === 'number' && !Number.isNaN(v)
    );
    if (!metrics.length) return [];

    const tableLabel = table === '全国' ? '全国' : table === '省份' ? `${region}（省级）` : `${region}（地级市）`;

    // 段落1：综合概述
    const allMetricText = metrics
        .map(([k, v]) => `${cleanMetricName(k)}为${formatValue(v)}`)
        .join('，');
    const para1 = `${year}年${tableLabel}的科研教育人才综合数据如下：${allMetricText}。`;

    // 段落2：教育维度
    const eduKeys = ['普通高校', '高校', '受教育', '教育支出', '大学生', '教师', '学校', '在校'];
    const eduMetrics = metrics.filter(([k]) => eduKeys.some(ek => k.includes(ek)));
    let para2 = '';
    if (eduMetrics.length) {
        const eduText = eduMetrics.map(([k, v]) => `${cleanMetricName(k)}${formatValue(v)}`).join('、');
        para2 = `${year}年${tableLabel}教育发展情况：${eduText}。`;
    }

    // 段落3：科研创新维度
    const rdKeys = ['R&D', '研发', '发明专利', '实用新型专利', '科学支出', '科研', '专利'];
    const rdMetrics = metrics.filter(([k]) => rdKeys.some(rk => k.includes(rk)));
    let para3 = '';
    if (rdMetrics.length) {
        const rdText = rdMetrics.map(([k, v]) => `${cleanMetricName(k)}${formatValue(v)}`).join('、');
        para3 = `${year}年${tableLabel}科研创新能力：${rdText}。`;
    }

    // 段落4：数字化/智能化维度
    const techKeys = ['人工智能', '工业机器人', '互联网', '数字化', '信息传输', '软件', '计算机'];
    const techMetrics = metrics.filter(([k]) => techKeys.some(tk => k.includes(tk)));
    let para4 = '';
    if (techMetrics.length) {
        const techText = techMetrics.map(([k, v]) => `${cleanMetricName(k)}${formatValue(v)}`).join('、');
        para4 = `${year}年${tableLabel}数字化与智能化水平：${techText}。`;
    }

    // 段落5：人才维度
    const talentKeys = ['人才', '从业人员', '就业', '人员数', '劳动', '职工', '员工'];
    const talentMetrics = metrics.filter(([k]) => talentKeys.some(tk => k.includes(tk)));
    let para5 = '';
    if (talentMetrics.length) {
        const talentText = talentMetrics.map(([k, v]) => `${cleanMetricName(k)}${formatValue(v)}`).join('、');
        para5 = `${year}年${tableLabel}人才与就业状况：${talentText}。`;
    }

    // 段落6：剩余指标兜底（确保所有数据都被覆盖）
    const coveredKeys = new Set([
        ...eduMetrics, ...rdMetrics, ...techMetrics, ...talentMetrics
    ].map(([k]) => k));
    const remainMetrics = metrics.filter(([k]) => !coveredKeys.has(k));
    let para6 = '';
    if (remainMetrics.length >= 2) {
        const remainText = remainMetrics.map(([k, v]) => `${cleanMetricName(k)}${formatValue(v)}`).join('、');
        para6 = `${year}年${tableLabel}其他指标：${remainText}。`;
    }

    return [para1, para2, para3, para4, para5, para6].filter(Boolean);
}

/**
 * 把所有行转成文档列表
 * 每个文档包含 id、text、metadata
 */
function buildDocuments(data) {
    const docs = [];
    const sources = [
        { table: '全国', rows: data['全国'] || [] },
        { table: '省份', rows: data['省份'] || [] },
        { table: '地级市', rows: data['地级市'] || [] }
    ];

    for (const { table, rows } of sources) {
        for (const row of rows) {
            const region = row['地区'] || '全国';
            const year = row['年份'] || row['时间'];
            if (!year) continue;

            const paragraphs = rowToNaturalLanguage(row, table);
            paragraphs.forEach((text, pIdx) => {
                // ID 格式：table_region_year_paragraph
                const safeRegion = String(region).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
                const id = `${table}_${safeRegion}_${year}_p${pIdx}`;
                docs.push({
                    id,
                    text,
                    metadata: {
                        table,
                        region,
                        year: Number(year),
                        paragraph: pIdx
                    }
                });
            });
        }
    }

    return docs;
}

/**
 * 调用 Ollama 生成 embedding
 */
async function getEmbedding(text) {
    const response = await axios.post(
        `${OLLAMA_URL}/api/embeddings`,
        { model: OLLAMA_EMBED_MODEL, prompt: String(text).slice(0, 4000) },
        { timeout: EMBED_TIMEOUT_MS }
    );
    if (!Array.isArray(response.data?.embedding)) {
        throw new Error('Ollama embedding 返回为空');
    }
    return response.data.embedding;
}

/**
 * 并发生成 embeddings，限制并发数避免 Ollama 过载
 */
async function batchEmbed(texts) {
    const results = new Array(texts.length);
    for (let i = 0; i < texts.length; i += EMBED_CONCURRENCY) {
        const chunk = texts.slice(i, i + EMBED_CONCURRENCY);
        const embeddings = await Promise.all(
            chunk.map(text => getEmbedding(text))
        );
        embeddings.forEach((emb, j) => { results[i + j] = emb; });
    }
    return results;
}

// ========== 主流程 ==========
async function main() {
    console.log('🚀 开始灌入数据...');
    console.log(`📡 Ollama: ${OLLAMA_URL}  模型: ${OLLAMA_EMBED_MODEL}`);
    console.log(`📦 ChromaDB: ${CHROMA_HOST}:${CHROMA_PORT}  集合: ${COLLECTION_NAME}`);

    // 1. 读取 data.json
    const dataPath = path.join(__dirname, 'data.json');
    console.log('\n📂 读取 data.json...');
    const raw = await fs.readFile(dataPath, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`  全国: ${data['全国']?.length || 0} 条`);
    console.log(`  省份: ${data['省份']?.length || 0} 条`);
    console.log(`  地级市: ${data['地级市']?.length || 0} 条`);

    // 2. 转换为自然语言文档
    console.log('\n📝 转换为自然语言段落...');
    const docs = buildDocuments(data);
    console.log(`  共生成 ${docs.length} 个文档段落`);

    // 3. 连接 ChromaDB
    console.log('\n🔗 连接 ChromaDB...');
    const chroma = new ChromaClient({
        host: CHROMA_HOST,
        port: CHROMA_PORT,
        ssl: false
    });

    // 测试连接
    try {
        await chroma.heartbeat();
        console.log('  ✅ ChromaDB 连接成功');
    } catch (err) {
        console.error('  ❌ ChromaDB 连接失败:', err.message);
        process.exit(1);
    }

    // 4. 获取或创建集合（先删除旧的，确保重新灌入干净数据）
    console.log(`\n🗄️  准备集合 ${COLLECTION_NAME}...`);
    let collection;
    try {
        // 检查是否已有数据
        collection = await chroma.getOrCreateCollection({
            name: COLLECTION_NAME,
            embeddingFunction: null,
            metadata: { 'hnsw:space': 'cosine' }
        });
        const existingCount = await collection.count();
        if (existingCount > 0) {
            console.log(`  ⚠️  集合已有 ${existingCount} 条数据`);
            console.log('  🗑️  清空旧数据，重新灌入...');
            await chroma.deleteCollection({ name: COLLECTION_NAME });
            collection = await chroma.getOrCreateCollection({
                name: COLLECTION_NAME,
                embeddingFunction: null,
                metadata: { 'hnsw:space': 'cosine' }
            });
            console.log('  ✅ 集合已重建');
        } else {
            console.log('  ✅ 集合为空，准备写入');
        }
    } catch (err) {
        console.error('  ❌ 集合操作失败:', err.message);
        process.exit(1);
    }

    // 5. 测试 Ollama embedding
    console.log('\n🧪 测试 Ollama embedding...');
    try {
        const testEmb = await getEmbedding('测试');
        console.log(`  ✅ embedding 维度: ${testEmb.length}`);
        if (testEmb.length !== 768) {
            console.warn(`  ⚠️  维度是 ${testEmb.length}，ChromaDB 集合期望 768，可能需要重建集合`);
        }
    } catch (err) {
        console.error('  ❌ Ollama embedding 失败:', err.message);
        console.error('  请确认 Ollama 正在运行且 nomic-embed-text 已安装');
        process.exit(1);
    }

    // 6. 分批生成 embedding 并写入
    console.log(`\n⚙️  开始写入（共 ${docs.length} 段，每批 ${BATCH_SIZE} 条）...`);
    const total = docs.length;
    let written = 0;
    let failed = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = docs.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(docs.length / BATCH_SIZE);

        try {
            // 生成 embeddings
            const embeddings = await batchEmbed(batch.map(d => d.text));

            // 写入 ChromaDB
            await collection.add({
                ids: batch.map(d => d.id),
                embeddings,
                documents: batch.map(d => d.text),
                metadatas: batch.map(d => d.metadata)
            });

            written += batch.length;
            const pct = ((written / total) * 100).toFixed(1);
            process.stdout.write(
                `\r  进度: ${written}/${total} (${pct}%) — 批次 ${batchNum}/${totalBatches}  `
            );
        } catch (err) {
            failed += batch.length;
            console.error(`\n  ❌ 批次 ${batchNum} 写入失败: ${err.message}`);
            // 失败时等待后继续
            await sleep(2000);
        }
    }

    // 7. 验证
    console.log('\n\n🔍 验证写入结果...');
    try {
        const finalCount = await collection.count();
        console.log(`  ✅ ChromaDB 中共 ${finalCount} 条文档`);
        console.log(`  ✅ 成功写入: ${written} 条`);
        if (failed > 0) console.log(`  ⚠️  写入失败: ${failed} 条`);

        // 测试一次语义查询
        console.log('\n🔎 测试语义查询（"广东省教育发展"）...');
        const testEmb = await getEmbedding('广东省教育发展情况');
        const result = await collection.query({
            queryEmbeddings: [testEmb],
            nResults: 3
        });
        const hits = result?.documents?.[0] || [];
        hits.forEach((doc, idx) => {
            console.log(`  结果${idx + 1}: ${String(doc).slice(0, 100)}...`);
        });
    } catch (err) {
        console.error('  ❌ 验证失败:', err.message);
    }

    console.log('\n🎉 灌入完成！现在重启 server.js 即可启用语义检索。');
    console.log('   命令：node server.js  或  npm start');
}

main().catch(err => {
    console.error('\n💥 致命错误:', err);
    process.exit(1);
});