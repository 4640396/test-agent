import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOpenApiSummary } from '../src/core/openapi.js'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'test-agent-openapi-'))
  roots.push(value)
  return value
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('OpenAPI contract ingestion', () => {
  it('summarizes verified methods, parameters, request bodies, and responses', async () => {
    const project = root()
    const file = join(project, 'openapi.yaml')
    writeFileSync(file, `
openapi: 3.0.3
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      parameters:
        - name: id
          in: path
          required: true
      responses:
        '200': { description: ok }
        '404': { description: missing }
    post:
      operationId: updateOrder
      requestBody:
        required: true
        content: { application/json: {} }
      responses:
        '201': { description: created }
`, 'utf8')
    const summary = await loadOpenApiSummary(file, project)
    expect(summary).toContain('GET /orders/{id} · getOrder · 参数=id · 无请求体 · 响应=200,404')
    expect(summary).toContain('POST /orders/{id} · updateOrder · 参数=无 · 请求体必填 · 响应=201')
  })

  it('loads HTTP documents with a bounded response size', async () => {
    const fetchMock = async () => new Response(JSON.stringify({ openapi: '3.1.0', paths: { '/health': { get: { responses: { 200: {} } } } } }), { status: 200 })
    await expect(loadOpenApiSummary('https://example.test/openapi.json', root(), fetchMock as typeof fetch)).resolves.toContain('GET /health')
  })

  it('rejects invalid documents and files outside the selected project', async () => {
    const project = root()
    const outside = join(root(), 'openapi.json')
    writeFileSync(outside, JSON.stringify({ openapi: '3.0.0', paths: {} }), 'utf8')
    await expect(loadOpenApiSummary(outside, project)).rejects.toThrow(/必须位于当前项目目录内/)
    const invalid = join(project, 'invalid.json')
    writeFileSync(invalid, JSON.stringify({ hello: 'world' }), 'utf8')
    await expect(loadOpenApiSummary(invalid, project)).rejects.toThrow(/OpenAPI 文档无效/)
  })
})
