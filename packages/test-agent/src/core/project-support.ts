import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ProjectKind = 'node' | 'maven' | 'gradle' | 'mixed' | 'go' | 'python' | 'unknown'

export interface ProjectSupport {
  kind: ProjectKind
  supported: boolean
  reason?: string
}

/** Detect only project roots with an executable adapter; never guess from source extensions. */
export function inspectProjectSupport(projectPath: string): ProjectSupport {
  const hasNode = existsSync(join(projectPath, 'package.json'))
  const hasMaven = existsSync(join(projectPath, 'pom.xml'))
  const hasGradle = existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))
  const supportedKinds = [hasNode ? 'node' : '', hasMaven ? 'maven' : '', hasGradle ? 'gradle' : ''].filter(Boolean)
  if (supportedKinds.length > 1) return { kind: 'mixed', supported: true }
  if (hasNode) return { kind: 'node', supported: true }
  if (hasMaven) return { kind: 'maven', supported: true }
  if (hasGradle) return { kind: 'gradle', supported: true }

  if (existsSync(join(projectPath, 'go.mod'))) {
    return { kind: 'go', supported: false, reason: '暂未支持 Go 项目；当前生产范围为 Node.js 前后端和 Java/Maven 项目。' }
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].some((name) => existsSync(join(projectPath, name)))) {
    return { kind: 'python', supported: false, reason: '暂未支持 Python 项目；当前生产范围为 Node.js 前后端和 Java/Maven 项目。' }
  }
  return {
    kind: 'unknown',
    supported: false,
    reason: '未识别到 package.json、pom.xml 或 build.gradle；请选择实际子项目的根目录。'
  }
}
