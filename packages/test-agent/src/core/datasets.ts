/**
 * 数据集管理 — PRD 功能四（第 8 节）测试数据管理。
 *
 * 核心能力：
 * 1. parseDataset 纯函数：解析 CSV（首行表头）或 JSON（对象数组），支持文件路径或内联字符串。
 * 2. DatasetLibrary：数据集版本化存储，镜像 cases.ts 的 CaseLibrary 设计
 *    （save/load/getHistory/rollback/version），存 .test-agent/datasets/<projectHash>/。
 * 3. namespaceForShard 纯函数：并行数据命名空间隔离前缀（对接 shard.ts）。
 *
 * 控制面零改动：纯文件系统，不依赖 Java/MySQL/Flyway。
 * 复用 cases.ts 的 computeProjectHash（项目 hash 稳定跨运行）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

/** history 版本上限（LRU 淘汰最旧），可配 TEST_AGENT_MAX_HISTORY 环境变量。 */
const MAX_HISTORY = Number(process.env.TEST_AGENT_MAX_HISTORY ?? "50");
import { isAbsolute, join, resolve } from "node:path";
import { computeProjectHash } from "./cases.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 数据集行（字段 → 值，值统一为 string | number）。 */
export type DatasetRow = Record<string, string | number>;

/** 数据集解析结果。 */
export interface ParsedDataset {
  rows: DatasetRow[];
  format: "csv" | "json";
}

/** 数据集版本记录（每次修改追加一条，旧版本归档不删）。 */
export interface DatasetVersion {
  version: number;
  rows: DatasetRow[];
  createdAt: string;
  /** 版本创建原因：initial | save | edit | delete | rollback。 */
  reason: string;
}

/** 持久化的数据集（含版本历史）。 */
export interface StoredDataset {
  datasetId: string;
  projectHash: string;
  name: string;
  rows: DatasetRow[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  history: DatasetVersion[];
}

/** 数据集库索引。 */
export interface DatasetLibraryIndex {
  projectHash: string;
  lastUpdatedAt: string;
  datasetCount: number;
}

// ---------------------------------------------------------------------------
// parseDataset 纯函数
// ---------------------------------------------------------------------------

/**
 * 解析数据集：接受文件路径或内联 JSON 字符串/数组。
 *
 * - 内联数组（Record 数组）→ 直接返回，format='json'
 * - 字符串以 `[` 开头且可解析为 JSON 数组 → 内联 JSON，format='json'
 * - 字符串为已存在的文件路径 → 按扩展名解析（.csv → CSV，.json → JSON）
 * - 字符串既非 JSON 数组也非文件路径 → 尝试 JSON 解析，失败则抛清晰错误
 *
 * CSV 格式：首行表头，后续行数据，逗号分隔，解析为对象数组。
 * 支持简单引号转义（双引号包裹的字段可含逗号）。
 *
 * @param source 文件路径、内联 JSON 字符串或内联数组
 * @param projectPath 项目根（解析相对路径用，可选）
 * @returns { rows, format }
 */
export function parseDataset(
  source: string | DatasetRow[],
  projectPath?: string,
): ParsedDataset {
  // 内联数组 → JSON
  if (Array.isArray(source)) {
    validateRows(source, "内联数组");
    return { rows: source.map(normalizeRow), format: "json" };
  }

  if (typeof source !== "string") {
    throw new Error(`parseDataset: 不支持的 source 类型 (${typeof source})`);
  }

  const trimmed = source.trim();

  // 内联 JSON 字符串（以 [ 开头）
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`parseDataset: 内联 JSON 解析失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("parseDataset: 内联 JSON 不是数组");
    }
    validateRows(parsed, "内联 JSON");
    return { rows: (parsed as unknown[]).map(normalizeRow), format: "json" };
  }

  // 文件路径
  const filePath = isAbsolute(source) ? source : resolve(projectPath ?? process.cwd(), source);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8");
    if (filePath.toLowerCase().endsWith(".csv")) {
      return { rows: parseCsv(content), format: "csv" };
    }
    // 默认按 JSON 解析（.json 或无扩展名）
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`parseDataset: 文件 ${source} JSON 解析失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`parseDataset: 文件 ${source} 内容不是 JSON 数组`);
    }
    validateRows(parsed, `文件 ${source}`);
    return { rows: (parsed as unknown[]).map(normalizeRow), format: "json" };
  }

  // 既非 JSON 数组也非文件 → 尝试当 JSON 解析兜底
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      validateRows(parsed, "字符串");
      return { rows: (parsed as unknown[]).map(normalizeRow), format: "json" };
    }
  } catch {
    // 解析失败 → 继续抛出明确错误
  }
  throw new Error(`parseDataset: 无法解析数据集 — 既非 JSON 数组，也非存在的文件路径: ${source}`);
}

