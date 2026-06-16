"""
Step 3+4: 读取 mapping_*.csv（人工确认后），提取原始数据，标准化，分级加权，输出指数 CSV。
输入：
  - build_index/mapping_全国.csv / mapping_省份.csv / mapping_地级市.csv
  - public/基础数据汇总5.26.xlsx
输出：
  - build_index/index_全国.csv
  - build_index/index_省份.csv
  - build_index/index_地级市.csv
"""

import pandas as pd
import numpy as np
import os
import re

# ─── 路径配置 ─────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, '..', 'public')
OUT_DIR    = BASE_DIR

DATA_FILE  = os.path.join(PUBLIC_DIR, '基础数据汇总5.26.xlsx')

# 各层级配置：{sheet_name: (数据源工作表, 年份列, 地区列)}
# ★ 如果原始数据列名不同，请修改这里
LEVEL_CONFIG = {
    '全国': {
        'data_sheet':  '全国',          # 原始数据工作表名
        'year_col':    '年份',
        'region_col':  None,            # 全国无地区列
    },
    '省份': {
        'data_sheet':  '省份',
        'year_col':    '年份',
        'region_col':  '地区',
    },
    '地级市': {
        'data_sheet':  '地级市',        # ★ 请确认实际工作表名（数据列显示是"时间"）
        'year_col':    '时间',          # ★ 地级市时间列名
        'region_col':  '地区',          # ★ 地级市地区列名
    },
}

LOW_COVERAGE_THRESHOLD = 0.6   # 有效权重覆盖率低于此值时标记 low_coverage

# ─── 工具函数 ─────────────────────────────────────────────

def load_raw_data(sheet_name: str, year_col: str, region_col: str | None) -> pd.DataFrame:
    df = pd.read_excel(DATA_FILE, sheet_name=sheet_name)
    df[year_col] = pd.to_numeric(df[year_col], errors='coerce').astype('Int64')
    df = df.dropna(subset=[year_col])
    return df


def eval_formula(formula: str, row: pd.Series) -> float | None:
    """
    执行 formula 中的表达式，col["列名"] 已绑定到 row。
    例：col["城镇人口"] / col["总人口"] * 100
    如果 formula 引用的列在 row 里不存在，返回 None（不报错，指标会被跳过）。
    """
    try:
        col = row  # 让 formula 里的 col["xxx"] 直接引用 row
        result = eval(formula, {'col': col, 'np': np})
        return float(result) if pd.notna(result) and np.isfinite(result) else None
    except (KeyError, ZeroDivisionError, TypeError):
        # KeyError: 分母列不在数据里（如常住人口、GDP）→ 静默跳过
        return None
    except Exception as e:
        return None


def extract_indicator_series(df: pd.DataFrame, mapping_row: pd.Series) -> pd.Series:
    """
    从 df 中提取一个三级指标的原始值 Series（与 df.index 对齐）。
    """
    raw_cols  = str(mapping_row.get('raw_cols', '') or '').strip()
    formula   = str(mapping_row.get('formula', '') or '').strip()
    match_type = str(mapping_row.get('match_type', '') or '').strip()

    if not raw_cols and not formula:
        return pd.Series([None] * len(df), index=df.index)

    cols_list = [c.strip() for c in raw_cols.split(',') if c.strip() and c.strip() in df.columns]

    if formula and formula not in ('nan', 'None'):
        # 公式计算
        return df.apply(lambda row: eval_formula(formula, row), axis=1)
    elif len(cols_list) == 1:
        return pd.to_numeric(df[cols_list[0]], errors='coerce')
    elif len(cols_list) > 1:
        # 多列默认求和（如有别的逻辑在 formula 里写）
        return df[cols_list].apply(pd.to_numeric, errors='coerce').sum(axis=1, min_count=1)
    else:
        return pd.Series([None] * len(df), index=df.index)


def minmax_normalize(series: pd.Series, direction: str) -> pd.Series:
    """Min-Max 标准化，负向指标取反。"""
    s = pd.to_numeric(series, errors='coerce')
    mn, mx = s.min(), s.max()
    if mx == mn:
        return pd.Series(0.5, index=s.index)  # 无变化默认中间值
    normalized = (s - mn) / (mx - mn)
    if direction.strip() in ('-', '负', 'negative'):
        normalized = 1 - normalized
    return normalized


