# 一体化指数构建流程

## 目录结构
```
build_index/
  step1_parse_scheme.py       解析指标体系 Excel
  step2_match_indicators.py   指标与原始数据列匹配
  step3_calculate_index.py    标准化 + 分级加权计算
  step4_import_vector_db.py   入向量库
  scheme_全国.csv             Step1 输出，指标体系
  mapping_全国.csv            Step2 输出，人工确认后使用
  index_全国.csv              Step3 输出，最终指数
  ...（省份/地级市同理）
```

## 运行顺序

```bash
cd build_index

# 1. 解析指标体系（检查列映射是否正确）
python step1_parse_scheme.py

# 2. 自动匹配指标 → 生成 mapping_*.csv
python step2_match_indicators.py

# 3. ★ 人工检查 mapping_*.csv
#    - match_type=manual 的行：填写 raw_cols（原始列名）
#    - match_type=fuzzy 置信度低的：确认 raw_cols 是否正确
#    - formula 指标：确认/修改 formula 表达式
#      格式：col["列名"] / col["另一列"] * 100

# 4. 计算指数
python step3_calculate_index.py

# 5. 检查 index_*.csv，确认数据合理后入库
python step4_import_vector_db.py
```

## 常见问题

**Q: Step1 列映射不对（一级/二级/三级 识别错了）**
A: 修改 `step1_parse_scheme.py` 里 `detect_columns()` 的 keywords 字典，加入你的实际列名关键词。

**Q: Step3 提示"读取原始数据失败"**
A: 修改 `step3_calculate_index.py` 里 `LEVEL_CONFIG` 的 `data_sheet` / `year_col` / `region_col` 为实际列名。

**Q: 全国层级没有地区列**
A: 已处理，`region_col=None` 时按年份聚合。

**Q: 权重校验提示某二级权重和≠1**
A: 是原 Excel 的权重填写问题，Step1 会列出，可手动在 scheme_*.csv 里修正后重跑 Step2。
