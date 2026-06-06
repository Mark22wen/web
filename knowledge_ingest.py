"""
knowledge_ingest.py — 把 PDF + Word 背景知识文档写入 ChromaDB
在 rag-backend 根目录下运行：python knowledge_ingest.py

依赖安装：
    pip install pymupdf python-docx chromadb requests

说明：
  - 扫描 public/资料/ 下所有 .pdf 和 .docx
  - 提取文本，按 ~600字 分块（重叠100字）
  - 调用本地 Ollama nomic-embed-text 生成 embedding
  - 写入 ChromaDB patent_knowledge 集合（与结构化数据共用）
  - 用 metadata.table = "knowledge" 区分，不会覆盖结构化数据
"""

import os
import json
import hashlib
import time
import re
import requests

# ── 配置 ──────────────────────────────────────────────
DOCS_FOLDER    = os.path.join(os.path.dirname(__file__), "public", "资料")
CHROMA_HOST    = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT    = int(os.environ.get("CHROMA_PORT", "8000"))
OLLAMA_URL     = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL    = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION     = "patent_knowledge"
CHUNK_SIZE     = 600   # 每块字符数
CHUNK_OVERLAP  = 100   # 相邻块重叠字符数
BATCH_SIZE     = 10    # 每批写入 ChromaDB 的块数
EMBED_TIMEOUT  = 30    # embedding 超时秒数
# ──────────────────────────────────────────────────────


# ── 文本提取 ──────────────────────────────────────────

def extract_pdf(path):
    """用 PyMuPDF (fitz) 提取 PDF 文本"""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(path)
        pages = []
        for page in doc:
            text = page.get_text("text")
            if text.strip():
                pages.append(text.strip())
        doc.close()
        return "\n".join(pages)
    except ImportError:
        print("  ⚠️  未安装 pymupdf，尝试 pdfminer...")
        return extract_pdf_pdfminer(path)
    except Exception as e:
        print(f"  ❌ PDF 提取失败 {os.path.basename(path)}: {e}")
        return ""


def extract_pdf_pdfminer(path):
    try:
        from pdfminer.high_level import extract_text
        return extract_text(path) or ""
    except Exception as e:
        print(f"  ❌ pdfminer 提取失败: {e}")
        return ""


def extract_docx(path):
    """用 python-docx 提取 Word 文档文本"""
    try:
        from docx import Document
        doc = Document(path)
        parts = []
        for para in doc.paragraphs:
            if para.text.strip():
                parts.append(para.text.strip())
        # 也提取表格中的文本
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    except Exception as e:
        print(f"  ❌ Word 提取失败 {os.path.basename(path)}: {e}")
        return ""


# ── 分块 ──────────────────────────────────────────────

