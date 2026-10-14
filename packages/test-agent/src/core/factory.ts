/**
 * 执行器工厂 — 选择内置 AI 路径还是外部 CLI 路径。
 *
 * 两条路径：
 * - `ai-native`（内置 AI）：Runner — Agent + 测试工具，agent-core agentLoop
 * - `cimicode`/`claude-code`/`codex-cli`（外部 CLI）：spawn CLI 子进程
 *
 * 非 AI 路径（existing-maven/node/local-go）已删除。
 */

import type { AgentAdapter } from './types.js'
import { createCimiCodeAdapter } from '../cli-runners/cimicode.js'
import { ClaudeCodeAdapter, resolveClaudeExecutable } from '../cli-runners/claude-code.js'
import { CodexCliAdapter, resolveCodexExecutable } from '../cli-runners/codex-cli.js'
import { createRunner } from './runner.js'

export function createAgentAdapter(_projectPath?: string): AgentAdapter | null {
  // 默认 AI 生成测试（cimicode 为公司正式目标 Provider）。
  // ai-native 为内置 Agent 路径（Agent + 测试工具，无 CLI 子进程），需 ai-config.json。
  const provider = process.env.TEST_AGENT_PROVIDER?.trim() ?? 'cimicode'
  if (provider === 'cimicode') return createCimiCodeAdapter()
  if (provider === 'ai-native') return createRunner()
  if (provider === 'codex-cli') {
    const codex = resolveCodexExecutable()
    return codex ? new CodexCliAdapter(codex) : null
  }
  if (provider === 'claude-code') {
    const claude = resolveClaudeExecutable()
    return claude ? new ClaudeCodeAdapter(claude) : null
  }
  throw new Error(`Unsupported TEST_AGENT_PROVIDER: ${provider}`)
}

/**
 * Local Host provider selection. The desktop product is AI-first: when the
 * host opts into AI mode, prefer Codex CLI (read code, generate tests, run,
 * fix and collect coverage), then Claude Code, then CimiCode as fallback.
 */
export function createHostAgentAdapter(projectPath: string, preferAi: boolean): AgentAdapter | null {
  if (preferAi && !process.env.TEST_AGENT_PROVIDER?.trim()) {
    const codex = resolveCodexExecutable()
    if (codex) return new CodexCliAdapter(codex)
    const claude = resolveClaudeExecutable()
    if (claude) return new ClaudeCodeAdapter(claude)
  }
  return createAgentAdapter(projectPath)
}
