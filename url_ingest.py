"""
url_ingest.py — 爬取人才奖项网页内容写入 ChromaDB，并处理手动保存的微信文章

用法：
    python url_ingest.py

依赖：
    pip install requests beautifulsoup4

说明：
    - 自动爬取 URLS 列表中的公开网页
    - 读取 public/资料/手动保存/*.txt（微信文章等无法自动爬取的内容）
    - 通过 ChromaDB REST v2 写入 patent_knowledge 集合
    - 支持断点续传

微信文章处理方法：
    浏览器打开文章 → Ctrl+A → Ctrl+C → 粘贴到记事本
    保存为 UTF-8 的 .txt 文件 → 放入 public/资料/手动保存/
    再次运行本脚本即可自动入库
"""

import os
import re
import time
import hashlib
import warnings
import requests
from bs4 import BeautifulSoup

warnings.filterwarnings("ignore")  # 忽略 SSL 警告

# ── 配置 ──────────────────────────────────────────────
CHROMA_HOST    = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT    = int(os.environ.get("CHROMA_PORT", "8000"))
OLLAMA_URL     = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL    = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION     = "patent_knowledge"
TENANT         = "default_tenant"
DATABASE       = "default_database"
MANUAL_DIR     = os.path.join(os.path.dirname(__file__), "public", "资料", "手动保存")
CHUNK_SIZE     = 600
CHUNK_OVERLAP  = 100
CRAWL_DELAY    = 1.0  # 礼貌性延迟（秒）

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# ── 可自动爬取的 URL 列表 ──────────────────────────────
URLS = [
    {"name": "国家最高科技奖获得者",  "url": "https://www.most.gov.cn/ztzl/kjrw/"},
    {"name": "中科院院士名单",        "url": "https://casad.cas.cn/ysxx2022/ysmd/qtys/"},
    {"name": "工程院院士名单",        "url": "https://www.cae.cn/cae/html/main/col48/column_48_1.html"},
    {"name": "何梁何利基金奖",        "url": "https://www.hlhl.org.cn/channels/2.html"},
    {"name": "光华工程科技奖",        "url": "https://www.cae.cn/cae/html/main/col143/2025-03/11/20250311095509882806959_1.html"},
    {"name": "全国创新争先奖",        "url": "https://www.cast.org.cn/rc2/bzytj/qgcxzxj/ljhjz/art/2025/art_4dcd06a6a69e47f8b7fcc0f650a82815.html"},
    {"name": "国家工程师奖",          "url": "https://www.gov.cn/zhengce/202401/content_6927128.htm"},
    {"name": "万人领军第一批",        "url": "https://news.sciencenet.cn/htmlnews/2013/1/273773.shtm"},
    {"name": "万人领军第二批",        "url": "https://wap.sciencenet.cn/mobile.php?type=detail&id=349271&mobile=1"},
    {"name": "万人领军第三批",        "url": "https://www.163.com/dy/article/D6S9GGNE0517DHAI.html"},
    {"name": "万人领军第四批",        "url": "https://www.163.com/dy/article/E8VU7AMT05366EUH.html"},
    {"name": "万人青拔第三批",        "url": "https://k.sina.cn/article_5359069294_13f6ce86e034001w1j.html"},
]


# ── ChromaDB REST v2 ──────────────────────────────────

def _col_url(path=""):
    base = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2"
    return f"{base}/tenants/{TENANT}/databases/{DATABASE}/collections{path}"

def _req(method, url, **kwargs):
    r = requests.request(method, url, timeout=15, **kwargs)
    r.raise_for_status()
    return r.json() if r.content else {}

def chroma_get_or_create():
    try:
        return _req("GET", _col_url(f"/{COLLECTION}"))["id"]
    except requests.HTTPError:
        return _req("POST", _col_url(), json={
            "name": COLLECTION,
            "metadata": {"hnsw:space": "cosine"}
        })["id"]

def chroma_get_ids(col_id):
    try:
        return set(_req("POST", _col_url(f"/{col_id}/get"), json={"include": []}).get("ids", []))
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
        timeout=30
    )
    r.raise_for_status()
    emb = r.json().get("embedding")
    if not emb:
        raise ValueError("embedding 返回为空")
    return emb


# ── 网页抓取 ──────────────────────────────────────────

