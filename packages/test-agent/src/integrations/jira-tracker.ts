/**
 * Jira 缺陷跟踪器实现（PRD 功能三：缺陷联动）。
 *
 * 环境变量配置：JIRA_URL / JIRA_TOKEN / JIRA_PROJECT_KEY。
 * - 缺任一环境变量 → 构造时抛清晰错误。
 * - createDefect 调 Jira REST API（POST /rest/api/3/issue），标题=caseName，
 *   描述=description+证据+建议，附件按 Jira 附件 API 上传。
 * - HTTP 失败 → { ok:false, error } 不抛。
 * - 凭据缺失或不可达 → { ok:false, error:'Jira 未配置或不可达' }，不阻塞任务。
 *
 * [需人工复核-Jira环境] 真实联调需 Jira 测试环境，单元测试用 mock fetch 验证。
 */

import type { DefectCreateInput, DefectCreateResult, DefectTracker } from "./defect-tracker.js";

export interface JiraConfig {
  /** Jira 基础 URL，如 https://your-domain.atlassian.net。 */
  url: string;
  /** API Token（Basic auth username:token）。 */
  token: string;
  /** Jira 项目 Key，如 PROJ。 */
  projectKey: string;
}

/** 从环境变量读取 Jira 配置。缺任一返回 null。 */
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig | null {
  const url = env.JIRA_URL?.trim();
  const token = env.JIRA_TOKEN?.trim();
  const projectKey = env.JIRA_PROJECT_KEY?.trim();
  if (!url || !token || !projectKey) return null;
  return { url, token, projectKey };
}

/** 检查 Jira 配置是否完整（不验证可达性）。 */
export function isJiraConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return jiraConfigFromEnv(env) !== null;
}

/** 构造 Basic auth header（Jira API Token 模式：email:token）。 */
function authHeader(token: string): string {
  return `Basic ${Buffer.from(token).toString("base64")}`;
}

/** 组装 Jira issue 描述（Atlassian Document Format 简化版——纯文本 + 结构标记）。 */
function buildDescription(input: DefectCreateInput): string {
  const parts: string[] = [input.description || input.title];
  if (input.evidence) parts.push(`\n*证据*\n${input.evidence}`);
  if (input.suggestion) parts.push(`\n*修复建议*\n${input.suggestion}`);
  if (input.screenshots?.length) parts.push(`\n*截图*\n${input.screenshots.join("\n")}`);
  return parts.join("\n");
}

export class JiraDefectTracker implements DefectTracker {
  private readonly config: JiraConfig;

  constructor(config: JiraConfig) {
  if (!config.url || !config.token || !config.projectKey) {
    throw new Error("Jira 配置不完整：需 JIRA_URL / JIRA_TOKEN / JIRA_PROJECT_KEY");
  }
  this.config = config;
  }

  /** 从环境变量构造。缺任一环境变量时抛错。 */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): JiraDefectTracker {
    const config = jiraConfigFromEnv(env);
    if (!config) {
      throw new Error("Jira 未配置：需设置 JIRA_URL / JIRA_TOKEN / JIRA_PROJECT_KEY 环境变量");
    }
    return new JiraDefectTracker(config);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.url}/rest/api/3/myself`, {
        method: "GET",
        headers: {
          "Authorization": authHeader(this.config.token),
          "Accept": "application/json",
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createDefect(input: DefectCreateInput): Promise<DefectCreateResult> {
    try {
      const issueBody = {
        fields: {
          project: { key: this.config.projectKey },
          summary: input.title || input.caseName,
          description: buildDescription(input),
          issuetype: { name: "Bug" },
          labels: ["test-agent", input.category],
        },
      };

      const createRes = await fetch(`${this.config.url}/rest/api/3/issue`, {
        method: "POST",
        headers: {
          "Authorization": authHeader(this.config.token),
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(issueBody),
      });

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => createRes.statusText);
        return { ok: false, error: `Jira 创建失败 ${createRes.status}: ${errText}` };
      }

      const created = (await createRes.json()) as { key?: string; self?: string };
      const defectId = created.key ?? undefined;
      const defectUrl = defectId ? `${this.config.url}/browse/${defectId}` : created.self;

      // 附件上传（Jira 附件 API：POST /rest/api/3/issue/{issueId}/attachments，X-Atlassian-Token: no-check）
      if (defectId && input.attachments && input.attachments.length > 0) {
        await this.uploadAttachments(defectId, input.attachments);
      }

      return { ok: true, defectId, defectUrl };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Jira 未配置或不可达: ${msg}` };
    }
  }

  /** 上传附件到已创建的 issue。失败不阻塞（附件是 best-effort）。 */
  private async uploadAttachments(issueKey: string, attachments: string[]): Promise<void> {
    const formData = new FormData();
    for (const path of attachments) {
      try {
        const { readFileSync } = await import("node:fs");
        const { basename } = await import("node:path");
        const buffer = readFileSync(path);
        const blob = new Blob([buffer]);
        formData.append("file", blob, basename(path));
      } catch {
        // 附件读取失败跳过，不阻塞建单
      }
    }
    try {
      await fetch(`${this.config.url}/rest/api/3/issue/${issueKey}/attachments`, {
        method: "POST",
        headers: {
          "Authorization": authHeader(this.config.token),
          "X-Atlassian-Token": "no-check",
        },
        body: formData,
      });
    } catch {
      // 附件上传失败不阻塞
    }
  }
}