def preprocess_talent_list(text):
    """
    检测并格式化人才名单类连续文本。
    识别模式：姓名 + 年份 + "年度"/"年入选"/"年获" 等关键词
    自动在每条记录前插入换行，变成一人一行。
    """
    # 判断是否是密集名单文本（每100字超过2个年份则认为是）
    year_count = len(re.findall(r'20\d{2}年', text))
    if year_count < 3 or len(text) / max(year_count, 1) > 80:
        return text  # 不像名单，原样返回

    # 在"20XX年"前面插入换行（年份前通常是姓名末尾）
    # 先把已有换行统一，再按年份断行
    text = re.sub(r'\s+', '', text)  # 先去掉所有空白
    # 在每个 "XXXX年度/年入选/年获" 前断行
    text = re.sub(r'(20\d{2}年(?:度|入选|获|荣获|被评|当选))', r'\n\1', text)
    # 处理没有"度/入选"等词、直接是"20XX年"跟奖项名的情况
    text = re.sub(r'([^\n])(20\d{2}年[^度入获荣被当\d])', r'\1\n\2', text)

    lines = [l.strip() for l in text.split('\n') if l.strip()]
    return '\n'.join(lines)


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """把长文本切成带重叠的小块，名单类文本先格式化"""
    text = preprocess_talent_list(text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    if len(text) <= chunk_size:
        return [text] if text else []

    # 名单文本：按行分组，每块凑够 chunk_size 个字
    lines = text.split('\n')
    if len(lines) > 10:  # 多行结构，按行聚合
        chunks = []
        current = []
        current_len = 0
        for line in lines:
            if current_len + len(line) > chunk_size and current:
                chunks.append('\n'.join(current))
                # 保留最后几行作为重叠
                overlap_lines = []
                overlap_len = 0
                for l in reversed(current):
                    if overlap_len + len(l) > overlap:
                        break
                    overlap_lines.insert(0, l)
                    overlap_len += len(l)
                current = overlap_lines
                current_len = overlap_len
            current.append(line)
            current_len += len(line)
        if current:
            chunks.append('\n'.join(current))
        return [c for c in chunks if len(c.strip()) > 20]

    # 普通文本：按字符切
    chunks = []
    start = 0
    while start < len(text):
        chunk = text[start:start + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        start += chunk_size - overlap
    return chunks


# ── Ollama Embedding ──────────────────────────────────

def get_embedding(text):
    resp = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": str(text)[:4000]},
        timeout=EMBED_TIMEOUT
    )
    resp.raise_for_status()
    emb = resp.json().get("embedding")
    if not emb:
        raise ValueError("embedding 返回为空")
    return emb


# ── ChromaDB 操作（直接调 REST API v2，不依赖 Python chromadb 包）────────

CHROMA_TENANT = "default_tenant"
CHROMA_DB     = "default_database"

def chroma_base():
    return f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/tenants/{CHROMA_TENANT}/databases/{CHROMA_DB}"

def chroma_request(method, path, **kwargs):
    # path 以 /collections 开头时走 tenant/db 前缀，否则直接用
    if path.startswith("/collections"):
        url = chroma_base() + path
    else:
        url = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2" + path
    resp = requests.request(method, url, timeout=15, **kwargs)
    resp.raise_for_status()
    return resp.json() if resp.content else {}

def get_collection():
    """获取或创建集合，返回集合 ID"""
    try:
        data = chroma_request("GET", f"/collections/{COLLECTION}")
        return data["id"]
    except Exception:
        pass
    data = chroma_request("POST", "/collections", json={
        "name": COLLECTION,
        "metadata": {"hnsw:space": "cosine"}
    })
    return data["id"]

def get_existing_ids(col_id):
    """获取集合中所有已有 ID，用于断点续传"""
    try:
        result = chroma_request("POST", f"/collections/{col_id}/get", json={"include": []})
        return set(result.get("ids", []))
    except Exception:
        return set()

def chroma_add(col_id, ids, embeddings, documents, metadatas):
    chroma_request("POST", f"/collections/{col_id}/add", json={
        "ids": ids, "embeddings": embeddings,
        "documents": documents, "metadatas": metadatas
    })

def chroma_count(col_id):
    try:
        return chroma_request("GET", f"/collections/{col_id}/count")
    except Exception:
        return "?"


# ── 扫描文件 ──────────────────────────────────────────

def scan_docs(folder):
    docs = []
    for root, dirs, files in os.walk(folder):
        # 跳过隐藏目录
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for fname in files:
            # 跳过 Word 临时锁文件（~$ 开头）和隐藏文件
            if fname.startswith('~$') or fname.startswith('.'):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext in ('.pdf', '.docx'):
                docs.append(os.path.join(root, fname))
    return sorted(docs)


def make_doc_id(path, chunk_idx):
    """基于文件路径+块序号生成稳定ID"""
    rel = os.path.relpath(path, DOCS_FOLDER)
    key = f"knowledge_{rel}_{chunk_idx}"
    return "k_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:16]


# ── 主流程 ────────────────────────────────────────────

def main():
    print("🚀 开始处理知识库文档...")
    print(f"   文档目录: {DOCS_FOLDER}")
    print(f"   ChromaDB: {CHROMA_HOST}:{CHROMA_PORT}")
    print(f"   Ollama:   {OLLAMA_URL}  模型: {EMBED_MODEL}")

    # 1. 扫描文件
    files = scan_docs(DOCS_FOLDER)
    if not files:
        print(f"❌ 在 {DOCS_FOLDER} 没有找到 PDF 或 Word 文件")
        return
    print(f"\n📄 找到 {len(files)} 个文档：")
    for f in files:
        print(f"   {os.path.relpath(f, DOCS_FOLDER)}")

    # 2. 连接 ChromaDB
    print("\n🔗 连接 ChromaDB...")
    try:
        # 先测试心跳
        requests.get(f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat", timeout=5).raise_for_status()
        col_id = get_collection()
        existing_ids = get_existing_ids(col_id)
        print(f"   ✅ 连接成功，集合 ID: {col_id[:8]}...，已有 {len(existing_ids)} 条")
    except Exception as e:
        import traceback
        print(f"   ❌ 连接失败: {e}")
        traceback.print_exc()
        print("   请确认 Docker 中 my-chromadb 容器正在运行，端口 8000")
        return

    # 3. 测试 Ollama
    print("\n🧪 测试 Ollama embedding...")
    try:
        test = get_embedding("测试")
        print(f"   ✅ embedding 维度: {len(test)}")
    except Exception as e:
        print(f"   ❌ Ollama 失败: {e}")
        print("   请确认 Ollama 正在运行，且已安装 nomic-embed-text")
        return

    # 4. 逐文件处理
    total_chunks = 0
    skipped = 0
    failed_files = []

    for file_path in files:
        fname = os.path.basename(file_path)
        ext   = os.path.splitext(fname)[1].lower()
        rel   = os.path.relpath(file_path, DOCS_FOLDER)
        print(f"\n📖 处理: {rel}")

        # 提取文本
        if ext == ".pdf":
            text = extract_pdf(file_path)
        else:
            text = extract_docx(file_path)

        if not text or len(text.strip()) < 50:
            print(f"   ⚠️  文本提取为空或过短，跳过")
            failed_files.append(fname)
            continue

        print(f"   字符数: {len(text)}")

        # 分块
        chunks = chunk_text(text)
        print(f"   分块数: {len(chunks)}")

        # 批量写入
        batch_ids, batch_embs, batch_docs, batch_metas = [], [], [], []
        new_count = 0

        for i, chunk in enumerate(chunks):
            doc_id = make_doc_id(file_path, i)
            if doc_id in existing_ids:
                skipped += 1
                continue  # 断点续传：已存在的跳过

            try:
                emb = get_embedding(chunk)
            except Exception as e:
                print(f"   ❌ embedding 失败 chunk {i}: {e}")
                time.sleep(1)
                continue

            batch_ids.append(doc_id)
            batch_embs.append(emb)
            batch_docs.append(chunk)
            batch_metas.append({
                "table":    "knowledge",
                "source":   rel,
                "filename": fname,
                "chunk":    i,
                "total":    len(chunks)
            })
            new_count += 1

            # 攒够一批就写入
            if len(batch_ids) >= BATCH_SIZE:
                try:
                    chroma_add(col_id, batch_ids, batch_embs, batch_docs, batch_metas)
                    existing_ids.update(batch_ids)
                    print(f"   ✅ 已写入 {new_count}/{len(chunks)} 块", end="\r")
                except Exception as e:
                    print(f"\n   ❌ 写入失败: {e}")
                batch_ids, batch_embs, batch_docs, batch_metas = [], [], [], []

        # 写入剩余
        if batch_ids:
            try:
                chroma_add(col_id, batch_ids, batch_embs, batch_docs, batch_metas)
                existing_ids.update(batch_ids)
            except Exception as e:
                print(f"\n   ❌ 写入尾批失败: {e}")

        total_chunks += new_count
        print(f"   ✅ 新增 {new_count} 块（已跳过 {skipped} 块重复）")

    # 5. 汇总
    print(f"\n{'='*50}")
    print(f"🎉 完成！本次新增 {total_chunks} 个文档块")
    if skipped:
        print(f"   （{skipped} 块已存在，断点续传跳过）")
    if failed_files:
        print(f"   ⚠️  以下文件提取失败：{failed_files}")

    try:
        final = chroma_count(col_id)
        print(f"   ChromaDB 集合总量: {final} 条")
    except Exception:
        pass

    print("\n📌 下一步：重启 node server.js（不需要重跑 node ingest.js）")


if __name__ == "__main__":
    main()
