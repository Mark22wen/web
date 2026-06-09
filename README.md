# 科研教育人才一体化数据平台 · 开发说明书

> 山东财经大学 · 全栈单体应用  
> Node.js 后端 + 原生前端（无框架）+ ChromaDB 向量数据库 + DeepSeek / Ollama LLM

---

## 目录

1. [项目简介](#1-项目简介)
2. [技术栈总览](#2-技术栈总览)
3. [目录结构](#3-目录结构)
4. [依赖安装](#4-依赖安装)
5. [环境变量配置](#5-环境变量配置)
6. [ChromaDB 向量库安装与启动](#6-chromadb-向量库安装与启动)
7. [数据文件说明](#7-数据文件说明)
8. [启动方式](#8-启动方式)
9. [网站逐步构建思路](#9-网站逐步构建思路)
10. [RAG 实现流程](#10-rag-实现流程)
11. [Agent 决策流程](#11-agent-决策流程)
12. [前端图表渲染流程](#12-前端图表渲染流程)
13. [SSE 流式推送流程](#13-sse-流式推送流程)
14. [常见问题](#14-常见问题)

---

## 1. 项目简介

本平台是一个面向高校科研管理场景的**数智化数据分析平台**，主要功能：

- **数据看板**：以 ECharts 可视化展示全国/省份/地级市科研教育指标（普通高校数量、工业机器人密度、杰青/长江学者等 30+ 指标）
- **AI 数据分析助手**：自然语言问答，支持趋势分析、排名、区域对比、预测（ARIMA/线性/指数平滑/霍尔特）、复合问题拆解
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
├── package.json           # Node.js 依赖声明
├── .env                   # 环境变量（不提交 Git）
├── public/
│   ├── index.html         # 单页应用入口（SVG 图标、页面骨架、内联 JS）
│   ├── script.js          # 前端全部逻辑（~5900 行）
│   ├── style.css          # 全部样式（~5400 行）
│   └── images/            # 静态图片（Logo 等）
│   └── 资料/              # PDF 报告白皮书（直接通过 /资料/xxx.pdf 访问）
│       └── PDF名单/       # 历年人才名单 PDF
└── node_modules/          # 依赖包（npm install 生成）
```

**说明：**
- `data.json` 由外部 ETL 脚本生成，格式见第 7 节。平台启动时一次性加载进内存。
- `public/资料/` 下的 PDF 通过 Express 静态文件服务直接暴露，无需额外路由。
- `sharp` 包虽在 node_modules 中但未被代码引用，可忽略或删除。

---

## 4. 依赖安装

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
| uuid | ^14 | 会话 ID 生成 |
| natural | ^8.1 | NLP 辅助（分词等） |
| @xenova/transformers | ^2.17 | 本地嵌入模型（ChromaDB 向量化，可选） |

---

## 5. 环境变量配置

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

## 6. ChromaDB 向量库安装与启动

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

将 PDF/文本知识文档写入 ChromaDB 需要额外的导入脚本（不在本仓库中）。写入后 server.js 在启动时自动连接并建立 BM25 索引。

若 `patent_knowledge` Collection 为空，平台会使用本地混合索引兜底，正常功能不受影响。

---

## 7. 数据文件说明

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

## 8. 启动方式

```bash
# 同时启动 ChromaDB（若需要语义检索）
chroma run --path ./chroma_db &

# 启动 Node.js 服务
node server.js
# 或使用 npm
npm start
```

访问 `http://localhost:3001`

启动日志示例：
```
🚀 服务启动 → http://localhost:3001
🤖 推理引擎: DeepSeek API (deepseek-chat)
📊 共加载 32 个指标：普通高校数量、工业机器人密度...
✅ 本地混合知识索引构建完成 (18420条)
✅ ChromaDB 知识库已连接: patent_knowledge / 2840 条
✅ BM25 索引构建完成 (2840 条知识文档)
✅ 就绪，等待提问...
```

---

## 9. 网站逐步构建思路

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
- 四种预测算法（ARIMA、线性回归、指数平滑、Holt）
- 复合问题拆解（`planCompoundQuestions` + `runAgentBatch`）

### 第四阶段：体验优化

- SDUFE 封面动效（brush reveal 效果）
- 夜间模式
- 对话历史持久化（LocalStorage）
- AI 回复内联图表（点击"展开图表"直接在气泡内渲染）
- 追问建议按钮（`.rag-suggestion`）
- 主流 RAG condense question 机制（LangChain 风格）

---

## 10. RAG 实现流程

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

### 知识问答流程（answerEvidenceChat）

```
问题 + 检索到的证据片段
    │
    ├─ 第一次检索：ChromaDB 5条 + BM25 5条
    │
    ├─ 重写查询（HyDE）→ 第二次检索扩充
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

## 11. Agent 决策流程

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

对每个预测问题并行跑四种方法，选 AIC 最低者作为推荐结果：

| 方法 | 适用场景 |
|------|----------|
| 线性回归 | 稳定增长/下降趋势 |
| 指数平滑（Holt-Winters） | 有趋势无季节性 |
| ARIMA(1,1,0) | 差分平稳序列 |
| 霍尔特双参数 | 趋势变化较平缓 |

---

## 12. 前端图表渲染流程

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

## 13. SSE 流式推送流程

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

## 14. 常见问题

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

### Q: 如何修改端口

在 `.env` 中设置 `PORT=xxxx`。

---

*最后更新：2026-06*
