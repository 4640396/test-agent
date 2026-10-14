import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const MAX_OPENAPI_BYTES = 2 * 1024 * 1024
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

function assertProjectLocal(projectPath: string, source: string): string {
  if (!isAbsolute(source)) throw new Error('OpenAPI 文件必须使用项目内的绝对路径')
  const root = resolve(projectPath)
  const file = resolve(source)
  const rel = relative(root, file)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('OpenAPI 文件必须位于当前项目目录内')
  return file
}

async function readOpenApiSource(source: string, projectPath: string, fetchImpl: typeof fetch): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json, application/yaml, text/yaml, text/plain' } })
    if (!response.ok) throw new Error(`OpenAPI 文档请求失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_OPENAPI_BYTES) throw new Error('OpenAPI 文档超过 2 MB 限制')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_OPENAPI_BYTES) throw new Error('OpenAPI 文档超过 2 MB 限制')
    return text
  }
  const file = assertProjectLocal(projectPath, source)
  if (statSync(file).size > MAX_OPENAPI_BYTES) throw new Error('OpenAPI 文档超过 2 MB 限制')
  return readFileSync(file, 'utf8')
}

type OpenApiDocument = {
  openapi?: string
  swagger?: string
  paths?: Record<string, Record<string, unknown>>
}

/** Load and summarize an OpenAPI document so case design uses verified endpoints instead of guesses. */
export async function loadOpenApiSummary(source: string | undefined, projectPath: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (!source?.trim()) return undefined
  const raw = await readOpenApiSource(source.trim(), projectPath, fetchImpl)
  let document: OpenApiDocument
  try {
    document = parseYaml(raw) as OpenApiDocument
  } catch (error) {
    throw new Error(`OpenAPI 文档解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if ((!document.openapi && !document.swagger) || !document.paths || typeof document.paths !== 'object') {
    throw new Error('OpenAPI 文档无效：缺少 openapi/swagger 版本或 paths')
  }
  const lines: string[] = [`规范版本：${document.openapi ?? document.swagger}`]
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Record<string, unknown> | undefined
      if (!operation || typeof operation !== 'object') continue
      const parameters = Array.isArray(operation.parameters)
        ? operation.parameters.map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).name ?? '') : '').filter(Boolean)
        : []
      const requestBody = operation.requestBody && typeof operation.requestBody === 'object'
        ? ((operation.requestBody as Record<string, unknown>).required === true ? '请求体必填' : '有请求体')
        : '无请求体'
      const responses = operation.responses && typeof operation.responses === 'object'
        ? Object.keys(operation.responses as Record<string, unknown>).slice(0, 12)
        : []
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : ''
      lines.push(`${method.toUpperCase()} ${path}${operationId ? ` · ${operationId}` : ''} · 参数=${parameters.join(',') || '无'} · ${requestBody} · 响应=${responses.join(',') || '未声明'}`)
      if (lines.length >= 101) {
        lines.push('[仅展示前 100 个接口操作]')
        return lines.join('\n')
      }
    }
  }
  if (lines.length === 1) throw new Error('OpenAPI 文档无效：paths 中没有可执行的 HTTP 操作')
  return lines.join('\n')
}
