# agents/ 角色定义

每个角色一个 .md 文件，含 YAML frontmatter + 正文（systemPrompt + escalate 指引等）。

## 运行时使用方式

**frontmatter（所有角色 LIVE）：** agent-loader 加载 frontmatter 字段（tools/turnBudget/escalation/escalationSteer/thinking/fallback）用于运行时接线。**不得删除 frontmatter。**

**systemPrompt + 正文（非对称，按角色分两类）：**

| 角色 | systemPrompt 运行时来源 | .md 正文是否 LIVE |
|------|------------------------|------------------|
| scout | `role.systemPrompt`（scout.md，runner.ts:752） | ✅ LIVE（直接用）|
| case-designer | `role.systemPrompt`（case-designer.md，runner.ts:897） | ✅ LIVE（直接用）|
| tester | `testerRole.systemPrompt + scenario.systemPrompt`（tester.md 通用段 + scenario 专精段，runner.ts:1239） | ✅ LIVE（通用段直接用）|
| result-reviewer | `getScenario("result-reviewer").systemPrompt`（scenarios.ts，orchestrator.ts:256） | ❌ DEAD（scenario 覆盖，.md 正文不进运行时）|
| fixer | `getScenario("fix-by-diagnosis").systemPrompt`（scenarios.ts，fix-orchestrator.ts:225） | ❌ DEAD（scenario 覆盖，.md 正文不进运行时）|

## agent-loader 提取方式

agent-loader.ts（`loadRoles` → `parseFrontmatter`）将 frontmatter `---` 之后的**整个 body** 作为 `systemPrompt` 字段（`systemPrompt: body.trim()`）。
因此 **.md 正文 = systemPrompt**——对 scout/case-designer/tester 直接进运行时；对 fixer/result-reviewer 虽不进运行时（scenario 覆盖），但 body 内容仍被 agent-loader 解析到 `role.systemPrompt`。

> **维护推论**：不可往 fixer.md / result-reviewer.md 的 body 加注释块（会进 `role.systemPrompt`，语义混乱）。DEAD 标注放在 frontmatter `#` 注释中（YAML 注释，agent-loader 解析器忽略）。

## 维护指引

- **scout/case-designer/tester**：.md 正文是 LIVE 源，改 systemPrompt/escalate 指引**必须改 .md**（scenarios.ts 的 tester scenario 是专精补充，不是主源）。
- **fixer/result-reviewer**：.md 正文是 DEAD 重复，改 systemPrompt/escalate 指引**改 scenarios.ts**（fix-by-diagnosis / result-reviewer scenario）。.md 正文作文档参考，frontmatter `#` 注释标注"以 scenarios.ts 为准"。
- **所有角色**：frontmatter 不得删除（运行时接线用）。

## 为何非对称

历史演进：早期角色（scout/case-designer/tester）systemPrompt 在 .md，后引入 scenarios.ts 做场景化配置，新角色（fixer/result-reviewer）systemPrompt 放 scenarios.ts，旧角色保留 .md 兼容。导致来源混合。
