"""
convert_to_json.py — 把 基础数据汇总5.26.xlsx 转成 data.json
放在 public/ 下运行：python convert_to_json.py
依赖：pip install openpyxl pandas numpy
"""
import pandas as pd
import json
import numpy as np
import os

EXCEL_PATH = os.path.join(os.path.dirname(__file__), "基础数据汇总5.26.xlsx")
OUTPUT_JSON = os.path.join(os.path.dirname(__file__), "..", "data.json")

# ── 省份名规范化：新Excel用简称，server.js 用全称 ──
PROVINCE_NAME_MAP = {
    "北京": "北京市", "天津": "天津市", "上海": "上海市", "重庆": "重庆市",
    "河北": "河北省", "山西": "山西省", "辽宁": "辽宁省", "吉林": "吉林省",
    "黑龙江": "黑龙江省", "江苏": "江苏省", "浙江": "浙江省", "安徽": "安徽省",
    "福建": "福建省", "江西": "江西省", "山东": "山东省", "河南": "河南省",
    "湖北": "湖北省", "湖南": "湖南省", "广东": "广东省", "海南": "海南省",
    "四川": "四川省", "贵州": "贵州省", "云南": "云南省", "陕西": "陕西省",
    "甘肃": "甘肃省", "青海": "青海省",
    "内蒙古": "内蒙古自治区", "广西": "广西壮族自治区",
    "西藏": "西藏自治区", "宁夏": "宁夏回族自治区", "新疆": "新疆维吾尔自治区",
}

# ── 跳过的ID拼接列（无分析价值）──
SKIP_COLS = {"年份地区", "时间地区"}


def clean_value(v):
    if v is None:
        return None
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    return v


def clean_df(df):
    # 删除无用ID列
    df = df.drop(columns=[c for c in SKIP_COLS if c in df.columns])
    # NaN/inf → None
    df = df.replace([np.nan, np.inf, -np.inf], None)
    # 年份/时间列 → int
    for col in ["年份", "时间"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)
    return df


def normalize_province(name):
    """把简称补全为全称，已经是全称的直接返回"""
    if not isinstance(name, str):
        return name
    name = name.strip()
    if name in PROVINCE_NAME_MAP.values():  # 已是全称
        return name
    return PROVINCE_NAME_MAP.get(name, name)


def df_to_records(df):
    records = []
    for row in df.to_dict(orient="records"):
        cleaned = {k: clean_value(v) for k, v in row.items()}
        records.append(cleaned)
    return records


def main():
    print(f"📂 读取 {os.path.basename(EXCEL_PATH)} ...")
    if not os.path.exists(EXCEL_PATH):
        print(f"❌ 找不到文件：{EXCEL_PATH}")
        print("   请确认 基础数据汇总5.26.xlsx 在 public/ 文件夹内")
        return

    xl = pd.ExcelFile(EXCEL_PATH)
    print(f"   工作表: {xl.sheet_names}")

    workbook = {}

    # ── 全国 ──
    if "全国" in xl.sheet_names:
        df = pd.read_excel(EXCEL_PATH, sheet_name="全国")
        df = clean_df(df)
        workbook["全国"] = df_to_records(df)
        print(f"   全国: {len(workbook['全国'])} 条，{len(df.columns)} 列")
    else:
        print("⚠️  找不到'全国'工作表")

    # ── 省份 ──
    if "省份" in xl.sheet_names:
        df = pd.read_excel(EXCEL_PATH, sheet_name="省份")
        df = clean_df(df)
        # 规范化省份名
        if "地区" in df.columns:
            df["地区"] = df["地区"].apply(normalize_province)
        workbook["省份"] = df_to_records(df)
        print(f"   省份: {len(workbook['省份'])} 条，{len(df.columns)} 列")
        # 打印去重后的地区名，方便核对
        if "地区" in df.columns:
            provinces = sorted(df["地区"].dropna().unique().tolist())
            print(f"   省份列表({len(provinces)}个): {provinces[:8]}...")
    else:
        print("⚠️  找不到'省份'工作表")

    # ── 地级市 ──
    if "地级市" in xl.sheet_names:
        df = pd.read_excel(EXCEL_PATH, sheet_name="地级市")
        df = clean_df(df)
        workbook["地级市"] = df_to_records(df)
        print(f"   地级市: {len(workbook['地级市'])} 条，{len(df.columns)} 列")
    else:
        print("⚠️  找不到'地级市'工作表")

    # ── 写出 JSON ──
    out_path = os.path.abspath(OUTPUT_JSON)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(workbook, f, ensure_ascii=False, indent=2)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\n✅ 生成完成：{out_path}  ({size_mb:.1f} MB)")
    print("   下一步：重启 node server.js，再运行 node ingest.js 重建向量库")


if __name__ == "__main__":
    main()
