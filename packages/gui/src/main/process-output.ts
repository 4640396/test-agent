function replacementCount(value: string): number {
  return value.split('\ufffd').length - 1
}

/** Decode child-process output without corrupting Chinese diagnostics on Windows. */
export function decodeProcessOutput(chunks: Buffer[]): string {
  if (!chunks.length) return ''
  const bytes = Buffer.concat(chunks)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (replacementCount(utf8) === 0) return utf8
  try {
    const gb18030 = new TextDecoder('gb18030').decode(bytes)
    return replacementCount(gb18030) < replacementCount(utf8) ? gb18030 : utf8
  } catch {
    return utf8
  }
}
