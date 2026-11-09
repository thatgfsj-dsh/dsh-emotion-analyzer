# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/).

> 版本历史说明：`v0.2.2-fix`（2026-10-26）晚于 `v0.2.3`（2026-10-25）发布但版本号更小，属历史遗留；
> 自 `0.2.4` 起 tag 与 `package.json` 版本一一对应。

## [0.2.5] - 2026-11-10

### Added（#41 自定义 API 通道）

- OpenAI-compatible chat 打分通道（**opt-in**）：`POST {baseUrl}/chat/completions`，要求严格 JSON 7 维分数；支持 `baseUrl / model / apiKeyEnv / timeoutMs`，密钥只从环境变量读取、不落盘。
- 新增 `unified-7` 映射 profile（7 维 identity）：API 记录带 `profileId: 'unified-7'`，projection 重放不依赖网络。
- Host API 新增 `POST /provider`；`GET /state` 增加 `provider` 与 `providerStatus`。
- 设置页新增「打分通道」卡片：本地 ONNX / 自定义 API 单选、字段校验、状态提示、隐私/成本说明。

### Changed

- `EmotionModelService` 变为 provider 感知：API 失败（超时 / HTTP / JSON 非法 / 密钥缺失）自动回退本地并标记 `fallbackActive`；`POST /test` 对 API 失败返回 502 `api_failed`。
- `ProviderSettings` 扩展为 `local | api` 联合；配置文件里损坏的 API 配置规范化为 `local`（安全默认）。
- 文档：`docs/models.md` §9、README「打分通道」、architecture / e2e / calibration 同步。

### Verified

- `npm run check`：179 tests / 178 pass / 1 skip / 0 fail；`npm run build` 通过。
- 本机回环 HTTP server 实测：成功 / 超时 / HTTP 500 / 非法 JSON / 密钥缺失 5 类路径；**未调用真实第三方 API**。

## [0.2.4] - 2026-11-10

### Changed（适配 DSH 0.2.2-rc.1，#70）

- **宿主 `dsh-session` 共享实例**：`appendPluginRecord` 在 0.2.2 用 Session 品牌检查，`link:` 安装时插件本地副本会抛 `TypeError: Receiver must be an instance of class Session`。新增 `src/host-modules.ts`，运行时优先从运行中的 dsh 安装解析宿主模块（`realpath(process.argv[1])` 锚点），失败才回退本地副本（开发/单测），并缓存结果。
- **projection 注册契约**：`ctx.sessionProjections.register()` 返回 Promise，`apply` 改为 async 并 `await` 注册完成。
- **append 异步化**：`runEmotionTurn` 的 `appendRecord` 支持异步并在返回前 await（宿主模块解析是异步的）。
- **依赖声明**：`@deepseek-ai/dsh-session` 同时进 `peerDependencies` + `devDependencies`（0.2.2-rc.1）；`engines.dsh` 收敛为 `>=0.2.2-rc.1 <0.3.0`（0.2.1 未复测，故不再声明支持）。
- **测试**：新增 `tests/turn.test.ts`（turn 提取/打分/异步 append/超时降级）与 `tests/host-modules.test.ts`（宿主锚点优先、缓存、回退），`src/index.ts` 首次有回归覆盖。
- **文档**：`docs/calibration.md` 重写为 0.2.2-rc.1 证据表并新增「第三方插件的宿主模块解析」；architecture / e2e / README / AGENTS 同步版本与验证结论。

### Verified（0.2.2-rc.1）

- `npm run check`：158 tests / 157 pass / 1 skip / 0 fail；`npm run build` 通过。
- `--patch` 冒烟加载真实插件行：`apply` 执行、无报错。
- 真实模型完整 turn（headless profile + `--patch`）：horizon-small 17–20ms，写入 `plugin:emotion-analyzer/turn` v2 记录，projection `stateVersion 4 / turn 1 / dominant pleasant`。

### Changed（版本与发布收口，#72）

- `package.json` version 0.2.2 → **0.2.4**，与最新 tag 对齐；补齐 `[0.2.3]` CHANGELOG 条目。
- 仓库内 10 处旧组织链接 `Thatgfsj/dsh-emotion-analyzer` → `thatgfsj-dsh/dsh-emotion-analyzer`（`package.json` repository/homepage/bugs、README 宣传片、`docs/promo.md`、`docs/architecture.md`）。

## [0.2.3] - 2026-10-25

> tag `v0.2.3`；该 tag 在特性分支提交上，内容随 PR #58 进入 main。

### Fixed

- 模型页状态卡住：已下载模型显示未安装、其他模型一直「处理中」。下载中只让当前卡片显示取消/进度，其余保留各自动作（禁用）；下载后主动刷新 state；新增「刷新状态」按钮与实时/演示数据标识。

## [0.2.2] - 2026-10-26

> 本版本以 tag `v0.2.2-fix` 发布（发布时间晚于 `v0.2.3`，版本号保持 0.2.2）。

### Fixed（外部审查修复批次 #59）

