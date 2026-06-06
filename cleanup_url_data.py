"""
cleanup_url_data.py — 删除 url_ingest.py 写入的爬取数据
运行：python cleanup_url_data.py
"""
import requests

CHROMA_HOST   = "localhost"
CHROMA_PORT   = 8000
COLLECTION    = "patent_knowledge"
TENANT        = "default_tenant"
DATABASE      = "default_database"
BASE = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/tenants/{TENANT}/databases/{DATABASE}"

def req(method, path, **kwargs):
    r = requests.request(method, BASE + path, timeout=30, **kwargs)
    r.raise_for_status()
    return r.json() if r.content else {}

# 获取集合 ID
col = req("GET", f"/collections/{COLLECTION}")
col_id = col["id"]
print(f"集合 ID: {col_id[:8]}...  总量: ", end="")
print(req("GET", f"/collections/{col_id}/count"), "条")

# 分批获取所有 ID
all_url_ids = []
offset = 0
batch = 500
while True:
    result = req("POST", f"/collections/{col_id}/get", json={
        "limit": batch, "offset": offset, "include": []
    })
    ids = result.get("ids", [])
    if not ids:
        break
    url_ids = [i for i in ids if i.startswith("u_")]
    all_url_ids.extend(url_ids)
    offset += len(ids)
    if len(ids) < batch:
        break

print(f"找到爬取数据: {len(all_url_ids)} 条（ID 前缀 u_）")

if not all_url_ids:
    print("没有需要删除的数据。")
else:
    confirm = input(f"确认删除这 {len(all_url_ids)} 条？(y/n): ")
    if confirm.lower() == 'y':
        req("POST", f"/collections/{col_id}/delete", json={"ids": all_url_ids})
        final = req("GET", f"/collections/{col_id}/count")
        print(f"✅ 删除完成，剩余: {final} 条")
    else:
        print("已取消。")
