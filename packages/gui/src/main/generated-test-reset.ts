import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface GeneratedTestResetPreview {
  removableFiles: string[]
  protectedFiles: string[]
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function isGitUntracked(projectPath: string, relativePath: string): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', relativePath], { cwd: projectPath, encoding: 'utf8' })
    return status.split(/\r?\n/).some(line => line.startsWith('?? '))
  } catch {
    return false
  }
}

export function classifyGeneratedTestFiles(projectPath: string, caseIds: Iterable<string>): GeneratedTestResetPreview {
  const root = resolve(projectPath)
  const testRoot = join(root, 'src', 'test')
  const ids = [...new Set(caseIds)].filter(id => /^[a-f0-9]{16}$/i.test(id))
  const removableFiles: string[] = []
  const protectedFiles: string[] = []
  for (const absolutePath of walk(testRoot)) {
    const rel = relative(root, absolutePath).replace(/\\/g, '/')
    if (!/\.(?:java|kt|groovy|js|jsx|ts|tsx)$/i.test(rel)) continue
    let text = ''
    try { text = readFileSync(absolutePath, 'utf8') } catch { protectedFiles.push(rel); continue }
    const linkedCase = ids.some(id => text.includes(id))
    const fixedRunner = rel === 'src/test/java/com/cxmt/testagent/ReflectTestRunner.java' && text.includes('package com.cxmt.testagent')
    if ((linkedCase || fixedRunner) && isGitUntracked(root, rel)) removableFiles.push(rel)
    else if (linkedCase || fixedRunner) protectedFiles.push(rel)
  }
  return { removableFiles: removableFiles.sort(), protectedFiles: protectedFiles.sort() }
}

export function removeGeneratedTestFiles(projectPath: string, preview: GeneratedTestResetPreview): { removedFiles: string[]; failedFiles: string[]; protectedFiles: string[] } {
  const root = resolve(projectPath)
  const removedFiles: string[] = []
  const failedFiles: string[] = []
  for (const rel of preview.removableFiles) {
    const target = resolve(root, rel)
    if (!target.startsWith(join(root, 'src', 'test'))) { failedFiles.push(rel); continue }
    try { unlinkSync(target); removedFiles.push(rel) } catch { failedFiles.push(rel) }
  }
  return { removedFiles, failedFiles, protectedFiles: preview.protectedFiles }
}
