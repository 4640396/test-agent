import { describe, expect, it } from 'vitest'
import { summarizeMavenFailure } from './maven-result.js'

describe('summarizeMavenFailure', () => {
  it('reports a test compilation location instead of exit code', () => {
    const output = '[ERROR] COMPILATION ERROR\n[ERROR] /D:/repo/src/test/java/demo/ExampleTest.java:[42,22] cannot find symbol\n[INFO] BUILD FAILURE'
    expect(summarizeMavenFailure(output, 'exit 1')).toBe('测试代码编译失败：ExampleTest.java 第 42 行。请展开查看 Maven 输出。')
  })

  it('reports failed and errored test counts', () => {
    const output = 'Tests run: 20, Failures: 2, Errors: 1, Skipped: 3\n[INFO] BUILD FAILURE'
    expect(summarizeMavenFailure(output, 'exit 1')).toBe('项目测试未通过：2 项失败、1 项错误、3 项跳过。请展开查看 Maven 输出。')
  })
})