/** 校验解析后的数组元素是否为对象。 */
function validateRows(arr: unknown[], label: string): void {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`parseDataset: ${label} 第 ${i + 1} 项不是对象（应为 Record<string, string|number>）`);
    }
  }
}

/** 规范化行：确保值为 string | number。 */
function normalizeRow(row: unknown): DatasetRow {
  const obj = row as Record<string, unknown>;
  const result: DatasetRow = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = typeof value === "boolean" ? String(value) : value;
    } else if (value === null || value === undefined) {
      result[key] = "";
    } else {
      // 嵌套对象/数组 → JSON 字符串
      result[key] = JSON.stringify(value);
    }
  }
  return result;
}

/**
 * 解析 CSV 文本为对象数组（首行表头，逗号分隔，支持双引号转义）。
 */
export function parseCsv(text: string): DatasetRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: DatasetRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: DatasetRow = {};
    for (let j = 0; j < headers.length; j++) {
      const raw = values[j] ?? "";
      const num = Number(raw);
      row[headers[j]] = raw !== "" && Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(raw) ? num : raw;
    }
    rows.push(row);
  }
  return rows;
}

/** 解析单行 CSV（支持双引号包裹字段含逗号）。 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ---------------------------------------------------------------------------
// namespaceForShard 纯函数
// ---------------------------------------------------------------------------

/**
 * 并行数据命名空间隔离前缀（对接 shard.ts）。
 *
 * - 有 shardIndex（并行分片）→ `shard<shardIndex>-`（如 `shard0-`、`shard1-`）
 * - 无 shardIndex（串行）→ `serial-`
 *
 * 用于 factory 造数时给唯一标识加前缀，避免并行片唯一约束冲突（PRD 8.5 场景 C）。
 */
export function namespaceForShard(shardIndex: number | undefined): string {
  if (shardIndex === undefined || shardIndex === null || Number.isNaN(shardIndex)) {
    return "serial-";
  }
  return `shard${shardIndex}-`;
}

// ---------------------------------------------------------------------------
// DatasetLibrary
// ---------------------------------------------------------------------------

/** 数据集 ID：SHA-256(projectHash + ":" + name) 前 16 字符，跨运行稳定。 */
export function computeDatasetId(projectHash: string, name: string): string {
  return createHash("sha256").update(`${projectHash}:${name}`).digest("hex").slice(0, 16);
}

/**
 * 数据集库 — 管理单个项目的持久化数据集（镜像 CaseLibrary 设计）。
 *
 * 存储布局：
 *   .test-agent/datasets/<projectHash>/
 *     index.json              # { projectHash, lastUpdatedAt, datasetCount }
 *     datasets/
 *       <datasetId>.json      # StoredDataset（含版本历史）
 *
 * 线程安全：单 Worker 进程内串行调用，无并发写入。
 */
export class DatasetLibrary {
  private readonly dir: string;
  private readonly datasetsDir: string;
  private readonly indexPath: string;

  constructor(
    private readonly projectPath: string,
    private readonly projectHash: string = computeProjectHash(projectPath),
  ) {
    this.dir = join(projectPath, ".test-agent", "datasets", projectHash);
    this.datasetsDir = join(this.dir, "datasets");
    this.indexPath = join(this.dir, "index.json");
  }

  get projectHashValue(): string {
    return this.projectHash;
  }

  // --- 索引 ---

