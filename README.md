# 乐音移调 · Spectral Pitch Transposer

保持总时长的乐音移调处理器，附带可用真实音频试听与 A/B 对比的频谱编辑窗口。

核心链路（`src/dsp/transpose.js`）：

```
输入
 └─ STFT 分析（周期 Hann，分析帧移 Ha = N/4，帧以 f·Ha 为中心，两端补零）
     ├─ 谱峰检测 + 抛物线插值 + 峰值跟踪（跨帧稳定分音身份）
     ├─ 起音检测（谱通量因果基线 + 局部极大 + 最小间隔 + 释音抑制 → 可靠度）
     └─ 相位声码器时间伸缩（合成帧移 Hs = ratio · Ha）
          ├─ 相位锁定：每个频率箱归属最近谱峰区域，取该峰传播相位 + 该箱自身的
          │  分析相位偏移（真实计算，不是把幅度数组整体平移）
          └─ 瞬态：按起音可靠度选“重置相位（锐利攻击）”或“延续相位（稳定音高）”
 └─ 逆 STFT + 加权重叠相加
 └─ 带限窗函数 sinc 重采样：以步长 ratio 读取、输出恰好 L 个样本
 └─ 移调音频，样本数与输入完全一致
```

**时长由样本数保持**，不修改播放器速度；界面中 `AudioBufferSourceNode.playbackRate`
恒为 1.0，测试会拦截 `start()` 断言这一点。

## 启动界面

```bash
node scripts/serve.mjs          # 默认 http://127.0.0.1:5173/
# 或 npm start
```

浏览器打开该地址。**只有 `index.html` + `src/` 被加载，内核就运行在页面里**——
界面由同一份乐音移调内核驱动，没有任何“界面用近似值、脚本才真实处理”的分叉。

界面操作：

1. 选择内置示例（单音 / 双音 / 起音乐句 / 密集七音），或拖入 WAV。
2. 拖动“半音”滑块（−12…+12，步长 0.01，连续可调）。
3. 按需切换瞬态策略（自动 / 延续 / 重置 / 每帧重置）与“相位锁定”“自适应帧长”。
4. 选项变化会自动重渲染；也可点“应用移调”。
5. `A 原音` / `B 移调` / `A/B 对比` 逐段试听；频谱上点击可定位播放头。
6. **逐段试听**：在频谱上 Shift+点击两次圈出区间，点“↻ 循环选段”循环播放该段；
   播放头在选段内回绕，`playbackRate` 仍为 1.0。
7. **帧级相位检查**：点击频谱后，下方“峰—邻域关联”面板显示最近合成帧的
   分音源/目标频率、分析相位、目标相位，以及每个归属频率箱的
   `输入相位 + 相位偏移 → 实际使用相位`。
8. 结果区读取内核回报的样本数、事件位置、算法延迟等；下方面板展示逐帧相位轨迹。
9. **后端切换与对比**（侧栏“后端”分组）：
   - “移调后端”下拉可在 **峰锁定相位声码器（当前）** 与 **逐箱相位声码器（旧）**
     之间切换；切换后自动用同一素材、同一参数重渲染，便于 A/B 试听。
   - “分析帧长（改窗）”可切到 1024 / 2048 / 4096；改窗后旧预设是否仍可用见下节。
   - 点“对比两个后端”：同时渲染两个后端，并在频谱上用红色高亮 **超差段**
     （局部 RMS 差异超过阈值且持续够长）。结果卡片列出段数、差异样本占比、
     受影响的预设/参数（当前帧长 + 音程），以及每段的峰值位置。
   - **从差异位置返回输入采样**：点击列表中的任一段，播放头跳到该段差异峰值，
     并显示差异峰值对应的 **输入采样编号**（`inputSample`），可直接回到原始素材核对。
10. “下载移调 WAV”导出真实文件，“下载相位轨迹 JSON”导出中间相位。

内核抛出的错误（如超出比例范围）会带错误码回显在“渲染”分组，并回写内核状态徽标。

## 兼容样例库（改窗后哪些预设还可用）

兼容样例完全由可编辑的源音 JSON 重建，不手写音频：

```
fixtures/sources/stable-dual.json        稳定双音（440 + 554.365 Hz）
fixtures/sources/short-attack.json       短起音（2 ms 攻击，多分音）
fixtures/sources/attack-window-edge.json 起音紧贴窗边（近窗边界处起音）
fixtures/legacy/presets.json             历史预设快照（故意混用旧键名）
fixtures/legacy/projects.json            旧工程：从中段起播 + 时间标志
fixtures/singles/legacy-phrase.json      旧工程用的乐句源（带衰减首音）
```

三种必需情形（稳定双音 / 短起音 / 起音紧贴窗边）各是一份 source-set，按采样率
列出多个变体；改动 JSON 后重跑构建即可刷新全部派生产物：

