/**
 * Electron IPC uses structured clone and cannot transfer Vue proxies or other
 * reactive wrappers. Task inputs are JSON-domain data, so normalizing them at
 * the preload boundary gives every caller the same safe transport behavior.
 */
export function toIpcValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