  loadIndex(): DatasetLibraryIndex | undefined {
    if (!existsSync(this.indexPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8")) as DatasetLibraryIndex;
    } catch {
      return undefined;
    }
  }

  private saveIndex(index: DatasetLibraryIndex): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  private refreshIndex(): void {
    const existing = this.loadIndex();
    const active = this.load();
    const now = new Date().toISOString();
    if (existing) {
      existing.datasetCount = active.length;
      existing.lastUpdatedAt = now;
      this.saveIndex(existing);
    } else {
      this.saveIndex({
        projectHash: this.projectHash,
        lastUpdatedAt: now,
        datasetCount: active.length,
      });
    }
  }

  // --- 数据集 CRUD ---

  /** 加载所有未删除的数据集。 */
  load(): StoredDataset[] {
    if (!existsSync(this.datasetsDir)) return [];
    const datasets: StoredDataset[] = [];
    for (const file of readdirSync(this.datasetsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const stored = JSON.parse(readFileSync(join(this.datasetsDir, file), "utf8")) as StoredDataset;
        if (stored && !stored.deleted) datasets.push(stored);
      } catch {
        /* 忽略损坏文件 */
      }
    }
    return datasets;
  }

  /** 加载单个数据集（含已删除）。 */
  getDataset(name: string): StoredDataset | undefined {
    const datasetId = computeDatasetId(this.projectHash, name);
    const filePath = join(this.datasetsDir, `${datasetId}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as StoredDataset;
    } catch {
      return undefined;
    }
  }

  /** 保存数据集（含版本历史）。 */
  saveDataset(name: string, rows: DatasetRow[], reason = "save"): StoredDataset {
    mkdirSync(this.datasetsDir, { recursive: true });
    const datasetId = computeDatasetId(this.projectHash, name);
    const existing = this.getDataset(name);
    const now = new Date().toISOString();

    const newVersion: DatasetVersion = {
      version: existing ? existing.version + 1 : 1,
      rows,
      createdAt: now,
      reason: existing ? reason : "initial",
    };

    const stored: StoredDataset = {
      datasetId,
      projectHash: this.projectHash,
      name,
      rows,
      version: newVersion.version,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deleted: false,
      history: existing ? [...existing.history, newVersion].slice(-MAX_HISTORY) : [newVersion],
    };

    writeFileSync(join(this.datasetsDir, `${datasetId}.json`), JSON.stringify(stored, null, 2), "utf8");
    this.refreshIndex();
    return stored;
  }

  /** 软删除数据集（标记 deleted=true，保留历史可回滚）。 */
  deleteDataset(name: string): boolean {
    const existing = this.getDataset(name);
    if (!existing || existing.deleted) return false;

    const now = new Date().toISOString();
    const deleteVersion: DatasetVersion = {
      version: existing.version + 1,
      rows: existing.rows,
      createdAt: now,
      reason: "delete",
    };

    const stored: StoredDataset = {
      ...existing,
      version: deleteVersion.version,
      updatedAt: now,
      deleted: true,
      history: [...existing.history, deleteVersion].slice(-MAX_HISTORY),
    };

    writeFileSync(join(this.datasetsDir, `${existing.datasetId}.json`), JSON.stringify(stored, null, 2), "utf8");
    this.refreshIndex();
    return true;
  }

  /** 加载数据集的行数据（未删除时）。 */
  loadDataset(name: string): DatasetRow[] | undefined {
    const stored = this.getDataset(name);
    if (!stored || stored.deleted) return undefined;
    return stored.rows;
  }

  /** 获取数据集版本历史。 */
  getHistory(name: string): DatasetVersion[] {
    return this.getDataset(name)?.history ?? [];
  }

  /** 回滚数据集到指定版本（追加一条 rollback 版本，不删历史）。 */
  rollback(name: string, version: number): StoredDataset | undefined {
    const stored = this.getDataset(name);
    if (!stored) return undefined;
    const targetVersion = stored.history.find((v) => v.version === version);
    if (!targetVersion) return undefined;

    const now = new Date().toISOString();
    const rollbackVersion: DatasetVersion = {
      version: stored.version + 1,
      rows: targetVersion.rows,
      createdAt: now,
      reason: "rollback",
    };

    const updated: StoredDataset = {
      ...stored,
      rows: targetVersion.rows,
      version: rollbackVersion.version,
      updatedAt: now,
      deleted: false,
      history: [...stored.history, rollbackVersion].slice(-MAX_HISTORY),
    };

    writeFileSync(join(this.datasetsDir, `${stored.datasetId}.json`), JSON.stringify(updated, null, 2), "utf8");
    this.refreshIndex();
    return updated;
  }
}