- **C1/C2 安装与首次运行**：新增 `scripts/check-install.sh` 自检 profile 依赖+bundle+`--dump-config`；README 安装必验；无可用模型时设置页明确提示并引导下载默认模型。
- **C3 打分生命周期**：冷启动 init 独立 10s 超时，单条推理仍 1.5s；首条回复不再因加载模型超时而丢 projection。
- **H1 doubt 误报**：剥离 fenced/inline code 与 URL；排除“需要我…吗”等服务性问句；问号降权、仅不确定词/真疑问词给高 doubt。
- **H2 假下载失败**：`error != null` 判断；真实 host state fixture 回归。
- **H3 模型完整性/回退**：下载/手动文件大小校验；init/select 失败自动回退 legacy；state 暴露 `effectiveModelId/effectiveFallback/runtimeError`。
- **H4 自动 mock**：生产默认 strict live；mock 仅显式参数；失败不再伪造成功。
- **H5 当前模型**：UI 区分“已选择”和“实际生效”。
- **H6/H7 悬浮框状态**：空 projection 视为无数据、不写 localStorage；隐藏→显示/切会话正确 reset/回填。
- **H8 中文预设**：改为 manual/experimental：用户手动把 `model.onnx`+`tokenizer.json`+`config.json` 放到 `$DSH_HOME/emotion-analyzer/models/zh-johnson-small/`，不再给错误导出指引。
- **H9/文档**：补充 apply/超时/state 归一化回归；README/architecture 隐私说明（推理不联网、下载模型联网）；Node engines >=22.18；修正体积/尺寸/版本描述。

### Changed（此前 0.2.2/0.2.3 快速版本合并进本版本）

- 深色/浅色 token 修正：`bg-layer-1/2`、`bg-mask-1`、`label-primary-foreground`，fallback 改为透明/继承/中性灰。
- 预设展示：Horizon Small（默认）、Horizon Base（推荐）、tabularisai（回退默认）、Chinese Emotion（中文）。
- 模型页状态卡住：下载中只让当前卡片显示取消/进度；下载后主动刷新；新增刷新状态按钮与实时/演示数据标识。

### Verification

- `npm run check`：146 tests / 145 pass / 1 skip / 0 fail；`npm run build` 通过。
- `bash scripts/check-install.sh web`：依赖+bundle+`--dump-config` 均 OK。

## [0.2.1] - 2026-10-25

### Fixed

- 插件管理页（Bundle 详情）缺少设置入口：注册 `plugins.bundle.config`（key=包名），内嵌完整的显隐/重置与模型管理区；无需再跳到 Settings（#50）。

## [0.2.0] - 2026-10-25

### Added

- **模型注册表与模型管理**（#39）：4 个预设——Horizon multilingual-emotions-small（默认，Apache-2.0，141M，36 语言，28 标签，官方 ONNX int8）、Horizon base（308M）、legacy tabularisai（11 标签，兼容旧行为）、Johnson8187 Chinese-Emotion-Small（中文 8 标签，需本地导出）。
- **模型下载/校验/切换**：流式下载到 `$DSH_HOME/emotion-analyzer/models/<id>/`，`.part` 回滚、字节数校验、进度、取消、并发去重、legacy 删除保护；未下载默认模型回退 legacy（不阻塞聊天）。
- **可插拔映射 profile**（#39）：`legacy-11` / `go-emotions-28` / `zh-8`；projection 记录携带 `profileId`（record v2 / stateVersion 4），跨模型切换后历史仍可正确重放。
- **设置页模型管理 UI**（#40）：当前模型卡片、预设卡片（下载进度/取消/删除/切换）、测试一句（7 维分数/耗时/modelId）、needsExport/fallback/错误提示；Host API `/api/emotion-analyzer/v1/{state,model/select,model/download,model/{id},test}`（Connection 鉴权）。
- 文档 `docs/models.md`（预设/许可/体积/映射/下载路径/回退/API）。

### Changed

- **默认模型改为 Horizon small**（#38 决策）：Apache-2.0 替代 CC-BY-NC，原生 confusion 标签；40 条中英验证 38/40 = 95%，CPU INT8 中位 19.3ms。
- legacy 11 标签模型保留为预设，历史会话/旧 projection 继续可读。
- `scripts/build.mjs` 支持 `lib/models/*` 嵌套 specifier；文档同步 README/architecture/calibration/e2e/model-export。

### Known limitations

- Horizon 初版 28→7 映射有 2 条 miss（pleasant→sad、angry→sadness），未特判。
- 中文预设只有注册/profile，ONNX 导出脚本待后续；下载完整性目前只校验存在+字节数（无 sha256）。
- `DELETE /model/{id}` 路由已单测；真实 DSH 页面尚未完成设置页模型区端到端截图（路由单测通过）。

## [0.1.3] - 2026-10-24

### Changed