def fetch_text(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=15, verify=False)
        r.encoding = r.apparent_encoding or "utf-8"
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
            tag.decompose()
        for sel in ["article", "main", ".content", "#content", ".article", "#article"]:
            el = soup.select_one(sel)
            if el and len(el.get_text(strip=True)) > 200:
                return el.get_text(separator="\n", strip=True)
        return soup.get_text(separator="\n", strip=True)
    except Exception as e:
        print(f"   ⚠️  请求失败: {e}")
        return ""


# ── 文本分块 ──────────────────────────────────────────

def chunk_text(text):
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    if not text or len(text) < 30:
        return []
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        chunk = text[start:start + CHUNK_SIZE].strip()
        if chunk:
            chunks.append(chunk)
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks

def make_id(source, idx):
    return "u_" + hashlib.md5(f"{source}_{idx}".encode()).hexdigest()[:16]


# ── 写入 ChromaDB ─────────────────────────────────────

def ingest_chunks(col_id, existing, chunks, source, extra_meta=None):
    new_count = 0
    for i, chunk in enumerate(chunks):
        cid = make_id(source, i)
        if cid in existing:
            continue
        try:
            emb = get_embedding(chunk)
        except Exception as e:
            print(f"   ❌ embedding 失败: {e}")
            continue
        meta = {"table": "knowledge", "source": source, "chunk": i}
        if extra_meta:
            meta.update(extra_meta)
        try:
            chroma_add(col_id, [cid], [emb], [chunk], [meta])
            existing.add(cid)
            new_count += 1
        except Exception as e:
            print(f"   ❌ 写入失败: {e}")
    return new_count


# ── 主流程 ────────────────────────────────────────────

def main():
    print("🚀 网址内容入库")
    print(f"   ChromaDB : {CHROMA_HOST}:{CHROMA_PORT}")
    print(f"   Ollama   : {OLLAMA_URL}  [{EMBED_MODEL}]")

    print("\n🔗 连接 ChromaDB...")
    try:
        requests.get(f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat", timeout=5).raise_for_status()
        col_id  = chroma_get_or_create()
        existing = chroma_get_ids(col_id)
        print(f"   ✅ 集合已有 {len(existing)} 条")
    except Exception as e:
        print(f"   ❌ 连接失败: {e}")
        return

    total_new = 0

    # 1. 爬取 URL
    print(f"\n🌐 爬取 {len(URLS)} 个网址...")
    for item in URLS:
        name, url = item["name"], item["url"]
        print(f"\n   [{name}]")
        text = fetch_text(url)
        text = re.sub(r'[ \t]{3,}', ' ', text).strip()
        if len(text) < 100:
            print(f"   ⚠️  内容过短（{len(text)}字），跳过")
        else:
            chunks = chunk_text(text)
            n = ingest_chunks(col_id, existing, chunks, name, {"url": url})
            total_new += n
            print(f"   ✅ 新增 {n} 块（共 {len(chunks)} 块）")
        time.sleep(CRAWL_DELAY)

    # 2. 手动保存的文章
    os.makedirs(MANUAL_DIR, exist_ok=True)
    txts = [f for f in os.listdir(MANUAL_DIR) if f.endswith(".txt")]
    if txts:
        print(f"\n📝 处理 {len(txts)} 个手动文件...")
        for fname in txts:
            path = os.path.join(MANUAL_DIR, fname)
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read().strip()
            except Exception as e:
                print(f"   ❌ 读取失败 {fname}: {e}")
                continue
            name = fname.replace(".txt", "")
            chunks = chunk_text(text)
            n = ingest_chunks(col_id, existing, chunks, name)
            total_new += n
            print(f"   ✅ [{name}] 新增 {n} 块")
    else:
        print(f"\n📌 微信文章等可手动处理：")
        print(f"   1. 浏览器打开文章 → Ctrl+A → Ctrl+C → 粘贴到记事本")
        print(f"   2. 保存为 UTF-8 的 .txt 文件")
        print(f"   3. 放入：{MANUAL_DIR}")
        print(f"   4. 再次运行本脚本")

    print(f"\n{'='*50}")
    print(f"🎉 完成  本次新增 {total_new} 块")
    print(f"   ChromaDB 总量: {chroma_count(col_id)} 条")


if __name__ == "__main__":
    main()
