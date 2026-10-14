import { spawn } from 'node:child_process'

/**
 * 可靠终止进程树。
 * Windows 使用 taskkill /T /F 杀整棵进程树，再兜底直接终止根进程；
 * 非 Windows 直接向根进程发 SIGKILL（需以进程组方式启动时生效）。
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    } catch {
      // 兜底走下面的直接终止
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已退出或不存在
  }
}
