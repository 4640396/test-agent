import { afterEach, describe, expect, it } from 'vitest'
import { createAgentAdapter } from '../src/core/factory.js'

const originalProvider = process.env.TEST_AGENT_PROVIDER

afterEach(() => {
  if (originalProvider === undefined) delete process.env.TEST_AGENT_PROVIDER
  else process.env.TEST_AGENT_PROVIDER = originalProvider
})

describe('createAgentAdapter', () => {
  it('defaults to the AI cimicode provider, not a deterministic suite', () => {
    delete process.env.TEST_AGENT_PROVIDER
    const adapter = createAgentAdapter()
    // 默认走 cimicode 分支；本机未装 cimicode 可执行文件时返回 null，但绝不回落到已删除的非 AI 路径
    expect(adapter?.name).not.toBe('Existing Maven Suite')
    expect(adapter?.name).not.toBe('Existing Node Suite')
  })

  it('rejects unknown providers during worker startup', () => {
    process.env.TEST_AGENT_PROVIDER = 'typo-provider'
    expect(() => createAgentAdapter()).toThrow('Unsupported TEST_AGENT_PROVIDER')
  })

  it('rejects deleted non-AI providers', () => {
    process.env.TEST_AGENT_PROVIDER = 'existing-maven'
    expect(() => createAgentAdapter()).toThrow('Unsupported TEST_AGENT_PROVIDER')
  })

  it('rejects deleted local-go provider', () => {
    process.env.TEST_AGENT_PROVIDER = 'local-go'
    expect(() => createAgentAdapter()).toThrow('Unsupported TEST_AGENT_PROVIDER')
  })

  it('routes ai-native to the in-process Runner when configured', () => {
    process.env.TEST_AGENT_PROVIDER = 'ai-native'
    // 无 ai-config.json 时返回 null（未配置），但不扚、不回落到其他 provider
    const adapter = createAgentAdapter()
    expect(adapter === null || adapter?.name === 'ai-native').toBe(true)
  })
})
