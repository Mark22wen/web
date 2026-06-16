"""
Step 2: 把三套 scheme_*.csv 里的三级指标与原始数据列进行匹配
策略（优先级从高到低）：
  1. source 里有 原"XXX" → 直接用 XXX 做精确匹配
  2. source 含"保留" → 用 level3 名（去括号/单位后）做精确/模糊匹配
  3. 其余 → 对 level3 名做模糊匹配（关键词子串）
  4. 以上都失败 → manual，需人工填写

输出：build_index/mapping_*.csv
mapping 列：
  level1/level2/level3  指标层级
  weight / weight_l2    权重
  direction             方向
  source                原始说明（含自动补全的候选提示）
  match_type            exact / formula / fuzzy / manual
  raw_cols              原始列名（逗号分隔，多列时用逗号）
  formula               Python 表达式（col["列名"] 引用原始列）
  confidence            0-1
"""

import pandas as pd
import re
import os

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, '..', 'public')
OUT_DIR    = BASE_DIR

DATA_FILE   = os.path.join(PUBLIC_DIR, '基础数据汇总5.26.xlsx')
SHEET_NAMES = ['全国', '省份', '地级市']

# 各层级对应原始数据的工作表名（如有出入请修改）
DATA_SHEET_MAP = {
    '全国':  ['全国'],
    '省份':  ['省份'],
    '地级市': ['城市', '地级市'],
}

# ★ 各层级人口列名及单位（用于生成"每万人/每百万人"公式）
# pop_unit: 'wan'=万人, 'ren'=人
POP_CONFIG = {
    '全国':   {'col': '常住人口',  'unit': 'wan'},  # 请根据实际列名修改
    '省份':   {'col': '常住人口',  'unit': 'wan'},
    '地级市': {'col': '常住人口',  'unit': 'wan'},
}
GDP_COL = 'GDP'   # GDP 列名，用于占比公式

# ─── 原始数据列名加载 ─────────────────────────────────────

def load_data_columns(filepath: str) -> dict:
    """返回 {sheet_name: [col, ...]}"""
    xl = pd.ExcelFile(filepath)
    result = {}
    for sh in xl.sheet_names:
        df = pd.read_excel(filepath, sheet_name=sh, nrows=0)
        result[sh] = [str(c).strip() for c in df.columns]
    return result


def get_candidate_cols(sheet_name: str, data_cols_map: dict) -> list:
    """取该层级对应工作表的列名作为候选集"""
    targets = DATA_SHEET_MAP.get(sheet_name, [])
    cols = []
    for t in targets:
        if t in data_cols_map:
            cols.extend(data_cols_map[t])
            break   # 取第一个匹配的工作表
    # 如果指定工作表没找到，fallback 全部列
    if not cols:
        for v in data_cols_map.values():
            cols.extend(v)
    return list(dict.fromkeys(cols))  # 去重保序

# ─── source 解析 ─────────────────────────────────────────

# 匹配带引号的 原"XXX"，兼容 ASCII/全角/弯引号/角括号等各种引号风格
# U+0022 " / U+201C " / U+201D " / U+2018 ' / U+2019 ' / U+FF02 ＂
_ANY_QUOTE = r'["“”‘’＂「『]'
_RE_ORIG_QUOTED = re.compile(r'原' + _ANY_QUOTE + r'(.*?)' + _ANY_QUOTE)

def parse_source_cols(source: str) -> list[str]:
    """
    只从 原"XXX" 提取原始列名，描述性的 原已为/原指标/保留 不提取。
    原"A+B" → ['A', 'B']   原"A" → ['A']   原已为相对量 → []
    """
    if not source or source in ('nan', 'None'):
        return []

    matches = _RE_ORIG_QUOTED.findall(source)
    cols = []
    for m in matches:
        parts = re.split(r'[+＋]', m)   # 只按加号拆，/ 可能是比值不是分隔
        cols.extend(p.strip() for p in parts if p.strip())
    return cols


def has_formula(source: str) -> bool:
    """source 里是否含有需要运算的提示"""
    hints = ['除以', '÷', '×', '×', '→', '之和', '相加', '合计', '转化', '取倒数',
             '计算', '差', '比值', '比率', '相减', '减去', '+', '乘以']
    return any(h in source for h in hints) if source else False


