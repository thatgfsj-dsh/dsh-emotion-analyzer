# 模型注册、下载与映射（v0.2）

> 对应 issue #39；v0.2 默认模型从 legacy tabularisai（11 标签）切换为 **Horizon-Labs/multilingual-emotions-small**（28 标签、36 语言、Apache-2.0）。

## 1. 预设一览

| id | 模型 | 许可 | 体积 | 语言 | 标签 | 映射 profile | 状态 |
|---|---|---|---|---|---|---|---|
| `horizon-small`（**默认**） | [Horizon-Labs/multilingual-emotions-small](https://huggingface.co/Horizon-Labs/multilingual-emotions-small) | Apache-2.0 | 268,449,278 B（约 256 MiB） | 36 | 28（GoEmotions） | `go-emotions-28` | 官方 INT8 ONNX，可下载 |
| `horizon-base`（**推荐**） | [Horizon-Labs/multilingual-emotions-base](https://huggingface.co/Horizon-Labs/multilingual-emotions-base) | Apache-2.0 | 641,205,891 B（约 612 MiB） | 36 | 28 | `go-emotions-28` | 官方 INT8 ONNX，可下载 |
| `legacy-tabularisai`（**回退默认**） | [tabularisai/multilingual-emotion-classification](https://huggingface.co/tabularisai/multilingual-emotion-classification) | **CC-BY-NC-4.0**（非商业） | 278,963,213 B | 23 | 11 | `legacy-11` | 包内 `assets/`，回退资产，**不可删除** |
| `zh-johnson-small`（**中文**，manual/experimental） | [Johnson8187/Chinese-Emotion-Small](https://huggingface.co/Johnson8187/Chinese-Emotion-Small) | MIT | 手动放置（0 表示未知） | zh | 8（LABEL_0..7） | `zh-8` | **manual**：不提供在线下载；手动放置 `model.onnx`+`tokenizer.json`+`config.json` |

下载 URL 固定为 Hugging Face `resolve/main`：

- `horizon-small`: `https://huggingface.co/Horizon-Labs/multilingual-emotions-small/resolve/main/onnx/model_quantized.onnx` + `tokenizer.json` + `config.json`
- `horizon-base`: 同一路径规则，仓库换为 `Horizon-Labs/multilingual-emotions-base`
- `zh-johnson-small`: 无官方 ONNX；需要本地导出 `model.onnx`，与 `tokenizer.json` / `config.json` 一起放到 `$DSH_HOME/emotion-analyzer/models/zh-johnson-small/`（tokenizer/config 可从 HF 下载）。

体积来自 2026-10-25 HEAD 实测（`content-length` / `x-linked-size`）；`sizeBytes` 展示模型文件本身，tokenizer/config 在下载时单独校验。

## 2. 目录与设置

```text
$DSH_HOME/emotion-analyzer/                 # DSH_HOME 未设置时回退 ~/.dsh
├── config.json                             # 原子写入（临时文件 → rename）
└── models/
    ├── horizon-small/
    │   ├── onnx/model_quantized.onnx
    │   ├── tokenizer.json
    │   └── config.json
    └── horizon-base/...
```

`config.json`：

```json
{
  "activeModelId": "horizon-small",
  "provider": { "type": "local" },
  "providerStatus": { "ready": true, "error": null }
}
```

- `activeModelId` 默认 `horizon-small`；`provider` v0.2 只有 `local`，`apiKeyEnv` 为后续自定义 API 预留（当前只做兼容读取/写入）。
- 设置由 `src/settings.ts` 负责：损坏 JSON / 非法字段回退默认值并 warning；写入先落 `.tmp` 再 rename，不会留下半个文件。

## 3. 默认与回退规则

1. 读取 `activeModelId`；
2. 对应模型已完整下载 → 使用该模型 + 它的 mapping profile；
3. 否则若 legacy `assets/model-int8.onnx` + `assets/tokenizer.json` 存在 → **回退 legacy**，`state.fallbackActive = true`，并打一次 warning；
4. 两者都没有 → 打分为空（`score()` 返回 undefined），turn-stopping 跳过本轮，不影响主流程。

安装后默认走 legacy 回退；用户在设置页（或调用 API）下载 `horizon-small` 并选择后，**下一轮生效**（旧 ONNX session 会被 dispose）。

## 4. 下载管理

实现：`src/models/manager.ts`。

- **流式写盘**：每个文件先写 `<file>.part`，完整接收且大小校验通过后 rename 为正式文件；失败 / 取消会删除 `.part`，不会留下半成品。
- **进度**：`receivedBytes / totalBytes / percent`，通过 `GET state` 轮询；同一模型并发下载会去重。
- **取消**：取消后状态 `cancelled`，无残留文件。
- **大小校验**：优先与注册表 `sizeBytes` 比对，否则与 `content-length` 比对；不一致报 `size_mismatch`。
- **删除**：只允许删非 legacy；删除当前激活模型后会回退 legacy。
- **不提交权重**：模型目录位于 `$DSH_HOME`，仓库 `assets/` 只有 legacy 导出产物且被 `.gitignore` 忽略。

## 5. 映射 profile（28 / 11 / 8 标签 / 7 维直出 → 7 维）

实现：`src/models/profiles.ts`（纯数据 + 纯函数，projection 重放只依赖 `profileId`）。
统一维度固定为：`pleasant / sad / angry / anxious / unwell / confused / neutral`。

### 5.1 `go-emotions-28`（Horizon small/base）

| 统一维度 | 来源标签 |
|---|---|
| pleasant | joy, amusement, admiration, approval, caring, gratitude, love, optimism, pride, excitement, relief, **desire** |
| sad | sadness, disappointment, grief, remorse |
| angry | anger, annoyance, disapproval |
| anxious | fear, nervousness |
| unwell | disgust, embarrassment |
| confused | confusion, curiosity, surprise, realization, **doubt**（宿主文本启发式） |
| neutral | neutral |

- 任务给定分组没有覆盖 `desire`，这里补进 pleasant（正向愿望），保证 28 个标签全部有归属。
- `doubt` 仍由 `src/text.ts` 生成，用于中文疑问/不确定句；GoEmotions 原生的 `confusion` 与它取 max。
- 初版映射沿用现有 7 维语义，未对 28 标签重新聚类；40 条验收集 **38/40 = 95%**（2 条 miss 见 §7），达到 ≥90% 验收线。

### 5.2 `legacy-11`（回退）

保持 v0.1 语义，详见 [架构文档的“情绪映射与累积”](architecture.md#情绪映射与累积srcmappingts)。40 条验收集仍 **40/40**。

### 5.3 `zh-8`（Johnson8187 small）

| 模型标签 | 语义 | 统一维度 |
|---|---|---|
| LABEL_0 | 平淡 | neutral |
| LABEL_1 | 关切 | anxious（在意 / 担忧） |
| LABEL_2 | 开心 | pleasant |
| LABEL_3 | 愤怒 | angry |
| LABEL_4 | 悲伤 | sad |
| LABEL_5 | 疑问 | confused |
| LABEL_6 | 惊奇 | confused |
| LABEL_7 | 厌恶 | unwell |

`doubt` 同样并入 confused。该预设当前 **manual/experimental**：不提供在线下载；用户自行导出 `model.onnx`（deberta-v2 tokenizer）并与 tokenizer/config 一起放入 `$DSH_HOME/emotion-analyzer/models/zh-johnson-small/` 后即可在设置页选择。

### 5.4 `unified-7`（自定义 API 直出，#41）

API 通道让第三方模型直接输出 7 个统一维度分数，因此该 profile 是 **identity 映射**：
每个维度只由同名标签驱动，`doubt` 等派生信号不参与（API 输出里出现也会被丢弃）。
记录带 `profileId: 'unified-7'`，projection 重放不访问网络，切换通道不影响历史轮次。

## 6. Host API（`/api/emotion-analyzer/v1`）

路由通过 `ctx.connection.fetch.register` 注册在 Connection 的鉴权栅栏内：只有 owner Peer 能访问，其他 principal 由 Host 返回 403；本插件不自行解析 token。

| Method | Path | Body | 返回 |
|---|---|---|---|
| GET | `/state` | — | `ModelStatePayload` |
| POST | `/model/select` | `{ "id": "<preset-id>" }` | `ModelStatePayload` |
| POST | `/model/download` | `{ "id": "<preset-id>" }` | `202` + `ModelStatePayload`（立即返回，进度轮询 state） |
| DELETE | `/model/{id}` | — | `ModelStatePayload` |
| POST | `/provider` | `{ "type": "local" }` 或 `{ "type": "api", "baseUrl", "model", "apiKeyEnv?", "timeoutMs?" }` | `ModelStatePayload` |
| POST | `/test` | `{ "text": "..." }` | `{ scores, modelId, latencyMs }`（scores 为 7 维统一分数；API 模式走 API） |

`ModelStatePayload`：

```json
{
  "activeModelId": "horizon-small",
  "fallbackActive": false,
  "models": [{
    "id": "horizon-small", "name": "...", "license": "Apache-2.0", "sizeBytes": 268449278,
    "languages": ["en", "..."], "labels": ["admiration", "..."], "mappingProfile": "go-emotions-28",
    "downloaded": true, "downloading": false,
    "progress": { "receivedBytes": 268449278, "totalBytes": 302815719, "percent": 100 },
    "error": null, "needsExport": false
  }],
  "provider": { "type": "local" }
}
```

错误统一为 `{ "error": { "code": "...", "message": "..." } }`。
常见 code：`invalid_body`、`unknown_model`、`not_downloaded`、`needs_export`、`legacy_protected`、`model_unavailable`、`inference_failed`、`invalid_provider`、`provider_unavailable`、`api_failed`、`internal`。

> 路由注册限制：Connection exact Fetch route 以完整 pathname 匹配、不支持 `:id` 参数，因此 DELETE 按 4 个预设 id 预注册；新增预设时要同步注册（`src/models/routes.ts` 遍历 `MODEL_PRESET_IDS`）。

## 7. 精度与延迟（v0.2 验收）

本地 Linux / Node 24.21 / CPU INT8，40 条固定 CASES（`scripts/validate.py`，20 中文 + 20 英文）：

| 模型 | top-1 统一维度 | 中位延迟（Node 含分词） | 备注 |
|---|---|---|---|
| legacy-tabularisai | **40/40 = 100%** | 8.6 ms | 无 miss |
| horizon-small | **38/40 = 95%** | 19.3 ms | 2 miss：`She said yes and I have never been happier…`（pleasant → sad）、`This company cheated…makes me sick.`（angry → sadness） |

Horizon 两条 miss 来自模型原始分布（第一条最高标签 disappointment 0.16、pleasant 相关 <0.13；第二条 sadness 0.71、angry 0.26），不是映射或 softmax 问题；初版映射不做逐条特判。

复跑方式（不会提交权重）：

```sh
# 1) 下载到任意本地目录
huggingface-cli download Horizon-Labs/multilingual-emotions-small \
  --include 'onnx/model_quantized.onnx' 'tokenizer.json' 'config.json' --local-dir <任意目录>/horizon-small

# 2) 跑真实模型回归（legacy 40/40 也会在 assets 存在时一起跑）
DSH_EMOTION_HORIZON_DIR=<任意目录>/horizon-small node --test tests/models-accuracy.test.ts
```

## 8. 离线 / 代理 / 风险

- **离线安装**：按 §2 的目录手动放置文件（大小见 §1），`GET state` 会显示 `downloaded: true`，不需要联网。
- **代理**：下载使用 Node fetch 访问 huggingface.co。Node 24 可用 `NODE_USE_ENV_PROXY=1` 让 `HTTP(S)_PROXY` 生效（以本机 Node 版本为准）；镜像/企业网关可等价替换 URL 后手动放置文件。
- **完整性**：当前只校验“存在 + 字节数”，未做 sha256；后续 issue 可加 checksum/manifest。
- **DELETE 方法**：Connection 的 `ConnectionFetchMethod` 类型只声明 GET/HEAD/POST；本实现按契约注册 DELETE，运行时 Host 只校验 path/method 唯一性。若某版 Host 在 HTTP 桥拒收 DELETE，需要退回 POST 变体（风险待真实页面验证）。
- **许可**：默认 Horizon 为 Apache-2.0；legacy 仍为 CC-BY-NC-4.0（非商业），仅作回退资产，商用请使用默认模型或自行替换。


## 9. 自定义 OpenAI-compatible API（#41）

默认通道仍是本地 ONNX。设置页「打分通道」可切到第三方 API（**opt-in**）：

```json
{
  "activeModelId": "horizon-small",
  "provider": {
    "type": "api",
    "baseUrl": "https://api.example.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "EMOTION_API_KEY",
    "timeoutMs": 8000
  }
}
```

- 请求：`POST {baseUrl}/chat/completions`（OpenAI chat 协议），`temperature: 0`，要求模型只输出 7 维严格 JSON。
- 解析：容忍 ```json 围栏/前后文字；出现的维度必须是 0–1 有限数字，否则整体判非法；未知键丢弃、缺失维度按 0。
- 降级：超时（默认 8s）/ HTTP 非 2xx / JSON 非法 / 密钥缺失 → 回退本地 ONNX（若可用），`fallbackActive=true`，
  `providerStatus.error` 暴露原因；本地也不可用则本轮跳过。
- 密钥：只从 `apiKeyEnv` 指向的**环境变量**读取，配置文件只存变量名，不落盘密钥。
- 成本：`POST /test` 与每轮打分都会调用 API，按对方价格计费；发送内容为**助手回复文本**（截断 4000 字符），不含用户输入、会话 id 或密钥。
- 映射：API 记录用 `unified-7` profile，projection 重放不依赖网络。
- 非法配置（URL/模型名/超时/环境变量名）在保存时被拒绝；配置文件里损坏的 API 配置会被规范化为 `local`（安全默认），不会把插件锁死。
