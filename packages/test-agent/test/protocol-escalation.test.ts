import { describe, expect, it } from 'vitest'
import type { ClientMessage, LocalHostAgentEvent, EscalationReplyRequest } from '@cxmt/protocol'

describe('protocol escalation types', () => {
  it('EscalationReplyRequest narrows from ClientMessage by kind', () => {
    const msg: EscalationReplyRequest = { id: 'r1', kind: 'escalation-reply', executionId: 'exec-1', escalationId: 'esc-1', answer: 'yes' }
    const client: ClientMessage = msg
    expect(client.kind).toBe('escalation-reply')
    if (client.kind === 'escalation-reply') {
      expect(client.executionId).toBe('exec-1')
      expect(client.escalationId).toBe('esc-1')
      expect(client.answer).toBe('yes')
    }
  })

  it('LocalHostAgentEvent escalation narrows by type', () => {
    const e: LocalHostAgentEvent = { type: 'escalation', escalationId: 'esc-1', role: 'reviewer', question: '继续?' }
    if (e.type === 'escalation') {
      expect(e.escalationId).toBe('esc-1')
      expect(e.role).toBe('reviewer')
      expect(e.question).toBe('继续?')
      expect(e.fallback).toBeUndefined()
      expect(e.context).toBeUndefined()
    }
  })

  it('LocalHostAgentEvent escalation carries optional fields', () => {
    const e: LocalHostAgentEvent = {
      type: 'escalation',
      escalationId: 'esc-2',
      role: 'reviewer',
      question: '选 A 还是 B?',
      fallback: '保守方案',
      context: '上下文信息',
    }
    if (e.type === 'escalation') {
      expect(e.fallback).toBe('保守方案')
      expect(e.context).toBe('上下文信息')
    }
  })
})
