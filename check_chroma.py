"""
check_chroma.py — 诊断 ChromaDB 实际存储内容
用法：python check_chroma.py
"""
import requests

CHROMA = "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database"
OLLAMA = "http://localhost:11434"
EMBED_MODEL = "bge-m3"

def req(method, path, **kw):
    r = requests.request(method, CHROMA + path, timeout=30, **kw)
    r.raise_for_status()
    return r.json() if r.content else {}

col = req("GET", "/collections/patent_knowledge")
col_id = col["id"]
total = req("GET", f"/collections/{col_id}/count")
print(f"✅ ChromaDB 连接正常，总量: {total} 条\n")

# ── 1. 检查「德国经济」是否在库里 ──────────────────────────
print("=" * 60)
print("【1】文本搜索「德国经济」")
r1 = req("POST", f"/collections/{col_id}/get", json={
    "where_document": {"$contains": "德国经济"},
    "limit": 5,
    "include": ["documents", "metadatas"]
})
docs1 = r1.get("documents", [])
metas1 = r1.get("metadatas", [])
print(f"  找到: {len(docs1)} 条")
for i, (d, m) in enumerate(zip(docs1, metas1)):
    print(f"  [{i+1}] source={m.get('source','?')} chunk={m.get('chunk','?')}")
    print(f"       {d[:200]}\n")

# ── 2. 检查该 PDF 入库了多少 chunks ────────────────────────
print("=" * 60)
print("【2】检查「2026全球智数化人才指数报告.pdf」的入库情况")
# 分批拉取所有 k_ ID 并过滤
offset, page, pdf_chunks = 0, 500, []
while True:
    r2 = req("POST", f"/collections/{col_id}/get", json={
        "include": ["metadatas"],
        "limit": page, "offset": offset
    })
    batch_ids = r2.get("ids", [])
    batch_metas = r2.get("metadatas", [])
    for mid, m in zip(batch_ids, batch_metas):
        if "2026全球" in m.get("source", "") or "2026全球" in m.get("filename", ""):
            pdf_chunks.append((mid, m))
    if len(batch_ids) < page:
        break
    offset += len(batch_ids)

print(f"  找到该PDF的chunks: {len(pdf_chunks)} 条（预计应有约266条）")
if pdf_chunks:
    m0 = pdf_chunks[0][1]
    print(f"  示例 metadata: {m0}")

# ── 3. 向量搜索测试 ────────────────────────────────────────
print("\n" + "=" * 60)
print("【3】向量搜索「德国经济陷入结构性困境」")
try:
    emb_r = requests.post(f"{OLLAMA}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": "德国经济陷入结构性困境表现"},
        timeout=30)
    emb_r.raise_for_status()
    emb = emb_r.json().get("embedding")
    if emb:
        r3 = req("POST", f"/collections/{col_id}/query", json={
            "query_embeddings": [emb],
            "n_results": 5,
            "include": ["documents", "metadatas", "distances"]
        })
        qdocs = r3.get("documents", [[]])[0]
        qmeta = r3.get("metadatas", [[]])[0]
        qdist = r3.get("distances", [[]])[0]
        print(f"  Top-5 向量召回（distance越小越相关）：")
        for i, (d, m, dist) in enumerate(zip(qdocs, qmeta, qdist)):
            print(f"  [{i+1}] dist={dist:.4f} source={m.get('source','?')[:40]}")
            print(f"       {d[:150]}\n")
    else:
        print("  ❌ Ollama embedding 返回为空")
except Exception as e:
    print(f"  ❌ 向量搜索失败: {e}")

# ── 4. 按页码查第169页 ─────────────────────────────────────
print("\n" + "=" * 60)
TARGET_PAGE = 169
print(f"【4】按 metadata.page={TARGET_PAGE} 精确查询")
try:
    r4 = req("POST", f"/collections/{col_id}/get", json={
        "where": {"$and": [
            {"table": {"$eq": "knowledge"}},
            {"page": {"$eq": TARGET_PAGE}}
        ]},
        "include": ["documents", "metadatas"],
        "limit": 20
    })
    docs4 = r4.get("documents", [])
    metas4 = r4.get("metadatas", [])
    print(f"  第{TARGET_PAGE}页 chunks: {len(docs4)} 条")
    for i, (d, m) in enumerate(zip(docs4, metas4)):
        print(f"  [{i+1}] file={m.get('filename','?')}  chunk={m.get('chunk','?')}")
        print(f"       {d[:300]}\n")
    if not docs4:
        print(f"  ⚠️  第{TARGET_PAGE}页未入库，可能原因：")
        print("     A. 该页以图表为主且 llava 未安装（文字<80字走图片识别）")
        print("     B. detect_printed_page 识别偏差，实际存的 page 值不是 169")
        print("     C. 该 PDF 整体入库失败（见【2】的 chunks 数量）")
except Exception as e:
    print(f"  ❌ 查询失败: {e}")

# ── 5. 扫描该 PDF 实际入库的页码范围 ──────────────────────
print("\n" + "=" * 60)
print("【5】扫描「2026全球智数化人才指数报告」实际入库的页码分布")
pages_found = {}
for mid, m in pdf_chunks:
    p = m.get("page")
    if p is not None:
        pages_found[p] = pages_found.get(p, 0) + 1

if pages_found:
    sorted_pages = sorted(pages_found.keys())
    print(f"  入库页码范围: {sorted_pages[0]} ~ {sorted_pages[-1]}，共 {len(sorted_pages)} 个不同页码")
    # 找出缺失页（连续范围内的空洞）
    full_range = set(range(sorted_pages[0], sorted_pages[-1] + 1))
    missing = sorted(full_range - set(sorted_pages))
    if missing:
        # 只显示前30个缺失页，避免输出过长
        preview = missing[:30]
        print(f"  缺失页码（共{len(missing)}个）: {preview}{'...' if len(missing)>30 else ''}")
    else:
        print("  无缺失页码（连续完整）")
    # 检查169是否在已入库的页码里
    if TARGET_PAGE in pages_found:
        print(f"  ✅ 第{TARGET_PAGE}页已入库，共 {pages_found[TARGET_PAGE]} 个chunk")
    else:
        print(f"  ❌ 第{TARGET_PAGE}页不在入库页码中")
        # 找最近的已入库页码
        near = sorted(pages_found.keys(), key=lambda x: abs(x - TARGET_PAGE))[:5]
        print(f"     最近的已入库页码: {near}")
else:
    print("  ⚠️  该 PDF 的 chunks 均无 page 字段（可能入库时未提取页码）")

# ── 6. 用关键词直接文本搜索第169页内容 ─────────────────────
print("\n" + "=" * 60)
print("【6】关键词文本搜索（不依赖 page 字段，直接搜内容）")
keywords = ["169", "第169"]
for kw in keywords:
    try:
        rk = req("POST", f"/collections/{col_id}/get", json={
            "where": {"table": {"$eq": "knowledge"}},
            "where_document": {"$contains": kw},
            "include": ["documents", "metadatas"],
            "limit": 5
        })
        kw_docs = rk.get("documents", [])
        kw_metas = rk.get("metadatas", [])
        print(f"  搜「{kw}」: {len(kw_docs)} 条")
        for i, (d, m) in enumerate(zip(kw_docs, kw_metas)):
            print(f"    [{i+1}] page={m.get('page','?')} file={m.get('filename','?')}")
            print(f"         {d[:200]}\n")
    except Exception as e:
        print(f"  搜「{kw}」失败: {e}")

print("=" * 60)
print("✅ 诊断完成")
