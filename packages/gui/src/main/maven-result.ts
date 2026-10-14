function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
}

/** Convert Maven's process-level failure into a short user-facing diagnosis. */
export function summarizeMavenFailure(output: string, fallback = '全量项目测试失败'): string {
  const text = stripAnsi(output)
  const compileLocation = text.match(/(?:\[ERROR\]\s*)?[\\/]([^\\/\r\n]+\.java):\[(\d+),(\d+)\]/)
  if (/COMPILATION ERROR|Compilation failure|testCompile/i.test(text) && compileLocation) {
    return `测试代码编译失败：${compileLocation[1]} 第 ${compileLocation[2]} 行。请展开查看 Maven 输出。`
  }
  if (/COMPILATION ERROR|Compilation failure|testCompile/i.test(text)) {
    return '测试代码编译失败。请展开查看 Maven 输出。'
  }

  const testSummary = [...text.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/gi)].at(-1)
  if (testSummary && (Number(testSummary[2]) > 0 || Number(testSummary[3]) > 0)) {
    return `项目测试未通过：${testSummary[2]} 项失败、${testSummary[3]} 项错误${testSummary[4] ? `、${testSummary[4]} 项跳过` : ''}。请展开查看 Maven 输出。`
  }
  if (/BUILD FAILURE/i.test(text)) return 'Maven 构建失败。请展开查看命令输出定位原因。'
  return fallback === 'exit 1' ? '全量项目测试执行失败。请展开查看 Maven 输出。' : fallback
}
