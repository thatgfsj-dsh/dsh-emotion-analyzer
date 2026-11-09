# dsh-emotion-analyzer

> DSH（DeepSeek Harness）情绪分析器插件：对主模型的每条回复做**本地**情绪打分，把累积情绪状态投影进 Session，并在 DSH 网站注入一个可拖拽的悬浮情绪监测框。

[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/code-MIT-green)](LICENSE)
[![model: Apache-2.0 default](https://img.shields.io/badge/model-Apache--2.0-blue)](docs/models.md)
[![files <1000 lines](https://img.shields.io/badge/file-%E2%89%A41000%20lines-brightgreen)](CONTRIBUTING.md)

[![宣传片：给你的 AI 聊天窗口装个情绪手环](docs/media/promo-poster.jpg)](https://github.com/Thatgfsj/dsh-emotion-analyzer/releases/download/promo-2026-10/promo45.mp4)

> ▶ **45 秒横版宣传片**（竖版 30 秒 × 3 个开场钩子见 [Release](https://github.com/Thatgfsj/dsh-emotion-analyzer/releases/tag/promo-2026-10)）· 数据口径与发布建议见 [docs/promo.md](docs/promo.md)

![悬浮框展开态](docs/screenshots/widget-expanded.png)

## 功能

- **本地推理，零第三方模型 API**：默认 **Horizon-Labs/multilingual-emotions-small**（GoEmotions 28 标签、36 语言、Apache-2.0、官方 INT8，约 256 MiB）；legacy tabularisai（11 标签）保留为回退资产。ONNX 全本地 CPU 推理，**推理阶段不联网**、不额外消耗主模型 Token；仅“下载模型”时访问 HuggingFace。
- **多语言**：默认模型覆盖 36 种语言；中文 / 英文按 CJK 占比显示语言标识。
- **可插拔映射 profile**：模型标签 → 7 个统一维度（**愉快 pleasant** / 悲伤 / 愤怒 / 焦虑 / **反感 unwell** / **疑问 confused** / 平静）。内置 `legacy-11`、`go-emotions-28`、`zh-8` 三套 profile；阈值过滤 + 衰减 + 步长 + 封顶，参数集中在 `src/mapping.ts`。详见 [模型与映射](docs/models.md)。
- **Session projection**：每轮分数以 `plugin:emotion-analyzer/turn`（ignorable）写入会话日志，由 `emotion` projection 单元纯同步 fold；重启、fork 自动恢复。
- **悬浮框**：Web Components + Shadow DOM；**默认 64px compact 徽章（emoji + 中文情绪）**，可拖拽；点击展开分数条/sparkline，再点 [—] 折叠；无 [×]/重开 chip，显示/隐藏只由 Settings → 情绪分析器控制（#31、#34）。

| 折叠徽章 | 暗色主题 | 等待态 |
|---|---|---|
| ![折叠](docs/screenshots/widget-collapsed.png) | ![暗色](docs/screenshots/widget-dark.png) | ![等待态](docs/screenshots/widget-waiting.png) |

## 架构（DSH 0.2.2-rc.1 实际 API）

```
agent/turn-stopping { agent, turn, signal }      ← 真实事件名（不是 turn-stopping）
  → 最后一条 assistant 的 text block
  → EmotionScorer.score(text)                    ← onnxruntime-node + INT8，惰性加载
  → appendPluginRecord(session, 'plugin:emotion-analyzer/turn', data)
  → ctx.sessionProjections.register({ key:'emotion', ... })   ← 纯同步 fold
  → Web 客户端 useProjection('emotion') → 模块 store
  → shell.overlay（root slot）→ React portal → <emotion-monitor>（Shadow DOM）
```

> 提示词里的 `turn-stopping` / `ctx.session.projection` / `ev.getLastMessage()` 与真实宿主不一致，完整校准表见 [docs/calibration.md](docs/calibration.md)。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-emotion-analyzer

# 必做：验证插件真的进了 profile 的 bundle 层
bash scripts/check-install.sh web
# 输出 OK 才算安装成功；若提示 bundle missing：
#   dsh plugin --profile web remove dsh-emotion-analyzer
#   dsh plugin --profile web add .
```

装好后默认尝试使用 `horizon-small`；如果模型尚未下载，会自动回退到 `assets/` 里的 legacy 模型（需按 [模型导出与量化](docs/model-export.md) 生成），两者都没有时插件静默降级、不影响聊天。

在设置页（或调用 Host API）下载并选择模型后，下一轮生效：

```sh
curl -X POST http://127.0.0.1:<port>/api/emotion-analyzer/v1/model/download \
  -H 'content-type: application/json' -d '{"id":"horizon-small"}'
curl -X POST http://127.0.0.1:<port>/api/emotion-analyzer/v1/model/select \
  -H 'content-type: application/json' -d '{"id":"horizon-small"}'
curl http://127.0.0.1:<port>/api/emotion-analyzer/v1/state
```

- 首次回复会触发 ONNX 加载（legacy 约 1.5s，Horizon small 约 2–3s），之后单条约 9–20ms；模型缺失时自动降级。
- `onnxruntime-node` / `tokenizers` 是原生模块，Windows/macOS 的安装脚本批准与二进制下载需在目标机验证（本机只验证了 Linux + Node 24）。
- **0.2.2 起宿主模块需共享实例**：`appendPluginRecord` 会做 Session 品牌检查，插件运行时从**运行中的 dsh 安装**解析 `@deepseek-ai/dsh-session`（`src/host-modules.ts`），`link:` 安装无需额外处理；非 dsh 进程内调用才回退插件本地副本（仅开发/单测）。

## 模型选择（v0.2）

| 预设 | 许可 | 体积 | 语言 | 标签 | 说明 |
|---|---|---|---|---|---|
| `horizon-small`（**默认**） | Apache-2.0 | 268 MB | 36 | 28 | 官方 INT8，可在线下载 |
| `horizon-base` | Apache-2.0 | 641 MB | 36 | 28 | 更准但更慢/更大 |
| `legacy-tabularisai`（**回退默认**） | CC-BY-NC-4.0 | 279 MB | 23 | 11 | 包内 assets，回退用，不可删除 |
| `zh-johnson-small` | MIT | 待导出 | zh | 8 | needsExport（暂无官方 ONNX） |

- 设置持久化在 `$DSH_HOME/emotion-analyzer/config.json`；模型下载到同目录 `models/<id>/`，不进仓库。
- 下载/切换/删除/测试接口：`/api/emotion-analyzer/v1/*`（鉴权由 DSH Connection 负责）。
- 完整预设、映射 profile、离线安装与风险见 [docs/models.md](docs/models.md)。

## 可调参数

都集中在 `src/mapping.ts` 顶部：

| 常量 | 值 | 说明 |
|---|---|---|
| `THRESHOLD` | 0.2 | 聚合分低于该值视为噪声：整轮跳过，不积累也不衰减。**校准记录**：模型对“难过”常给 sadness≈0.27，0.3 会丢真实悲伤；中性句其余标签 <0.05，降到 0.2 不误报（#30） |
| `DECAY` | 0.85 | 每轮回落系数。**校准记录**：提示词给 0.9，但 0.9^10=0.349 无法满足"5 轮伤心 + 10 轮中性后 sad<0.2"，故取 0.85（见 [#13](https://github.com/Thatgfsj/dsh-emotion-analyzer/issues/13)） |
| `STEP_MAX` | 0.25 | 单轮命中最大步长，避免一次爆表 |
| `CAP` | 1.0 | 统一维度封顶 |

模型原始标签 → 统一维度映射见 `EMOTION_MAP`（`sad = sadness`、`angry = max(anger, contempt, frustration)`、`anxious = fear`、`unwell = max(disgust, 0.5·fear)`、`confused = max(surprise, doubt)`，doubt 为文本启发式）。

## 验收结果

| 项 | 结果 |
|---|---|
| 20 中文 + 20 英文 top-1（legacy） | **40/40 = 100%**（Node 复算同一 40 条 CASES） |
| 20 中文 + 20 英文 top-1（Horizon small） | **38/40 = 95%**（≥90% 验收线） |
| CPU INT8 单条推理 | legacy 中位 **8.6ms**；Horizon small 中位 **19.3ms**（Node 含分词，< 200ms） |
| tokenizer 与 Python fast 对齐 | 4/4 case 逐 token 一致 |
| 5 轮 sad 累积 / 10 轮 neutral 回落 | 单测通过（≤ CAP、< 0.2） |
| 重启 projection 恢复 | 日志重放回归测试通过 |
| 真实 DSH 页面悬浮框 | 展开/折叠/预览截图，0 console error |
| 0.2.2-rc.1 真实模型完整 turn | ✅ headless 实测：horizon-small 20ms，v2 record 写入 + projection 折叠（pleasant 0.356） |

完整矩阵与未验证项见 [docs/e2e.md](docs/e2e.md)。

## 文档

- [架构](docs/architecture.md)
- [DSH 宿主 API 校准](docs/calibration.md)
- [客户端集成（slot / portal / 设置开关）](docs/client-integration.md)
- [悬浮框（交互、主题、localStorage）](docs/widget.md)
- [模型注册、下载与映射](docs/models.md)
- [模型导出与量化（legacy）](docs/model-export.md)
- [端到端验收](docs/e2e.md)
- [贡献规则](CONTRIBUTING.md) · [AGENTS](AGENTS.md)

## 隐私

- 只把**助手回复文本**送进本进程内的 ONNX 推理；推理阶段不联网、不调用第三方模型 API。
- 只有当用户主动下载模型时才会访问 HuggingFace（模型权重不随仓库分发）。
- 会话日志中的插件记录只含分数、语言、长度、FNV-1a 文本 hash 与时间，**不含回复原文**。
- 悬浮框趋势最多 30 轮（内存 + localStorage），不上传。

## License

- **代码**：MIT（见 [LICENSE](LICENSE)）。
- **模型权重**：默认模型 Horizon-Labs/multilingual-emotions-small 为 **Apache-2.0**；回退用的 legacy [tabularisai/multilingual-emotion-classification](https://huggingface.co/tabularisai/multilingual-emotion-classification) 为 **CC-BY-NC-4.0（非商业）**。本仓库不随源码分发权重，只提供下载/导出/量化脚本。商用请使用默认模型或自行替换。
