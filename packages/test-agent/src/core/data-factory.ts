/**
 * 数据工厂 — PRD 功能四（第 8 节）测试数据管理。
 *
 * 首期手写 3 个模板：
 * - createOrder()：造前置订单数据，返回订单实体（含唯一订单号）。
 * - createUser()：造前置用户数据，返回用户实体（含唯一用户 ID）。
 * - cleanUp(entities)：按实体标识列表删除测试数据。清理失败抛错/返回失败，不静默。
 *
 * 设计原则：
 * - factory 造数失败 → 用例标『环境问题』（复用诊断分类 'environment'），不误判代码 bug。
 * - 可注入 HTTP 客户端/ baseUrl，便于单测 mock。
 * - 并行数据命名空间隔离：造数时注入前缀 namespaceForShard(shardIndex)，
 *   唯一标识带前缀避免并行片唯一约束冲突（PRD 8.5 场景 C）。
 *
 * 控制面零改动：factory 通过 HTTP（apiBaseUrl）或可注入的 createFn/deleteFn 造数，
 * 不直接操作数据库。
 */

import type { DiagnosisCategory } from "./types.js";
import { namespaceForShard } from "./datasets.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 创建的实体引用（含类型 + 唯一标识，用于清理）。 */
export interface EntityRef {
  /** 实体类型：order / user / custom。 */
  type: string;
  /** 唯一标识（如订单号、用户 ID）。 */
  id: string;
  /** 删除该实体用的 HTTP 路径（可选，默认按 type 推导）。 */
  deletePath?: string;
}

/** 造数结果。 */
export interface CreateResult<T extends EntityRef = EntityRef> {
  ok: boolean;
  entity?: T;
  /** 失败原因（ok=false 时）。 */
  error?: string;
}

/** 清理结果。 */
export interface CleanupResult {
  ok: boolean;
  /** 成功删除的实体数。 */
  deleted: number;
  /** 失败的实体（含标识 + 失败原因）。 */
  failures: Array<{ id: string; error: string }>;
}

/** cleanup hook 执行结果（含诊断分类，用于标记用例失败）。 */
export interface CleanupHookResult {
  ok: boolean;
  result: CleanupResult;
  /** 失败时的诊断分类（清理失败 → 'environment'）。 */
  category?: DiagnosisCategory;
  /** 告警消息（不静默）。 */
  warning: string;
}

/** 可注入的造数函数（默认通过 HTTP fetch，单测可 mock）。 */
export type CreateFn = (payload: unknown) => Promise<{ status: number; body: unknown }>;

/** 可注入的删除函数。 */
export type DeleteFn = (path: string) => Promise<{ status: number; body: unknown }>;

// ---------------------------------------------------------------------------
// DataFactory 接口
// ---------------------------------------------------------------------------

/**
 * 数据工厂接口 — 3 个模板（createOrder / createUser / cleanUp）。
 *
 * 实现可通过 HTTP（apiBaseUrl）或可注入的 createFn/deleteFn 造数，便于单测 mock。
 */
export interface DataFactory {
  createOrder(overrides?: Record<string, unknown>): Promise<CreateResult>;
  createUser(overrides?: Record<string, unknown>): Promise<CreateResult>;
  cleanUp(entities: EntityRef[]): Promise<CleanupResult>;
}

// ---------------------------------------------------------------------------
// DefaultDataFactory
// ---------------------------------------------------------------------------

/**
 * 默认数据工厂实现：通过 HTTP（apiBaseUrl）或可注入的 createFn/deleteFn 造数。
 *
 * 唯一标识带命名空间前缀（namespaceForShard(shardIndex)），避免并行片唯一约束冲突。
 */
