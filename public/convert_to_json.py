import pandas as pd
import json
import numpy as np

EXCEL_PATH = "data.xlsx"   # 或改为您的文件名
OUTPUT_JSON = "data.json"

def clean_value(v):
    """将 NaN, inf 转换为 None (JSON null)"""
    if pd.isna(v) or np.isinf(v):
        return None
    return v

def clean_df(df):
    """将 DataFrame 中的所有 NaN 转为 None（JSON null），并转换数值类型"""
    df = df.replace([np.nan, np.inf, -np.inf], None)
    # 将年份转为整数（如果存在）
    if "年份" in df.columns:
        df["年份"] = pd.to_numeric(df["年份"], errors='coerce').fillna(0).astype(int)
    # 对所有数值列，确保没有 NaN
    for col in df.select_dtypes(include=['number']).columns:
        df[col] = df[col].apply(clean_value)
    return df

def main():
    print("读取 Excel...")
    xl = pd.ExcelFile(EXCEL_PATH)
    sheet_names = xl.sheet_names
    print("工作表:", sheet_names)
    
    workbook = {}
    for sheet in ["全国", "省份", "地级市"]:
        if sheet not in sheet_names:
            print(f"警告: 找不到工作表 '{sheet}'，跳过")
            continue
        df = pd.read_excel(EXCEL_PATH, sheet_name=sheet)
        df = clean_df(df)
        # 转为字典列表，NaN 已经转为 None，JSON 会输出为 null
        workbook[sheet] = df.to_dict(orient="records")
        print(f"{sheet}: {len(workbook[sheet])} 条记录")
    
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(workbook, f, ensure_ascii=False, indent=2)
    print(f"✅ 生成 {OUTPUT_JSON} 完成")

if __name__ == "__main__":
    main()