```bash
npm run compat          # 构建 + 旧工程检查 + 审计（= 下面三条）
npm run compat:build    # scripts/build-compat-library.mjs
npm run compat:legacy   # scripts/check-legacy-projects.mjs
npm run compat:audit    # scripts/audit-compat.mjs
```

`build-compat-library.mjs` 对每个 source × 采样率 × 音程（+7/−5 st）× 窗长
（1024/2048/4096）生成：

- 输入 WAV（由源音合成）、参考 WAV（由**原始谐音**乘以比例重新生成）；
- 两个后端的输出 WAV；
- `outputs/compat/library.json`：逐后端记录起音偏移、固定延迟、频率漂移，
  以及跨后端差异段（每段回指到输入采样）；
- `outputs/compat/onset-compensation.md`：**按 (窗长, 采样率) 维护的起音补偿表**。

所有记录的数值都取自 **写盘后再解析回来的 16-bit 样本**（`writeAndReadBack`），
因此报告描述的就是交付文件本身，而不是内存中的浮点缓冲。

### 旧工程兼容判定：两种失败必须区分

`check-legacy-projects.mjs` 读取旧预设（容忍 `fftSize`/`windowSize`/`N`、
`osamp`/`hopDiv`、`lockPhase`/`phase_locked` 等历史键名）与旧工程的
`playFromSample`、`markerSample`，将“第一处有效起音”对齐到工程时间标志，
并输出 `outputs/compat/legacy-projects.json`：

| 状态 | 含义 | 例 |
| --- | --- | --- |
| `preset-read-failed` | 预设读不出来，窗长未知，起音对齐无从谈起 | `old-broken`（缺窗长键） |
| `first-window-missing-history` | 预设可读，但工程从中段起播，首窗左侧零填充无历史 | `old-midstream`（冷 −178 spl，暖 +4 spl） |
| `delay-drift-regression` | 有真实历史且延迟/漂移超差 | 真实回归时 |
| `onset-misaligned` | 有历史、无延迟漂移问题，仅起音偏移超差 | — |
| `ok` | 全部在容差内 | — |

关键在于：`preset-read-failed` 在**任何测量之前**判定，绝不把“读不出预设”误报成
“内核起音有问题”；`first-window-missing-history` 由结构事实（`playFromSample>0` 且
无预卷）+ 暖渲染佐证（补齐一窗真实历史后误差落到 +4 采样）共同确认。

### 固定延迟与频率漂移独立报告

`compat.js` 用两种互不干扰的测量：

- **固定延迟**：累积能量包络对齐（`measureFixedDelaySamples`），对拍频稳健；
- **频率漂移**：逐分音 cents 误差对时间的线性回归斜率（`measureFrequencyDrift`）。

`audit-compat.mjs` 证明二者独立：注入 128 采样的整体延迟只移动延迟读数（107→235，
恰好 +128），漂移读数不变；注入 45 音分/秒的线性滑音只移动漂移读数（0→45.02 c/s），
延迟读数保持 −11 采样。审计从磁盘 WAV 独立重算每个数字，与存储值逐一比对。

## 无依赖运行

内核、WAV 编解码、测量工具都是纯 JS ES 模块，Node ≥ 18 与浏览器通用，**无需安装依赖**。
`index.html` 直接通过 `<script type="module">` 引入 `src/dsp/*`。

只有无头浏览器界面测试需要 `playwright-core`（见下）。

## 测试与验证

```bash
node tests/run-tests.mjs        # 内核 + 兼容工具测试（45 项）
node scripts/render-cases.mjs    # 渲染真实 WAV 到 outputs/
node scripts/verify-outputs.mjs  # 从磁盘上的导出文件反向验证（38 项）
node scripts/transient-tradeoff.mjs  # 瞬态取舍量化（读导出文件）
npm run compat                   # 兼容样例库 + 旧工程检查 + 审计（10/10）
```

界面测试（需要 Chromium）：

```bash
npm install playwright-core
npx playwright-core install chromium
node scripts/serve.mjs &
BASE_URL=http://127.0.0.1:5173/ node tests/ui-check.mjs   # 25 项
```

无 Chromium 时的界面接线检查（在 Node 里用最小 DOM 桩运行页面真实模块脚本）：

```bash
npm run test:ui-dom      # 15 项：后端切换、后端对比、差异段回指输入采样、旧工程面板
```

> `test:ui-dom` 验证的是**接线与计算**（选择器由注册表填充、对比结果与差异段、
> 点击差异段跳回对应输入采样、旧工程两种失败分类都能显示），不验证视觉绘制；
> 视觉由上面的 Chromium 测试覆盖。本机无浏览器二进制时，这是能跑的最近似检查。

## 交付物（`outputs/`）