export class DefaultDataFactory implements DataFactory {
  private readonly prefix: string;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly shardIndex?: number,
    private readonly createFn?: CreateFn,
    private readonly deleteFn?: DeleteFn,
  ) {
    this.prefix = namespaceForShard(shardIndex);
  }

  async createOrder(overrides: Record<string, unknown> = {}): Promise<CreateResult> {
    const orderId = `${this.prefix}ORD-${generateId()}`;
    const payload = { orderId, status: "pending", ...overrides };
    return this.createEntity("/api/orders", payload, "order", orderId);
  }

  async createUser(overrides: Record<string, unknown> = {}): Promise<CreateResult> {
    const userId = `${this.prefix}USR-${generateId()}`;
    const payload = { userId, name: `test-${userId}`, ...overrides };
    return this.createEntity("/api/users", payload, "user", userId);
  }

  async cleanUp(entities: EntityRef[]): Promise<CleanupResult> {
    const failures: Array<{ id: string; error: string }> = [];
    let deleted = 0;
    for (const entity of entities) {
      const path = entity.deletePath ?? defaultDeletePath(entity);
      try {
        const res = this.deleteFn ? await this.deleteFn(path) : await httpDelete(this.apiBaseUrl, path);
        if (res.status >= 200 && res.status < 300) {
          deleted++;
        } else {
          failures.push({ id: entity.id, error: `删除返回状态码 ${res.status}` });
        }
      } catch (e) {
        // 清理失败不静默 — 记录失败原因
        failures.push({ id: entity.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok: failures.length === 0, deleted, failures };
  }

  private async createEntity(
    path: string,
    payload: unknown,
    type: string,
    fallbackId: string,
  ): Promise<CreateResult> {
    try {
      const res = this.createFn ? await this.createFn(payload) : await httpPost(this.apiBaseUrl, path, payload);
      if (res.status >= 200 && res.status < 300) {
        const body = res.body as Record<string, unknown> | null;
        const id = extractId(body) ?? fallbackId;
        return {
          ok: true,
          entity: { type, id: String(id), deletePath: `${path}/${id}` },
        };
      }
      return {
        ok: false,
        error: `造数失败（${type}）：HTTP ${res.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        error: `造数失败（${type}）：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// executeCleanupHook — cleanup 失败告警不静默
// ---------------------------------------------------------------------------

/**
 * 执行 cleanup hook，返回含诊断分类的结果。
 *
 * - 清理成功 → ok=true，无告警
 * - 清理部分失败 → ok=false，warning 含失败列表，category='environment'
 * - 清理全部失败 → ok=false，warning 含失败列表，category='environment'（严重时标记用例失败）
 * - factory 未提供 → ok=true，warning 提示无 factory（非失败）
 *
 * 清理失败分类为 'environment'（不误判代码 bug）。
 */
export async function executeCleanupHook(
  factory: DataFactory | undefined,
  entities: EntityRef[],
): Promise<CleanupHookResult> {
  if (!factory) {
    return {
      ok: true,
      result: { ok: true, deleted: 0, failures: [] },
      warning: entities.length > 0
        ? `cleanup 请求但未提供 DataFactory，${entities.length} 个实体未清理`
        : "cleanup 请求但无实体需清理",
    };
  }
  if (entities.length === 0) {
    return {
      ok: true,
      result: { ok: true, deleted: 0, failures: [] },
      warning: "cleanup 请求但无实体需清理",
    };
  }
  const result = await factory.cleanUp(entities);
  if (result.ok) {
    return {
      ok: true,
      result,
      warning: `清理完成：删除 ${result.deleted} 个实体`,
    };
  }
  const failureDesc = result.failures.map((f) => `${f.id}(${f.error})`).join("; ");
  return {
    ok: false,
    result,
    category: "environment",
    warning: `清理失败（${result.failures.length}/${entities.length}）：${failureDesc}`,
  };
}

/**
 * 判定造数失败是否应标记用例失败（category='environment'）。
 *
 * 造数失败 → 'environment'（不误判代码 bug）。
 */
export function categorizeCreateFailure(result: CreateResult): DiagnosisCategory | undefined {
  if (result.ok) return undefined;
  return "environment";
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 生成短随机 ID（用于唯一标识后缀）。 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从响应体提取唯一标识（id / orderId / userId 等常见字段）。 */
function extractId(body: Record<string, unknown> | null): string | number | undefined {
  if (!body) return undefined;
  return (body.id ?? body.orderId ?? body.userId ?? body.uuid) as string | number | undefined;
}

/** 默认删除路径推导。 */
function defaultDeletePath(entity: EntityRef): string {
  switch (entity.type) {
    case "order":
      return `/api/orders/${entity.id}`;
    case "user":
      return `/api/users/${entity.id}`;
    default:
      return `/api/${entity.type}s/${entity.id}`;
  }
}

async function httpPost(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const root = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${root}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  const resBody = await safeParseJson(res);
  return { status: res.status, body: resBody };
}

async function httpDelete(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const root = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${root}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
  const resBody = await safeParseJson(res);
  return { status: res.status, body: resBody };
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
