/**
 * 缺陷跟踪器工厂（PRD 功能三：缺陷联动）。
 *
 * createDefectTracker() 按环境变量选择实现：
 * - TEST_AGENT_DEFECT_TRACKER=mock → Mock（显式选 mock）
 * - TEST_AGENT_DEFECT_TRACKER=jira → Jira（显式选 jira，配置不齐抛错）
 * - 默认：JIRA_URL / JIRA_TOKEN / JIRA_PROJECT_KEY 配齐 → Jira，否则 → Mock
 */

import type { DefectTracker, DefectCreateInput, DefectCreateResult } from "./defect-tracker.js";
import { MockDefectTracker } from "./mock-tracker.js";
import { JiraDefectTracker, jiraConfigFromEnv } from "./jira-tracker.js";

export { type DefectTracker, type DefectCreateInput, type DefectCreateResult } from "./defect-tracker.js";
export { MockDefectTracker, resetMockCounter, getMockCounter } from "./mock-tracker.js";
export { JiraDefectTracker, jiraConfigFromEnv, isJiraConfigured, type JiraConfig } from "./jira-tracker.js";

/**
 * 带防御纵深校验的缺陷跟踪器包装（P2-1 防御纵深补强）。
 *
 * GUI 的 v-if="category==='real-bug'" 是第一道防线；本包装是第二道防线——
 * 即使绕过 GUI 直调 createDefect（如 IPC 直调、未来新增调用方），
 * 非 real-bug 用例也会被拒绝并返回结构化失败结果，不抛异常中断。
 *
 * 校验在工厂层统一施加，Mock/Jira 实现都受同一保护，不用各改。
 */
export class GuardedDefectTracker implements DefectTracker {
  /** 被包装的真实跟踪器（Mock/Jira），测试可读以判定类型。 */
  readonly inner: DefectTracker;

  constructor(inner: DefectTracker) {
    this.inner = inner;
  }

  async createDefect(input: DefectCreateInput): Promise<DefectCreateResult> {
    if (input.category !== "real-bug") {
      return {
        ok: false,
        error: `非 real-bug 用例不允许建单（category=${input.category}）。仅 real-bug 进缺陷系统，避免污染工单库。`,
      };
    }
    return this.inner.createDefect(input);
  }

  async ping(): Promise<boolean> {
    return typeof this.inner.ping === "function" ? this.inner.ping() : true;
  }
}

/**
 * 按环境变量创建缺陷跟踪器（带 real-bug 防御纵深校验）。
 *
 * 返回 GuardedDefectTracker，在工厂层统一施加 category==='real-bug' 校验，
 * Mock/Jira 实现都受同一保护。调用方可通过 `.inner` 访问被包装的真实跟踪器。
 *
 * @param env 环境变量（默认 process.env，测试可注入）
 * @returns GuardedDefectTracker 实例
 */
export function createDefectTracker(env: NodeJS.ProcessEnv = process.env): DefectTracker {
  const explicit = env.TEST_AGENT_DEFECT_TRACKER?.trim().toLowerCase();

  if (explicit === "mock") return new GuardedDefectTracker(new MockDefectTracker());

  if (explicit === "jira") {
    // 显式选 jira，配置不齐抛错
    return new GuardedDefectTracker(JiraDefectTracker.fromEnv(env));
  }

  // 默认：Jira 配齐用 Jira，否则 Mock
  const config = jiraConfigFromEnv(env);
  if (config) return new GuardedDefectTracker(new JiraDefectTracker(config));
  return new GuardedDefectTracker(new MockDefectTracker());
}
