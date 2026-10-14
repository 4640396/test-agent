import { isAbsolute, relative, resolve } from 'node:path'

export type SandboxPolicy = 'workspace-write' | 'read-only'

export function assertInsideProject(projectPath: string, candidate: string): void {
  const root = resolve(projectPath)
  const target = resolve(candidate)
  const rel = relative(root, target)
  if (rel === '') return
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Sandbox violation: ${candidate} is outside project ${projectPath}`)
  }
}

export function sandboxEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && !/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i.test(name)))
}

export function sandboxCommandSpec(projectPath: string, cwd: string, policy: SandboxPolicy): { cwd: string; readOnly: boolean } {
  assertInsideProject(projectPath, cwd)
  return { cwd: resolve(cwd), readOnly: policy === 'read-only' }
}
