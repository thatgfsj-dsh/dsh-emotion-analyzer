# 架构

```
主模型回复完成
  │  agent/turn-stopping { agent, turn, signal }   （DSH 0.2.2-rc.1 实际事件名）
  ▼
EmotionModelService.score(text)      src/models/service.ts
  │  settings(activeModelId) → registry preset → manager 下载目录 / legacy assets
  │  EmotionScorer(modelPath, tokenizerPath, labels)  src/inference.ts
  │  onnxruntime-node + INT8 ONNX；N 个原始标签逐元素 sigmoid
  ▼
profile.updateProjection(current, raw)   src/models/profiles.ts → src/mapping.ts
  │  按模型 profile（legacy-11 / go-emotions-28 / zh-8）聚合 7 维
  │  阈值过滤 + 衰减 + 步长 + 封顶
  ▼
appendPluginRecord(session, 'plugin:emotion-analyzer/turn', v2 data with modelId/profileId)
  │  src/host-modules.ts：从运行中的 dsh 安装解析宿主 dsh-session（品牌检查）
  │  ignorable 会话事件 → 持久化 / 重启恢复 / fork 携带
  ▼
await ctx.sessionProjections.register({ key: 'emotion', ... })   src/projection.ts
  │  纯同步 fold（按记录自带 profileId 重放）；wire view 推送给 Web 客户端
  ▼
客户端隐形桥 useProjection('emotion') → 模块级 store
  ▼
shell.overlay 浮层 → React portal → <emotion-monitor>（Shadow DOM）
```

模型管理旁路：`GET/POST /api/emotion-analyzer/v1/*`（`src/models/routes.ts`）→ `EmotionModelService` →
`ModelManager`（下载/校验/删除）与 `settings.ts`（`$DSH_HOME/emotion-analyzer/config.json`）。