- **合并 happy → pleasant（#30）**：统一维度收敛为 7 个（pleasant / sad / angry / anxious / unwell / confused / neutral）。joy / love / gratitude 统一映射到「愉快」，悬浮框、projection、类型定义、测试与文档同步；旧缓存由 `stateVersion` 回放日志重建。
- **映射精修（#30）**：`frustration` 只归 angry；`sad` 只看 `sadness`；`anxious` 只看 `fear`，不再因 frustration 同时抬高 sad / anxious。
- **unwell 与 sad 解耦（#32）**：`unwell` 由 `sadness×0.5 + disgust×0.4` 改为 `max(disgust, 0.5×fear)`。40 条验收集上 unwell↔sad 相关系数 **r=0.965 → 0.028**；纯悲伤不再点亮「反感」，「头晕恶心」句 unwell 0.404 → 0.991。
- **disgust 单一归属（#32）**：`angry` 的 terms 去掉 `disgust`，避免“恶心”句同时高亮 angry + unwell 两条重复（disgust=0.994 时旧 angry=0.994 → 新 angry=0.008）。
- **THRESHOLD 0.3 → 0.2（#30）**：模型对“难过”常给 sadness≈0.27，原阈值会丢弃真实悲伤；8 条中性句其余维度最大仅 0.018，未引入误报。
- **投影新增 `turnScores` / `turnDominant`（#30）**：保存“本回合原始聚合”分数与主导情绪（不经 `STEP_MAX` 累积），悬浮框“本回合”分数条/emoji 使用该字段；session projection `stateVersion` 2 → 3，旧缓存回放日志重建。
- **悬浮框默认 compact（#31）**：默认 48px emoji 徽章，点击展开、点 `—` 收起；移除 hover 自动预览，关闭后仍可从设置页/右上角 💗 重开。
- **模型校验同步**：`scripts/validate.py` 的 `unified_scores` / report mapping 与 `src/mapping.ts` 对齐（含 disgust 只归 unwell），40 条用例期望由 happy 改为 pleasant。
- **文档**：architecture / model-export / widget / e2e 的映射表、阈值、示例与实测数据；README 参数表同步。

### Fixed

- 疑问维度的回归数据与映射说明随本轮调整更新（`doubt` 启发式本身的修复见 0.1.2）。

### Verification

- Node 24.21 + INT8 真实模型复算 `scripts/validate.py` 的 40 条 CASES：**40/40 = 100%**（zh 20/20、en 20/20，无 miss），tie-break 与 validate.py 一致。
- `npm run check` 全绿（含真实模型端到端与 tokenizer 对齐；无 assets 时显式 skip）。

## [0.1.2] - 2026-10-24

### Fixed

- 「疑问」维度提取不到：实测模型 surprise 对中文疑问句不响应（0.006~0.075），新增宿主文本启发式 `doubt`（问号/疑问词/不确定词），与 surprise 取 max 后映射到 confused；补充单测与文档（#28 / #29）。

### Changed

- 记录里的 `raw` 新增派生键 `doubt`（非模型标签，schema 允许任意 0~1 键）。

## [0.1.1] - 2026-10-24

### Added

- 新增统一维度 **confused（疑问）**：以模型 `surprise` 作为代理（模型没有 confusion/uncertainty 标签），悬浮框新增「疑问 🤔」分数条与趋势线（#25）。
- 新增 **Settings → 情绪分析器** 设置页：显示/隐藏悬浮框、立即显示、重置悬浮框位置（#26）。
- 关闭悬浮框后的 💗 重开按钮移动位置并加大可发现性（#26）。

### Changed

- Session projection `stateVersion` 1 → 2（映射语义变化，旧持久化缓存回放日志）。

### Fixed

- 重新显示时 widget 自身 `closed` 持久化导致仍然隐藏（#27）。

## [0.1.0] - 2026-10-24

### Added

- 本地 ONNX 情绪推理：`EmotionScorer`（懒加载、INT8、int64 张量、逐元素 sigmoid、512 截断、200ms 告警、异常降级）。
- 模型流水线：`scripts/export_model.py`（HF → ONNX → INT8 动态量化）与 `scripts/validate.py`（20 中文 + 20 英文自验收）。
- 硬编码映射层 `src/mapping.ts`：11 原始标签 → 统一维度，THRESHOLD / DECAY / STEP_MAX / CAP。
- 宿主集成：`agent/turn-stopping` 钩子、`plugin:emotion-analyzer/turn` ignorable 会话记录、`emotion` session projection（纯同步 fold、wire view、重启/fork 恢复）。
- Web 客户端：`shell.overlay` 悬浮框（React portal + Shadow DOM）、session 投影桥（`useProjection('emotion')`）、Settings → General 显示开关。
- 悬浮框：拖拽/位置记忆、折叠 48px emoji 徽章、300ms 分数条动画、30 轮 canvas sparkline、明暗主题、关闭/重开、rAF 合并。
- 测试：mapping / inference / projection / text / store / widget / restore，含真实模型与 tokenizer 对齐用例（无资产时显式 skip）。
- 文档：architecture、calibration、client-integration、widget、model-export、e2e、贡献规则。
- Build-time-only CI（`v*` tag 或手动 dispatch）；PR 不跑 CI。

### Known limitations

- 真实模型完整 turn 的端到端未在本机复跑（测试环境缺少可用模型路由/API key）；各段已分别验证。
- 跨平台原生模块安装仅验证 Linux + Node 24。
- 模型权重许可证为 CC-BY-NC-4.0（非商业）。