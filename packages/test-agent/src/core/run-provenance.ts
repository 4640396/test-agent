import { spawnSync } from 'node:child_process'
import { arch, platform, release } from 'node:os'
import type { TaskInput } from '@cxmt/protocol'
import { inspectProjectSupport, type ProjectKind } from './project-support.js'

export interface RunProvenance {
  gitCommitSha: string | null
  gitDirty: boolean | null
  projectType: ProjectKind
  executionEnvironment: string
  targetUrl: string | null
  capturedAt: string
}

function git(projectPath: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

/** Capture immutable run context before later exports can observe a different checkout. */
export function captureRunProvenance(input: TaskInput, now: Date = new Date()): RunProvenance {
  const insideWorkTree = git(input.projectPath, ['rev-parse', '--is-inside-work-tree']) === 'true'
  return {
    gitCommitSha: insideWorkTree ? git(input.projectPath, ['rev-parse', 'HEAD']) : null,
    gitDirty: insideWorkTree ? Boolean(git(input.projectPath, ['status', '--porcelain=v1'])) : null,
    projectType: inspectProjectSupport(input.projectPath).kind,
    executionEnvironment: `${platform()} ${release()} (${arch()}) · Node ${process.version}`,
    targetUrl: input.apiBaseUrl?.trim() || input.uiEntryUrl?.trim() || null,
    capturedAt: now.toISOString(),
  }
}
