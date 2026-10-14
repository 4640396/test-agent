export type NavigationDecision = 'internal' | 'artifact' | 'external' | 'blocked'

export function classifyNavigation(target: string, rendererUrl: string): NavigationDecision {
  try {
    const url = new URL(target)
    if (url.protocol === 'local-file:') return 'artifact'
    if (url.protocol === 'https:') return 'external'
    const renderer = new URL(rendererUrl)
    if (url.protocol === renderer.protocol && url.origin === renderer.origin) return 'internal'
    if (renderer.protocol === 'file:' && url.protocol === 'file:' && url.pathname === renderer.pathname) return 'internal'
    return 'blocked'
  } catch { return 'blocked' }
}
