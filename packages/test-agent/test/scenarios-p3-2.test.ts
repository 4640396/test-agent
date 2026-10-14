/**
 * P3-2 场景文件管理单测。
 *
 * 测 scenarios:delete / scenarios:import / scenarios:export 的核心逻辑。
 * main/index.ts 的实现是 GUI 自含（本地 fs 操作），这里用 tmpdir 模拟同样的
 * 文件操作逻辑验证正确性（不依赖 Electron ipcMain）。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 镜像 main/index.ts 的 scenariosDirFor + scenarios:* 逻辑
// ---------------------------------------------------------------------------

function scenariosDirFor(projectPath: string): string {
  return join(projectPath, '.test-agent', 'scenarios')
}

function scenarioDelete(projectPath: string, caseId: string): boolean {
  if (!projectPath || !caseId || !existsSync(projectPath)) return false
  const file = join(scenariosDirFor(projectPath), `${caseId}.json`)
  if (!existsSync(file)) return false
  try { unlinkSync(file); return true } catch { return false }
}

function scenarioImport(
  projectPath: string,
  scenarios: Array<{ caseId: string; scenario: unknown }>,
): { imported: number; skipped: number } {
  if (!projectPath || !Array.isArray(scenarios) || !existsSync(projectPath)) return { imported: 0, skipped: 0 }
  const dir = scenariosDirFor(projectPath)
  mkdirSync(dir, { recursive: true })
  let imported = 0, skipped = 0
  for (const item of scenarios) {
    if (!item?.caseId || typeof item.scenario !== 'object') { skipped++; continue }
    try { writeFileSync(join(dir, `${item.caseId}.json`), JSON.stringify(item.scenario, null, 2), 'utf8'); imported++ } catch { skipped++ }
  }
  return { imported, skipped }
}

function scenarioExport(
  projectPath: string,
  caseIds?: string[],
): Array<{ caseId: string; scenario: unknown }> {
  if (!projectPath || !existsSync(projectPath)) return []
  const dir = scenariosDirFor(projectPath)
  if (!existsSync(dir)) return []
  const result: Array<{ caseId: string; scenario: unknown }> = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const caseId = file.replace(/\.json$/, '')
    if (caseIds && caseIds.length && !caseIds.includes(caseId)) continue
    try {
      const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      result.push({ caseId, scenario })
    } catch { /* 忽略损坏文件 */ }
  }
  return result
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("P3-2 场景文件管理", () => {
  const testDir = join(tmpdir(), `test-agent-scenarios-p32-${Date.now()}`)
  const scenariosDir = scenariosDirFor(testDir)

  beforeEach(() => {
    mkdirSync(scenariosDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("scenarioDelete", () => {
    it("删除已存在的场景文件", () => {
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify({ id: "TC001" }), 'utf8')
      expect(existsSync(join(scenariosDir, "TC001.json"))).toBe(true)
      const ok = scenarioDelete(testDir, "TC001")
      expect(ok).toBe(true)
      expect(existsSync(join(scenariosDir, "TC001.json"))).toBe(false)
    })

    it("删除不存在的场景文件返回 false", () => {
      const ok = scenarioDelete(testDir, "NOTEXIST")
      expect(ok).toBe(false)
    })

    it("空参数返回 false", () => {
      expect(scenarioDelete("", "TC001")).toBe(false)
      expect(scenarioDelete(testDir, "")).toBe(false)
    })

    it("项目路径不存在返回 false", () => {
      const ok = scenarioDelete("/nonexistent/path", "TC001")
      expect(ok).toBe(false)
    })
  })

  describe("scenarioImport", () => {
    it("导入多个有效场景", () => {
      const result = scenarioImport(testDir, [
        { caseId: "TC001", scenario: { id: "TC001", target: { className: "Foo", method: "bar" } } },
        { caseId: "TC002", scenario: { id: "TC002", target: { className: "Baz", method: "qux" } } },
      ])
      expect(result.imported).toBe(2)
      expect(result.skipped).toBe(0)
      expect(existsSync(join(scenariosDir, "TC001.json"))).toBe(true)
      expect(existsSync(join(scenariosDir, "TC002.json"))).toBe(true)
    })

    it("跳过无效条目（缺 caseId 或 scenario 非对象）", () => {
      const result = scenarioImport(testDir, [
        { caseId: "TC001", scenario: { id: "TC001" } },
        { caseId: "", scenario: { id: "TC002" } },
        { caseId: "TC003", scenario: "not-an-object" as unknown },
      ])
      expect(result.imported).toBe(1)
      expect(result.skipped).toBe(2)
    })

    it("空数组返回 imported:0 skipped:0", () => {
      const result = scenarioImport(testDir, [])
      expect(result.imported).toBe(0)
      expect(result.skipped).toBe(0)
    })

    it("非数组参数返回 imported:0 skipped:0", () => {
      const result = scenarioImport(testDir, "not-an-array" as unknown as Array<{ caseId: string; scenario: unknown }>)
      expect(result.imported).toBe(0)
      expect(result.skipped).toBe(0)
    })

    it("覆盖已存在的场景文件", () => {
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify({ old: true }), 'utf8')
      const result = scenarioImport(testDir, [
        { caseId: "TC001", scenario: { id: "TC001", new: true } },
      ])
      expect(result.imported).toBe(1)
      const content = JSON.parse(readFileSync(join(scenariosDir, "TC001.json"), 'utf8'))
      expect(content.new).toBe(true)
      expect(content.old).toBeUndefined()
    })
  })

  describe("scenarioExport", () => {
    it("导出所有场景文件", () => {
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify({ id: "TC001" }), 'utf8')
      writeFileSync(join(scenariosDir, "TC002.json"), JSON.stringify({ id: "TC002" }), 'utf8')
      const result = scenarioExport(testDir)
      expect(result).toHaveLength(2)
      expect(result.map(r => r.caseId).sort()).toEqual(["TC001", "TC002"])
    })

    it("按 caseIds 过滤导出", () => {
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify({ id: "TC001" }), 'utf8')
      writeFileSync(join(scenariosDir, "TC002.json"), JSON.stringify({ id: "TC002" }), 'utf8')
      const result = scenarioExport(testDir, ["TC001"])
      expect(result).toHaveLength(1)
      expect(result[0].caseId).toBe("TC001")
    })

    it("无场景文件返回空数组", () => {
      const result = scenarioExport(testDir)
      expect(result).toEqual([])
    })

    it("无 scenarios 目录返回空数组", () => {
      rmSync(scenariosDir, { recursive: true, force: true })
      const result = scenarioExport(testDir)
      expect(result).toEqual([])
    })

    it("忽略非 .json 文件", () => {
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify({ id: "TC001" }), 'utf8')
      writeFileSync(join(scenariosDir, "readme.txt"), "not json", 'utf8')
      const result = scenarioExport(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].caseId).toBe("TC001")
    })

    it("导出内容包含完整 scenario 对象", () => {
      const fullScenario = { id: "TC001", target: { className: "com.Foo", method: "bar" }, params: [], assertion: { type: "return", expected: 42 } }
      writeFileSync(join(scenariosDir, "TC001.json"), JSON.stringify(fullScenario), 'utf8')
      const result = scenarioExport(testDir)
      expect(result[0].scenario).toEqual(fullScenario)
    })
  })

  describe("删除 + 导入 + 导出 组合", () => {
    it("导入 → 导出 → 删除 → 导出空", () => {
      // 导入
      const imp = scenarioImport(testDir, [
        { caseId: "TC001", scenario: { id: "TC001", target: { className: "Foo", method: "bar" } } },
        { caseId: "TC002", scenario: { id: "TC002", target: { className: "Baz", method: "qux" } } },
      ])
      expect(imp.imported).toBe(2)

      // 导出验证
      const exported = scenarioExport(testDir)
      expect(exported).toHaveLength(2)

      // 删除一个
      const deleted = scenarioDelete(testDir, "TC001")
      expect(deleted).toBe(true)

      // 再次导出，只剩一个
      const exported2 = scenarioExport(testDir)
      expect(exported2).toHaveLength(1)
      expect(exported2[0].caseId).toBe("TC002")
    })
  })
})
