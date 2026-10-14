/**
 * Mock 缺陷跟踪器（PRD 功能三）。
 *
 * 用于测试与无 Jira 环境回退。返回确定性 ok=true，defectId='MOCK-<n>'。
 */

import type { DefectCreateInput, DefectCreateResult, DefectTracker } from "./defect-tracker.js";

let mockCounter = 0;

/**
 * 重置 Mock 计数器（测试用）。
 *
 * Mock 实现的 defectId 依赖全局计数器，测试间需重置以保证确定性。
 */
export function resetMockCounter(): void {
  mockCounter = 0;
}

/** 获取当前 Mock 计数器值（测试用）。 */
export function getMockCounter(): number {
  return mockCounter;
}

export class MockDefectTracker implements DefectTracker {
  createDefect(_input: DefectCreateInput): Promise<DefectCreateResult> {
    mockCounter += 1;
    const id = `MOCK-${mockCounter}`;
    return Promise.resolve({
      ok: true,
      defectId: id,
      defectUrl: `mock://${id}`,
    });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
