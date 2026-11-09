# 端到端与验收记录

> 环境：Linux（x86_64，i5-1240P，16 GB），Node 24.21，Python 3.13.5，CPU INT8。
> 历史行在 DSH 0.2.1-rc.2 上测得；0.2.2-rc.1 适配复测见「0.2.2-rc.1 适配验证」一节。
> 原则：只记录实际跑过的结果；未跑过的项明确标注。

## 验收矩阵

| 验收项 | 状态 | 证据 |
|---|---|---|
| 20 中文 + 20 英文 top-1 准确率 ≥ 80% | ✅ **40/40 = 100%** | `scripts/validate.py`（Python venv 已清理；2026-10-24 用 Node `lib/inference.js` + `lib/mapping.js` 复算同一 40 条 CASES：zh 20/20、en 20/20，无 miss，详见 §0.1.3） |
| 单条推理 < 200ms（CPU INT8） | ✅ Python `validate.py` 中位 **6.8ms**；Node 侧含分词中位 **8.3ms**、p95 **11.6ms**、max 21.3ms | `validate.py` 计时 + `tests/inference.test.ts` 真实模型用例 + §0.1.3 复算 |
| tokenizer 与 Python fast tokenizer 逐 token 对齐 | ✅ 4/4 case ids/mask 完全一致 | `tests/fixtures/tokenizer-reference.json` + `tests/inference.test.ts` |
| 连续 5 轮 sad 单调上升且 ≤ CAP=1.0 | ✅ | `tests/mapping.test.ts`、`tests/projection.test.ts` |
| 之后 10 轮 neutral sad < 0.2 | ✅（DECAY 校准为 0.85，见 #13） | `tests/mapping.test.ts` 验收场景 |
| 推理异常不影响主流程 | ✅ init/score 全部降级为空对象 + 日志 | `tests/inference.test.ts`（缺失资产、run 抛错、logits 维度不符） |
| 进程重启后 projection 恢复 | ✅ 日志重放回归测试 | `tests/projection-restore.test.ts` + `tests/fixtures/session-restore-events.jsonl` |
| 悬浮框可拖拽/折叠/位置记忆/动画 | ✅ 真实 DSH 页面 + demo CDP | 本页截图、`docs/widget.md`、widget CDP 17 项断言 |
| Shadow DOM 隔离 | ✅ 恶意宿主 CSS demo + 真实页面 shadowRoot | `demo/index.html`、本页截图 |
| DSH 真实页面加载无 slot crash | ✅ 无 console error；元素正常升级 | 本页截图 + #20 |
| Host 插件真实加载 | ✅ `dsh --profile emo-test --help` EXIT 0；`import('dsh-emotion-analyzer')` 成功 | #17/#18 |
| 真实模型完整 turn（回复→打分→投影→UI） | ✅ **0.2.2-rc.1 上已复跑**（2026-11-10）：headless profile + `--patch` 注入插件，真实 LLM 一轮 → 写入 v2 plugin record → projection 折叠成功；见下节「0.2.2-rc.1 适配验证」。UI 端仍以隔离页面 CDP 断言为准。 | 见下节 |

## 真实页面（隔离 profile + 合成会话日志）

在隔离的 DSH_HOME 与测试 profile 下启动 DSH Web，Headless Chrome CDP 加载真实页面（为避免暴露本机工作区，不提交页面截图）：

- 展开态、折叠徽章以 DOM/计算样式断言为准；
- 本机工作区名、绝对路径、profile 名一律不写入仓库。

CDP 断言（真实页面）：

| 断言 | 结果 |
|---|---|
| `customElements.get('emotion-monitor')` | function |
| `document.createElement('emotion-monitor')` | 不抛错，构造函数为自定义类，shadowRoot 存在 |
| portal 容器 `[data-dsh-emotion-analyzer]` | 1 个 |
| 默认态 | `data-view=collapsed`、48×48、徽章 emoji 😐 |
| 点击徽章 | 展开 328×139（等待态面板；有数据时含分数条/sparkline） |
| 点击折叠按钮 | 回到 `data-view=collapsed`、48×48 |
| hover 徽章 | 不展开（#31 移除 hover 预览） |
| 页面 console | 修复 #20 后 0 个异常 |

