# AGENTS.md

本文件给 AI 代理与维护者共同遵守的仓库级指令。

- 语言：面向用户的文档以中文为主，代码注释可中英混排。
- 任何仓库修改 = 先 Issue，再 PR；不直接推 `main`。
- PR 不跑 CI；CI 仅在 `v*` tag / `workflow_dispatch` 时运行。
- 单文件 ≤ 1000 行；接近上限就拆分。
- 分支、worktree、本地构建产物（`lib/`、`demo/widget.iife.js`、`node_modules/`、模型文件）用完即清理。
- 文档与代码同 PR 更新。
- 不提交模型权重（CC-BY-NC-4.0，且 >100MB）。
- Host API 以本机 DSH 0.2.2-rc.1 的类型定义为准，见 `docs/calibration.md`。
