import { describe, expect, it } from 'vitest'
import { classifyNavigation } from './navigation-policy.js'

describe('desktop navigation policy', () => {
  it('keeps renderer navigation on its own origin', () => {
    expect(classifyNavigation('http://localhost:5173/report', 'http://localhost:5173/')).toBe('internal')
    expect(classifyNavigation('http://evil.test/', 'http://localhost:5173/')).toBe('blocked')
  })

  it('allows only controlled artifacts and HTTPS external links', () => {
    expect(classifyNavigation('local-file:///C:/project/.test-agent/shot.png', 'file:///app/index.html')).toBe('artifact')
    expect(classifyNavigation('https://docs.example.test/help', 'file:///app/index.html')).toBe('external')
    expect(classifyNavigation('http://docs.example.test/help', 'file:///app/index.html')).toBe('blocked')
    expect(classifyNavigation('javascript:alert(1)', 'file:///app/index.html')).toBe('blocked')
  })
})
