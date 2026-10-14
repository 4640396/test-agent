import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { TaskInput } from '@cxmt/protocol'
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../core/types.js'
import { log } from '../core/types.js'
import { killProcessTree } from '../core/proc.js'

const RESULT_SCHEMA = {
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
    artifacts: { type: 'array', items: { type: 'string' } },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          scenario: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          layer: { type: 'string', enum: ['api', 'ui', 'unit'] },
          source: { type: 'string' },
          target: { type: 'string' },
          assertions: { type: 'integer', minimum: 0 },
          coverageDelta: { type: 'string' }
        },
        required: ['id', 'title', 'scenario', 'steps', 'expected', 'priority', 'layer', 'source', 'target', 'assertions', 'coverageDelta']
      }
    },
    riskPoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          message: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['severity', 'file', 'message', 'suggestion']
      }
    },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          beforeCode: { type: 'string' },
          afterCode: { type: 'string' }
        },
        required: ['severity', 'file', 'title', 'summary', 'beforeCode', 'afterCode'],
        additionalProperties: false
      }
    }
  },
  required: ['lanes', 'report', 'artifacts', 'cases', 'riskPoints', 'fixes']
} as const

const CODEX_NOISE_PATTERNS = [
  /failed to install system skills/i,
  /ignoring interface\.icon_/i,
  /Failed to create shell snapshot for powershell/i,
  /failed to warm featured plugin ids cache/i,
  /ignoring interface\.defaultPrompt/i,
  /Reading additional input from stdin/i
]

function isCodexNoise(line: string): boolean {
  return CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(line))
}

function buildPrompt(input: TaskInput, outputDirectory: string, knowledge?: string): string {
  const lines = [
    '你是 CIMDEV Test Agent 的测试执行代理。必须在当前项目内完成真实测试，不得虚构结果。',
    `系统：${input.systemName}`,
    `版本：${input.version || '未识别'}`,
    `测试类型：${input.testTypes.join(', ')}`,
    `测试产物目录：${outputDirectory}`,
    '',
    '执行要求：',
    '1. 识别项目技术栈、模块、现有测试框架和可用构建命令。',
    '1.1 运行任何命令前必须先读取 package.json/pom.xml 中的实际 scripts；不要假设存在 build/test/dev 命令。前端项目没有 build 脚本时，可运行 npx vite build 或仅启动 dev 服务器。',
    '2. 仅为选中的测试类型生成或补强必要测试；尽量不修改生产代码。',
    '2.1 先生成结构化测试用例清单并放入返回结果的 cases 字段：每例包含 id、title、scenario、steps（数组）、expected、priority(low|medium|high)、layer(api|ui|unit)、source（来源文档或模块）、target（被测方法或函数）、assertions（真实断言数量）、coverageDelta（该用例新增覆盖，如"+18行/+4分支"）。',
    '2.2 将用例清单另存为项目内 .test-agent/cases/cases-<时间戳>.json。',
    '3. 必须调用项目真实工具执行测试，例如 go test、Maven、Gradle、npm、Vitest 或 Playwright。',
    '3.1 这是硬性要求：若项目没有任何测试文件，必须为每个公开 Service/Util/Controller 方法生成有业务意义的单元测试（Java 使用 JUnit），真实断言方法行为、边界和异常；禁止只生成 SmokeTest 或 assertTrue(true) 这类空测试。',
    '3.2 同时生成 riskPoints 数组，描述未被覆盖或风险较高的模块：每项包含 severity(high|medium|low)、file（文件或方法）、message（具体风险）、suggestion（建议修复）。',
    '3.3 同时生成 fixes 数组，为高风险问题提供建议修复：每项包含 severity、file、title、summary、beforeCode（修复前代码片段）、afterCode（修复后代码片段）；没有修复建议时返回空数组。',
    '4. 单元测试必须编译、执行并包含有业务意义的断言；仅判空断言不能视为有效用例。',
    '5. 回归测试必须基于真实核心场景或已有回归基线；没有可执行条件时标记失败并说明原因。',
    '6. UI 测试必须真实启动或连接应用并执行浏览器操作；成功执行时保存截图，否则标记失败。',
    '6.1 UI 测试优先使用项目已有 Playwright 配置；若需要浏览器，优先使用本机微软 Edge（Playwright channel: "msedge"），不要检查或安装 Playwright 自带浏览器（ms-playwright）。',
    '6.2 当前执行环境不支持图片输入，不要调用 view_image；截图文件保存后只需在 artifacts 中返回相对路径，不要尝试读取或解析图片内容。',
    '7. passed、failed 和 coverage 只能来自真实测试工具输出；没有覆盖率数据时返回 null。',
    '8. 将测试计划、原始日志和综合报告保存到指定产物目录。',
    '9. artifacts 只返回当前项目内确实存在的相对路径。',
    '10. 最终严格按输出 Schema 返回，不要把计划或推测写成测试结果。',
    '11. 测试日志与报告产物必须写入项目目录内（建议 .test-agent/results），禁止写入系统临时目录；越界制品会被丢弃。',
    '13. 禁止递归扫描 node_modules、.git、dist、target、.test-agent 等大目录；需要了解结构时使用定向查询（如 Get-ChildItem 指定目录或读关键文件）。',
    ...(input.targetClasses && input.targetClasses.length > 0
      ? [`12. 本次必须为以下核心类生成单元测试：${input.targetClasses.join('、')}。为每个类至少生成一个可编译、可运行的 JUnit 测试，不得以“无测试设施”为由跳过。`]
      : [])
  ]
  const base = lines.join('\n')
  return knowledge ? `${base}\n\n## 业务知识参考（仅作带来源的上下文，冲突转人工确认）\n${knowledge}` : base
}

function messageFromEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.type === 'error') {
    return log('error', String(event.message ?? 'Codex CLI 返回错误'))
  }
  const item = event.item as Record<string, unknown> | undefined
  if (!item) return null
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return log('info', item.text)
  }
  if (item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '项目测试命令'
    const status = typeof item.status === 'string' ? item.status : 'running'
    return log(status === 'failed' ? 'error' : 'info', `Codex ${status}: ${command}`)
  }
  if (item.type === 'file_change') return log('info', 'Codex 已更新测试文件')
  return null
}

function validateResult(value: unknown, projectPath: string): AgentRunResult {
  if (!value || typeof value !== 'object') throw new Error('Codex CLI 未返回结构化测试结果')
  const result = value as AgentRunResult
  if (!Array.isArray(result.lanes) || !result.report || !Array.isArray(result.artifacts)) {
    throw new Error('Codex CLI 测试结果结构不完整')
  }
  if (result.riskPoints !== undefined && !Array.isArray(result.riskPoints)) {
    throw new Error('Codex CLI riskPoints 必须是数组')
  }
  if (result.fixes !== undefined && !Array.isArray(result.fixes)) {
    throw new Error('Codex CLI fixes 必须是数组')
  }
  return result
}

function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 尝试从 Markdown 代码块提取
  }
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (match) {
    try {
      return JSON.parse(match[1])
    } catch {
      // 继续回退
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // 继续回退
    }
  }
  return null
}

/** 优先读结果文件；失败时从事件流中回退提取符合结构的结果（模型最后消息不一定是 JSON）。 */
function extractStructuredResult(resultPath: string, eventsPath: string): unknown {
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    // 回退到事件流
  }
  let events = ''
  try {
    events = readFileSync(eventsPath, 'utf8')
  } catch {
    return null
  }
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const item = event.item as Record<string, unknown> | undefined
      if (!item) continue
      const candidates: unknown[] = []
      if (Array.isArray(item.content)) {
        for (const part of item.content as Array<Record<string, unknown>>) {
          if (typeof part.text === 'string') candidates.push(part.text)
        }
      }
      if (typeof item.text === 'string') candidates.push(item.text)
      if (typeof item.output === 'string') candidates.push(item.output)
      for (const candidate of candidates) {
        const parsed = parseJsonFromText(candidate as string)
        if (parsed && typeof parsed === 'object' && 'lanes' in parsed && 'report' in parsed && 'artifacts' in parsed) return parsed
      }
    } catch {
      // 跳过异常行
    }
  }
  return null
}

