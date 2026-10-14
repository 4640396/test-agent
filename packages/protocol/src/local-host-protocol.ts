import type { TaskInput } from './contracts.js'

/**
 * 协议版本语义策略：
 *
 * - major bump（破坏向后兼容，需升 version）：删 kind / 改 kind 字段类型 / 改协议握手行为
 * - 兼容扩展（不升 version）：新增 kind（ClientMessage/LocalHostAgentEvent union 扩展，旧端走 default error 分支不影响现有链路）
 * - 先例：RunResultMessage.phase 多次扩展（加 'diagnosis'/'fix'/'scout'）均未升 version
 *
 * escalation-reply 正式化即兼容扩展（加 EscalationReplyRequest kind，version 保持 1）。
 */
export const LOCAL_HOST_PROTOCOL_VERSION = 1
export const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * Agent 事件协议（LIVE 定义）。test-agent 的 AgentEvent 是本类型的别名（types.ts import），
 * 单一来源，避免两处手工对齐的漂移风险。
 *
 * - `log`：简单日志行（外部 CLI adapter 路径），兼容旧 `{ level, message, stage }`
 * - `agent_start`/`agent_end`：Agent 生命周期
 * - `turn_start`/`turn_end`：一轮对话
 * - `message_update`：LLM 流式文本增量（delta）
 * - `tool_execution_start`/`tool_execution_end`：工具调用，end 带 result（含结构化测试结果）
 */
export type LocalHostAgentEvent =
  | { type: 'log'; level: 'info' | 'success' | 'warning' | 'error'; message: string; stage?: string; role?: string }
  | { type: 'agent_start'; role?: string }
  | { type: 'planning_start'; role?: string }
  | { type: 'planning_end'; caseCount: number; cases: unknown[]; role?: string }
  | { type: 'generation_progress'; target: string; outputPath: string; completed: number; total: number; status: 'queued' | 'running' | 'retrying' | 'completed' | 'reused' | 'failed'; message?: string; role?: string }
  | { type: 'test_execution_complete'; passed: number; failed: number; role?: string }
  | { type: 'turn_start'; turn: number; role?: string }
  | { type: 'message_update'; text: string; role?: string }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown; role?: string }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean; role?: string }
  | { type: 'turn_end'; turn: number; role?: string }
  | { type: 'agent_end'; role?: string }
  | { type: 'escalation'; escalationId: string; role: string; question: string; fallback?: string; context?: string }
  | { type: 'coordinator-message'; messageType: 'dispatch' | 'report' | 'ask' | 'reply'; from: string; to: string; content: string; role?: string }

export interface HandshakeRequest {
  id: string
  kind: 'handshake'
  protocolVersion: number
}

export interface HealthRequest {
  id: string
  kind: 'health'
}

export interface RunRequest {
  id: string
  kind: 'run'
  executionId: string
  input: TaskInput
}

export interface CancelRequest {
  id: string
  kind: 'cancel'
  executionId: string
}

export interface EscalationReplyRequest {
  id: string
  kind: 'escalation-reply'
  executionId: string
  escalationId: string
  answer: string
}

export interface EscalationDismissRequest {
  id: string
  kind: 'escalation-dismiss'
  executionId: string
  escalationId: string
}

export type ClientMessage = HandshakeRequest | HealthRequest | RunRequest | CancelRequest | EscalationReplyRequest | EscalationDismissRequest

export interface HandshakeResponse {
  id: string
  kind: 'handshake'
  ok: boolean
  protocolVersion: number
  hostVersion?: string
  capabilities?: string[]
  error?: string
}

export interface HealthResponse {
  id: string
  kind: 'health'
  ok: boolean
  activeRuns?: number
  error?: string
}

export interface RunAcceptedMessage {
  id: string
  kind: 'run-accepted'
  executionId: string
}

export interface AgentEventMessage {
  id: string
  kind: 'event'
  executionId: string
  event: LocalHostAgentEvent
}

export interface RunResultMessage {
  id: string
  kind: 'run-result'
  executionId: string
  outcome: unknown
  /**
   * 阶段标记：plan=计划阶段完成（GUI 显示确认），generate=测试代码生成并编译完成，execute=执行阶段完成（GUI 显示报告），
   * diagnosis=诊断完成需用户确认（GUI 显示诊断确认视图），fix=修复完成（GUI 显示报告）。
   * 缺省=旧 adapter 一次性完成。
   */
  phase?: 'plan' | 'generate' | 'execute' | 'diagnosis' | 'fix' | 'scout'
}

export interface RunErrorMessage {
  id: string
  kind: 'run-error'
  executionId: string
  error: string
  cancelled: boolean
}

export interface CancelledMessage {
  id: string
  kind: 'cancelled'
  executionId: string
}

export interface EscalationDismissedMessage {
  id: string
  kind: 'escalation-dismissed'
  executionId: string
  escalationId: string
}

export interface ErrorMessage {
  id: string
  kind: 'error'
  message: string
}

export type HostMessage =
  | HandshakeResponse
  | HealthResponse
  | RunAcceptedMessage
  | AgentEventMessage
  | RunResultMessage
  | RunErrorMessage
  | CancelledMessage
  | EscalationDismissedMessage
  | ErrorMessage