## 0.2.2-rc.1 适配验证（2026-11-10）

> 环境：Linux x86_64 / Node 24.21 / **DSH 0.2.2-rc.1** / CPU INT8。验证后已清理测试会话与临时文件。

| 验收项 | 结果 | 证据 |
|---|---|---|
| `npm run check`（typecheck + 158 tests） | ✅ 157 pass / 1 skip / 0 fail（skip = 需 `DSH_EMOTION_HORIZON_DIR` 的精度回归） | 本机运行输出 |
| `npm run build` | ✅ | esbuild 输出 |
| 隐私检查 | ✅ 无本机路径 | `scripts/check-privacy.sh` |
| `--patch` 冒烟（真实插件行插入 web profile） | ✅ `apply` 执行、无报错、进程正常退出 | `dsh --profile web --patch <overlay> --help` |
| 宿主模块解析 | ✅ 解析到 `~/.npm-global/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`（宿主副本），不是插件本地副本 | 探针插件打印 + `createRequire(realpath(process.argv[1]))` |
| 宿主 Session 写入 | ✅ `createAppendRecord` 在真实 dsh 进程内 append 成功（seq=0，事件 1 条） | 探针插件输出 |
| **真实模型完整 turn** | ✅ 两次真实 turn 均写入成功（latencyMs 20 / 17） | headless profile + `--patch`（插件行 + 用户 LLM provider 配置） |
| projection 折叠 | ✅ `stateVersion 4 / turn 1 / dominant pleasant`，`pleasant 0.356 > neutral 0.324`，`latencyMs 17–20`，`language zh` | 会话 projection 缓存（验证后已清理） |

真实 turn 的 plugin record（会话日志原文摘要）：

```json
{"type":"plugin:emotion-analyzer/turn","ignorable":true,
 "data":{"version":2,"turn":1,"modelId":"horizon-small","profileId":"go-emotions-28",
         "latencyMs":17,"language":"zh","chars":20}}
```

结论：0.2.2-rc.1 上「回复 → 本地打分 → 写 plugin record → projection 折叠」链路打通；此前记录的阻断级风险（插件本地 `dsh-session` 副本导致 `TypeError: Receiver must be an instance of class Session`）已由 `src/host-modules.ts` 的宿主解析修复。

## 未验证 / 已知限制

- **UI 端真实模型数据**：完整 turn 已在 headless profile 验证（见上节），但 Web 页面在「真实 turn 数据」下的悬浮框截图尚未复跑；UI 行为以隔离页面 CDP 断言为准。
- Node 22 / Windows / macOS 下的 `onnxruntime-node`、`tokenizers` 安装未在本机复跑（仅 Linux + Node 24）。
- DSH 设置页的开关行只做了代码路径与注册验证，未在真实页面打开 Settings 截图。
- 多标签页、prefers-reduced-motion、隐私模式 localStorage 降级：代码已处理，未逐项截图。

## 0.1.1 用户反馈修复验证

| 项 | 结果 |
|---|---|
| 新增“疑问”维度 | 真实页面 widget 显示 7 条分数条，含「疑问 0%」；映射为 surprise 代理（happy 并入 pleasant 后为 7 维） |
| 关闭 → 重开 | 点击 [×] 后 widget 隐藏、出现「💗 情绪」按钮、localStorage visible=0；点击后 widget 恢复、visible=1 |
| slot 注册 | 真实页面 console 探针确认 `shell.overlay`、`settings.section`、`settings.general.item`、`conversation.session.header.utilities` 四个 inject 回调全部触发 |
| 控制台错误 | 0 |

