"""
url_ingest.py — 爬取人才奖项网页内容，写入 ChromaDB
在 rag-backend 根目录运行：python url_ingest.py

依赖：pip install requests beautifulsoup4 chromadb
微信文章无法自动爬取，需手动保存为 txt 文件（见下方说明）
"""

import os
import re
import time
import hashlib
import requests
from bs4 import BeautifulSoup

# ── 配置 ──────────────────────────────────────────────
CHROMA_HOST   = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT   = int(os.environ.get("CHROMA_PORT", "8000"))
OLLAMA_URL    = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL   = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION    = "patent_knowledge"
CHUNK_SIZE    = 600
CHUNK_OVERLAP = 100
MANUAL_TXT_DIR = os.path.join(os.path.dirname(__file__), "public", "资料", "手动保存")

# ── 所有可自动爬取的 URL（微信文章已跳过，需手动处理）──
URLS = [
    {
        "name": "国家最高科技奖获得者",
        "url": "https://www.most.gov.cn/ztzl/gjkxjsjldh/jldhrmd/",
        "type": "gov"
    },
    {
        "name": "中科院院士名单",
        "url": "https://casad.cas.cn/ysxx2022/ysmdyjj/qtysmd/",
        "type": "academic"
    },
    {
        "name": "工程院院士名单",
        "url": "https://www.cae.cn/cae/html/main/col48/column_48_1.html",
        "type": "academic"
    },
    {
        "name": "何梁何利基金奖",
        "url": "https://www.hlhl.org.cn/awards/",
        "type": "foundation"
    },
    {
        "name": "光华工程科技奖",
        "url": "https://www.cae.cn/cae/html/main/col1641/20250311095509882806959_1.html",
        "type": "academic"
    },
    {
        "name": "全国创新争先奖",
        "url": "https://www.cast.org.cn/rc2/bzytj/qgcxzxj/ljhjz/art/2025/art_e0d7f6d2a8c74a5e9b5c2815.html",
        "type": "gov"
    },
    {
        "name": "国家工程师奖",
        "url": "https://www.gov.cn/zhengce/202401/content_6924863.htm",
        "type": "gov"
    },
    {
        "name": "万人领军第一批",
        "url": "https://news.sciencenet.cn/htmlnews/2013/9/281936.shtm",
        "type": "news"
    },
    {
        "name": "万人领军第二批",
        "url": "https://wap.sciencenet.cn/mobile.php?type=detail&id=875590",
        "type": "news"
    },
    {
        "name": "万人领军第三批",
        "url": "https://www.163.com/dy/article/D6S9G.html",
        "type": "news"
    },
    {
        "name": "万人领军第四批",
        "url": "https://www.163.com/dy/article/E8VU7.html",
        "type": "news"
    },
    # 微信文章需手动处理，见脚本末尾说明：
    # 杰青 2025: https://m.thepaper.cn/baijiahao_29xxx
    # 杰青 2020-2024: https://mp.weixin.qq.com/...
    # 优青 2020-2024: https://mp.weixin.qq.com/...
    # 万人表现: https://mp.weixin.qq.com/...
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


# ── 工具函数 ──────────────────────────────────────────

def fetch_page(url, timeout=15):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, verify=False)
        resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.text
    except Exception as e:
        print(f"   ⚠️  请求失败: {e}")
        return None


def extract_text_from_html(html, url=""):
    soup = BeautifulSoup(html, "html.parser")
    # 删除脚本、样式、导航等噪声
    for tag in soup(["script", "style", "nav", "footer", "header",
                     "aside", "noscript", "iframe"]):
        tag.decompose()
    # 优先取主体内容区
    for selector in ["article", "main", ".content", "#content",
                     ".article", "#article", ".main-content"]:
        main = soup.select_one(selector)
        if main and len(main.get_text(strip=True)) > 200:
            return main.get_text(separator="\n", strip=True)
    return soup.get_text(separator="\n", strip=True)


def clean_text(text):
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]{3,}', ' ', text)
    return text.strip()


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    text = clean_text(text)
    if len(text) <= size:
        return [text] if text else []
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size].strip())
        start += size - overlap
    return [c for c in chunks if len(c) > 30]


def get_embedding(text):
    resp = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": str(text)[:4000]},
        timeout=30
    )
    resp.raise_for_status()
    emb = resp.json().get("embedding")
    if not emb:
        raise ValueError("embedding 返回空")
    return emb


def make_id(source, chunk_idx):
    key = f"url_{source}_{chunk_idx}"
    return "u_" + hashlib.md5(key.encode()).hexdigest()[:16]


def load_manual_txts():
    """读取手动保存的微信文章 txt 文件"""
    docs = []
    if not os.path.exists(MANUAL_TXT_DIR):
        return docs
    for fname in os.listdir(MANUAL_TXT_DIR):
        if fname.endswith(".txt"):
            path = os.path.join(MANUAL_TXT_DIR, fname)
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read().strip()
                if text:
                    docs.append({"name": fname.replace(".txt", ""), "text": text, "source": f"手动/{fname}"})
                    print(f"   📄 读取手动文件: {fname} ({len(text)} 字)")
            except Exception as e:
                print(f"   ❌ 读取失败 {fname}: {e}")
    return docs


