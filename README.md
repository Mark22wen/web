# 科研教育人才一体化数据平台 · 开发说明书

> 山东财经大学 · 全栈单体应用  
> Node.js 后端 + 原生前端（无框架）+ ChromaDB 向量数据库 + DeepSeek / Ollama LLM

---

## 目录

1. [项目简介](#1-项目简介)
2. [技术栈总览](#2-技术栈总览)
3. [目录结构](#3-目录结构)
4. [文件使用顺序](#4-文件使用顺序)
5. [依赖安装](#5-依赖安装)
6. [环境变量配置](#6-环境变量配置)
7. [ChromaDB 向量库安装与启动](#7-chromadb-向量库安装与启动)
8. [数据文件说明](#8-数据文件说明)
9. [启动方式](#9-启动方式)
10. [网站逐步构建思路](#10-网站逐步构建思路)
11. [RAG 实现流程](#11-rag-实现流程)
12. [Agent 决策流程](#12-agent-决策流程)
13. [前端图表渲染流程](#13-前端图表渲染流程)
14. [SSE 流式推送流程](#14-sse-流式推送流程)
15. [提交包与本地运行](#15-提交包与本地运行)
16. [常见问题](#16-常见问题)

---

## 1. 项目简介

本平台是一个面向高校科研管理场景的**数智化数据分析平台**，主要功能：

- **数据看板**：以 ECharts 可视化展示全国/省份/地级市科研教育指标（普通高校数量、工业机器人密度、杰青/长江学者等 30+ 指标）
- **AI 数据分析助手**：自然语言问答，支持趋势分析、排名、区域对比、预测（线性回归 / Holt 指数平滑 / 平均漂移外推 / 近年移动均值）、复合问题拆解
- **知识检索（RAG）**：基于 ChromaDB + FlexSearch 的混合检索，支持报告/白皮书语义问答
- **数据导出**：图表 PNG 导出、数据 Excel 导出、对话内容 DOCX 报告导出

---

## 2. 技术栈总览

| 层级 | 技术 | 用途 |
|------|------|------|
| 后端运行时 | Node.js 18+ | Express HTTP/SSE 服务 |
| LLM 接入 | DeepSeek API（优先）/ Ollama（本地降级） | 路由决策、实体提取、回答润色 |
| 向量数据库 | ChromaDB（Python 服务，本地 8000 端口） | 知识文档语义检索 |
| 全文检索 | FlexSearch | BM25 风格关键词检索 + 本地混合知识索引 |
| 统计计算 | simple-statistics | 皮尔逊相关、线性回归、预测区间 |
| 前端渲染 | 原生 HTML + CSS + JS（无框架） | 数据看板、AI 对话、图表 |
| 图表库 | ECharts 5.4（CDN） | 折线图、柱状图、散点图、气泡图、蝴蝶图 |
| 数据解析 | XLSX.js（CDN） | 前端直接解析 Excel 文件 |

---

## 3. 目录结构

```
rag-backend/
├── server.js              # 后端主文件（全部逻辑）
├── data.json              # 结构化数据缓存（全国/省份/地级市三张表）
├── chroma_db/             # 已构建的 ChromaDB 向量库（提交包可附带）
├── package.json           # Node.js 依赖声明
├── .env                   # 环境变量（本地演示用，包含 API Key 时请勿公开传播）
├── public/
│   ├── index.html         # 单页应用入口（SVG 图标、页面骨架、内联 JS）
│   ├── script.js          # 前端全部逻辑
│   ├── style.css          # 全部样式
│   └── images/            # 静态图片（Logo 等）
│   └── 资料/              # PDF 报告白皮书（直接通过 /资料/xxx.pdf 访问）
│       └── PDF名单/       # 历年人才名单 PDF
└── node_modules/          # 依赖包（npm install 生成）
```

**说明：**
- `data.json` 由外部 ETL 脚本生成，格式见第 8 节。平台启动时一次性加载进内存。
- `public/资料/` 下的 PDF 通过 Express 静态文件服务直接暴露，无需额外路由。
- `data.json` 由 `convert_to_json.py` 生成，约 20 MB，包含全国/省份/地级市三张表的完整数据。

---

## 4. 文件使用顺序

本节说明各脚本和配置文件的用途及执行顺序，分**首次部署**和**日常维护**两种场景。

### 脚本文件一览

| 文件 | 语言 | 作用 |
|------|------|------|
| `public/convert_to_json.py` | Python | 将 Excel 原始数据表转换为 `data.json`，是平台数据的唯一来源 |
| `ingest.js` | Node.js | 将 `data.json` 中的结构化数据转为自然语言段落并写入 ChromaDB |
| `knowledge_ingest.py` | Python | 将 `public/资料/` 下的 PDF、Word、Excel 文档向量化后写入 ChromaDB |
| `url_ingest.py` | Python | 爬取指定网页/微信文章写入 ChromaDB（可选，补充网络内容） |
| `check_chroma.py` | Python | 诊断工具：检查 ChromaDB 连接状态和已存储文档数量 |
| `server.js` | Node.js | 后端主服务，包含全部 API、检索、Agent 逻辑 |
| `public/index.html` | HTML | 前端单页入口，直接由浏览器加载 |
| `public/script.js` | JS | 前端全部交互逻辑 |
| `public/style.css` | CSS | 全部样式 |

---

### 首次部署流程

**第 1 步：准备结构化数据（Excel → data.json）**

将原始数据 Excel（含`全国`、`省份`、`地级市`三张工作表）放入 `public/` 目录，然后运行：

```bash
cd public
python convert_to_json.py
```

生成 `data.json`（约 20 MB），放于项目根目录。这是平台图表和 AI 数据分析的数据来源，**只需生成一次**，数据更新时重新运行。

---

**第 2 步：安装 Node.js 依赖**

```bash
cd rag-backend
npm install
```

---

**第 3 步：配置 `.env`**

复制或新建 `.env`，填写 `DEEPSEEK_API_KEY`（或留空使用本地 Ollama）。详见第 6 节。

---

**第 4 步：启动 ChromaDB（可跳过）**

若需要语义检索（报告/白皮书问答），先启动 ChromaDB：

```bash
pip install chromadb
chroma run --path ./chroma_db
```

若跳过此步，在 `.env` 中设置 `DISABLE_CHROMA=true`，系统自动降级为本地关键词检索，其他功能不受影响。

---

**第 5 步：知识文档入库**

若需要从零重建完整向量库，先将 `data.json` 中的结构化数据写入 ChromaDB：

```bash
node ingest.js
```

再将 PDF / Word / Excel 报告放入 `public/资料/`，然后运行：

```bash
# 安装 Python 依赖（首次）
pip install pymupdf4llm pdfplumber pymupdf python-docx openpyxl requests

# 增量入库（已有的 chunk 自动跳过，可多次运行）
python knowledge_ingest.py

# 可选：爬取网页内容入库
pip install beautifulsoup4
python url_ingest.py
```

入库完成后可用诊断工具验证：

```bash
python check_chroma.py
# 输出示例：✅ ChromaDB 连接正常，总量: N 条（以实际为准）
```

---

**第 6 步：启动服务**

```bash
node server.js
# 或
npm start
```

访问 `http://localhost:3001`，平台即可使用。

---

### 日常维护

| 场景 | 操作 |
|------|------|
| **更新统计数据**（新一年 Excel） | 替换 Excel → 重跑 `python public/convert_to_json.py` → 重启 `server.js` |
| **重建结构化数据向量库** | 确认 ChromaDB 与 Ollama/bge-m3 已启动 → 运行 `node ingest.js` |
| **新增报告 PDF** | 把 PDF 放入 `public/资料/` → 运行 `python knowledge_ingest.py` |
| **重建特定文档**（内容改动） | `python knowledge_ingest.py --file 报告名.pdf --force` |
| **全量重建知识库**（换嵌入模型） | `python knowledge_ingest.py --drop-collection` → `python knowledge_ingest.py --force` |
| **补写 metadata**（不重新嵌入） | `python knowledge_ingest.py --update-meta` |
| **检查向量库状态** | `python check_chroma.py` |

---

### 数据流向总览

```
基础数据汇总.xlsx
        │
        ▼
convert_to_json.py  ──→  data.json  ──→  server.js（启动时加载）
        │                                       │
        └────────────→  ingest.js  ────────────┤
                                                ▼
public/资料/*.pdf
public/资料/*.docx   ──→  knowledge_ingest.py  ──→  ChromaDB（知识向量库）
public/资料/*.xlsx                                       │
url_ingest.py（网页）──────────────────────────────────┘
                                                         │
                                              server.js 检索 + LLM
                                                         │
                                              浏览器 ← index.html / script.js
```

---

## 5. 依赖安装

### 前提条件

- Node.js 18 或更高版本（`node -v` 检查）
- Python 3.10+（仅 ChromaDB 需要，纯本地模式可跳过）

### 安装 Node 依赖

```bash
cd rag-backend
npm install
```

安装后 node_modules 中应包含以下核心包：

| 包名 | 版本 | 用途 |
|------|------|------|
| express | ^4.22 | HTTP 服务框架 |
| cors | ^2.8 | 跨域请求处理 |
| dotenv | ^16.6 | .env 配置读取 |
| axios | ^1.16 | HTTP 客户端（Ollama 调用） |
| chromadb | ^3.4 | ChromaDB 客户端 |
| flexsearch | ^0.8 | BM25 全文检索 |
| simple-statistics | ^7.8 | 统计函数（回归、相关性） |
| ollama | ^0.6 | Ollama 本地 LLM 接口 |
| uuid | ^14 | 会话 ID 生成（预留依赖） |
| natural | ^8.1 | NLP 辅助（预留依赖，当前主要用 DeepSeek/Ollama） |
| @xenova/transformers | ^2.17 | 本地嵌入模型（预留依赖，当前嵌入走 Ollama bge-m3） |

---

## 6. 环境变量配置

在项目根目录创建 `.env` 文件：

```env
# ── LLM 配置 ──────────────────────────────────────────────
# 填写 DeepSeek API Key 后自动启用 API 模式；留空则降级到本地 Ollama
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_MODEL=deepseek-chat          # 或 deepseek-reasoner

# 本地 Ollama（DEEPSEEK_API_KEY 为空时使用）
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=deepseek-r1:7b
OLLAMA_EMBED_MODEL=bge-m3
OLLAMA_TIMEOUT_MS=120000

# ── 服务配置 ──────────────────────────────────────────────
PORT=3001
ALLOWED_ORIGINS=                      # 额外允许的跨域来源，逗号分隔
ENABLE_DEBUG_ROUTES=false             # true 时开启 /api/debug/chroma 诊断接口

# ── 会话管理 ──────────────────────────────────────────────
MAX_HISTORY=12                        # 每个会话保留的最大对话轮数
SESSION_TTL_MINUTES=30                # 会话空闲超时（分钟）
MAX_SESSIONS=500                      # 最大并发会话数
DISABLE_HISTORY=false                 # true 时完全关闭历史记忆

# ── ChromaDB ──────────────────────────────────────────────
DISABLE_CHROMA=false                  # true 时跳过 ChromaDB，仅用本地混合检索

# ── 网络搜索（可选，不填时跳过） ──────────────────────────
TAVILY_API_KEY=
SERPER_API_KEY=
```

---

## 7. ChromaDB 向量库安装与启动

ChromaDB 是一个独立的 Python 进程，提供向量存储和语义检索服务。平台不强依赖它——若连接失败会自动降级为本地混合检索（FlexSearch）。

### 安装

```bash
pip install chromadb
```

### 启动 ChromaDB 服务

```bash
# 在独立终端中运行，默认监听 localhost:8000
chroma run --path ./chroma_db
```

### 向量库初始化（首次使用）

将 `data.json` 结构化数据写入 ChromaDB 使用 `node ingest.js`；将 PDF/Word/Excel 知识文档写入 ChromaDB 使用 `knowledge_ingest.py`。写入后 server.js 在启动时自动连接并建立 BM25 索引。

若 `patent_knowledge` Collection 为空，平台会使用本地混合索引兜底，正常功能不受影响。

---

## 8. 数据文件说明

### data.json 格式

```json
{
  "全国": [
    { "年份": 2015, "普通高校数量": 2560, "工业机器人密度": 49.0, ... }
  ],
  "省份": [
    { "年份": 2015, "地区": "广东省", "普通高校数量": 143, ... },
    { "年份": 2015, "地区": "江苏省", ... }
  ],
  "地级市": [
    { "年份": 2020, "地区": "济南市", "科学支出水平": 0.031, ... }
  ]
}
```

**注意：** 地级市原始数据可能使用`时间`字段而非`年份`，server.js 在 `loadDataCache()` 中自动重命名统一。

### 更新数据

替换 `data.json` 后重启服务即可，无需重建向量库。

---

### 知识文档入库说明

#### 已处理的资料

| 资料类型 | 存放位置 | 处理方式 |
|----------|----------|----------|
| 结构化统计数据 | `data.json` | `ingest.js` 将全国/省份/地级市数据转为自然语言段落，使用 bge-m3 向量化后写入 ChromaDB |
| PDF 报告、白皮书（政策文件、行业报告） | `public/资料/*.pdf` | `knowledge_ingest.py` 用 pymupdf4llm / pdfplumber 提取正文，按 600 字切块（重叠 100 字），bge-m3 向量化后存入 ChromaDB |
| Word 文档（.docx） | `public/资料/*.docx` | 同上（python-docx 提取段落） |
| 名单类 Excel（`.xlsx`） | `public/资料/PDF名单/` | 由 `knowledge_ingest.py` 以"整行描述"格式读取，作为知识文档入库 |
| 网页文章（可选） | 无本地文件 | `url_ingest.py` 爬取后写入 ChromaDB，与本地文档共用同一集合 |

> 具体入库了哪些文件、共多少条 chunk，可运行 `python check_chroma.py` 查看（示例输出：`✅ ChromaDB 连接正常，总量: N 条（以实际为准）`）。

#### 未处理的资料

| 内容 | 原因 |
|------|------|
| 原始 Excel 统计数据（`基础数据汇总.xlsx`） | 不直接入库，先通过 `convert_to_json.py` 转为 `data.json`，再由 `ingest.js` 写入向量库 |
| PDF 中的图片、表格图（非文字部分） | 默认跳过；若本地有 LLaVA 视觉模型，运行 `python knowledge_ingest.py`（不带 `--no-vision`）可自动识别图表内容 |
| 未放入 `public/资料/` 的文件 | `knowledge_ingest.py` 只扫描该目录，其他位置不会被入库 |

---

## 9. 启动方式

```bash
# 同时启动 ChromaDB（若需要语义检索）
chroma run --path ./chroma_db &

# 启动 Node.js 服务
node server.js
# 或使用 npm
npm start

# 可选：运行基础语法检查
npm test
```

访问 `http://localhost:3001`

启动日志示例：
```
🚀 服务启动 → http://localhost:3001
🤖 推理引擎: DeepSeek API (deepseek-chat)
📊 共加载 71 个指标：科学支出水平、工业机器人密度...
✅ 本地混合知识索引构建完成 (N条，取决于 data.json 数据量)
✅ ChromaDB 知识库已连接: patent_knowledge / N 条（取决于已入库文档数量）
✅ BM25 索引构建完成 (N 条知识文档)
✅ 就绪，等待提问...
```

---

## 10. 网站逐步构建思路

### 第一阶段：数据看板（纯前端）

最初平台只是一个数据可视化看板。前端通过 `/api/data` 加载 `data.json`，使用 XLSX.js 解析数据，ECharts 渲染图表。

核心交互：
- 左侧指标面板 → 选择指标
- 顶部工具栏 → 切换图表类型（折线/柱状）、调整年份范围
- 数据明细表 → 支持排序、列选择、导出 Excel

### 第二阶段：RAG 知识问答

在看板基础上增加 AI 助手入口（浮动按钮 → 全屏对话）。

后端加入：
- ChromaDB 向量数据库存储 PDF 报告内容
- FlexSearch BM25 全文检索作为向量检索的补充
- `/api/agent/stream` SSE 端点，实时推送回答

前端加入：
- RAG 全屏界面（左侧会话列表 + 右侧对话区）
- 流式打字机效果
- 来源引用渲染

### 第三阶段：结构化数据 Agent

将 RAG 扩展为能操作结构化数据的 Agent 系统：
- `llmDecideAction` 决策函数替代纯关键词路由
- 新增 `executeTool` 执行六种数据工具（趋势/排名/对比/预测/单点/相关性）
- 四种预测算法（线性回归、Holt 指数平滑、平均漂移外推、近年移动均值）
- 复合问题拆解（`planCompoundQuestions` + `runAgentBatch`）

### 第四阶段：体验优化

- SDUFE 封面动效（brush reveal 效果）
- 夜间模式
- 对话历史持久化（LocalStorage）
- AI 回复内联图表（点击"展开图表"直接在气泡内渲染）
- 追问建议按钮（`.rag-suggestion`）
- 主流 RAG condense question 机制（LangChain 风格）

---

## 11. RAG / Corrective RAG 实现流程

### 检索策略：混合检索（Hybrid Retrieval）

```
用户问题
    │
    ├─── ChromaDB 向量检索（语义相似度）
    │        └─ 使用 HyDE（假设文档扩展）提升召回率
    │
    ├─── BM25 关键词检索（FlexSearch）
    │        └─ 针对 patent_knowledge Collection 中的知识文档
    │
    └─── 本地混合索引检索（兜底）
             └─ hybridDocuments：全量数据行的文本化快照

三路结果 → RRF 重排序（Reciprocal Rank Fusion）→ 取 Top-K
```

### 纠正式 RAG 流程（Corrective RAG）

平台在普通混合检索外增加了证据质量评估和自动纠正步骤，避免低相关证据直接进入生成阶段：

```
用户问题
    │
    ├─ 第一轮混合检索：本地结构化索引 + BM25 + ChromaDB + HyDE
    │
    ├─ 证据质量评估
    │     ├─ 规则评估：指标/地区/年份命中、召回数量、向量距离
    │     └─ LLM 评估：correct / ambiguous / incorrect
    │
    ├─ 若证据不足：
    │     ├─ rewriteQueryForCorrectiveRag() 改写查询
    │     ├─ 第二轮重新检索
    │     └─ 必要时 webSearchFallback() 网络搜索兜底
    │
    ├─ refineKnowledge() 提取与问题直接相关的证据片段
    │
    └─ 证据约束生成：只基于召回证据组织回答并返回 citations
```

### 知识问答流程（answerEvidenceChat）

```
问题 + 检索到的证据片段
    │
    ├─ 第一次检索：ChromaDB + BM25 + 本地混合索引
    │
    ├─ 检索质量评估 → 必要时改写查询并第二次检索
    │
    ├─ 若仍不足 → 可选网络搜索兜底
    │
    ├─ 知识精炼 → 提取关键片段
    │
    ├─ 实体继承（上下文追问时补全 region/metric）
    │
    ├─ 构造 Prompt：
    │   "你是数据分析助手，根据以下证据回答问题：
    │    [证据1] [证据2] ... 问题：xxx"
    │
    └─ LLM 生成回答 → 提取引用来源 → 返回
```

### 上下文压缩（Condense Question）

参考 LangChain `ConversationalRetrievalChain` 的主流做法：

```
if 追问较短（<25字）且无明显独立信息：
    将最近 4 条历史 + 当前问题发给 LLM
    → 重写为独立完整问题（max_tokens=80，极低延迟）
else：
    直接使用原问题（跳过 LLM 调用）
```

---

## 12. Agent 决策流程

用户每次提问经过以下流水线：

```
用户输入
    │
    ├─ 1. 快速拦截层（无需 LLM）
    │     ├─ 指标列表查询 → 直接返回
    │     ├─ 年份/地区覆盖查询 → 直接返回
    │     ├─ 能力/功能查询 → 直接返回
    │     ├─ 全球话题 / 报告查询 → 跳转 evidence_chat
    │     └─ 打招呼 → answerGeneralChat
    │
    ├─ 2. 问题压缩（condenseQuestion）
    │     └─ 将追问改写为独立完整问题
    │
    ├─ 3. LLM 路由决策（llmDecideAction）
    │     └─ 输出：tool + params + regions + metric
    │     工具选项：
    │       trend_analysis / get_ranking / compare /
    │       forecast / point_query / evidence_chat /
    │       answer_directly / ask_clarification / forecast_compare
    │
    ├─ 4. LLM 决策失败 → 规则降级（ruleBasedDecide）
    │
    ├─ 5. 实体提取（extractEntitiesAsync）
    │     └─ 复用 llmDecideAction 结果，避免重复 LLM 调用
    │
    ├─ 6. 并行执行
    │     ├─ executeTool（结构化数据查询）
    │     └─ retrieveChromaEvidence（知识库检索，用于补充回答）
    │
    ├─ 7. 指标未找到 → 候选指标提示（findFuzzyMetrics）
    │
    ├─ 8. 生成文本（generateAnswer）
    │
    ├─ 9. LLM 润色（synthesizeConversationalAnswer）
    │     └─ 合并数据结果 + 知识证据 → 最终回答
    │
    └─ 10. 构建追问建议（buildFollowupSuggestions）→ 返回
```

### 复合问题拆解（runAgentBatch）

```
输入："预测山东高校数量，再给我广东机器人密度排名"
    │
    ├─ looksLikeCompoundQuestion() → true（多意图）
    │
    ├─ planCompoundQuestions()（LLM）→ ["预测山东高校数量", "广东机器人密度排名"]
    │
    ├─ 逐题调用 runAgent()
    │
    └─ 合并回答，取第一个有效 chart，合并 citations/suggestions
```

### 预测算法（四选最优）

对每个预测问题并行跑四种方法，选残差最小者作为推荐结果：

| 方法 | 适用场景 |
|------|----------|
| 线性回归趋势 | 稳定增长/下降趋势 |
| Holt 线性指数平滑 | 有趋势、近期数据权重高 |
| 平均漂移外推 | 逐年变化量稳定 |
| 近年移动均值趋势 | 短期波动较大、近年数据更可信 |

---

## 13. 前端图表渲染流程

### 内联图表（AI 气泡内）

```
用户点击"展开图表"按钮
    │
    renderAgentChartInsideBubble(bubble, data.chart)
    │
    ├─ 在气泡内创建 .agent-inline-chart-wrap > .agent-inline-chart
    │
    └─ requestAnimationFrame → _doRenderInlineChart(chartId, config, false)
            │
            ├─ 从 window.workbook 查找对应数据表（全国/省份/地级市）
            ├─ 模糊匹配字段名（支持括号内注释差异）
            ├─ 地级市数据自动检测（优先级：地级市 > 省份 > 全国）
            ├─ initEChartSafe(chartDom, { width, height })
            └─ ResizeObserver 监听容器宽度变化 → 自动 resize
```

### 图表类型判断

- `config.type === 'line'`：折线/面积图（趋势查询）
- `config.type === 'bar'` + 单年份：横向排名柱状图
- `config.type === 'bar'` + 多年份 + 多地区：分组柱状图
- `config.type === 'correlation'`：双 Y 轴折线 + 散点相关性图

---

## 14. SSE 流式推送流程

```
POST /api/agent/stream
    │
    ├─ 写入 SSE 响应头（Content-Type: text/event-stream）
    │
    ├─ 启动进度定时器（每 1.4s 发一条 status 事件）
    │   {"type":"status","step":0,"text":"正在分析问题…"}
    │
    ├─ await runAgentBatch()（≈0.5~5s）
    │
    ├─ 停止进度定时器
    │
    ├─ 逐块推送回答文字（每 4 字一块，10ms 间隔）
    │   {"type":"token","text":"近10年工业"}
    │
    ├─ 推送元数据（一次性）
    │   {"type":"done","chart":{...},"citations":[...],"suggestions":[...]}
    │
    └─ res.end()

前端接收：
    ├─ status → 更新进度条文字
    ├─ token → 追加到气泡 innerHTML
    └─ done → 渲染来源/追问建议/action 按钮，180ms 后调用 executeAgentUiActions
```

---

## 15. 提交包与本地运行

### 提交包内容

压缩包结构如下（已排除 `node_modules/` 和 `.git/`）：

```text
rag-backend/
├── server.js
├── package.json
├── package-lock.json
├── README.md
├── data.json
├── .env                  ← 含 API Key，仅用于验收体验，勿上传公开网盘
├── public/
├── chroma_db/            ← 已构建的向量库，可直接使用
├── ingest.js
├── knowledge_ingest.py
├── url_ingest.py
├── check_chroma.py
└── .gitignore
```

> ⚠️ `.env` 中含有 `DEEPSEEK_API_KEY`，仅供本地验收体验使用，请勿公开传播。

---

### 本地运行完整步骤

#### 前提：安装运行环境（首次运行需完成）

**① 安装 Node.js 18+**

前往官网下载 `.msi` 安装包（推荐，不要用 winget，可能 PATH 未自动更新）：

```
https://nodejs.org/zh-cn/download
```

安装时保持默认选项，安装完成后重新打开 PowerShell，验证：

```powershell
node -v   # 应显示 v18.x 或更高
npm -v
```

**② 安装 Python 3.10+ 及 ChromaDB（用于知识库语义检索）**

前往官网下载 Python：

```
https://www.python.org/downloads/
```

> ⚠️ 安装时勾选 **"Add Python to PATH"**，否则后续命令找不到 python/pip。

安装完成后，打开 PowerShell 安装 ChromaDB：

```powershell
pip install chromadb
```

如果网络较慢，可加国内镜像：

```powershell
pip install chromadb -i https://pypi.tuna.tsinghua.edu.cn/simple
```

---

#### 运行项目（每次启动）

**第 1 步：解压项目，切换到项目目录**

```powershell
cd D:\Users\lbc\Desktop\666\rag-backend   # 替换为实际解压路径
```

**第 2 步：安装 Node.js 依赖**

```powershell
npm install --ignore-scripts
```

> 加 `--ignore-scripts` 是为了跳过 `sharp` 等需要本地编译工具的包，避免报错。

如果遇到 "无法加载文件，因为在此系统上禁止运行脚本" 的错误，先执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

然后重新运行 `npm install --ignore-scripts`。

**第 3 步：启动 ChromaDB 向量库**（另开一个 PowerShell 窗口）

```powershell
cd D:\Users\lbc\Desktop\666\rag-backend
chroma run --path ./chroma_db
```

看到 `Running on http://localhost:8000` 即表示启动成功，**不要关闭此窗口**。

如果不需要报告/白皮书语义检索功能，也可以跳过此步，在项目的 `.env` 文件中添加一行：

```env
DISABLE_CHROMA=true
```

**第 4 步：启动网站后端**（再开一个 PowerShell 窗口）

```powershell
cd D:\Users\lbc\Desktop\666\rag-backend
node server.js
```

看到控制台输出：

```text
✅ 就绪，等待提问...
```

即表示启动成功，**不要关闭此窗口**。

**第 5 步：浏览器访问**

打开浏览器，输入：

```
http://localhost:3001
```

即可进入系统主界面。

---

#### 可选：本地 Ollama 部署（无需 DeepSeek API Key 的离线模式）

如果运行环境没有网络或 API Key 不可用，可以安装 Ollama 使用本地大模型：

```
https://ollama.com/download
```

安装后拉取所需模型（约 5~8 GB，需要时间）：

```powershell
ollama pull deepseek-r1:7b
ollama pull bge-m3
```

然后将 `.env` 中的 `DEEPSEEK_API_KEY` 设为空，系统会自动切换到本地 Ollama。

---

#### 常用检查命令

```powershell
# 验证 Node.js 版本
node -v

# 验证依赖已安装
npm list --depth=0

# 检查语法是否正常（可选）
npm test
```

---

## 16. 常见问题

### Q: 启动后 AI 无回答，控制台报 "DeepSeek API 超时"

检查 `.env` 中 `DEEPSEEK_API_KEY` 是否正确，以及网络是否能访问 `api.deepseek.com`。或者设置 `DEEPSEEK_API_KEY=` 留空，改用本地 Ollama。

### Q: ChromaDB 相关报错 `Connection refused`

ChromaDB 需要单独启动。如果不需要知识库语义检索，在 `.env` 中设置 `DISABLE_CHROMA=true` 跳过。

### Q: 地级市图表无数据（折线空白）

确认 `data.json` 的 `地级市` 表中该城市有对应指标。地级市原始字段名可能与省份表不同，server.js 已做模糊匹配（去括号后比对）。

### Q: 换了新数据集如何接入

1. 按 `data.json` 的三表格式（`全国` / `省份` / `地级市`）准备数据
2. 将 `年份` 和 `地区` 列名统一（地级市如使用`时间`会自动转换）
3. 替换 `data.json` 重启服务
4. 如有新指标，更新 `server.js` 顶部的 `METRIC_SYNONYMS` 词表以便语义识别

### Q: `npm install` 报 `sharp` 编译超时或失败

部分机器没有安装 Visual Studio C++ 构建工具，`sharp` 包会编译失败。改用：

```powershell
npm install --ignore-scripts
```

`sharp` 仅用于图片处理（PNG 导出优化），跳过编译不影响核心功能。

### Q: 如何修改端口

在 `.env` 中设置 `PORT=xxxx`。

---

*最后更新：2026-06*
