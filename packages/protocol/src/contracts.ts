/**
 * 测试运行请求契约 — protocol 包自包含的领域模型。
 *
 * 这些类型是 gui ↔ test-agent ↔ worker-mode 之间的传输契约，
 * 类似 pi protocol 的 SessionSnapshot/Command——协议包自己定义，
 * 不依赖 test-agent 产品包。
 */

export type TestType = 'unit' | 'regression' | 'ui' | 'api';

export interface TaskInput {
  projectPath: string;
  systemName: string;
  version: string;
  testTypes: TestType[];
  requiredCapabilities?: string[];
  coverageTarget?: number;
  knowledgeRoots?: string[];
  targetClasses?: string[];
  apiBaseUrl?: string;
  openApiUrl?: string;
  apiHeaders?: Record<string, string>;
  uiEntryUrl?: string;
  environment?: Record<string, string>;
  /**
   * Execution target invariant: endpoint tasks are device-bound and must never
   * be re-dispatched to another terminal; shared tasks are re-acquirable and
   * must never carry developer-local absolute paths.
   */
  executionTarget?: 'endpoint' | 'shared';
  deviceId?: string;
  workspaceId?: string;
  sourceSnapshot?: {
    gitHead?: string;
    dirty?: boolean;
    digest?: string;
  };
  sourceRef?: string;
  /** 测试策略：反射场景驱动（reflect_test，LLM 生成 JSON 场景）vs 传统 JUnit（maven_test，LLM 写 Java 代码）。缺省 junit（向后兼容）。 */
  testStrategy?: 'reflect' | 'junit';
  /** 计划确认时选择执行范围；true=全量，false=增量。旧调用方缺省保持增量。 */
  fullRun?: boolean;
  /** 计划阶段产出的用例——执行阶段传入，host 据此分发到 runExecute。 */
  cases?: unknown[];
  /** 修复阶段用：从诊断确认阶段传回的诊断结果。host 收到后用它驱动修复，不重新诊断。 */
  diagnosis?: {
    failedCases: Array<{
      name: string;
      layer: string;
      error: string;
      category: 'real-bug' | 'test-defect' | 'environment' | 'flaky';
      confidence?: 'high' | 'low';
      evidence?: string;
      suggestion?: string;
      screenshot?: string;
    }>;
  };
  /** 修复阶段用：分层决策结果。 */
  fixDecision?: { action: 'auto-fix' | 'needs-confirm' | 'no-fix'; reason: string };
  /** 侦察阶段产出，计划阶段传回用（scout 报告传给 case-designer）。 */
  scoutReport?: string;
  /** P3-5：执行时跳过的用例 ID 列表，runner 据此过滤 executionCases。 */
  skipCaseIds?: string[];
  /** 已完成受控测试代码生成；后续执行阶段不得再次读取源码或写测试。 */
  testCodeGenerated?: boolean;
}

export interface AiProviderConfig {
  baseUrl: string;
  api: 'openai-completions';
  apiKey: string;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
  };
  models: Array<{ id: string; reasoning?: boolean }>;
}

export interface AiConfig {
  providers: Record<string, AiProviderConfig>;
  defaultProvider?: string;
  defaultModel?: string;
  /** 执行引擎选择：'cimicode'（默认 CLI provider）或 'ai-native'（内置 LLM in-process）。 */
  executionEngine?: 'cimicode' | 'ai-native';
}

// ---------------------------------------------------------------------------
// 诊断类型组（跨包统一：test-agent/gui 共用）
// ---------------------------------------------------------------------------

/** 失败诊断分类（PRD 第4节 4 类分类）。 */
export type DiagnosisCategory = 'real-bug' | 'test-defect' | 'environment' | 'flaky';

/** escalation 记录汇总（复用 escalation-audit.ts EscalationAuditEntry 字段，供 AgentRunResult.report.escalations）。 */
export interface EscalationRecord {
  /** ISO 时间戳。 */
  timestamp: string;
  /** escalation 唯一 ID。 */
  escalationId: string;
  /** 角色（scout/case-designer/tester/result-reviewer/fixer）。 */
  role: string;
  /** 角色提的问题。 */
  question: string;
  /** 保守方案（超时降级用）。 */
  fallback?: string;
  /** 是否已答复（reply 被调）。 */
  resolved: boolean;
  /** 是否降级（超时或预算耗尽）。 */
  degraded: boolean;
  /** 答复内容（resolved=true 时有）。 */
  answer?: string;
  /** 从 ask 到 resolve/reject 的耗时（毫秒）。 */
  durationMs?: number;
  /** 突变检测告警（同角色短时高频 escalate 时标）。 */
  burstWarning?: string;
}

/** 失败用例诊断记录。 */
export interface FailedCaseRecord {
  name: string;
  layer: string;
  error: string;
  category: DiagnosisCategory;
  /** 诊断置信度（high=证据定位到具体行+明确缺陷 / low=证据模糊），驱动分层自动决策。 */
  confidence?: "high" | "low";
  evidence?: string;
  suggestion?: string;
  screenshot?: string;
  /** P0 项4：源码位置（surefire stack 第一帧），GUI 报告展示 + 定位。 */
  location?: { path: string; line: number };
  /** P0 项4：关联的反射场景 caseId（与 .test-agent/scenarios/<caseId>.json 对应），重跑入口。 */
  caseId?: string;
  /** P0 项4：surefire 报告提取的测试类全名（比 LLM 输出更可靠）。 */
  testClass?: string;
}

/** 修复动作记录（可追溯可回滚）。 */
export interface FixAction {
  /** 对应哪条诊断。 */
  diagnosisName: string;
  category: DiagnosisCategory;
  confidence: "high" | "low";
  /** 改了哪些文件 + diff。 */
  files: Array<{ path: string; diff: string }>;
  /** 修复后重跑结果。 */
  rerunResult: { passed: number; failed: number };
  /** 回滚用 reverse patch（修复前 git diff HEAD）。 */
  patch: string;
}
