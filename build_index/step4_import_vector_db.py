"""
Step 4: 把 index_*.csv 入向量库
逻辑与现有 embed_and_store 流程一致，只是加了 integration_index 这一类型。
"""

import pandas as pd
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 把项目根目录加到 path，以便 import 现有的 embed/store 函数
sys.path.insert(0, os.path.join(BASE_DIR, '..'))

OUT_DIR = BASE_DIR

LEVEL_LABELS = {
    '全国': '全国',
    '省份': '省份',
    '地级市': '地级市',
}

def row_to_text(row: pd.Series, sheet: str, region_col: str | None) -> str:
    """把一行指数结果转为自然语言描述，用于生成 embedding。"""
    year = row.get('年份', '')
    region = f"{row[region_col]}" if region_col and region_col in row else '全国'
    idx = row.get('final_index', 'N/A')
    coverage = row.get('coverage', 'N/A')

    dim_parts = []
    for col in row.index:
        if col.startswith('dim_'):
            dim_name = col.replace('dim_', '')
            dim_parts.append(f'{dim_name}维度得分{row[col]:.4f}')

    dim_str = '，'.join(dim_parts) if dim_parts else '（无维度得分）'
    low_flag = '【低覆盖率警告】' if row.get('low_coverage') else ''

    return (
        f"{year}年{region}一体化指数（{sheet}层级）为{idx:.4f}，"
        f"有效权重覆盖率{float(coverage)*100:.1f}%，{dim_str}。{low_flag}"
    )


def main():
    try:
        # 尝试 import 现有的向量库写入函数
        from server import embed_and_store_rows   # ← 根据实际函数名调整
        use_existing = True
    except ImportError:
        print('⚠ 未找到 embed_and_store_rows，将只生成文本文件供手动导入。')
        use_existing = False

    for sheet, label in LEVEL_LABELS.items():
        csv_path = os.path.join(OUT_DIR, f'index_{sheet}.csv')
        if not os.path.exists(csv_path):
            print(f'⚠ 找不到 {csv_path}，跳过')
            continue

        df = pd.read_csv(csv_path, encoding='utf-8-sig')
        region_col = '地区' if sheet == '省份' else ('城市' if sheet == '地级市' else None)

        texts = []
        for _, row in df.iterrows():
            text = row_to_text(row, sheet, region_col)
            texts.append({
                'text':   text,
                'meta': {
                    'type':         'integration_index',
                    'level':        sheet,
                    'year':         row.get('年份'),
                    'region':       row.get(region_col) if region_col else '全国',
                    'final_index':  row.get('final_index'),
                    'coverage':     row.get('coverage'),
                    'low_coverage': bool(row.get('low_coverage', False)),
                    'source':       f'index_{sheet}.csv',
                }
            })

        if use_existing:
            embed_and_store_rows(texts)
            print(f'✓ {sheet}：{len(texts)} 条已入向量库')
        else:
            # 输出为文本文件备用
            out_txt = os.path.join(OUT_DIR, f'embed_texts_{sheet}.txt')
            with open(out_txt, 'w', encoding='utf-8') as f:
                for t in texts:
                    f.write(t['text'] + '\n')
            print(f'✓ {sheet}：文本已保存 → {out_txt}（请手动导入向量库）')

    print('\n══ Step 4 完成 ══')


if __name__ == '__main__':
    main()
