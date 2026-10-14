/**
 * tester-found bug 复现测试：parseFrontmatter 正则只匹配 LF，CRLF 文件静默加载失败
 *
 * 发现者：tester（持续 bug 修复循环第 4 轮）
 * 模块：packages/test-agent/src/core/agent-loader.ts parseFrontmatter
 *
 * bug 描述：
 *   parseFrontmatter 正则 `/^---\n([\s\S]*?)\n---\n([\s\S]*)$/` 硬编码 `\n`。
 *   若 .md 文件用 CRLF 换行（Windows 编辑器默认），开头是 `---\r\n`，不匹配 `---\n`
 *   → match=null → 返回 null → loadRoles `if (!parsed) continue` 静默跳过该角色。
 *
 *   角色静默缺失 → runner 后续 `if (!role) throw new Error("xxx 角色配置未找到")`，
 *   用户看到"角色配置未找到"但不知根因是 CRLF 换行。无诊断日志（continue 静默）。
 *
 *   触发场景：用户在 Windows 编辑器（记事本/部分 IDE 默认 CRLF）编辑 agents/*.md
 *   保存后变 CRLF → 角色加载失败。项目自带文件是 LF 不受影响，但用户自定义/编辑会触发。
 *
 * 严重性建议：P2——边界鲁棒性 + 静默失败无诊断。非 P1（项目自带文件 LF，仅用户编辑触发）。
 *
 * 预期修复方向（reviewer/worker 定）：
 *   A. 正则用 \r?\n：`/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/`，body 内换行 normalize
 *   B. 或加载前 raw.replace(/\r\n/g, "\n") 统一 LF 再解析
 *   建议加诊断：parseFrontmatter 返回 null 时 loadRoles 记录 warn（哪个文件解析失败）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles } from "../src/core/agent-loader.js";

const LF_ROLE_MD = `---
name: scout
description: 侦察角色
tools: read, grep, find, ls
thinking: high
systemPromptMode: replace
turnBudget: { maxTurns: 6, graceTurns: 1 }
acceptanceRole: read-only
escalation: true
---

你是侦察角色。读取项目结构。`;

describe("[tester-found] parseFrontmatter CRLF 静默加载失败", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tester-roles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("LF 换行的 .md → 角色正常加载", () => {
    writeFileSync(join(tmpDir, "scout.md"), LF_ROLE_MD, "utf8");
    const roles = loadRoles(tmpDir);
    expect(roles["scout"]).toBeDefined();
    expect(roles["scout"].name).toBe("scout");
    expect(roles["scout"].tools).toContain("read");
  });

  it("CRLF 换行的 .md → 角色正常加载（修复后回归守卫）", () => {
    // 同样内容但用 CRLF 换行（Windows 编辑器默认）
    const crlfRoleMd = LF_ROLE_MD.replace(/\n/g, "\r\n");
    writeFileSync(join(tmpDir, "scout.md"), crlfRoleMd, "utf8");
    const roles = loadRoles(tmpDir);

    // 期望：CRLF 也应正常加载
    // 实际（bug）：parseFrontmatter 正则不匹配 CRLF → null → continue 跳过 → undefined
    expect(roles["scout"]).toBeDefined(); // ← FAIL，复现 bug
    expect(roles["scout"]?.name).toBe("scout");
  });

  it("README.md 是说明文档，不作为角色解析或输出警告", () => {
    writeFileSync(join(tmpDir, "README.md"), "# 角色说明\n", "utf8");
    writeFileSync(join(tmpDir, "scout.md"), LF_ROLE_MD, "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(Object.keys(loadRoles(tmpDir))).toEqual(["scout"]);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