# ── 主流程 ────────────────────────────────────────────

def main():
    import warnings
    warnings.filterwarnings("ignore")  # 忽略 SSL 警告

    print("🚀 开始处理网址内容...")

    # 连接 ChromaDB（直接调 REST API v2）
    CHROMA_TENANT = "default_tenant"
    CHROMA_DB     = "default_database"
    CHROMA_COL_BASE = (f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2"
                       f"/tenants/{CHROMA_TENANT}/databases/{CHROMA_DB}")

    def chroma_req(method, path, **kwargs):
        if path.startswith("/collections"):
            url = CHROMA_COL_BASE + path
        else:
            url = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2" + path
        r = requests.request(method, url, timeout=15, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else {}

    print("\n🔗 连接 ChromaDB...")
    try:
        requests.get(f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat", timeout=5).raise_for_status()
        try:
            col_data = chroma_req("GET", f"/collections/{COLLECTION}")
        except Exception:
            col_data = chroma_req("POST", "/collections", json={
                "name": COLLECTION, "metadata": {"hnsw:space": "cosine"}
            })
        col_id = col_data["id"]
        id_data = chroma_req("POST", f"/collections/{col_id}/get", json={"include": []})
        existing = set(id_data.get("ids", []))
        print(f"   ✅ 集合已有 {len(existing)} 条")
    except Exception as e:
        print(f"   ❌ ChromaDB 连接失败: {e}")
        return

    total_new = 0

    # ── 1. 爬取 URL ──
    print(f"\n🌐 开始爬取 {len(URLS)} 个网址...")
    for item in URLS:
        name = item["name"]
        url  = item["url"]
        print(f"\n   [{name}] {url[:60]}...")

        html = fetch_page(url)
        if not html:
            continue

        text = extract_text_from_html(html, url)
        text = clean_text(text)
        if len(text) < 100:
            print(f"   ⚠️  提取文本太短（{len(text)}字），跳过")
            continue

        print(f"   字符数: {len(text)}")
        chunks = chunk_text(text)
        print(f"   分块数: {len(chunks)}")

        batch_ids, batch_embs, batch_docs, batch_metas = [], [], [], []
        for i, chunk in enumerate(chunks):
            doc_id = make_id(name, i)
            if doc_id in existing:
                continue
            try:
                emb = get_embedding(chunk)
            except Exception as e:
                print(f"   ❌ embedding 失败: {e}")
                continue
            batch_ids.append(doc_id)
            batch_embs.append(emb)
            batch_docs.append(chunk)
            batch_metas.append({
                "table":  "knowledge",
                "source": name,
                "url":    url,
                "chunk":  i
            })

        if batch_ids:
            try:
                chroma_req("POST", f"/collections/{col_id}/add", json={
                    "ids": batch_ids, "embeddings": batch_embs,
                    "documents": batch_docs, "metadatas": batch_metas
                })
                existing.update(batch_ids)
                total_new += len(batch_ids)
                print(f"   ✅ 写入 {len(batch_ids)} 块")
            except Exception as e:
                print(f"   ❌ 写入失败: {e}")

        time.sleep(1)  # 礼貌性延迟

    # ── 2. 手动保存的微信文章 ──
    manual_docs = load_manual_txts()
    if manual_docs:
        print(f"\n📝 处理 {len(manual_docs)} 个手动保存文件...")
        for doc in manual_docs:
            chunks = chunk_text(doc["text"])
            batch_ids, batch_embs, batch_docs_list, batch_metas = [], [], [], []
            for i, chunk in enumerate(chunks):
                doc_id = make_id(doc["source"], i)
                if doc_id in existing:
                    continue
                try:
                    emb = get_embedding(chunk)
                except Exception as e:
                    print(f"   ❌ embedding 失败: {e}")
                    continue
                batch_ids.append(doc_id)
                batch_embs.append(emb)
                batch_docs_list.append(chunk)
                batch_metas.append({
                    "table":  "knowledge",
                    "source": doc["name"],
                    "chunk":  i
                })
            if batch_ids:
                chroma_req("POST", f"/collections/{col_id}/add", json={
                    "ids": batch_ids, "embeddings": batch_embs,
                    "documents": batch_docs_list, "metadatas": batch_metas
                })
                existing.update(batch_ids)
                total_new += len(batch_ids)
                print(f"   ✅ [{doc['name']}] 写入 {len(batch_ids)} 块")
    else:
        print(f"\n📌 微信文章手动处理说明：")
        print(f"   1. 在浏览器打开微信文章，Ctrl+A 全选，Ctrl+C 复制")
        print(f"   2. 粘贴到记事本，保存为 .txt 文件（UTF-8 编码）")
        print(f"   3. 放到：{MANUAL_TXT_DIR}")
        print(f"   4. 再次运行本脚本即可自动处理")
        os.makedirs(MANUAL_TXT_DIR, exist_ok=True)
        print(f"   （文件夹已创建）")

    print(f"\n{'='*50}")
    print(f"🎉 完成！本次新增 {total_new} 个文档块")
    try:
        final = chroma_req("GET", f"/collections/{col_id}/count")
        print(f"   ChromaDB 集合总量: {final} 条")
    except Exception:
        pass


if __name__ == "__main__":
    main()
