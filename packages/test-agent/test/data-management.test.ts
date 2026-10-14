/**
 * 测试数据管理测试 — PRD 功能四片4。
 *
 * 覆盖：
 * - parseDataset: CSV 解析 / JSON 解析 / 文件路径读取 / 内联字符串 / 格式错误抛清晰错误
 * - DatasetLibrary: save/load/version 递增/getHistory/rollback
 * - factory: createOrder/createUser 造数（mock HTTP）返回唯一标识 / cleanUp 删除 /
 *   造数失败标 environment / cleanUp 失败不静默
 * - namespaceForShard: shard0→'shard0-' / shard1→'shard1-' / 串行无 shardIndex→'serial-'
 * - api-test 参数化: 1 用例绑定 5 组数据 → 执行 5 次 → 5 个结果
 * - PRD 8.5 场景A（参数化 1 用例 5 组数据）
 * - PRD 8.5 场景B（factory 造前置 + 清理）
 * - PRD 8.5 场景C（并行数据隔离：2 片各造各的，前缀不冲突）
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDataset,
  parseCsv,
  namespaceForShard,
  DatasetLibrary,
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

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()!;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmp(): string {
  const root = mkdtempSync(join(tmpdir(), "data-mgmt-"));
  tmpRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// parseDataset
// ---------------------------------------------------------------------------

describe("parseDataset — CSV 解析", () => {
  it("首行表头，后续行数据，解析为对象数组", () => {
    const root = makeTmp();
    writeFileSync(join(root, "data.csv"), "name,age,city\nAlice,30,Beijing\nBob,25,Shanghai", "utf8");
    const result = parseDataset(join(root, "data.csv"));
    expect(result.format).toBe("csv");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ name: "Alice", age: 30, city: "Beijing" });
    expect(result.rows[1]).toEqual({ name: "Bob", age: 25, city: "Shanghai" });
  });

  it("支持双引号包裹字段含逗号", () => {
    const root = makeTmp();
    writeFileSync(join(root, "data.csv"), 'name,desc\nAlice,"hello, world"', "utf8");
    const result = parseDataset(join(root, "data.csv"));
    expect(result.rows[0]).toEqual({ name: "Alice", desc: "hello, world" });
  });

  it("空 CSV → 空数组", () => {
    expect(parseCsv("").length).toBe(0);
  });

  it("纯数字值解析为 number，非纯数字保持 string", () => {
    const rows = parseCsv("id,code\n42,ABC\n");
    expect(rows[0]).toEqual({ id: 42, code: "ABC" });
  });
});

describe("parseDataset — JSON 解析", () => {
  it("内联 JSON 字符串解析为对象数组", () => {
    const json = '[{"x":1,"y":"a"},{"x":2,"y":"b"}]';
    const result = parseDataset(json);
    expect(result.format).toBe("json");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ x: 1, y: "a" });
  });

  it("内联数组直接传入", () => {
    const rows: DatasetRow[] = [{ a: 1 }, { a: 2 }];
    const result = parseDataset(rows);
    expect(result.format).toBe("json");
    expect(result.rows).toEqual(rows);
  });
});

describe("parseDataset — 文件路径读取", () => {
  it("读取 CSV 文件", () => {
    const root = makeTmp();
    writeFileSync(join(root, "data.csv"), "name,age\nAlice,30\n", "utf8");
    const result = parseDataset(join(root, "data.csv"));
    expect(result.format).toBe("csv");
    expect(result.rows[0]).toEqual({ name: "Alice", age: 30 });
  });

  it("读取 JSON 文件", () => {
    const root = makeTmp();
    writeFileSync(join(root, "data.json"), '[{"k":"v"}]', "utf8");
    const result = parseDataset(join(root, "data.json"));
    expect(result.format).toBe("json");
    expect(result.rows[0]).toEqual({ k: "v" });
  });

  it("相对路径基于 projectPath 解析", () => {
    const root = makeTmp();
    writeFileSync(join(root, "data.csv"), "a,b\n1,2\n", "utf8");
    const result = parseDataset("data.csv", root);
    expect(result.rows[0]).toEqual({ a: 1, b: 2 });
  });
});

describe("parseDataset — 格式错误", () => {
  it("内联 JSON 不是数组 → 抛清晰错误", () => {
    expect(() => parseDataset('{"a":1}')).toThrow(/不是数组|无法解析/);
  });

  it("数组元素不是对象 → 抛清晰错误", () => {
    expect(() => parseDataset("[1, 2, 3]")).toThrow(/不是对象/);
  });

  it("既非 JSON 也非文件 → 抛清晰错误", () => {
    expect(() => parseDataset("not-a-path-not-json")).toThrow(/无法解析|不是数组/);
  });

  it("JSON 文件内容不是数组 → 抛清晰错误", () => {
    const root = makeTmp();
    writeFileSync(join(root, "bad.json"), '{"a":1}', "utf8");
    expect(() => parseDataset(join(root, "bad.json"))).toThrow(/不是 JSON 数组/);
  });
});

// ---------------------------------------------------------------------------
// namespaceForShard
// ---------------------------------------------------------------------------

describe("namespaceForShard", () => {
  it("shard0 → 'shard0-'", () => {
    expect(namespaceForShard(0)).toBe("shard0-");
  });
  it("shard1 → 'shard1-'", () => {
    expect(namespaceForShard(1)).toBe("shard1-");
  });
  it("串行无 shardIndex → 'serial-'", () => {
    expect(namespaceForShard(undefined)).toBe("serial-");
  });
  it("null → 'serial-'", () => {
    expect(namespaceForShard(null as unknown as undefined)).toBe("serial-");
  });
  it("NaN → 'serial-'", () => {
    expect(namespaceForShard(Number.NaN)).toBe("serial-");
  });
});

// ---------------------------------------------------------------------------
// DatasetLibrary
// ---------------------------------------------------------------------------

describe("DatasetLibrary — 版本化", () => {
  it("saveDataset → loadDataset 返回数据", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    const rows: DatasetRow[] = [{ a: 1 }, { a: 2 }];
    const stored = lib.saveDataset("orders", rows);
    expect(stored.version).toBe(1);
    expect(stored.name).toBe("orders");
    expect(lib.loadDataset("orders")).toEqual(rows);
  });

  it("重复 save → version 递增", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    lib.saveDataset("ds", [{ x: 1 }]);
    const v2 = lib.saveDataset("ds", [{ x: 2 }]);
    const v3 = lib.saveDataset("ds", [{ x: 3 }]);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(lib.loadDataset("ds")).toEqual([{ x: 3 }]);
  });

  it("getHistory 返回完整版本历史", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    lib.saveDataset("ds", [{ x: 1 }]);
    lib.saveDataset("ds", [{ x: 2 }]);
    const history = lib.getHistory("ds");
    expect(history).toHaveLength(2);
    expect(history[0].version).toBe(1);
    expect(history[0].reason).toBe("initial");
    expect(history[1].version).toBe(2);
    expect(history[1].reason).toBe("save");
  });

  it("rollback 回滚到指定版本", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    lib.saveDataset("ds", [{ x: 1 }]);
    lib.saveDataset("ds", [{ x: 2 }]);
    const rolled = lib.rollback("ds", 1);
    expect(rolled).toBeDefined();
    expect(rolled!.version).toBe(3);
    expect(rolled!.rows).toEqual([{ x: 1 }]);
    expect(lib.loadDataset("ds")).toEqual([{ x: 1 }]);
    // 历史含 rollback 记录
    const history = lib.getHistory("ds");
    expect(history[2].reason).toBe("rollback");
  });

  it("deleteDataset 软删除，loadDataset 返回 undefined", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    lib.saveDataset("ds", [{ x: 1 }]);
    expect(lib.deleteDataset("ds")).toBe(true);
    expect(lib.loadDataset("ds")).toBeUndefined();
  });

  it("rollback 不存在的版本 → undefined", () => {
    const root = makeTmp();
    const lib = new DatasetLibrary(root);
    lib.saveDataset("ds", [{ x: 1 }]);
    expect(lib.rollback("ds", 99)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DataFactory
// ---------------------------------------------------------------------------

describe("DataFactory — createOrder/createUser（mock HTTP）", () => {
  it("createOrder 返回唯一标识，含命名空间前缀", async () => {
    const createFn: CreateFn = async (payload) => ({ status: 201, body: { orderId: (payload as { orderId: string }).orderId } });
    const factory = new DefaultDataFactory("http://api", 0, createFn);
    const result = await factory.createOrder();
    expect(result.ok).toBe(true);
    expect(result.entity!.id).toMatch(/^shard0-ORD-/);
    expect(result.entity!.type).toBe("order");
  });

  it("createUser 返回唯一标识，含命名空间前缀", async () => {
    const createFn: CreateFn = async (payload) => ({ status: 201, body: { userId: (payload as { userId: string }).userId } });
    const factory = new DefaultDataFactory("http://api", 1, createFn);
    const result = await factory.createUser();
    expect(result.ok).toBe(true);
    expect(result.entity!.id).toMatch(/^shard1-USR-/);
  });

  it("串行（无 shardIndex）→ 前缀 serial-", async () => {
    const createFn: CreateFn = async (payload) => ({ status: 201, body: { orderId: (payload as { orderId: string }).orderId } });
    const factory = new DefaultDataFactory("http://api", undefined, createFn);
    const result = await factory.createOrder();
    expect(result.entity!.id).toMatch(/^serial-ORD-/);
  });

  it("造数失败（HTTP 500）→ ok=false，categorizeCreateFailure 标 environment", async () => {
    const createFn: CreateFn = async () => ({ status: 500, body: { error: "server" } });
    const factory = new DefaultDataFactory("http://api", 0, createFn);
    const result = await factory.createOrder();
    expect(result.ok).toBe(false);
    expect(categorizeCreateFailure(result)).toBe("environment");
  });

  it("造数异常（createFn 抛错）→ ok=false，标 environment", async () => {
    const createFn: CreateFn = async () => { throw new Error("connection refused"); };
    const factory = new DefaultDataFactory("http://api", 0, createFn);
    const result = await factory.createOrder();
    expect(result.ok).toBe(false);
    expect(categorizeCreateFailure(result)).toBe("environment");
  });
});

describe("DataFactory — cleanUp", () => {
  it("cleanUp 成功删除所有实体", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("http://api", 0, undefined, deleteFn);
    const entities: EntityRef[] = [
      { type: "order", id: "shard0-ORD-1" },
      { type: "user", id: "shard0-USR-1" },
    ];
    const result = await factory.cleanUp(entities);
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.failures).toHaveLength(0);
  });

  it("cleanUp 部分失败 → failures 不静默", async () => {
    const deleteFn: DeleteFn = async (path) => ({
      status: path.includes("ORD-1") ? 500 : 204,
      body: null,
    });
    const factory = new DefaultDataFactory("http://api", 0, undefined, deleteFn);
    const entities: EntityRef[] = [
      { type: "order", id: "shard0-ORD-1" },
      { type: "user", id: "shard0-USR-1" },
    ];
    const result = await factory.cleanUp(entities);
    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("shard0-ORD-1");
  });

  it("cleanUp 异常 → 记录失败原因", async () => {
    const deleteFn: DeleteFn = async () => { throw new Error("network down"); };
    const factory = new DefaultDataFactory("http://api", 0, undefined, deleteFn);
    const result = await factory.cleanUp([{ type: "order", id: "x" }]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].error).toBe("network down");
  });
});

describe("executeCleanupHook — 失败告警不静默", () => {
  it("无 factory + 有实体 → 告警但不失败", async () => {
    const result = await executeCleanupHook(undefined, [{ type: "order", id: "x" }]);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("未提供 DataFactory");
  });

  it("清理失败 → category='environment'，不误判代码 bug", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 500, body: null });
    const factory = new DefaultDataFactory("http://api", 0, undefined, deleteFn);
    const result = await executeCleanupHook(factory, [{ type: "order", id: "x" }]);
    expect(result.ok).toBe(false);
    expect(result.category).toBe("environment");
    expect(result.warning).toContain("清理失败");
  });

  it("清理成功 → 无 category", async () => {
    const deleteFn: DeleteFn = async () => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("http://api", 0, undefined, deleteFn);
    const result = await executeCleanupHook(factory, [{ type: "order", id: "x" }]);
    expect(result.ok).toBe(true);
    expect(result.category).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// api-test 参数化 — PRD 8.5 场景A
// ---------------------------------------------------------------------------

describe("expandApiCases — 参数化（场景A: 1 用例 5 组数据 → 5 次执行 → 5 个结果）", () => {
  it("无 dataset → 1 用例保留原样", () => {
    const expanded = expandApiCases([
      { id: "login", title: "登录", scenario: "POST /api/login", steps: ["请求 /api/login"], expected: "200" },
    ]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].case.id).toBe("login");
    expect(expanded[0].rowIndex).toBeUndefined();
  });

  it("1 用例绑定 5 组数据 → 展开为 5 个用例，ID 加后缀 #0..#4", () => {
    const dataset = [
      { user: "alice", pass: "123" },
      { user: "bob", pass: "456" },
      { user: "carol", pass: "789" },
      { user: "dave", pass: "000" },
      { user: "eve", pass: "111" },
    ];
    const expanded = expandApiCases([
      {
        id: "login",
        title: "登录 ${user}",
        scenario: "POST /api/login as ${user}",
        steps: ["请求 /api/login"],
        expected: "200",
        dataset,
      },
    ]);
    expect(expanded).toHaveLength(5);
    expect(expanded.map((e) => e.case.id)).toEqual(["login#0", "login#1", "login#2", "login#3", "login#4"]);
    expect(expanded[0].case.title).toBe("登录 alice");
    expect(expanded[0].case.scenario).toBe("POST /api/login as alice");
    expect(expanded[4].case.title).toBe("登录 eve");
    expect(expanded[0].rowIndex).toBe(0);
  });

  it("占位符替换 steps 和 expected", () => {
    const expanded = expandApiCases([
      {
        id: "get",
        title: "查询 ${id}",
        scenario: "GET /api/items/${id}",
        steps: ["请求 /api/items/${id}"],
        expected: "200 for ${id}",
        dataset: [{ id: "A1" }, { id: "B2" }],
      },
    ]);
    expect(expanded).toHaveLength(2);
    expect(expanded[0].case.scenario).toBe("GET /api/items/A1");
    expect(expanded[0].case.steps[0]).toBe("请求 /api/items/A1");
    expect(expanded[0].case.expected).toBe("200 for A1");
    expect(expanded[1].case.scenario).toBe("GET /api/items/B2");
  });

  it("dataset 为空数组 → 保留 1 用例", () => {
    const expanded = expandApiCases([
      { id: "x", title: "t", scenario: "GET /a", steps: ["s"], expected: "200", dataset: "[]" },
    ]);
    expect(expanded).toHaveLength(1);
  });

  it("cleanup 标记透传", () => {
    const expanded = expandApiCases([
      { id: "x", title: "t", scenario: "POST /a", steps: ["s"], expected: "200", cleanup: true },
    ]);
    expect(expanded[0].cleanup).toBe(true);
  });

  it("向后兼容：不传 dataset/cleanup 行为同今", () => {
    const expanded = expandApiCases([
      { id: "x", title: "t", scenario: "GET /a", steps: ["s"], expected: "200" },
    ]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].cleanup).toBe(false);
    expect(expanded[0].rowIndex).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PRD 8.5 场景B — factory 造前置 + 清理
// ---------------------------------------------------------------------------

describe("PRD 8.5 场景B: factory 造前置 + 清理", () => {
  it("createOrder → 得到订单号 → cleanUp 删除该订单", async () => {
    const created: EntityRef[] = [];
    const createFn: CreateFn = async (payload) => {
      const orderId = (payload as { orderId: string }).orderId;
      created.push({ type: "order", id: orderId, deletePath: `/api/orders/${orderId}` });
      return { status: 201, body: { orderId } };
    };
    const deleteFn: DeleteFn = async (path) => ({ status: 204, body: null });
    const factory = new DefaultDataFactory("http://api", undefined, createFn, deleteFn);

    const createResult = await factory.createOrder();
    expect(createResult.ok).toBe(true);

    const cleanupResult = await executeCleanupHook(factory, created);
    expect(cleanupResult.ok).toBe(true);
    expect(cleanupResult.result.deleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PRD 8.5 场景C — 并行数据隔离：2 片各造各的，前缀不冲突
// ---------------------------------------------------------------------------

describe("PRD 8.5 场景C: 并行数据命名空间隔离", () => {
  it("2 片各造订单，前缀 shard0-/shard1- 不冲突", async () => {
    const ids = new Set<string>();
    const makeFactory = (shard: number) => {
      const createFn: CreateFn = async (payload) => {
        const orderId = (payload as { orderId: string }).orderId;
        ids.add(orderId);
        return { status: 201, body: { orderId } };
      };
      return new DefaultDataFactory("http://api", shard, createFn);
    };

    const r0 = await makeFactory(0).createOrder();
    const r1 = await makeFactory(1).createOrder();

    expect(r0.entity!.id).toMatch(/^shard0-ORD-/);
    expect(r1.entity!.id).toMatch(/^shard1-ORD-/);
    expect(r0.entity!.id).not.toBe(r1.entity!.id);
    // 命名空间前缀不同 → 唯一标识不会冲突
    expect(ids.size).toBe(2);
  });

  it("namespaceForShard 产出不同前缀，标识不碰撞", () => {
    const prefix0 = namespaceForShard(0);
    const prefix1 = namespaceForShard(1);
    expect(prefix0).toBe("shard0-");
    expect(prefix1).toBe("shard1-");
    expect(prefix0).not.toBe(prefix1);
  });
});