def calculate_index(mapping_df: pd.DataFrame, raw_df: pd.DataFrame,
                    year_col: str, region_col: str | None) -> pd.DataFrame:
    """
    核心计算：
    1. 提取每个三级指标的原始值
    2. 全时间段/全地区一起做 min-max 标准化（统一基准）
    3. 三级 × weight(三级层内) → 归一化 → 二级得分
       二级 × weight_l2(二级层内) → 归一化 → 一级得分
       一级等权平均 → 最终指数
    4. 记录每个观测单元的指标覆盖率
    """
    group_keys = [year_col] + ([region_col] if region_col else [])

    # 先全量提取 + 标准化（全时间/地区统一归一化）
    std_cols: dict[str, pd.Series] = {}
    for _, m in mapping_df.iterrows():
        l3 = str(m['level3'])
        raw_s = extract_indicator_series(raw_df, m)
        std_cols[l3] = minmax_normalize(raw_s, str(m.get('direction', '+') or '+'))

    std_df = pd.DataFrame(std_cols, index=raw_df.index)
    for k in group_keys:
        std_df[k] = raw_df[k].values

    # 逐观测单元（年份×地区）计算指数
    results = []
    for keys, grp in std_df.groupby(group_keys):
        if not isinstance(keys, tuple):
            keys = (keys,)
        key_dict = dict(zip(group_keys, keys))

        l1_scores:   dict[str, float] = {}
        valid_w_sum  = 0.0
        total_w_sum  = 0.0

        for l1, l1_grp in mapping_df.groupby('level1', sort=False):
            # ── 二级 → 一级 ──
            l2_groups = list(l1_grp.groupby('level2', sort=False))
            l1_score  = 0.0
            w2_total  = 0.0

            for l2, l2_grp in l2_groups:
                # ── 三级 → 二级 ──
                l3_score = 0.0
                w3_valid = 0.0
                w3_total_local = 0.0

                for _, m3 in l2_grp.iterrows():
                    l3 = str(m3['level3'])
                    w3 = float(m3['weight']) if pd.notna(m3['weight']) else 0.0
                    w3_total_local += w3
                    total_w_sum    += w3
                    vals = grp[l3].dropna() if l3 in grp.columns else pd.Series(dtype=float)
                    if not vals.empty and w3 > 0:
                        l3_score   += vals.mean() * w3
                        w3_valid   += w3
                        valid_w_sum += w3

                # 三级加权均值（以有效权重归一化，避免缺失指标拉低得分）
                l2_score = l3_score / w3_valid if w3_valid > 0 else 0.0

                # 读取二级权重（weight_l2 字段；缺失则等权）
                w2_raw = l2_grp['weight_l2'].iloc[0] if 'weight_l2' in l2_grp.columns else None
                w2 = float(w2_raw) if (w2_raw is not None and pd.notna(w2_raw)) else None

                if w2 is not None and w2 > 0:
                    l1_score += l2_score * w2
                    w2_total += w2
                elif w2_valid > 0:   # 没有 weight_l2 → 等权（后面除以组数）
                    l1_score += l2_score
                    w2_total += 1.0

            l1_scores[l1] = l1_score / w2_total if w2_total > 0 else 0.0

        # 一级等权平均
        row_result = {**key_dict, 'final_index': None, 'coverage': None, 'low_coverage': False}
        if l1_scores:
            final    = float(np.mean(list(l1_scores.values())))
            coverage = valid_w_sum / total_w_sum if total_w_sum > 0 else 0.0
            row_result.update(
                final_index  = round(final, 6),
                coverage     = round(coverage, 3),
                low_coverage = coverage < LOW_COVERAGE_THRESHOLD,
            )
            for l1, score in l1_scores.items():
                row_result[f'dim_{l1}'] = round(score, 6)

        results.append(row_result)

    return pd.DataFrame(results)


# ─── 主流程 ──────────────────────────────────────────────

def main():
    for sheet, cfg in LEVEL_CONFIG.items():
        mapping_path = os.path.join(OUT_DIR, f'mapping_{sheet}.csv')
        if not os.path.exists(mapping_path):
            print(f'⚠ 找不到 {mapping_path}，跳过（请先完成 step2 并人工确认）')
            continue

        print(f'\n══ 计算：{sheet} ══')
        mapping_df = pd.read_csv(mapping_path, encoding='utf-8-sig')

        # 过滤掉 match_type=manual 且 raw_cols 仍为空的（未确认）
        unresolved = mapping_df[(mapping_df['match_type'] == 'manual') & (mapping_df['raw_cols'].isna() | (mapping_df['raw_cols'] == ''))]
        if not unresolved.empty:
            print(f'  ⚠ 以下指标仍未手动补全 raw_cols，将跳过：')
            for _, r in unresolved.iterrows():
                print(f'    {r["level3"]}')
        mapping_df = mapping_df[~((mapping_df['match_type'] == 'manual') & (mapping_df['raw_cols'].isna() | (mapping_df['raw_cols'] == '')))]

        # 读取原始数据
        data_sheet  = cfg['data_sheet']
        year_col    = cfg['year_col']
        region_col  = cfg['region_col']
        try:
            raw_df = load_raw_data(data_sheet, year_col, region_col)
            print(f'  原始数据：{len(raw_df)} 行，{len(raw_df.columns)} 列')
        except Exception as e:
            print(f'  ⚠ 读取原始数据失败（工作表={data_sheet}）：{e}')
            print('    请检查 LEVEL_CONFIG 里的 data_sheet / year_col / region_col 配置')
            continue

        index_df = calculate_index(mapping_df, raw_df, year_col, region_col)

        low_n = index_df['low_coverage'].sum()
        print(f'  输出：{len(index_df)} 条记录，其中低覆盖率：{low_n} 条')

        out_path = os.path.join(OUT_DIR, f'index_{sheet}.csv')
        index_df.to_csv(out_path, index=False, encoding='utf-8-sig')
        print(f'  ✓ 保存 → {out_path}')

    print('\n══ Step 3 完成，请检查 index_*.csv ══')
    print('确认数据无误后运行 step4_import_vector_db.py 入库')


if __name__ == '__main__':
    main()
