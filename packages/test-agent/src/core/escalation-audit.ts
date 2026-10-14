/**
 * Escalation 审计日志 — 每次 ask/reply/超时降级落 JSONL 供审计。
 *
 * 存储布局（照抄 cases.ts/flaky.ts 的 .test-agent/<projectHash>/ 存储模式）：
 *   .test-agent/escalations/<projectHash>/audit.jsonl
 *
 * 每条记录一行 JSON（JSONL），追加写入（appendFileSync），不修改已有行。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeProjectHash } from "./cases.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 审计日志条目（每次 ask 记一条，reply/超时后更新同一条或追加）。 */
export interface EscalationAuditEntry {
  /** ISO 时间戳。 */
  timestamp: string;
  /** escalation 唯一 ID（与 EscalationHandler 的 escalationId 对应）。 */
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
  /** 从 ask 到 resolve/reject 的耗时（毫秒，resolved 或 degraded 时有）。 */
  durationMs?: number;
  /** 突变检测告警（同角色短时高频 escalate 时标）。 */
  burstWarning?: string;
}

// ---------------------------------------------------------------------------
// 存储路径
// ---------------------------------------------------------------------------

/** 审计日志目录：.test-agent/escalations/<projectHash>/ */
function auditDir(projectPath: string, projectHash?: string): string {
  const hash = projectHash ?? computeProjectHash(projectPath);
  return join(resolve(projectPath), ".test-agent", "escalations", hash);
}

/** 审计日志文件路径。 */
function auditFilePath(projectPath: string, projectHash?: string): string {
  return join(auditDir(projectPath, projectHash), "audit.jsonl");
}

// ---------------------------------------------------------------------------
// 写入 / 读取
// ---------------------------------------------------------------------------

/**
 * 追加一条审计日志到 audit.jsonl。
 *
 * 照抄 flaky.ts recordRun 的 appendFileSync + JSON.stringify + "\n" 模式。
 */
export function appendEscalationAudit(
  projectPath: string,
  entry: EscalationAuditEntry,
  projectHash?: string,
): void {
  const dir = auditDir(projectPath, projectHash);
  mkdirSync(dir, { recursive: true });
  appendFileSync(auditFilePath(projectPath, projectHash), JSON.stringify(entry) + "\n", "utf8");
}

/**
 * 加载审计日志（全部条目，按时间正序）。
 *
 * 照抄 flaky.ts loadRuns 的 readFileSync + split + JSON.parse 模式。
 */
export function loadEscalationAudit(
  projectPath: string,
  projectHash?: string,
): EscalationAuditEntry[] {
  const filePath = auditFilePath(projectPath, projectHash);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const result: EscalationAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line) as EscalationAuditEntry);
    } catch {
      // 跳过损坏行（进程崩溃/磁盘满/断电致末行截断），保留完好行
    }
  }
  return result;
}