def build_formula(raw_cols: list[str], source: str, sheet_name: str = '') -> str:
    """
    根据 source 描述自动生成 Python 表达式。
    每万人/每百万人 根据 POP_CONFIG 中的人口列和单位来生成正确公式。
    """
    if not raw_cols:
        return ''

    base = ' + '.join(f'col["{c}"]' for c in raw_cols) if len(raw_cols) > 1 else f'col["{raw_cols[0]}"]'
    pop_cfg  = POP_CONFIG.get(sheet_name, {'col': '常住人口', 'unit': 'wan'})
    pop_col  = pop_cfg['col']
    pop_unit = pop_cfg['unit']  # 'wan'=万人, 'ren'=人

    # 每万人口 = 原始值 / 常住人口(万人) 或 原始值 / 常住人口(人) * 10000
    per_wan_formula = (
        f'{base} / col["{pop_col}"]'
        if pop_unit == 'wan'
        else f'{base} / col["{pop_col}"] * 10000'
    )
    # 每百万人口 = 原始值 / 常住人口(万人) * 100 或 / 人 * 1000000
    per_baiwan_formula = (
        f'{base} / col["{pop_col}"] * 100'
        if pop_unit == 'wan'
        else f'{base} / col["{pop_col}"] * 1000000'
    )

    if '每万人' in source or '万人' in source and '除以' in source:
        return per_wan_formula
    if '每百万人' in source or '百万人' in source and '除以' in source:
        return per_baiwan_formula
    if '除以常住人口' in source or '/ 年末人口' in source:
        # 判断分母单位
        if '百万' in source:
            return per_baiwan_formula
        return per_wan_formula
    if '人均' in source or '人均' in raw_cols[0] if raw_cols else False:
        return f'{base} / col["{pop_col}"]{"" if pop_unit == "wan" else " * 10000"}'
    if '占GDP' in source or '除以GDP' in source:
        return f'{base} / col["{GDP_COL}"] * 100'
    if '占财政支出' in source:
        return f'{base} / col["财政支出"] * 100'
    if '取倒数' in source:
        return f'1 / ({base})'
    if len(raw_cols) > 1:
        return f'{base}   # 多列合并，请根据 source 补充完整公式'
    return ''

# ─── 模糊匹配（仅作兜底）────────────────────────────────

def strip_unit(name: str) -> str:
    """去掉括号内单位、（%）、（万元）等，用于宽松匹配"""
    return re.sub(r'[（(][^）)]*[）)]', '', name).strip()


def fuzzy_match_col(name: str, candidates: list[str], threshold: float = 0.4) -> list[tuple]:
    """
    基于最长公共子串 + 关键词包含的模糊匹配。
    返回 [(col, score), ...] 降序。
    """
    name_clean = strip_unit(name)
    name_set   = set(name_clean)
    results = []
    for cand in candidates:
        cand_clean = strip_unit(str(cand))
        cand_set   = set(cand_clean)
        if not cand_set:
            continue
        # 字符重叠
        overlap = len(name_set & cand_set) / max(len(name_set), len(cand_set))
        # 子串包含加分
        contain = 0.35 if (name_clean in cand_clean or cand_clean in name_clean) else 0
        score = min(overlap + contain, 1.0)
        if score >= threshold:
            results.append((cand, round(score, 3)))
    return sorted(results, key=lambda x: -x[1])

# ─── 单指标匹配 ──────────────────────────────────────────

