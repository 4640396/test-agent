import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const COMMANDS: Record<string, { win32: string; other: string }> = {
  npm: { win32: 'npm.cmd', other: 'npm' },
  pnpm: { win32: 'pnpm.cmd', other: 'pnpm' },
  yarn: { win32: 'yarn.cmd', other: 'yarn' },
  bun: { win32: 'bun.exe', other: 'bun' },
  java: { win32: 'java.exe', other: 'java' },
  maven: { win32: 'mvn.cmd', other: 'mvn' },
  gradle: { win32: 'gradle.bat', other: 'gradle' }
}

function commandAvailable(command: string, platform: NodeJS.Platform): boolean {
  const result = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
  return result.status === 0
}

/** A Playwright CLI without a launchable browser is not an executable UI-test capability. */
export function playwrightRuntimeAvailable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  if (platform === 'win32') {
    const roots = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA]
      .filter((value): value is string => !!value)
    const edgePaths = roots.flatMap((root) => [
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe')
    ])
    if (edgePaths.some(fileExists)) return true
  }
  try {
    const playwright = require('playwright') as { chromium?: { executablePath(): string } }
    const executable = playwright.chromium?.executablePath()
    return !!executable && fileExists(executable)
  } catch {
    return false
  }
}

export function detectExecutionCapabilities(
  platform: NodeJS.Platform = process.platform,
  available: (command: string, platform: NodeJS.Platform) => boolean = commandAvailable,
  browserAvailable: () => boolean = () => playwrightRuntimeAvailable(platform)
): string[] {
  const capabilities = new Set<string>([platform === 'win32' ? 'windows' : platform, 'node'])
  if (browserAvailable()) capabilities.add('playwright')
  for (const [capability, commands] of Object.entries(COMMANDS)) {
    if (available(platform === 'win32' ? commands.win32 : commands.other, platform)) capabilities.add(capability)
  }
  return [...capabilities]
}

export function configuredCapabilities(value: string | undefined): string[] {
  return value?.trim()
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : detectExecutionCapabilities()
}