> **0.2.2 适配要点**：`apply` 是 async 并 `await` projection 注册（`register()` 返回 Promise）；
> `appendPluginRecord` 必须用宿主那一份 `@deepseek-ai/dsh-session`（品牌检查），解析策略见
> [校准文档](calibration.md#第三方插件的宿主模块解析022-实测阻断级)。

## 模块边界

| 文件 | 职责 | 行数预算 |
|---|---|---|
| `src/mapping.ts` | 通用规则聚合 / 累积纯函数（legacy 默认导出） | < 320 |
| `src/models/registry.ts` | 模型预设静态数据（许可/体积/标签/URL） | < 300 |
| `src/models/profiles.ts` | 标签 → 7 维映射 profile（28/11/8） | < 300 |
| `src/models/manager.ts` | 模型下载 / 校验 / 取消 / 删除 | < 400 |
| `src/models/service.ts` | 激活模型解析、回退、打分、切换 | < 420 |
| `src/models/routes.ts` | Host API `/api/emotion-analyzer/v1/*` | < 250 |
| `src/settings.ts` | `$DSH_HOME/emotion-analyzer/config.json` 原子读写 | < 200 |
| `src/inference.ts` | ONNX 会话、分词、sigmoid、计时/降级 | < 450 |
| `src/projection.ts` | projection 单元定义与 schema | < 250 |
| `src/host-modules.ts` | 宿主 `dsh-session` 模块解析（0.2.2 品牌检查） | < 150 |
| `src/index.ts` | 插件入口、turn-stopping 钩子、路由注册 | < 300 |
| `src/widget/*` | Shadow DOM 悬浮框、sparkline、样式 | 每文件 < 700 |
| `src/client/index.ts` | shell.overlay + 隐形桥 + portal | < 300 |

## 情绪映射与累积（`src/mapping.ts` + `src/models/profiles.ts`）

v0.2 起映射按模型可插拔：`src/mapping.ts` 只提供通用规则函数（`aggregateWithRules` /
`updateProjectionWithRules`），具体标签表在 `src/models/profiles.ts`（`legacy-11` /
`go-emotions-28` / `zh-8`，详见 [模型文档](models.md#5-映射-profile28--11--8-标签--7-维)）。
下面以 legacy-11 为例说明 7 维语义；其余 profile 保持同一批 7 个维度。

模型的 11 个原始标签（逐标签 sigmoid，互不排斥）+ 宿主派生信号 `doubt`，聚合成 7 个统一维度：

| 统一维度 | 聚合 | 来源标签 |
|---|---|---|
| `pleasant`（愉快） | max | joy, love, gratitude（happy 已并入，#30） |
| `sad` | max | sadness（frustration 只归 angry，#30） |
| `angry` | max | anger, contempt, frustration（disgust 只归 unwell，#32） |
| `anxious` | max | fear（frustration 只归 angry，#30） |
| `unwell`（反感） | max | max(disgust, fear×0.5)，与 sad 解耦（#32） |
| `confused`（疑问） | max | surprise（模型）+ doubt（宿主文本启发式） |
| `neutral` | max | neutral |

`max` 让同义标签取最强的一个，避免重复放大。几处刻意的“单一归属”：

- `frustration` 只归 `angry`，不再同时推高 `sad` / `anxious`（#30）。
- `disgust` 只归 `unwell`：实测“恶心”句 disgust≈0.99，若同时进 angry 会出现两条重复高亮（#32）。
- `unwell` 不再用 sadness 拼装，避免与 sad 共线（40 条验收集 r=0.965 → 0.028），纯悲伤不再点亮“反感”（#32）。
- `confused` 由模型 `surprise`（只覆盖真正的惊讶）+ 宿主启发式 `doubt`（覆盖中文疑问/不确定句，见 [issue #28](https://github.com/Thatgfsj/dsh-emotion-analyzer/issues/28)）组成；二者都是代理，不代表模型具备真实困惑分类能力。

`updateProjection(current, rawScores)` 是纯函数，按顺序执行：

1. **聚合**：11 个模型标签 + `doubt` → 7 个维度（越界 / 非有限值按 0 处理）。
2. **门控**：
   - 本轮没有**被映射的**输入（空对象、全非法值）→ 视为“无输入”，所有维度纯衰减；
   - 有输入但所有维度聚合值都低于 `THRESHOLD`（0.2，issue #30 校准）→ 判为噪声，整轮跳过，状态不变。
3. **命中**（聚合值 ≥ `THRESHOLD`）：`next = min(CAP, old × DECAY + min(raw, STEP_MAX))`。
4. **未命中**：`next = old × DECAY`。
5. 钳制到 `[0, 1]`，返回新对象，不修改入参。

常量集中在 `src/mapping.ts` 顶部：`THRESHOLD=0.2`、`DECAY=0.85`、`STEP_MAX=0.25`、`CAP=1.0`。

- `THRESHOLD` 从 0.3 降到 0.2（#30）：模型对“难过”常给 sadness≈0.27，0.3 会直接丢弃真实悲伤；中性句其余标签实测 <0.05，不会误报。
- `DECAY` 取 0.85 而不是 0.9：0.9^10 = 0.349 无法满足“5 轮伤心 + 10 轮中性后 sad < 0.2”的验收（[issue #13](https://github.com/Thatgfsj/dsh-emotion-analyzer/issues/13)），0.85^10 = 0.197。
- 当前 `THRESHOLD < STEP_MAX`，命中维度的单轮增量 = `min(raw, STEP_MAX)`：raw ∈ [0.2, 0.25) 时取 raw，否则封顶 0.25。

示例：连续 5 轮高强度 `sad`（聚合 raw=1.0）→ `0.25 → 0.4625 → 0.643 → 0.797 → 0.927`（单调上升、不超 `CAP`）；随后 10 轮 `neutral`，`sad` 衰减为 `0.927 × 0.85¹⁰ ≈ 0.183 < 0.2`。

## 本地推理（`src/inference.ts`）

- `EmotionScorer` 惰性加载：首次 `init()` 才 `import('onnxruntime-node')` 建 `InferenceSession`、`import('tokenizers')` 读 `assets/tokenizer.json`；路径用 `new URL('../assets/...', import.meta.url)`，src/ 与构建后的 lib/ 都指向包根 assets，不依赖进程 cwd。
- 分词：`Tokenizer.fromFile` + `setTruncation(512)`；`encode()` 的 ids / attention_mask 在 scorer 内再截断一次作为双保险；特殊 token 由 tokenizer 自带后处理器加入，不手工拼接。
- 张量：`int64` + `BigInt64Array`，dims `[1, seq]`；输出 logits → **逐元素 sigmoid**（多标签分类，不能 softmax）。`EmotionScorer` 接受 `{ modelPath, tokenizerPath, labels }`：标签顺序由 active 预设提供（legacy 11 / GoEmotions 28 / zh 8），logits 列数必须与标签数一致，否则降级为空对象；`switchModel()` 会先 dispose 旧 session。
- 失败降级：assets 缺失 / native 模块加载失败 / `session.run` 抛错 / logits 维度不符 → `init() === false` 或 `score() === {}`，写 `console.warn` / `console.error`，**绝不抛**。
- 计时：单条推理（不含首次模型加载）超过 `SLOW_INFERENCE_MS = 200` 打 warning；`dispose()` 释放 ONNX session，可重复调用。
- 测试：mock session 覆盖 sigmoid / int64 / 512 截断 / 异常降级 / 计时告警；`tests/fixtures/tokenizer-reference.json` 与 Python fast tokenizer 逐 token 对齐（fixture 或 assets 缺失时显式 skip 并打印原因）。

## 模型管理与切换（`src/models/*` + `src/settings.ts`）

- **registry.ts**：4 个预设（`horizon-small` 默认 / `horizon-base` / `legacy-tabularisai` / `zh-johnson-small`），
  含 id / name / repo / license / sizeBytes / languages / labels / mappingProfile / default / urls。
  `zh-johnson-small` 标 `needsExport`（无官方 ONNX）；legacy 用包内 `assets/`，不可删除。
- **manager.ts**：下载到 `$DSH_HOME/emotion-analyzer/models/<id>/`。流式写 `<file>.part` → 大小校验 → rename；
  失败/取消回滚，进度可轮询，同一模型并发去重。状态含 downloaded / downloading / progress / error / needsExport。
- **settings.ts**：`$DSH_HOME/emotion-analyzer/config.json`（activeModelId + provider:{type:'local'}），
  临时文件 → rename 原子写；损坏时回退默认值并 warning。
- **service.ts**：解析 activeModelId → 已下载模型 / legacy 回退（fallbackActive=true + warning）；
  按 active profile 暴露 score / testModel / getState / selectModel / downloadModel / deleteModel；
  切换/删除时 dispose 旧 scorer，下一轮惰性加载新模型。
- **routes.ts**：`/api/emotion-analyzer/v1/*`（state / model/select / model/download / model/{id} DELETE / test），
  注册在 Connection 鉴权栅栏内；错误统一 `{error:{code,message}}`。
- **projection**：插件记录升级为 v2（带 modelId / profileId），fold 时按记录自己的 profile 重放；
  stateVersion 3 → 4，旧缓存回放重建，切换模型不影响历史轮次。

## 数据与隐私

- 只把**助手回复文本**送进本地 ONNX，推理阶段不联网、不发往任何模型 API；模型下载（用户主动操作）会访问 HuggingFace。
- 会话日志里新增的是 `plugin:` 命名空间、`ignorable` 的插件记录（原始分数 + 统一维度分数 + 元信息），不含用户输入原文。
- 悬浮框历史最多保留 30 轮（内存 + localStorage）。