## 0.1.2 「疑问」提取修复验证（真实模型）

模型 surprise 对中文疑问句几乎不响应；新增宿主 `doubt` 启发式后，用真实 INT8 模型 + mapping 实测：

| 文本 | doubt | surprise | confused（单轮，STEP_MAX 封顶） |
|---|---|---|---|
| 这是为什么？ | 0.50 | 0.036 | **0.250** |
| 我不太确定接下来该怎么办。 | 0.50 | 0.006 | **0.250** |
| 你说的是什么意思？ | 0.50 | 0.019 | **0.250** |
| 真的吗？我没想到会这样！ | 0.50 | 0.985 | **0.250** |
| Why did this happen? | 0.50 | 0.847 | **0.250** |
| 今天天气不错。 | 0.00 | 0.003 | 0.000 |
| The meeting is at 3pm. | 0.00 | 0.002 | 0.000 |
| 请帮我改一下这个函数。 | 0.00 | 0.002 | 0.000 |

注：单轮受 `STEP_MAX=0.25` 限制，连续疑问/不确定回复会累积上升；陈述句不误报。

## 0.1.3 映射重构回归（Node 复算 validate.py 40 条）

> Python venv 已清理，本轮不重装 torch/transformers。用 Node 24.21 + 真实 INT8 模型复算 `scripts/validate.py` 内置的 40 条 CASES：
> `lib/inference.js` 打分（逐元素 sigmoid）→ `lib/mapping.js` 的 `aggregate` 聚合 → 与 validate.py 相同的 tie-break
> （pleasant → sad → angry → anxious → unwell → confused → neutral）。映射已与 validate.py 同步
> （sad=sadness、angry 去掉 disgust、anxious=fear、unwell=max(disgust, 0.5×fear)）。

| 项 | 结果 |
|---|---|
| 准确率 | **40/40 = 100%**（中文 20/20、英文 20/20，无 miss） |
| 单条耗时（Node 分词 + 推理） | 中位 **8.34ms**、p95 **11.56ms**、max 21.3ms |
| 8 条中性句「其它维度」最大值 | **0.018**（均 < THRESHOLD=0.2，无误报） |
| 次级维度 ≥0.2 的用例 | 12/40（其中 ≥0.3 的 11/40；降到 0.2 仅新增 5 个次级命中，0.210–0.245） |
| unwell ↔ sad 相关系数（40 条原始概率） | 旧映射 **0.965** → 新映射 **0.028**（新 unwell ↔ angry 0.112） |

逐条明细（期望 → 预测、raw top-1）无 miss 项；一次性复算脚本与 JSON 未入仓（避免把验证工具当功能提交）。

### unwell / sad 解耦抽检（真实模型）

| 文本 | 旧 unwell | 新 unwell | sad | angry | 结论 |
|---|---|---|---|---|---|
| 我头晕恶心，胃里翻江倒海，想吐。 | 0.404 | **0.991** | 0.016 | 0.012 | 恶心句命中反感，不再顺带抬高悲伤 |
| 今天一整天都很伤心，什么都不想做。 | 0.066 | **0.001** | 0.130 | 0.011 | 纯悲伤不点亮反感 |
| 看到蟑螂我觉得好恶心，差点吐出来。 | 0.403 | **0.994** | 0.011 | 0.008 | disgust 只归 unwell；旧映射 angry 会是 0.994（两条重复） |
| 这条新闻让我非常愤怒，简直无法接受。 | 0.032 | 0.025 | 0.048 | **0.953** | 愤怒句由 anger 主导，不被 disgust 干扰 |
| 明天就要面试了，我紧张得整晚睡不着。 | 0.004 | 0.378（fear×0.5） | 0.007 | 0.010 | anxious 为主；unwell 副作用来自 fear×0.5（设计如此） |
| 今天下午三点在五楼会议室开会。 | 0.005 | 0.006 | 0.006 | 0.009 | 中性句全部 <0.2 |

