/**
 * Desktop App 集成 e2e：模拟 ensureLocalHostClient 的 env 注入逻辑，
 * 启动真实 host-cli 子进程，发一个真实 TaskInput，验证 ai-native provider
 * 从 Desktop 链路端到端跑通。
 *
 * 门控：TEST_AGENT_E2E=1 才运行（会真实调用 GLM 5.2，耗时数分钟）。
 *
 * 验证点：
 * 1. ensureLocalHostClient 的 env 注入逻辑（读 ai-config.json → 设 TEST_AGENT_PROVIDER=ai-native）
 * 2. host-cli 子进程用注入的 env 启动
 * 3. LocalHostClient.run() 发真实任务并收到结构化结果
 * 4. ai-native adapter 在 host 子进程内执行 agentLoop
 */
import { describe, it, expect } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStdioHostIO, LocalHostClient } from './local-host-client.js'
import type { AiConfig, TaskInput, HostMessage } from '@cxmt/protocol'

const E2E = process.env.TEST_AGENT_E2E === '1'
const hostCliPath = join(process.cwd(), 'out', 'main', 'host-cli.js')

describe.skipIf(!existsSync(hostCliPath))('Desktop App 本地 Host 进程边界', { timeout: 30_000 }, () => {
  it('完成真实握手、健康检查，并立即返回工具链门禁错误', async () => {
    const projectPath = join(process.cwd(), 'tools', 'samples', 'ai-native-target')
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TEST_AGENT_HOST_CAPABILITIES: 'windows,node,npm',
      TEST_AGENT_ALLOWED_PROJECT_ROOTS: projectPath,
      TEST_AGENT_AI_MODE: 'false'
    }
    const client = new LocalHostClient(createStdioHostIO(process.execPath, [hostCliPath], { cwd: process.cwd(), env }))
    try {
      const handshake = await client.handshake()
      expect(handshake).toMatchObject({ kind: 'handshake', ok: true, capabilities: ['windows', 'node', 'npm'] })
      await expect(client.health()).resolves.toMatchObject({ kind: 'health', ok: true, activeRuns: 0 })
      const result = await client.run({
        projectPath,
        systemName: 'safe-process-boundary-check',
        version: '1.0.0',
        testTypes: ['unit'],
        requiredCapabilities: ['node', 'maven']
      }, `safe-desktop-e2e-${Date.now()}`)
      expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('maven') })
    } finally {
      client.close()
    }
  })
})

describe.skipIf(!E2E)('Desktop App 集成 e2e：host-cli + ai-native 端到端', { timeout: 600_000 }, () => {
  it('从 env 注入到 host-cli 执行 ai-native 任务全链路', async () => {
    // --- 模拟 ensureLocalHostClient 的 env 注入逻辑 ---
    // 配置路径对齐 pi 约定：~/.test-agent/ai-config.json（固定 home，不随应用名漂移）
    const aiConfigPath = join(homedir(), '.test-agent', 'ai-config.json')
    expect(existsSync(aiConfigPath), `ai-config.json 应存在: ${aiConfigPath}`).toBe(true)

    // 读配置确认 executionEngine=ai-native（由之前的 GUI 保存或手动写入）
    const config = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync(aiConfigPath, 'utf8')),
    ) as AiConfig
    expect(config.executionEngine).toBe('ai-native')
    expect(config.providers).toBeDefined()
    expect(Object.keys(config.providers!).length).toBeGreaterThan(0)

    // --- 目标项目（默认 ai-native-target，可用 TEST_AGENT_E2E_PROJECT 指定独立项目）---
    const projectPath = process.env.TEST_AGENT_E2E_PROJECT
      ? resolve(process.env.TEST_AGENT_E2E_PROJECT)
      : join(process.cwd(), 'tools', 'samples', 'ai-native-target')
    expect(existsSync(projectPath), `目标项目应存在: ${projectPath}`).toBe(true)

    // 清理上次产物
    const resultsDir = join(projectPath, '.test-agent', 'results')
    if (existsSync(resultsDir)) rmSync(resultsDir, { recursive: true, force: true })

    // --- 启动 host-cli（注入和 Desktop App 相同的 env）---
    expect(existsSync(hostCliPath), `host-cli.js 应存在，先 npm run build: ${hostCliPath}`).toBe(true)

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TEST_AGENT_HOST_CAPABILITIES: 'windows,node,vue',
      TEST_AGENT_AI_MODE: 'true',
      TEST_AGENT_ALLOWED_PROJECT_ROOTS: projectPath,
      TEST_AGENT_PROVIDER: 'ai-native',
      TEST_AGENT_AI_CONFIG: aiConfigPath,
    }

    const io = createStdioHostIO(process.execPath, [hostCliPath], { cwd: process.cwd(), env })
    const client = new LocalHostClient(io)

    // --- 收集消息 ---
    const messages: HostMessage[] = []
    client.onMessage((msg: HostMessage) => {
      messages.push(msg)
      if (msg.kind === 'event') {
        const event = (msg as any).event
        // eslint-disable-next-line no-console
        console.log(`  [event] ${(event?.message ?? '').slice(0, 120)}`)
      }
    })

    // --- 发任务 ---
    const input: TaskInput = {
      projectPath,
      systemName: process.env.TEST_AGENT_E2E_PROJECT ? 'string-utils' : 'calculator',
      version: '1.0.0',
      testTypes: ['unit'],
    }

    const result = await client.run(input, `desktop-e2e-${Date.now()}`)

    // --- 验证 ---
    console.log(`\n  host 返回 kind: ${result.kind}`)
    if (result.kind === 'error') {
      console.log(`  error: ${(result as any).message}`)
    }
    if (result.kind === 'run-result') {
      const outcome = (result as any).outcome
      console.log(`  lanes: ${JSON.stringify(outcome?.lanes)?.slice(0, 200)}`)
      console.log(`  report: ${JSON.stringify(outcome?.report)}`)
    }

    // 应该成功完成（kind 不是 error）
    expect(result.kind).not.toBe('error')

    // 应该有结构化结果
    const outcome = (result as any).outcome
    expect(outcome).toBeDefined()
    expect(outcome.lanes).toBeDefined()
    expect(Array.isArray(outcome.lanes)).toBe(true)
    expect(outcome.lanes.length).toBeGreaterThan(0)
    expect(outcome.report).toBeDefined()
    expect(typeof outcome.report.passed).toBe('number')
    expect(outcome.report.passed).toBeGreaterThan(0)

    client.close()
  })
})
