import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const artifactExtensions = new Set(['.png', '.jpg', '.jpeg', '.webm', '.mp4', '.zip'])
const artifactDirectories = new Set(['.test-agent', 'test-results', 'playwright-report'])

export function isAllowedLocalArtifact(projectRoots: readonly string[], requestedPath: string, canonicalize: (path: string) => string): boolean {
  if (!requestedPath || !isAbsolute(requestedPath) || !artifactExtensions.has(extname(requestedPath).toLowerCase())) return false
  let artifact: string
  try { artifact = canonicalize(resolve(requestedPath)) } catch { return false }
  for (const rootCandidate of projectRoots) {
    let root: string
    try { root = canonicalize(resolve(rootCandidate)) } catch { continue }
    const relation = relative(root, artifact)
    if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) continue
    const firstSegment = relation.split(/[\\/]/, 1)[0]
    if (artifactDirectories.has(firstSegment)) return true
  }
  return false
}