| 文件 | 内容 |
| --- | --- |
| `case1_sine220_*` | 单音 220 Hz，含 ±5/7/12 st 与 +3.5 st 连续移调 |
| `case2_dual_*` | 双音 440 + 554.365 Hz |
| `case3_phrase_*` | 带起音乐句，含 auto/continue/reset 三种瞬态策略 |
| `case4_tail_*` | 前导/尾部静音 + 短音，证明裁剪与尾部 |
| `case4b_reattack_*` | 同音高重起音，量化瞬态取舍 |
| `case5_dense_*` | 密集七音和弦（触发自适应帧长） |
| `traces/*.trace.json` | 逐帧相位轨迹：源/目标频率、相位、峰—邻域关联 |
| `report.json` | 全部用例的测量结果 |
| `verification.json` | 从导出 WAV 反向解析得到的验证结果 |
| `transient-tradeoff.json` | 瞬态指标：上升时间、音高散乱度、攻击幅度 |
| `compat/library.json` | 每 source×窗长×音程 的起音偏移、固定延迟、频率漂移、跨后端差异段 |
| `compat/onset-compensation.md` | 按 (窗长, 采样率) 的起音补偿表 |
| `compat/audit.json` | 从磁盘 WAV 独立重算的审计结果（10 项，含延迟/漂移独立性证明） |
| `compat/legacy-projects.json` | 旧工程逐项判定（冷/暖渲染、延迟、漂移、分类） |
| `compat/legacy/*_cold.wav` `*_warm.wav` | 旧工程冷启动与补齐历史后的可试听导出 |
| `compat/inputs/` `references/` `outputs/` | 兼容样例的输入、参考与两个后端输出 |

所有 `.wav` 是真实 16-bit PCM 文件，可直接播放或用任意工具检查样本数。

## 实测结论（导出文件反向测量）

- 单音：目标频率误差 < 0.2 音分，幅度变化 < 0.3%，样本数严格相等。
- 乐句：起音位置与结束位置偏差 < 1 个测量窗口（5 ms），样本数相等。
- 相位锁定：双音时内部分音边带从约 −6 dB 提升到约 +40 dB，AM 深度从 4.7% 降到 0.8%。
- 同音高重起音：重置模式把起音上升时间从 76 ms 降到 53 ms；每帧重置使音高散乱度翻倍
  （0.031 → 0.063 Hz），并让持续段音高均值偏离目标（306 Hz vs 330 Hz）。
- 密集七音：基础帧长无法分离时自适应升到 4096，七个分音幅度全部保留。

## 已知限制

- 移调范围 ±12 半音（比例 0.5–2.0），超出即报错而非静默降质。
- 分音间距小于约 1.5 个 FFT 频率箱会合并为单一拍频分量：总能量保留，逐分音身份丢失
  （8 Hz 间隔的双音是实测边界）。
- 起音间隔小于 40 ms 会被合并为一次重置决策（滚奏、装饰音可能变钝）。
- 强非谐波素材（钟、钹）缺乏稳定峰身份，跟踪可能重新编号分音。
- 上移 +12 半音时宽带内容接近新奈奎斯特频率，抗混叠滤波使其变暗（正确行为）。
- 浏览器版处理单声道；多声道需逐声道以同一参数处理。

## 目录

```
index.html                 频谱编辑窗口
src/dsp/fft.js             基 2 FFT
src/dsp/window.js          Hann 窗
src/dsp/peaks.js           峰检测、瞬时频率、跨帧跟踪
src/dsp/transpose.js       移调内核（分析/合成/起音/自适应帧长）
src/dsp/backends.js        后端注册表（峰锁定 / 逐箱相位声码器）
src/dsp/compat.js          兼容测量：固定延迟、频率漂移、起音、差异段、旧预设/工程
src/dsp/sources.js         可编辑源音 → 输入/参考合成
src/dsp/resample.js        带限窗函数 sinc 重采样
src/dsp/wav.js             WAV 读写
src/dsp/measure.js         共享测量工具
fixtures/sources/          可编辑源音（稳定双音 / 短起音 / 起音贴窗边）
fixtures/legacy/           旧预设快照与旧工程
fixtures/singles/          旧工程用的乐句源
tests/run-tests.mjs        内核 + 兼容工具测试（45 项）
tests/ui-check.mjs         无头浏览器界面测试
tests/signals.js           合成测试信号
scripts/serve.mjs          静态服务器
scripts/render-cases.mjs   批量导出 WAV 与报告
scripts/verify-outputs.mjs 从导出文件反向验证
scripts/transient-tradeoff.mjs 瞬态取舍量化
scripts/build-compat-library.mjs 重建兼容样例库与起音补偿表
scripts/check-legacy-projects.mjs 旧工程兼容判定
scripts/audit-compat.mjs   从磁盘 WAV 审计兼容产物
```
