/**
 * Agent Loader — 从 agents/ 目录加载角色 .md 定义（照 pi-subagents agent-serializer.ts 简化）。
 *
 * 解析 .md frontmatter（YAML）+ Markdown body，返回 RoleConfig map。
 * 保留 pi-subagents 字段：name/tools/thinking/systemPromptMode/turnBudget/acceptanceRole。
 * 不拷 Pi 专属字段：inheritProjectContext/inheritSkills/defaultContext/defaultProgress/output。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export interface RoleConfig {
  /** 角色标识（作为 key）。 */
  name: string;
  /** 角色描述。 */
  description?: string;
  /** 工具白名单（capability-ceiling 用）。 */
  tools: string[];
  /** 思考深度。 */
  thinking?: "off" | "low" | "medium" | "high";
  /** systemPrompt 注入模式（replace = 替换默认 prompt）。 */
  systemPromptMode?: "replace";
  /** systemPrompt 正文（.md body，frontmatter 之后）。 */
  systemPrompt: string;
  /** 轮次预算（turn-budget 用）。 */
  turnBudget?: { maxTurns: number; graceTurns: number };
  /** acceptance 角色（read-only / writer）。 */
  acceptanceRole?: "read-only" | "writer";
  /** 是否启用 escalate 工具（角色遇未预料决策时向总代理提问）。 */
  escalation?: boolean;
  /** 默认保守方案（escalation 超时降级时用）。 */
  fallback?: string;
  /** 是否在 reply 时用 agent.steer 注入答复（双重保险，默认关闭，靠工具返回值传递答复）。 */
  escalationSteer?: boolean;
}

/**
 * 从 agents/ 目录加载所有角色 .md，解析 frontmatter + body，返回 RoleConfig map。
 *
 * 照 pi-subagents agent-serializer.ts 的 KNOWN_FIELDS 简化：
 * 保留 name/description/tools/thinking/systemPromptMode/turnBudget/acceptanceRole，
 * 忽略其余字段（Pi 专属）。
 */
export function loadRoles(agentsDir: string): Record<string, RoleConfig> {
  const roles: Record<string, RoleConfig> = {};
  if (!existsSync(agentsDir)) return roles;

  const files = readdirSync(agentsDir).filter((f) => extname(f) === ".md" && f.toLowerCase() !== "readme.md");
  for (const file of files) {
  const filePath = join(agentsDir, file);
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    console.warn(`[agent-loader] failed to parse frontmatter: ${file}`);
    continue;
  }

  const { frontmatter, body } = parsed;
  const name = String(frontmatter.name ?? "").trim();
  if (!name) continue;

  // tools: 逗号分隔字符串 → string[]
  const toolsRaw = String(frontmatter.tools ?? "").trim();
  const tools = toolsRaw
    ? toolsRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  // turnBudget: 支持 JSON 对象或 YAML inline
  let turnBudget: RoleConfig["turnBudget"] | undefined;
  if (frontmatter.turnBudget && typeof frontmatter.turnBudget === "object") {
  const tb = frontmatter.turnBudget as { maxTurns?: number; graceTurns?: number };
  if (typeof tb.maxTurns === "number" && typeof tb.graceTurns === "number") {
    turnBudget = { maxTurns: tb.maxTurns, graceTurns: tb.graceTurns };
  }
  } else if (typeof frontmatter.turnBudget === "string") {
  // 尝试 JSON.parse（pi-subagents 用 JSON.stringify 格式）
  try {
    const tb = JSON.parse(frontmatter.turnBudget);
    if (typeof tb.maxTurns === "number" && typeof tb.graceTurns === "number") {
    turnBudget = { maxTurns: tb.maxTurns, graceTurns: tb.graceTurns };
    }
  } catch {
    // 非 JSON，忽略
  }
  }

  // thinking: off/low/medium/high
  let thinking: RoleConfig["thinking"];
  const thinkingRaw = String(frontmatter.thinking ?? "").trim().toLowerCase();
  if (thinkingRaw === "off" || thinkingRaw === "low" || thinkingRaw === "medium" || thinkingRaw === "high") {
    thinking = thinkingRaw;
  }

  // acceptanceRole: read-only / writer
  let acceptanceRole: RoleConfig["acceptanceRole"];
  const roleRaw = String(frontmatter.acceptanceRole ?? "").trim().toLowerCase();
  if (roleRaw === "read-only" || roleRaw === "writer") {
    acceptanceRole = roleRaw;
  }

  // escalation: boolean（是否启用 escalate 工具）
  const escalation = frontmatter.escalation === true ? true : undefined;

  // fallback: string（默认保守方案）
  const fallback = typeof frontmatter.fallback === "string" && frontmatter.fallback.trim() ? String(frontmatter.fallback).trim() : undefined;

  // escalationSteer: boolean（reply 时是否用 steer 注入答复，默认关闭）
  const escalationSteer = frontmatter.escalationSteer === true ? true : undefined;

  roles[name] = {
    name,
    description: frontmatter.description ? String(frontmatter.description).trim() : undefined,
    tools,
    thinking,
    systemPromptMode: frontmatter.systemPromptMode === "replace" ? "replace" : undefined,
    systemPrompt: body.trim(),
    turnBudget,
    acceptanceRole,
    escalation,
    fallback,
    escalationSteer,
  };
  }

  return roles;
}

/**
 * 解析 .md frontmatter + body。
 * frontmatter 在 --- 分隔符之间，用简易 YAML 解析（键值对）。
 * 支持嵌套对象（turnBudget: { maxTurns: 6, graceTurns: 1 }）。
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlStr = match[1];
  const body = match[2];

  // 简易 YAML 解析：逐行键值对，支持嵌套对象（缩进）
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nestedObj: Record<string, unknown> | null = null;

  for (const line of yamlStr.split("\n")) {
  if (line.trim() === "") continue;

  // 嵌套对象行（2 空格缩进）
  const nestedMatch = /^  (\w+):\s*(.*)$/.exec(line);
  if (nestedMatch && currentKey) {
    if (!nestedObj) {
    nestedObj = {};
    frontmatter[currentKey] = nestedObj;
    }
    const nk = nestedMatch[1].trim();
    const nv = nestedMatch[2].trim();
    nestedObj[nk] = parseYamlValue(nv);
    continue;
  }

  // 顶层键值对
  const kvMatch = /^(\w+):\s*(.*)$/.exec(line);
  if (kvMatch) {
    currentKey = kvMatch[1].trim();
    nestedObj = null;
    const value = kvMatch[2].trim();
    if (value === "") {
    // 值为空——可能是嵌套对象的开头，等下一行
    continue;
    }
    frontmatter[currentKey] = parseYamlValue(value);
  }
  }

  return { frontmatter, body };
}

/** 解析 YAML 值（字符串/数字/布尔/JSON 对象）。 */
function parseYamlValue(value: string): unknown {
  // 布尔
  if (value === "true") return true;
  if (value === "false") return false;
  // 数字
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // JSON 对象（如 turnBudget: { maxTurns: 6, graceTurns: 1 }）
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
    return JSON.parse(value);
    } catch {
    return value;
    }
  }
  // 普通字符串
  return value;
}
