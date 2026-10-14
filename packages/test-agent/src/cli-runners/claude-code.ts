import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskInput } from '@cxmt/protocol'
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../core/types.js'
import { log } from '../core/types.js'
import { killProcessTree } from '../core/proc.js'

const RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['unit', 'regression', 'ui'] },
          status: { type: 'string', enum: ['passed', 'failed'] },
          summary: { type: 'string' }
        },
        required: ['type', 'status', 'summary'],
        additionalProperties: false
      }
    },
    report: {
      type: 'object',
      properties: {
        passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        coverage: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] }
      },
      required: ['passed', 'failed', 'coverage'],
      additionalProperties: false
    },
    artifacts: { type: 'array', items: { type: 'string' } }
  },
  required: ['lanes', 'report', 'artifacts'],
  additionalProperties: false
})

function promptFor(input: TaskInput, knowledge?: string): string {
  const base = [
    '你是 CIMDEV Test Agent 的真实执行器。请直接在当前项目中工作，不得伪造任何测试结果。',
    `系统：${input.systemName}`,
    `版本：${input.version || '未识别'}`,
    `测试类型：${input.testTypes.join(', ')}`,
    '',
    '要求：',
    '1. 检测真实技术栈和现有测试框架。',
    '2. 针对所选测试类型生成必要的测试代码；尽量不修改生产代码。',
    '3. 调用项目已有的 Go/Maven/Gradle/npm/Vitest/Playwright 等真实工具执行测试。',
    '4. 只有编译和执行的真实结果可以计入 passed/failed；无法执行必须记为 failed 并说明原因。',
    '5. 覆盖率只能来自真实覆盖率工具；未取得时返回 null。',
    '6. artifacts 只返回确实存在的相对路径。',
    '7. 最终严格按照 JSON Schema 返回结构化结果。'
  ].join('\n')
  return knowledge ? `${base}\n\n业务知识参考（仅作带来源的上下文，冲突转人工确认）：\n${knowledge}` : base
}

function parseResult(stdout: string): AgentRunResult {
  const envelope = JSON.parse(stdout) as Record<string, unknown>
  const candidate = envelope.structured_output ?? envelope.structuredOutput ?? envelope.result
  const result = typeof candidate === 'string' ? JSON.parse(candidate) : candidate
  if (!result || typeof result !== 'object') throw new Error('Claude Code 未返回结构化测试结果')
  return result as AgentRunResult
}

export function resolveClaudeExecutable(): string | null {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE
  if (!process.env.APPDATA) return null
  const executable = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return existsSync(executable) ? executable : null
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'Claude Code'

  constructor(private readonly executable: string) {}

  run(input: TaskInput, emit: (event: AgentEvent) => void, signal?: AbortSignal, context?: { knowledge?: string }): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      const pathParts = [
        join(input.projectPath, '.preview-toolchain', 'go', 'bin'),
        join(input.projectPath, '.toolchain', 'go', 'bin'),
        process.env.PATH ?? ''
      ].filter((path, index) => index === 2 || existsSync(path))
      const args = [
        '-p', promptFor(input, context?.knowledge),
        '--output-format', 'json',
        '--json-schema', RESULT_SCHEMA,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash(go *),Bash(mvn *),Bash(./mvnw *),Bash(gradle *),Bash(./gradlew *),Bash(npm *),Bash(npx *),Bash(git status *),Bash(git diff *)',
        '--max-turns', process.env.CLAUDE_CODE_MAX_TURNS ?? '30',
        '--max-budget-usd', process.env.CLAUDE_CODE_MAX_BUDGET_USD ?? '5',
        '--no-session-persistence'
      ]
      const child = spawn(this.executable, args, {
        cwd: input.projectPath,
        env: { ...process.env, PATH: pathParts.join(';') },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const abort = (): void => {
        killProcessTree(child.pid ?? 0)
        reject(new Error('任务已取消'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      const stdout: string[] = []
      const timer = setTimeout(() => {
        killProcessTree(child.pid ?? 0)
        reject(new Error('Claude Code 执行超过 30 分钟，任务已终止'))
      }, 30 * 60 * 1000)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => stdout.push(chunk))
      child.stderr.on('data', (chunk: string) => {
        const message = chunk.trim()
        if (message) emit(log('warning', message))
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(`Claude Code 执行失败，退出码 ${code ?? 'unknown'}`))
        try {
          const result = parseResult(stdout.join(''))
          emit(log('success', 'Claude Code 已返回真实测试执行结果'))
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })
    })
  }
}
