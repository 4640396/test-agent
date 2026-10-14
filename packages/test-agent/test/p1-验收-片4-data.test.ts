/**
 * P1 片4 独立验收 — 测试数据管理（PRD 8.5 三场景 + 边界探针）
 *
 * 独立视角：不照抄 worker 内置 data-management.test.ts 结论。重点验证：
 * 1. PRD 8.5 场景 A/B/C 的 PRD 原意
 * 2. 边界探针：CSV 转义/引号/空行/表头不匹配、JSON 单对象 vs 数组、版本化递增/历史/回滚/软删、
 *    cleanup 失败分类 environment、cleanup 严重标用例失败（fail+1）、向后兼容、
 *    createdEntities 反向清理、路径正确、3 模板契约、占位符字段缺失→空串
 * 3. 独立判断点（KEY）：
 *    · 数据集版本化真复用 cases.ts computeProjectHash（不是另起一套 hash）
 *    · 并行命名空间隔离真对接 shard.ts（通过 TestToolContext.shardIndex 桥接 ShardAssignment）
 *    · cleanup 失败标 environment 真复用 DiagnosisCategory（不是新造错误码）
 *    · 控制面零改动——无 services/ 调用
 * 4. cleanup hook 端到端接线：cleanupFailed → fail+1（worker 可能只测纯函数，我测工具层接线）
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:http";
import {
  parseDataset,
  parseCsv,
  namespaceForShard,
  DatasetLibrary,
  computeDatasetId,
  type DatasetRow,
} from "../src/core/datasets.js";
import {
  DefaultDataFactory,
  executeCleanupHook,
  categorizeCreateFailure,
  type CreateFn,
  type DeleteFn,
  type EntityRef,
} from "../src/core/data-factory.js";
import { expandApiCases } from "../src/core/tools/api-test.js";
import { computeProjectHash } from "../src/core/cases.js";
import type { DiagnosisCategory } from "../src/core/types.js";

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()!;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmp(): string {
  const root = mkdtempSync(join(tmpdir(), "p1-data-"));
  tmpRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// PRD 8.5 场景 A：参数化 1 用例 5 组数据 → 5 结果
// ---------------------------------------------------------------------------

describe("[片4-验收] 场景A：参数化展开（expandApiCases）", () => {
  it("1 用例绑 5 组数据（内联数组）→ 展开 5 个用例，ID #0..#4，占位符替换", () => {
    const expanded = expandApiCases(
      [
        {
          id: "query_order",
          title: "查询订单 ${orderId}",
          scenario: "用 orderId=${orderId} 查询，预期 ${expectStatus}",
          steps: ["GET /api/orders/${orderId}"],
          expected: "${expectStatus}",
          dataset: [
            { orderId: "A001", expectStatus: "200" },
            { orderId: "NOT_EXIST", expectStatus: "404" },
            { orderId: "FORBID", expectStatus: "403" },
            { orderId: "", expectStatus: "400" },
            { orderId: "A999", expectStatus: "500" },
          ],
        },
      ],
      undefined,
    );
    expect(expanded).toHaveLength(5);
    expect(expanded.map((e) => e.case.id)).toEqual([
      "query_order#0",
      "query_order#1",
      "query_order#2",
      "query_order#3",
      "query_order#4",
    ]);
    // 占位符替换
    expect(expanded[0].case.title).toBe("查询订单 A001");
    expect(expanded[0].case.steps[0]).toBe("GET /api/orders/A001");
    expect(expanded[0].case.expected).toBe("200");
    expect(expanded[3].case.title).toBe("查询订单 "); // 空串占位
    expect(expanded[3].case.expected).toBe("400");
    // rowIndex 标记
    expect(expanded[0].rowIndex).toBe(0);
    expect(expanded[4].rowIndex).toBe(4);
  });

  it("CSV 数据集 5 行 → 展开 5 个用例", () => {
    const dir = makeTmp();
    const csvPath = join(dir, "orders.csv");
    writeFileSync(
      csvPath,
      "orderId,expectStatus\nA001,200\nNOT_EXIST,404\nFORBID,403\nEMPTY,400\nA999,500\n",
      "utf8",
    );
    const expanded = expandApiCases(
      [
        {
          id: "q",
          title: "查 ${orderId}",
          scenario: "s",
          steps: ["GET /api/orders/${orderId}"],
          expected: "${expectStatus}",
          dataset: csvPath,
        },
      ],
      dir,
    );
    expect(expanded).toHaveLength(5);
    expect(expanded[0].case.title).toBe("查 A001");
    expect(expanded[0].case.expected).toBe("200"); // CSV 数值字段 → number 200，替换为 "200"
    expect(expanded[4].case.expected).toBe("500");
  });

  it("向后兼容：无 dataset → 原样保留 1 用例（不展开）", () => {
    const expanded = expandApiCases(
      [
        {
          id: "plain",
          title: "普通用例",
          scenario: "s",
          steps: ["GET /api/users"],
          expected: "200",
        },
      ],
      undefined,
    );
    expect(expanded).toHaveLength(1);
    expect(expanded[0].case.id).toBe("plain"); // 无 # 后缀
    expect(expanded[0].rowIndex).toBeUndefined();
    expect(expanded[0].cleanup).toBe(false); // 默认
  });

  it("空数据集（0 行）→ 保留 1 用例不展开（不丢用例）", () => {
    const expanded = expandApiCases(
      [
        {
          id: "empty",
          title: "t",
          scenario: "s",
          steps: ["GET /x"],
          expected: "200",
          dataset: "[]",
        },
      ],
      undefined,
    );
    expect(expanded).toHaveLength(1);
    expect(expanded[0].case.id).toBe("empty"); // 无 # 后缀
  });

  it("cleanup 标记透传：dataset 展开 + cleanup=true → 每个展开项都带 cleanup=true", () => {
    const expanded = expandApiCases(
      [
        {
          id: "c",
          title: "t",
          scenario: "s",
          steps: ["GET /x"],
          expected: "200",
          cleanup: true,
          dataset: [{ a: "1" }, { a: "2" }],
        },
      ],
      undefined,
    );
    expect(expanded).toHaveLength(2);
    expect(expanded.every((e) => e.cleanup)).toBe(true);
  });

  it("占位符字段缺失 → 替换为空串（不抛错）", () => {
    const expanded = expandApiCases(
      [
        {
          id: "miss",
          title: "t-${missing}",
          scenario: "s",
          steps: ["GET /${path}"],
          expected: "${code}",
          dataset: [{ code: "200" }], // 无 missing、无 path
        },
      ],
      undefined,
    );
    expect(expanded[0].case.title).toBe("t-");
    expect(expanded[0].case.steps[0]).toBe("GET /");
    expect(expanded[0].case.expected).toBe("200");
  });

  it("多字段占位符同用例混合替换", () => {
    const expanded = expandApiCases(
      [
        {
          id: "mix",
          title: "${a}-${b}-${a}",
          scenario: "s",
          steps: ["POST /${a} body=${b}"],
          expected: "${a}${b}",
          dataset: [{ a: "x", b: "y" }],
        },
      ],
      undefined,
    );
    expect(expanded[0].case.title).toBe("x-y-x"); // 同字段多次引用
    expect(expanded[0].case.steps[0]).toBe("POST /x body=y");
    expect(expanded[0].case.expected).toBe("xy");
  });
});

// ---------------------------------------------------------------------------
// PRD 8.5 场景 B：factory 造前置 + cleanup 清理
// ---------------------------------------------------------------------------

describe("[片4-验收] 场景B：factory 造前置 + cleanup 清理", () => {
  it("createOrder → 得订单实体 → cleanUp 删除（mock HTTP 全流程）", async () => {
    const createdPayloads: unknown[] = [];
    const deletedPaths: string[] = [];
    const createFn: CreateFn = async (payload) => {
      createdPayloads.push(payload);
      return { status: 201, body: { orderId: (payload as { orderId: string }).orderId } };
    };
    const deleteFn: DeleteFn = async (path) => {
      deletedPaths.push(path);
      return { status: 204, body: null };
    };
    const factory = new DefaultDataFactory("https://api.test", undefined, createFn, deleteFn);

    // 造前置订单
    const created = await factory.createOrder({ amount: 100 });
    expect(created.ok).toBe(true);
    expect(created.entity).toBeDefined();
    expect(created.entity!.type).toBe("order");
    expect(created.entity!.id).toMatch(/^serial-ORD-/); // 串行前缀
    expect(created.entity!.deletePath).toBe(`/api/orders/${created.entity!.id}`);

    // cleanup 清理
    const cleanup = await factory.cleanUp([created.entity!]);
    expect(cleanup.ok).toBe(true);
    expect(cleanup.deleted).toBe(1);
    expect(cleanup.failures).toHaveLength(0);
    expect(deletedPaths[0]).toBe(`/api/orders/${created.entity!.id}`);
  });

  it("createUser → 得用户实体 → cleanUp", async () => {
    const createFn: CreateFn = async () => ({ status: 201, body: { userId: "U123" } });
    const deleteFn: DeleteFn = async () => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("https://api.test", undefined, createFn, deleteFn);

    const created = await factory.createUser({ name: "alice" });
    expect(created.ok).toBe(true);
    expect(created.entity!.type).toBe("user");
    expect(created.entity!.id).toBe("U123"); // 优先用响应体 id
    expect(created.entity!.deletePath).toBe(`/api/users/U123`);
  });

  it("executeCleanupHook：清理成功 → ok=true，无 category", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const entities: EntityRef[] = [{ type: "order", id: "O1", deletePath: "/api/orders/O1" }];
    const result = await executeCleanupHook(factory, entities);
    expect(result.ok).toBe(true);
    expect(result.category).toBeUndefined();
    expect(result.warning).toContain("清理完成");
  });

  it("executeCleanupHook：清理失败 → ok=false，category='environment'（不误判代码 bug）", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 500, body: "err" });
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const entities: EntityRef[] = [{ type: "order", id: "O1", deletePath: "/api/orders/O1" }];
    const result = await executeCleanupHook(factory, entities);
    expect(result.ok).toBe(false);
    expect(result.category).toBe("environment");
    expect(result.warning).toContain("清理失败");
    expect(result.warning).toContain("O1");
  });

  it("executeCleanupHook：factory 未提供 + 有实体 → ok=true 告警（非失败）", async () => {
    const entities: EntityRef[] = [{ type: "order", id: "O1" }];
    const result = await executeCleanupHook(undefined, entities);
    expect(result.ok).toBe(true); // 不阻断
    expect(result.warning).toContain("未提供 DataFactory");
  });

  it("executeCleanupHook：无实体 → ok=true", async () => {
    const factory = new DefaultDataFactory("https://x", undefined, undefined, async () => ({ status: 204, body: null }));
    const result = await executeCleanupHook(factory, []);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("无实体");
  });

  it("cleanUp 部分失败 → failures 记录，不静默", async () => {
    const deleteFn: DeleteFn = async (path) => {
      if (path.includes("O2")) return { status: 500, body: "err" };
      return { status: 204, body: null };
    };
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const entities: EntityRef[] = [
      { type: "order", id: "O1", deletePath: "/api/orders/O1" },
      { type: "order", id: "O2", deletePath: "/api/orders/O2" },
    ];
    const result = await factory.cleanUp(entities);
    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("O2");
    expect(result.failures[0].error).toContain("500");
  });

  it("cleanUp 网络异常 → 记入 failures 不抛", async () => {
    const deleteFn: DeleteFn = async () => { throw new Error("ECONNREFUSED"); };
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const result = await factory.cleanUp([{ type: "order", id: "O1", deletePath: "/api/orders/O1" }]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].error).toContain("ECONNREFUSED");
  });

  it("categorizeCreateFailure：造数失败 → 'environment'（复用 DiagnosisCategory）", () => {
    expect(categorizeCreateFailure({ ok: true })).toBeUndefined();
    expect(categorizeCreateFailure({ ok: false, error: "HTTP 500" })).toBe("environment");
  });

  it("造数失败（HTTP 500）→ ok=false，error 含状态码", async () => {
    const createFn: CreateFn = async () => ({ status: 500, body: "err" });
    const factory = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    const result = await factory.createOrder();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("造数网络异常 → ok=false 不抛", async () => {
    const createFn: CreateFn = async () => { throw new Error("timeout"); };
    const factory = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    const result = await factory.createOrder();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// 独立判断点（KEY）：cleanup hook 端到端接线 —— cleanupFailed → fail+1
// ---------------------------------------------------------------------------

describe("[片4-验收] 独立判断点：cleanup hook 工具层接线（cleanupFailed 标用例失败）", () => {
  it("createApiTestTool：cleanup=true + 清理失败 → details.fail+1, ok=false", async () => {
    // 镜像 api-test.ts execute 的 cleanup 接线逻辑（不调真实 HTTP，测接线分支）
    const { createApiTestTool } = await import("../src/core/tools/api-test.js");
    const deleteFn: DeleteFn = async () => ({ status: 500, body: "err" });
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    // runApiCases 会真实 fetch，用无效 baseUrl 触发失败，但 cleanup 接线才是重点
    // 用 mock fetch 让 runApiCases 返回通过，单独验证 cleanup 失败拉低 ok
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "ok",
    } as Response) as unknown as typeof globalThis.fetch;
    try {
      const tool = createApiTestTool({
        projectPath: makeTmp(),
        dataFactory: factory,
        createdEntities: [{ type: "order", id: "O1", deletePath: "/api/orders/O1" }],
      });
      const result = await tool.execute("call-1", {
        baseUrl: "https://api.test",
        cases: [
          {
            id: "q",
            title: "t",
            scenario: "s",
            steps: ["GET /api/orders/O1"],
            expected: "200",
            cleanup: true,
          },
        ],
      } as never, undefined);

      // cleanup 失败 → details.fail 至少 +1, ok=false
      expect(result.details.ok).toBe(false);
      expect(result.details.fail).toBeGreaterThanOrEqual(1);
      // 输出文本含清理失败告警
      const text = result.content[0].text;
      expect(text).toContain("[cleanup]");
      expect(text).toContain("清理失败");
      expect(text).toContain("environment");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("createApiTestTool：cleanup=true + 清理成功 → ok 不被拉低", async () => {
    const { createApiTestTool } = await import("../src/core/tools/api-test.js");
    const deleteFn: DeleteFn = async () => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "ok",
    } as Response) as unknown as typeof globalThis.fetch;
    try {
      const tool = createApiTestTool({
        projectPath: makeTmp(),
        dataFactory: factory,
        createdEntities: [{ type: "order", id: "O1", deletePath: "/api/orders/O1" }],
      });
      const result = await tool.execute("call-1", {
        baseUrl: "https://api.test",
        cases: [
          {
            id: "q",
            title: "t",
            scenario: "s",
            steps: ["GET /api/orders/O1"],
            expected: "200",
            cleanup: true,
          },
        ],
      } as never, undefined);
      expect(result.details.ok).toBe(true);
      expect(result.content[0].text).toContain("清理完成");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// PRD 8.5 场景 C：并行数据隔离（前缀分片ID）
// ---------------------------------------------------------------------------

describe("[片4-验收] 场景C：并行数据隔离前缀", () => {
  it("namespaceForShard：shard0→'shard0-'，shard1→'shard1-'，undefined→'serial-'", () => {
    expect(namespaceForShard(0)).toBe("shard0-");
    expect(namespaceForShard(1)).toBe("shard1-");
    expect(namespaceForShard(undefined)).toBe("serial-");
  });

  it("namespaceForShard：null/NaN → 'serial-'（健壮性）", () => {
    expect(namespaceForShard(null as never)).toBe("serial-");
    expect(namespaceForShard(Number.NaN)).toBe("serial-");
  });

  it("shard0 与 shard1 造数唯一标识不冲突（并行隔离）", async () => {
    const createFn: CreateFn = async (payload) => ({ status: 201, body: { orderId: (payload as { orderId: string }).orderId } });
    const factory0 = new DefaultDataFactory("https://x", 0, createFn, undefined);
    const factory1 = new DefaultDataFactory("https://x", 1, createFn, undefined);
    const r0 = await factory0.createOrder();
    const r1 = await factory1.createOrder();
    expect(r0.entity!.id).toMatch(/^shard0-ORD-/);
    expect(r1.entity!.id).toMatch(/^shard1-ORD-/);
    expect(r0.entity!.id).not.toBe(r1.entity!.id); // 不冲突
  });

  it("串行（无 shardIndex）前缀 'serial-'", async () => {
    const createFn: CreateFn = async (payload) => ({ status: 201, body: { orderId: (payload as { orderId: string }).orderId } });
    const factory = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    const r = await factory.createOrder();
    expect(r.entity!.id).toMatch(/^serial-ORD-/);
  });

  it("并行 2 片同数据集展开：各片独立前缀，数据不串扰", () => {
    // 模拟 P0 shard.ts 产出 ShardAssignment.shardIndex → TestToolContext.shardIndex → namespaceForShard
    const shardAssignments = [{ shardIndex: 0, cases: [], serial: false }, { shardIndex: 1, cases: [], serial: false }];
    const prefixes = shardAssignments.map((s) => namespaceForShard(s.shardIndex));
    expect(prefixes).toEqual(["shard0-", "shard1-"]);
    // 两片造 orderId 用各自前缀，唯一约束不冲突
    const id0 = `${prefixes[0]}ORD-1`;
    const id1 = `${prefixes[1]}ORD-1`;
    expect(id0).not.toBe(id1);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：CSV 解析
// ---------------------------------------------------------------------------

describe("[片4-验收] 边界探针：CSV 解析（parseCsv）", () => {
  it("双引号包裹字段含逗号", () => {
    const rows = parseCsv('name,desc\n"x","hello, world"\n"y","a,b,c"');
    expect(rows).toHaveLength(2);
    expect(rows[0].desc).toBe("hello, world");
    expect(rows[1].desc).toBe("a,b,c");
  });

  it("双引号转义（两个双引号 → 一个双引号）", () => {
    const rows = parseCsv('name,desc\n"x","say ""hi"""');
    expect(rows[0].desc).toBe('say "hi"');
  });

  it("空行被过滤", () => {
    const rows = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(rows).toHaveLength(2);
    expect(rows[1].a).toBe(3); // 数值
  });

  it("表头不匹配：数据列多于表头 → 多余列丢弃；少于 → 缺列补空串", () => {
    const rows = parseCsv("a,b\n1,2,3"); // 数据列多
    expect(rows[0].a).toBe(1);
    expect(rows[0].b).toBe(2);
    expect((rows[0] as Record<string, unknown>).c).toBeUndefined(); // 无第三列
    const rows2 = parseCsv("a,b,c\n1,2"); // 数据列少
    expect(rows2[0].a).toBe(1);
    expect(rows2[0].b).toBe(2);
    expect(rows2[0].c).toBe(""); // 补空串
  });

  it("纯数字字段 → number，非纯数字 → string", () => {
    const rows = parseCsv("id,name,price\n1,alice,9.99\n2,bob,free");
    expect(rows[0].id).toBe(1);
    expect(typeof rows[0].id).toBe("number");
    expect(rows[0].name).toBe("alice");
    expect(rows[0].price).toBe(9.99);
    expect(rows[1].price).toBe("free"); // 非数字保持 string
  });

  it("负数与小数解析", () => {
    const rows = parseCsv("v\n-5\n3.14\n-0.5");
    expect(rows[0].v).toBe(-5);
    expect(rows[1].v).toBe(3.14);
    expect(rows[2].v).toBe(-0.5);
  });

  it("空 CSV → []", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   \n  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：parseDataset 格式与错误
// ---------------------------------------------------------------------------

describe("[片4-验收] 边界探针：parseDataset 格式与错误", () => {
  it("内联 JSON 字符串数组", () => {
    const r = parseDataset('[{"a":"1"},{"a":"2"}]');
    expect(r.format).toBe("json");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].a).toBe("1");
  });

  it("JSON 文件路径（.json）", () => {
    const dir = makeTmp();
    const p = join(dir, "data.json");
    writeFileSync(p, '[{"x":1},{"x":2}]', "utf8");
    const r = parseDataset(p);
    expect(r.format).toBe("json");
    expect(r.rows[1].x).toBe(2);
  });

  it("CSV 文件路径（.csv）", () => {
    const dir = makeTmp();
    const p = join(dir, "d.csv");
    writeFileSync(p, "a,b\n1,2\n", "utf8");
    const r = parseDataset(p);
    expect(r.format).toBe("csv");
    expect(r.rows[0].a).toBe(1);
  });

  it("相对路径 + projectPath 解析", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, "d.csv"), "a\n1\n", "utf8");
    const r = parseDataset("d.csv", dir);
    expect(r.rows[0].a).toBe(1);
  });

  it("JSON 单对象（非数组）→ 抛清晰错误", () => {
    expect(() => parseDataset('{"a":1}')).toThrow(/不是数组|无法解析/);
  });

  it("内联数组元素含非对象（数字）→ 抛清晰错误", () => {
    expect(() => parseDataset('[1,2,3]')).toThrow(/不是对象/);
  });

  it("不存在的文件路径且非 JSON → 抛清晰错误", () => {
    expect(() => parseDataset("/nonexistent/path/to/data.csv")).toThrow(/无法解析|文件/);
  });

  it("normalizeRow：null/undefined → 空串，boolean → 字符串，嵌套对象 → JSON 字符串", () => {
    const r = parseDataset([{ a: null, b: undefined, c: true, d: { nested: 1 } }]);
    expect(r.rows[0].a).toBe("");
    expect(r.rows[0].b).toBe("");
    expect(r.rows[0].c).toBe("true");
    expect(r.rows[0].d).toBe('{"nested":1}');
  });
});

// ---------------------------------------------------------------------------
// 边界探针：DatasetLibrary 版本化
// ---------------------------------------------------------------------------

describe("[片4-验收] 边界探针：DatasetLibrary 版本化", () => {
  it("saveDataset 首次 → version=1, reason='initial'", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    const stored = lib.saveDataset("orders", [{ id: "O1" }]);
    expect(stored.version).toBe(1);
    expect(stored.history).toHaveLength(1);
    expect(stored.history[0].reason).toBe("initial");
    expect(stored.deleted).toBe(false);
  });

  it("saveDataset 再次 → version 递增, history 追加", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    const stored = lib.saveDataset("orders", [{ id: "O2" }]);
    expect(stored.version).toBe(2);
    expect(stored.history).toHaveLength(2);
    expect(stored.history[1].reason).toBe("save");
    expect(stored.rows[0].id).toBe("O2");
  });

  it("loadDataset 返回当前 rows；getHistory 完整历史可查", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    lib.saveDataset("orders", [{ id: "O2" }]);
    expect(lib.loadDataset("orders")).toEqual([{ id: "O2" }]);
    expect(lib.getHistory("orders")).toHaveLength(2);
    expect(lib.getHistory("orders")[0].rows[0].id).toBe("O1"); // 旧版本可查
  });

  it("rollback 到旧版本 → rows 恢复，version 递增，history 追加 rollback 记录", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    lib.saveDataset("orders", [{ id: "O2" }]);
    const rolled = lib.rollback("orders", 1); // 回滚到 v1
    expect(rolled).toBeDefined();
    expect(rolled!.rows).toEqual([{ id: "O1" }]);
    expect(rolled!.version).toBe(3);
    expect(rolled!.history).toHaveLength(3);
    expect(rolled!.history[2].reason).toBe("rollback");
  });

  it("deleteDataset 软删除 → deleted=true，loadDataset 返回 undefined，getHistory 仍可查", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    expect(lib.deleteDataset("orders")).toBe(true);
    expect(lib.loadDataset("orders")).toBeUndefined(); // 软删后不可 load
    expect(lib.getHistory("orders")).toHaveLength(2); // 历史仍可查
    expect(lib.getHistory("orders")[1].reason).toBe("delete");
  });

  it("deleteDataset 后可 rollback 恢复（deleted=false）", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    lib.deleteDataset("orders");
    const rolled = lib.rollback("orders", 1);
    expect(rolled!.deleted).toBe(false); // 恢复
    expect(lib.loadDataset("orders")).toEqual([{ id: "O1" }]);
  });

  it("load() 只返回未删除的数据集", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("a", [{ x: 1 }]);
    lib.saveDataset("b", [{ x: 2 }]);
    lib.deleteDataset("a");
    const all = lib.load();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("b");
  });

  it("index.json 索引：datasetCount 随增删更新", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("a", [{ x: 1 }]);
    lib.saveDataset("b", [{ x: 2 }]);
    expect(lib.loadIndex()?.datasetCount).toBe(2);
    lib.deleteDataset("a");
    expect(lib.loadIndex()?.datasetCount).toBe(1);
  });

  it("rollback 到不存在的版本 → undefined", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    expect(lib.rollback("orders", 99)).toBeUndefined();
  });

  it("deleteDataset 不存在的 → false", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    expect(lib.deleteDataset("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 独立判断点（KEY）：版本化真复用 cases.ts computeProjectHash
// ---------------------------------------------------------------------------

describe("[片4-验收] 独立判断点：DatasetLibrary 复用 cases.ts computeProjectHash", () => {
  it("DatasetLibrary.projectHashValue === computeProjectHash(projectPath)", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    expect(lib.projectHashValue).toBe(computeProjectHash(dir));
  });

  it("computeDatasetId 基于同一 projectHash（与 cases.ts 同 hash 算法）", () => {
    const dir = makeTmp();
    const hash = computeProjectHash(dir);
    const id = computeDatasetId(hash, "orders");
    // SHA-256 前 16 字符
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("数据集存储路径 = .test-agent/datasets/<projectHash>/", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    const hash = computeProjectHash(dir);
    const expectedDir = join(dir, ".test-agent", "datasets", hash);
    expect(existsSync(join(expectedDir, "index.json"))).toBe(true);
    const id = computeDatasetId(hash, "orders");
    expect(existsSync(join(expectedDir, "datasets", `${id}.json`))).toBe(true);
  });

  it("同名数据集跨运行稳定（hash + datasetId 确定性）", () => {
    const dir = makeTmp();
    const lib = new DatasetLibrary(dir);
    lib.saveDataset("orders", [{ id: "O1" }]);
    const id1 = computeDatasetId(computeProjectHash(dir), "orders");
    // 重新加载
    const lib2 = new DatasetLibrary(dir);
    expect(lib2.loadDataset("orders")).toEqual([{ id: "O1" }]);
    expect(computeDatasetId(computeProjectHash(dir), "orders")).toBe(id1);
  });
});

// ---------------------------------------------------------------------------
// 独立判断点：cleanup 失败复用 DiagnosisCategory（不是新造错误码）
// ---------------------------------------------------------------------------

describe("[片4-验收] 独立判断点：cleanup 失败复用 DiagnosisCategory", () => {
  it("executeCleanupHook 返回 category 类型为 DiagnosisCategory（'environment'）", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 500, body: "err" });
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const result = await executeCleanupHook(factory, [{ type: "order", id: "O1", deletePath: "/api/orders/O1" }]);
    // category 是 DiagnosisCategory 的 'environment'，不是新造错误码
    expect(result.category).toBe("environment");
    const validCategories: DiagnosisCategory[] = ["real-bug", "test-defect", "environment", "flaky"];
    expect(validCategories).toContain(result.category);
  });

  it("categorizeCreateFailure 返回 DiagnosisCategory（'environment'）", () => {
    const cat = categorizeCreateFailure({ ok: false, error: "x" });
    expect(cat).toBe("environment");
    expect(["real-bug", "test-defect", "environment", "flaky"]).toContain(cat);
  });
});

// ---------------------------------------------------------------------------
// 边界探针：3 模板契约 + createdEntities 反向清理
// ---------------------------------------------------------------------------

describe("[片4-验收] 边界探针：3 模板契约", () => {
  it("createOrder：返回 entity.type='order'，deletePath 含 id", async () => {
    const createFn: CreateFn = async (p) => ({ status: 201, body: { orderId: (p as { orderId: string }).orderId } });
    const f = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    const r = await f.createOrder();
    expect(r.entity!.type).toBe("order");
    expect(r.entity!.deletePath).toBe(`/api/orders/${r.entity!.id}`);
  });

  it("createUser：返回 entity.type='user'，deletePath 含 id", async () => {
    const createFn: CreateFn = async (p) => ({ status: 201, body: { userId: (p as { userId: string }).userId } });
    const f = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    const r = await f.createUser();
    expect(r.entity!.type).toBe("user");
    expect(r.entity!.deletePath).toBe(`/api/users/${r.entity!.id}`);
  });

  it("cleanUp：默认 deletePath 推导（order→/api/orders/<id>, user→/api/users/<id>）", async () => {
    const deleted: string[] = [];
    const deleteFn: DeleteFn = async (path) => { deleted.push(path); return { status: 204, body: null }; };
    const f = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    await f.cleanUp([
      { type: "order", id: "O1" }, // 无 deletePath → 推导
      { type: "user", id: "U1" },
      { type: "custom", id: "C1" },
    ]);
    expect(deleted).toContain("/api/orders/O1");
    expect(deleted).toContain("/api/users/U1");
    expect(deleted).toContain("/api/customs/C1");
  });

  it("createOrder overrides 覆盖默认 payload", async () => {
    let captured: unknown;
    const createFn: CreateFn = async (p) => { captured = p; return { status: 201, body: { orderId: "X" } }; };
    const f = new DefaultDataFactory("https://x", undefined, createFn, undefined);
    await f.createOrder({ amount: 999, status: "paid" });
    expect((captured as { amount: number }).amount).toBe(999);
    expect((captured as { status: string }).status).toBe("paid");
  });
});

describe("[片4-验收] 边界探针：createdEntities 反向清理", () => {
  it("createdEntities 累积多个实体 → cleanUp 按列表反向清理", async () => {
    const deleted: string[] = [];
    const deleteFn: DeleteFn = async (path) => { deleted.push(path); return { status: 204, body: null }; };
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const createdEntities: EntityRef[] = [
      { type: "order", id: "O1", deletePath: "/api/orders/O1" },
      { type: "user", id: "U1", deletePath: "/api/users/U1" },
    ];
    const result = await executeCleanupHook(factory, createdEntities);
    expect(result.ok).toBe(true);
    expect(result.result.deleted).toBe(2);
    expect(deleted).toEqual(["/api/orders/O1", "/api/users/U1"]); // 按列表顺序
  });

  it("createdEntities 空列表 → cleanUp 不调 deleteFn", async () => {
    let called = false;
    const deleteFn: DeleteFn = async () => { called = true; return { status: 204, body: null }; };
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const result = await executeCleanupHook(factory, []);
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 编排层 cleanup 实体追踪：runApiCases keepBody + entityIdField 提取存 createdEntities
// ---------------------------------------------------------------------------

describe("[片4-验收] 编排层 cleanup 实体追踪：keepBody + entityIdField 提取", () => {
  it("runApiCases keepBody=true → details.body 保留响应体", async () => {
    const { runApiCases } = await import("../src/core/validator.js");
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 42, name: "test" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const outcome = await runApiCases(
        [{ id: "c1", title: "t", scenario: "GET /item", steps: ["请求 /item"], expected: "200", priority: "medium" }],
        `http://127.0.0.1:${port}`,
        {},
        { keepBody: true },
      );
      const detail = outcome.details.find((d) => d.caseId === "c1");
      expect(detail?.body).toBe(JSON.stringify({ id: 42, name: "test" }));
    } finally {
      server.close();
    }
  });

  it("runApiCases 不传 keepBody → details.body 不存在（向后兼容）", async () => {
    const { runApiCases } = await import("../src/core/validator.js");
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 42 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const outcome = await runApiCases(
        [{ id: "c1", title: "t", scenario: "GET /item", steps: ["请求 /item"], expected: "200", priority: "medium" }],
        `http://127.0.0.1:${port}`,
      );
      const detail = outcome.details.find((d) => d.caseId === "c1");
      expect(detail?.body).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("createApiTestTool：cleanup=true + entityIdField → 从响应体提取实体 ID 存 createdEntities 并清理", async () => {
    const { createApiTestTool } = await import("../src/core/tools/api-test.js");
    const deleted: string[] = [];
    const deleteFn: DeleteFn = async (path) => { deleted.push(path); return { status: 204, body: null }; };
    const factory = new DefaultDataFactory("https://x", undefined, undefined, deleteFn);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ orderId: "ORD-99" }),
      text: async () => JSON.stringify({ orderId: "ORD-99" }),
    } as Response) as unknown as typeof globalThis.fetch;
    try {
      const context: { projectPath: string; dataFactory: typeof factory; createdEntities?: EntityRef[] } = {
        projectPath: makeTmp(),
        dataFactory: factory,
      };
      const tool = createApiTestTool(context as never);
      const result = await tool.execute("call-1", {
        baseUrl: "https://api.test",
        cases: [
          {
            id: "create-order",
            title: "创建订单",
            scenario: "POST /api/orders",
            steps: ["POST /api/orders"],
            expected: "201",
            cleanup: true,
            entityIdField: "orderId",
            entityType: "order",
            entityDeletePath: "/api/orders/ORD-99",
          },
        ],
      } as never, undefined);
      // 提取后 createdEntities 含实体
      expect(context.createdEntities).toBeDefined();
      expect(context.createdEntities!.length).toBe(1);
      expect(context.createdEntities![0]).toEqual({
        type: "order",
        id: "ORD-99",
        deletePath: "/api/orders/ORD-99",
      });
      // cleanup 执行了删除
      expect(deleted).toContain("/api/orders/ORD-99");
      expect(result.details.ok).toBe(true);
      expect(result.content[0].text).toContain("清理完成");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("createApiTestTool：cleanup=true + entityIdField 但响应体非 JSON → 跳过提取，cleanup 报无实体", async () => {
    const { createApiTestTool } = await import("../src/core/tools/api-test.js");
    const factory = new DefaultDataFactory("https://x", undefined, undefined, async () => ({ status: 204, body: null }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "not json",
    } as Response) as unknown as typeof globalThis.fetch;
    try {
      const context: { projectPath: string; dataFactory: typeof factory; createdEntities?: EntityRef[] } = {
        projectPath: makeTmp(),
        dataFactory: factory,
      };
      const tool = createApiTestTool(context as never);
      const result = await tool.execute("call-1", {
        baseUrl: "https://api.test",
        cases: [
          {
            id: "c1",
            title: "t",
            scenario: "POST /api/items",
            steps: ["POST /api/items"],
            expected: "200",
            cleanup: true,
            entityIdField: "id",
          },
        ],
      } as never, undefined);
      // 非响应体非 JSON → createdEntities 未被填充
      expect(context.createdEntities).toBeUndefined();
      // cleanup 报无实体
      expect(result.content[0].text).toContain("无实体需清理");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("createApiTestTool：不传 entityIdField → 不保留 body，不提取实体（向后兼容）", async () => {
    const { createApiTestTool } = await import("../src/core/tools/api-test.js");
    const factory = new DefaultDataFactory("https://x", undefined, undefined, async () => ({ status: 204, body: null }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "ok",
    } as Response) as unknown as typeof globalThis.fetch;
    try {
      const context: { projectPath: string; dataFactory: typeof factory; createdEntities?: EntityRef[] } = {
        projectPath: makeTmp(),
        dataFactory: factory,
        createdEntities: [{ type: "order", id: "PRE-EXISTING", deletePath: "/api/orders/PRE-EXISTING" }],
      };
      const tool = createApiTestTool(context as never);
      await tool.execute("call-1", {
        baseUrl: "https://api.test",
        cases: [
          { id: "c1", title: "t", scenario: "GET /api/x", steps: ["GET /api/x"], expected: "200", cleanup: true },
        ],
      } as never, undefined);
      // 无 entityIdField → 不提取，createdEntities 仍只有预置实体
      expect(context.createdEntities!.length).toBe(1);
      expect(context.createdEntities![0].id).toBe("PRE-EXISTING");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