### THRESHOLD=0.2 误报检查

- 8 条 neutral 句：除 neutral 外所有维度最大 **0.018**，`doubt` 全部为 0，不会触发更新。
- 40 条中次级维度 ≥0.2 的只有 12 条，其中 ≥0.3 的 11 条；降到 0.2 仅新增 5 个次级命中（0.210–0.245），top-1 与准确率不变。
- 真正的多标签串扰来自模型本身（例如「Walking home alone in the dark really scares me.」sad=0.853、anxious 才是期望），不是 0.2 阈值引入；投影按维度独立累积，属可接受行为。

## v0.2 模型切换回归（issue #39）

> 环境：Linux x86_64 / Node 24.21 / CPU INT8；Horizon small 从 Hugging Face 下载到 `/tmp`，未提交仓库。

| 项 | 结果 | 证据 |
|---|---|---|
| legacy 40 条 | **40/40 = 100%**，中位 8.6 ms | `DSH_EMOTION_HORIZON_DIR=... node --test tests/models-accuracy.test.ts` |
| Horizon small 40 条 | **38/40 = 95%**（≥90%），中位 19.3 ms | 同上；2 miss 见 `docs/models.md` §7 |
| 下载：流式 / 大小校验 / 回滚 / 取消 / 并发去重 | ✅ 8 个 manager 单测 | `tests/models-manager.test.ts` |
| 默认回退 legacy / 切换 / 删除后回退 / needsExport | ✅ 8 个 service 单测 | `tests/models-service.test.ts` |
| Host API 契约与错误形状 | ✅ 7 个 route 单测（含 4 条 DELETE 预注册） | `tests/models-routes.test.ts` |
| 设置原子写 / 损坏回退 | ✅ | `tests/settings.test.ts` |
| 映射 profile（28/11/8 标签 → 7 维） | ✅ | `tests/models-profiles.test.ts`、`tests/projection.test.ts`（v2 记录按 profileId 重放） |
| 真实 DSH 页面调用模型 API（下载/切换/DELETE） | ⚠️ **未在本机真实验证**：需要 Web 会话 + 大文件下载；route 逻辑已单测，DELETE 方法放行风险见 `docs/models.md` §8 | 后续设置页联调时补 |

## 0.2.0 模型管理验证

| 项 | 结果 |
|---|---|
| legacy 40 条 | 40/40 = 100%，中位 8.61ms |
| Horizon small 40 条 | 38/40 = 95%，中位 19.33ms（<200ms） |
| npm run check（无 Horizon env） | 120 tests / 119 pass / 1 skip（Horizon 精度用例） |
| npm run check（DSH_EMOTION_HORIZON_DIR） | 120/120 pass |
| npm run build | 通过（含 lib/models/*） |
| 模型 Host API | 路由单测通过；DELETE 方法运行时验证待真实页面 |
| 设置页模型 UI | 单测 + build 通过；真实页面模型区截图待补（欢迎页登录态限制） |
## 0.2.2 外部审查修复验证

| 项 | 结果 |
|---|---|
| 冷启动慢 init 首轮仍写 record | 单测覆盖（fake slow init，init 超时 10s / score 1.5s） |
| H2 error:null 不再产生假失败 | 真实 host state fixture 测试通过 |
| H4 默认 strict live | 404 不再自动 mock；显式参数才 mock |
| H6 空 projection | store 返回 data=null，widget 不写 storage |
| H7 隐藏/切会话 | update effect 依赖 visible/sessionId，reset/回填 |
| H3 坏模型回退 | 同尺寸坏 ONNX 测试：标记错误并回退 legacy |
| 安装自检 | `bash scripts/check-install.sh web` 输出 OK |
| 全量测试 | `npm run check` 146 tests / 145 pass / 1 skip / 0 fail；build 通过 |
