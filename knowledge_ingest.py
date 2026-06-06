"""
knowledge_ingest.py — 把 public/资料/ 下的 PDF 和 Word 文档写入 ChromaDB

用法：
    python knowledge_ingest.py

依赖：
    pip install pymupdf python-docx requests

说明：
    - 自动扫描 public/资料/ 下所有 .pdf / .docx（跳过 ~$ 临时文件）
    - 提取文本，智能分块（名单类自动按姓名断行）
    - 调用本地 Ollama nomic-embed-text 生成 embedding
    - 通过 ChromaDB REST v2 写入 patent_knowledge 集合
    - 支持断点续传：已存在的块自动跳过
"""

import os
import re
import time
import hashlib
import requests

# ── 配置 ──────────────────────────────────────────────
DOCS_FOLDER   = os.path.join(os.path.dirname(__file__), "public", "资料")
CHROMA_HOST   = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT   = int(os.environ.get("CHROMA_PORT", "8000"))
OLLAMA_URL    = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL   = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION    = "patent_knowledge"
TENANT        = "default_tenant"
DATABASE      = "default_database"
CHUNK_SIZE    = 600
CHUNK_OVERLAP = 100
BATCH_SIZE    = 10
EMBED_TIMEOUT = 30


# ── ChromaDB REST v2 ──────────────────────────────────

def _col_url(path=""):
    base = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2"
    return f"{base}/tenants/{TENANT}/databases/{DATABASE}/collections{path}"

def _req(method, url, **kwargs):
    r = requests.request(method, url, timeout=15, **kwargs)
    r.raise_for_status()
    return r.json() if r.content else {}

def chroma_heartbeat():
    requests.get(
        f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat", timeout=5
    ).raise_for_status()

def chroma_get_or_create():
    try:
        data = _req("GET", _col_url(f"/{COLLECTION}"))
        return data["id"]
    except requests.HTTPError:
        data = _req("POST", _col_url(), json={
            "name": COLLECTION,
            "metadata": {"hnsw:space": "cosine"}
        })
        return data["id"]

def chroma_get_ids(col_id):
    try:
        result = _req("POST", _col_url(f"/{col_id}/get"), json={"include": []})
        return set(result.get("ids", []))
    except Exception:
        return set()

def chroma_add(col_id, ids, embeddings, documents, metadatas):
    _req("POST", _col_url(f"/{col_id}/add"), json={
        "ids": ids, "embeddings": embeddings,
        "documents": documents, "metadatas": metadatas
    })

def chroma_count(col_id):
    return _req("GET", _col_url(f"/{col_id}/count"))


# ── Ollama Embedding ──────────────────────────────────

def get_embedding(text):
    r = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": str(text)[:4000]},
        timeout=EMBED_TIMEOUT
    )
    r.raise_for_status()
    emb = r.json().get("embedding")
    if not emb:
        raise ValueError("embedding 返回为空")
    return emb


# ── 文本提取 ──────────────────────────────────────────

def extract_pdf(path):
    try:
        import fitz
        doc = fitz.open(path)
        text = "\n".join(p.get_text("text").strip() for p in doc if p.get_text("text").strip())
        doc.close()
        return text
    except ImportError:
        print("  ⚠️  未安装 pymupdf，跳过此文件")
        return ""
    except Exception as e:
        print(f"  ❌ PDF 提取失败: {e}")
        return ""

def extract_docx(path):
    try:
        from docx import Document
        doc = Document(path)
        parts = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    except Exception as e:
        print(f"  ❌ Word 提取失败: {e}")
        return ""


# ── 分块 ──────────────────────────────────────────────

def preprocess_talent_list(text):
    """检测名单类密集文本，按年份自动断行"""
    year_count = len(re.findall(r'20\d{2}年', text))
    if year_count < 3 or len(text) / max(year_count, 1) > 80:
        return text
    text = re.sub(r'\s+', '', text)
    text = re.sub(r'(20\d{2}年(?:度|入选|获|荣获|被评|当选))', r'\n\1', text)
    text = re.sub(r'([^\n])(20\d{2}年[^度入获荣被当\d])', r'\1\n\2', text)
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    return '\n'.join(lines)

