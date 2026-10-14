import { existsSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, relative, resolve } from 'node:path'

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function parseAllowedProjectRoots(value: string | undefined, fallback = process.cwd()): string[] {
  const configured = value?.split(delimiter).map((item) => item.trim()).filter(Boolean) ?? []
  const roots = configured.length > 0 ? configured : [fallback]
  return [...new Set(roots.map((root) => {
    const absolute = resolve(root)
    if (!existsSync(absolute)) throw new Error(`Allowed project root does not exist: ${absolute}`)
    return realpathSync(absolute)
  }))]
}

export function authorizeProjectPath(projectPath: string, allowedRoots: readonly string[]): { ok: boolean; resolvedPath?: string; reason?: string } {
  try {
    const candidate = realpathSync(resolve(projectPath))
    if (!allowedRoots.some((root) => contained(root, candidate))) {
      return { ok: false, reason: 'Project path is outside TEST_AGENT_ALLOWED_PROJECT_ROOTS' }
    }
    return { ok: true, resolvedPath: candidate }
  } catch {
    return { ok: false, reason: 'Project path does not exist or cannot be resolved' }
  }
}
