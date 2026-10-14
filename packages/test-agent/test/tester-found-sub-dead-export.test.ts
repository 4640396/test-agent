/**
 * tester-found bug #15 回归守卫：@cxmt/sub 不导出 DiagnosisCategory（protocol 单一来源）
 *
 * 发现者：tester（持续 bug 修复循环第 15 轮）
 * 模块：packages/sub/src/types.ts
 *
 * bug 回顾：
 *   sub 的 DiagnosisCategory 是 dead export——protocol 是单一来源（febf409），
 *   sub 的定义无人用（连 sub 自己都不用）。修复（d95ef14）删定义留注释防回潮。
 *
 * 回归守卫：sub 不应导出 DiagnosisCategory（防上游重新 vendor 时同步回潮）。
 */

import { describe, it, expect } from "vitest";

describe("[tester-found] bug #15 回归守卫：sub 不导出 DiagnosisCategory", () => {
  it("@cxmt/sub 不含 DiagnosisCategory export（protocol 单一来源）", async () => {
    const sub = await import("@cxmt/sub");
    // sub 用 export * from "./types.ts"，DiagnosisCategory 若定义则导出
    // 修复后：定义已删，不应导出
    expect("DiagnosisCategory" in sub).toBe(false);
  });
});