def match_one(row: pd.Series, candidates: list[str], sheet_name: str = '') -> dict:
    l3     = str(row['level3']).strip()
    source = str(row.get('source', '') or '').strip()

    result = dict(match_type='manual', raw_cols='', formula='', confidence=0.0)

    # ── 策略 1：source 里有 原"XXX" ──
    src_cols = parse_source_cols(source)
    valid_src_cols = [c for c in src_cols if c in candidates]

    if valid_src_cols:
        needs_formula = has_formula(source) or len(valid_src_cols) > 1
        auto_formula  = build_formula(valid_src_cols, source, sheet_name)
        result.update(
            match_type  = 'formula' if needs_formula else 'exact',
            raw_cols    = ','.join(valid_src_cols),
            formula     = auto_formula,
            confidence  = 0.95,
        )
        return result

    # source 里提取到了列名但候选里没找到 → 对提取的名字再做一轮模糊匹配
    if src_cols:
        best_col, best_score = '', 0.0
        for sc in src_cols:
            hits = fuzzy_match_col(sc, candidates, threshold=0.3)
            if hits and hits[0][1] > best_score:
                best_col, best_score = hits[0]
        if best_col and best_score >= 0.5:
            needs_formula = has_formula(source) or len(src_cols) > 1
            all_matched = [best_col] if len(src_cols) == 1 else src_cols
            result.update(
                match_type = 'formula' if needs_formula else 'fuzzy',
                raw_cols   = best_col,
                formula    = build_formula(all_matched, source, sheet_name) if needs_formula else '',
                confidence = best_score,
            )
            result['source'] = source + f'  【source提取={src_cols}，模糊到={best_col}({best_score:.2f})】'
        else:
            result.update(match_type='manual', raw_cols=','.join(src_cols), confidence=0.0)
            result['source'] = source + f'  【source提取={src_cols}，数据中未找到，请核实列名】'
        return result

    # ── 策略 2：source 含"保留" → level3 名就是（近似）原始列名 ──
    if '保留' in source:
        # 先精确匹配 level3
        if l3 in candidates:
            result.update(match_type='exact', raw_cols=l3, confidence=1.0)
            return result
        # 再精确匹配去单位后的名称
        l3_clean = strip_unit(l3)
        if l3_clean in candidates:
            result.update(match_type='exact', raw_cols=l3_clean, confidence=0.95)
            return result
        # 最后模糊匹配
        hits = fuzzy_match_col(l3, candidates, threshold=0.45)
        if hits:
            best, score = hits[0]
            candidates_str = ' | '.join(f'{c}({s})' for c, s in hits[:3])
            result.update(
                match_type = 'fuzzy',
                raw_cols   = best,
                confidence = score,
                formula    = '',
            )
            result['source'] = source + f'  【模糊候选: {candidates_str}】'
            return result

    # ── 策略 3a：source 明确列举多个指标加总（含"："后跟顿号分隔列表） ──
    if ('加总' in source or '之和' in source or '相加' in source) and '：' in source:
        items_str = source.split('：', 1)[-1]
        items = [i.strip() for i in re.split(r'[、，,]', items_str) if i.strip()]
        matched = []
        for item in items:
            # 先精确后模糊
            if item in candidates:
                matched.append(item)
            else:
                hits_i = fuzzy_match_col(item, candidates, threshold=0.5)
                if hits_i:
                    matched.append(hits_i[0][0])
        matched = list(dict.fromkeys(matched))  # 去重保序
        if matched:
            formula = build_formula(matched, source, sheet_name)
            result.update(
                match_type = 'formula',
                raw_cols   = ','.join(matched),
                formula    = formula,
                confidence = 0.75,
            )
            result['source'] = source + f'  【列举式加总，匹配列={matched}】'
            return result

    # ── 策略 3b：直接对 level3 做精确/模糊匹配 ──
    if l3 in candidates:
        result.update(match_type='exact', raw_cols=l3, confidence=1.0)
        return result
    # 去掉括号里的单位再试一次精确匹配
    l3_clean = strip_unit(l3)
    if l3_clean and l3_clean in candidates:
        result.update(match_type='exact', raw_cols=l3_clean, confidence=0.95)
        return result

    hits = fuzzy_match_col(l3, candidates, threshold=0.4)
    if not hits:
        hits = fuzzy_match_col(l3, candidates, threshold=0.2)  # 宽松再试一次

    if hits:
        best, score = hits[0]
        candidates_str = ' | '.join(f'{c}({s})' for c, s in hits[:3])
        result.update(
            match_type = 'fuzzy',
            raw_cols   = best,
            confidence = score,
        )
        result['source'] = source + f'  【模糊候选: {candidates_str}】'
    else:
        result['source'] = source + '  【未匹配，请手动填写 raw_cols】'

    return result

# ─── 主流程 ──────────────────────────────────────────────

def main():
    print('读取原始数据列名...')
    try:
        data_cols_map = load_data_columns(DATA_FILE)
        print(f'  工作表：{list(data_cols_map.keys())}')
        for sh, cols in data_cols_map.items():
            print(f'  [{sh}] {len(cols)} 列：{cols}')
    except Exception as e:
        print(f'  ⚠ 无法读取原始数据：{e}')
        data_cols_map = {}

    for sheet in SHEET_NAMES:
        scheme_path = os.path.join(OUT_DIR, f'scheme_{sheet}.csv')
        if not os.path.exists(scheme_path):
            print(f'\n⚠ 找不到 {scheme_path}，请先运行 step1')
            continue

        scheme_df = pd.read_csv(scheme_path, encoding='utf-8-sig')
        candidates = get_candidate_cols(sheet, data_cols_map)
        print(f'\n══ 匹配：{sheet}（{len(scheme_df)} 条指标，候选列 {len(candidates)} 个）══')

        rows = []
        for _, r in scheme_df.iterrows():
            m = match_one(r, candidates, sheet_name=sheet)
            entry = r.to_dict()
            entry.update(m)
            rows.append(entry)

        mapping_df = pd.DataFrame(rows)

        # 统计
        counts = mapping_df['match_type'].value_counts()
        print(f'  精确(exact):{counts.get("exact",0)}  '
              f'公式(formula):{counts.get("formula",0)}  '
              f'模糊(fuzzy):{counts.get("fuzzy",0)}  '
              f'待人工(manual):{counts.get("manual",0)}')

        low = mapping_df[mapping_df['confidence'] < 0.6]
        if not low.empty:
            print(f'  ⚠ 置信度<0.6 或未匹配（重点核查）：')
            for _, r in low.iterrows():
                print(f'    [{r["match_type"]}] {r["level3"]}')
                print(f'           raw_cols={r["raw_cols"]}  confidence={r["confidence"]}')

        out = os.path.join(OUT_DIR, f'mapping_{sheet}.csv')
        mapping_df.to_csv(out, index=False, encoding='utf-8-sig')
        print(f'  ✓ 保存 → {out}')

    print('''
══ Step 2 完成 ══
请打开 mapping_*.csv 重点检查：
  match_type=manual    → 填写 raw_cols（原始列名）
  match_type=fuzzy     → 确认 raw_cols 是否正确
  match_type=formula   → 确认/补全 formula 表达式
    格式：col["列名"] / col["另一列"] * 100
确认后运行 step3_calculate_index.py
''')

if __name__ == '__main__':
    main()