def chunk_text(text):
    text = preprocess_talent_list(text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    if not text:
        return []
    if len(text) <= CHUNK_SIZE:
        return [text]

    lines = text.split('\n')
    if len(lines) > 10:
        chunks, current, cur_len = [], [], 0
        for line in lines:
            if cur_len + len(line) > CHUNK_SIZE and current:
                chunks.append('\n'.join(current))
                overlap, ol = [], 0
                for l in reversed(current):
                    if ol + len(l) > CHUNK_OVERLAP:
                        break
                    overlap.insert(0, l)
                    ol += len(l)
                current, cur_len = overlap, ol
            current.append(line)
            cur_len += len(line)
        if current:
            chunks.append('\n'.join(current))
        return [c for c in chunks if len(c.strip()) > 20]

    chunks, start = [], 0
    while start < len(text):
        chunk = text[start:start + CHUNK_SIZE].strip()
        if chunk:
            chunks.append(chunk)
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


# ── 文件扫描 ──────────────────────────────────────────

def scan_docs():
    docs = []
    for root, dirs, files in os.walk(DOCS_FOLDER):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for fname in sorted(files):
            if fname.startswith('~$') or fname.startswith('.'):
                continue
            if os.path.splitext(fname)[1].lower() in ('.pdf', '.docx'):
                docs.append(os.path.join(root, fname))
    return docs

def make_id(path, idx):
    rel = os.path.relpath(path, DOCS_FOLDER)
    return "k_" + hashlib.md5(f"{rel}_{idx}".encode()).hexdigest()[:16]


# ── 主流程 ────────────────────────────────────────────

def main():
    print("🚀 知识库文档入库")
    print(f"   文档目录 : {DOCS_FOLDER}")
    print(f"   ChromaDB : {CHROMA_HOST}:{CHROMA_PORT}")
    print(f"   Ollama   : {OLLAMA_URL}  [{EMBED_MODEL}]")

    files = scan_docs()
    if not files:
        print(f"\n❌ 未找到 PDF 或 Word 文件")
        return
    print(f"\n📄 找到 {len(files)} 个文档")

    print("\n🔗 连接 ChromaDB...")
    try:
        chroma_heartbeat()
        col_id = chroma_get_or_create()
        existing = chroma_get_ids(col_id)
        print(f"   ✅ 集合已有 {len(existing)} 条")
    except Exception as e:
        print(f"   ❌ 连接失败: {e}")
        return

    print("\n🧪 测试 Ollama...")
    try:
        dim = len(get_embedding("测试"))
        print(f"   ✅ embedding 维度: {dim}")
    except Exception as e:
        print(f"   ❌ Ollama 失败: {e}")
        return

    total_new, skipped, failed = 0, 0, []

    for path in files:
        rel  = os.path.relpath(path, DOCS_FOLDER)
        ext  = os.path.splitext(path)[1].lower()
        print(f"\n📖 {rel}")

        text = extract_pdf(path) if ext == '.pdf' else extract_docx(path)
        if len(text.strip()) < 50:
            print("   ⚠️  内容过短，跳过")
            failed.append(rel)
            continue

        chunks = chunk_text(text)
        print(f"   {len(text)} 字 → {len(chunks)} 块")

        ids, embs, docs, metas = [], [], [], []
        new_count = 0

        for i, chunk in enumerate(chunks):
            cid = make_id(path, i)
            if cid in existing:
                skipped += 1
                continue
            try:
                emb = get_embedding(chunk)
            except Exception as e:
                print(f"   ❌ embedding chunk {i}: {e}")
                time.sleep(1)
                continue
            ids.append(cid); embs.append(emb); docs.append(chunk)
            metas.append({"table": "knowledge", "source": rel,
                          "filename": os.path.basename(path), "chunk": i})
            new_count += 1

            if len(ids) >= BATCH_SIZE:
                try:
                    chroma_add(col_id, ids, embs, docs, metas)
                    existing.update(ids)
                    print(f"   ✅ {new_count}/{len(chunks)}", end="\r")
                except Exception as e:
                    print(f"\n   ❌ 写入失败: {e}")
                ids, embs, docs, metas = [], [], [], []

        if ids:
            try:
                chroma_add(col_id, ids, embs, docs, metas)
                existing.update(ids)
            except Exception as e:
                print(f"\n   ❌ 写入尾批失败: {e}")

        total_new += new_count
        print(f"   ✅ 新增 {new_count} 块")

    print(f"\n{'='*50}")
    print(f"🎉 完成  新增 {total_new} 块，跳过 {skipped} 块")
    if failed:
        print(f"   ⚠️  提取失败: {failed}")
    print(f"   ChromaDB 总量: {chroma_count(col_id)} 条")


if __name__ == "__main__":
    main()
