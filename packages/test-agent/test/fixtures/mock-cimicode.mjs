/**
 * Mock CimiCode CLI — 模拟 cimicode run 的 NDJSON 事件流输出。
 *
 * 通过 MOCK_CIMICODE_MODE 环境变量控制行为：
 *   file        写入合法结果 JSON 到结果文件（主路径），输出 text/reasoning 事件
 *   text        不写文件，在 text part 中输出结果 JSON（回退路径 1）
 *   tool-output 不写文件，输出 tool 事件含 vitest 测试输出（回退路径 2）
 *   fail        退出码 1，不输出有效内容
 *   events      输出多种 part 类型（text/tool/reasoning）用于事件转换测试，同时写结果文件
 *
 * 结果文件路径：优先从 prompt 文本提取（写入文件：<path>）；
 * 提取失败时（cmd.exe 截断长 prompt），从 --dir 参数查找最新创建的 .test-agent/results/<timestamp>/ 目录。
 * 退出码可通过 MOCK_CIMICODE_EXIT_CODE 覆盖（默认 0，fail 模式为 1）。
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const mode = process.env.MOCK_CIMICODE_MODE ?? 'file'
const forcedExit = process.env.MOCK_CIMICODE_EXIT_CODE

// --- 解析 argv ---
// cmd.exe 包装后: node mock-cimicode.mjs run <prompt> --format json --dir <path> ...
const argv = process.argv.slice(2)
const runIndex = argv.indexOf('run')
const prompt = runIndex >= 0 ? argv[runIndex + 1] ?? '' : ''
const dirIndex = argv.indexOf('--dir')
const projectPath = dirIndex >= 0 ? argv[dirIndex + 1] ?? process.cwd() : process.cwd()

// --- 从 prompt 中提取结果文件路径 ---
function extractResultPath(text) {
  const match = /写入文件[：:]\s*(\S+)/.exec(text)
  return match ? match[1] : null
}

// --- 回退：从 --dir 查找最新结果目录（adapter 在 spawn 前已创建） ---
function findLatestResultDir(projectPath) {
  const resultsRoot = join(projectPath, '.test-agent', 'results')
  if (!existsSync(resultsRoot)) return null
  let latest = null
  let latestMtime = 0
  for (const name of readdirSync(resultsRoot)) {
    const dir = join(resultsRoot, name)
    try {
      const stat = statSync(dir)
      if (stat.isDirectory() && stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs
        latest = dir
      }
    } catch { /* skip */ }
  }
  return latest ? join(latest, 'cimicode-result.json') : null
}

function resolveResultPath(prompt, projectPath) {
  return extractResultPath(prompt) ?? findLatestResultDir(projectPath)
}

// --- NDJSON 事件构造 ---
function ndjson(part) {
  return JSON.stringify({
    type: part.type,
    timestamp: new Date().toISOString(),
    sessionID: 'mock-session-001',
    part,
  })
}

function textPart(text) {
  return ndjson({ type: 'text', text })
}

function reasoningPart(text) {
  return ndjson({ type: 'reasoning', text })
}

function toolPart(tool, status, output) {
  return ndjson({
    type: 'tool',
    tool,
    state: { status, ...(output !== undefined ? { output } : {}) },
  })
}

// --- 各模式行为 ---
function writeResultFile(path, result) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf8')
}

const validResult = {
  lanes: [{ type: 'unit', status: 'passed', summary: '8 passed, 0 failed' }],
  report: { passed: 8, failed: 0, coverage: 75 },
  artifacts: [],
}

function run() {
  const resultPath = resolveResultPath(prompt, projectPath)
  const lines = []

  switch (mode) {
    case 'file': {
      lines.push(reasoningPart('分析项目技术栈和测试框架...'))
      lines.push(textPart('已识别 Maven 项目，开始生成 JUnit 测试。'))
      lines.push(toolPart('bash', 'completed', '$ mvn test\nTests run: 8, Failures: 0, Errors: 0, Skipped: 0'))
      lines.push(textPart('测试全部通过，覆盖率 75%。'))
      writeResultFile(resultPath, validResult)
      break
    }
    case 'text': {
      // 不写文件，在 text part 中返回 JSON（回退路径 1）
      lines.push(reasoningPart('生成测试用例...'))
      lines.push(textPart('测试完成，结果如下：\n```json\n' + JSON.stringify(validResult, null, 2) + '\n```'))
      break
    }
    case 'tool-output': {
      // 不写文件，通过 tool 事件的 bash 输出返回测试结果（回退路径 2）
      lines.push(textPart('执行 vitest 测试...'))
      lines.push(toolPart('bash', 'completed',
        'RUN  v1.9.0\n' +
        '\u2713 src/utils.test.ts (3 tests)\n' +
        '\u2713 src/parser.test.ts (5 tests)\n' +
        '\n' +
        ' Test Files  2 passed (2)\n' +
        '      Tests  8 passed (8)'))
      break
    }
    case 'fail': {
      lines.push(textPart('CimiCode 执行失败：无法连接 LLM 服务。'))
      break
    }
    case 'events': {
      // 输出多种 part 类型，测试事件转换
      lines.push(reasoningPart('推理过程不转发'))
      lines.push(textPart('开始执行测试'))
      lines.push(toolPart('read', 'completed'))
      lines.push(toolPart('bash', 'running'))
      lines.push(toolPart('bash', 'completed', 'Tests run: 4, Failures: 1, Errors: 0'))
      lines.push(toolPart('write', 'failed'))
      lines.push(textPart('测试执行完成'))
      writeResultFile(resultPath, validResult)
      break
    }
    default: {
      lines.push(textPart('未知 mock 模式: ' + mode))
    }
  }

  for (const line of lines) {
    process.stdout.write(line + '\n')
  }

  const exitCode = forcedExit !== undefined ? parseInt(forcedExit, 10) : (mode === 'fail' ? 1 : 0)
  process.exit(exitCode)
}

run()