export function resolveCodexExecutable(): string | null {
  if (process.env.CODEX_CLI_EXECUTABLE && existsSync(process.env.CODEX_CLI_EXECUTABLE)) {
    return process.env.CODEX_CLI_EXECUTABLE
  }
  if (!process.env.APPDATA) return null
  const command = join(process.env.APPDATA, 'npm', 'codex.cmd')
  return existsSync(command) ? command : null
}

export class CodexCliAdapter implements AgentAdapter {
  readonly name = 'Codex CLI'

  constructor(private readonly executable: string) {}

  run(input: TaskInput, emit: (event: AgentEvent) => void, signal?: AbortSignal, context?: { knowledge?: string }): Promise<AgentRunResult> {
    return new Promise((resolveRun, reject) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputDirectory = join(input.projectPath, '.test-agent', 'results', stamp)
      mkdirSync(outputDirectory, { recursive: true })
      const schemaPath = join(outputDirectory, 'result-schema.json')
      const resultPath = join(outputDirectory, 'codex-result.json')
      const eventsPath = join(outputDirectory, 'codex-events.jsonl')
      writeFileSync(schemaPath, JSON.stringify(RESULT_SCHEMA, null, 2), 'utf8')

      const args = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'workspace-write',
        '--output-schema', schemaPath,
        '--output-last-message', resultPath,
        buildPrompt(input, relative(input.projectPath, outputDirectory), context?.knowledge)
      ]
      const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : this.executable
      const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', this.executable, ...args] : args
      const child = spawn(command, commandArgs, {
        cwd: input.projectPath,
        env: { ...process.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const eventLines: string[] = []
      let stdoutBuffer = ''
      let stderrBuffer = ''
      let settled = false
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        killProcessTree(child.pid ?? 0)
        finishError(new Error('Codex CLI 执行超过 30 分钟，任务已终止'))
      }, Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 30 * 60 * 1000))
      const abort = (): void => {
        killProcessTree(child.pid ?? 0)
        finishError(new Error('任务已取消'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })

      const consumeLine = (line: string): void => {
        if (!line.trim()) return
        eventLines.push(line)
        try {
          const message = messageFromEvent(JSON.parse(line))
          if (message) emit(message)
        } catch {
          emit(log('warning', `Codex 输出了非 JSON 事件：${line.slice(0, 300)}`))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        lines.forEach(consumeLine)
      })
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk
        const lines = stderrBuffer.split(/\r?\n/)
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim() && !isCodexNoise(line)) emit(log('warning', line))
      })
      child.on('error', finishError)
      child.on('exit', (code) => {
        signal?.removeEventListener('abort', abort)
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer)
        if (stderrBuffer.trim() && !isCodexNoise(stderrBuffer.trim())) emit(log('warning', stderrBuffer.trim()))
        writeFileSync(eventsPath, `${eventLines.join('\n')}\n`, 'utf8')
        if (code !== 0) return reject(new Error(`Codex CLI 执行失败，退出码 ${code ?? 'unknown'}`))
        try {
          const parsed = extractStructuredResult(resultPath, eventsPath)
          if (parsed === null) return reject(new Error('Codex CLI 未返回可解析的结构化测试结果'))
          const result = validateResult(parsed, input.projectPath)
          const root = resolve(input.projectPath)
          const validArtifacts = result.artifacts.filter((artifact) => {
            const absolute = resolve(input.projectPath, artifact)
            let isFile = false
            try {
              isFile = statSync(absolute).isFile()
            } catch {
              isFile = false
            }
            return (absolute === root || absolute.startsWith(`${root}\\`)) && isFile
          })
          if (validArtifacts.length !== result.artifacts.length) {
            emit(log('warning', `忽略 ${result.artifacts.length - validArtifacts.length} 个越界或不存在制品`))
          }
          result.artifacts = validArtifacts
          const ownArtifacts = [relative(input.projectPath, resultPath), relative(input.projectPath, eventsPath)]
          result.artifacts = [...new Set([...result.artifacts, ...ownArtifacts])]
          emit(log('success', 'Codex CLI 已返回经过真实执行的结构化测试结果'))
          resolveRun(result)
        } catch (error) {
          reject(error)
        }
      })
    })
  }
}
