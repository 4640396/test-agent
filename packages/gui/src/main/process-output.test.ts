import { describe, expect, it } from 'vitest'
import { decodeProcessOutput } from './process-output.js'

describe('decodeProcessOutput', () => {
  it('keeps UTF-8 output intact across chunks', () => {
    const bytes = Buffer.from('测试执行完成', 'utf8')
    expect(decodeProcessOutput([bytes.subarray(0, 4), bytes.subarray(4)])).toBe('测试执行完成')
  })

  it('falls back to GB18030 for Windows javac diagnostics', () => {
    const gbk = Buffer.from([0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xb7, 0xfb, 0xba, 0xc5])
    expect(decodeProcessOutput([gbk.subarray(0, 3), gbk.subarray(3)])).toBe('找不到符号')
  })
})
