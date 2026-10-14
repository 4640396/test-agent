// 类型抽取自 pi-subagents src/shared/types.ts（MIT, Copyright (c) 2025 Nico Bailon）
// 仅抽取 @cxmt/sub 所需类型，不整拷 2533 行大文件。

// --- Acceptance roles ---

export type AcceptanceRole = "read-only" | "writer";

// --- Schema ---

export type JsonSchemaObject = Record<string, unknown>;

// --- Tool budget ---

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface ResolvedToolBudget {
	soft?: number;
	hard: number;
	block: string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
	outcome: ToolBudgetOutcome;
	toolCount: number;
	softReachedAt?: number;
	hardReachedAt?: number;
	blockedTool?: string;
}

// --- Turn budget ---

export interface ResolvedTurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export type TurnBudgetOutcome =
	| "within-budget"
	| "wrap-up-requested"
	| "termination-deferred"
	| "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
	outcome: TurnBudgetOutcome;
	turnCount: number;
	wrapUpRequestedAtTurn?: number;
	terminationDeferredAtTurn?: number;
	exceededAtTurn?: number;
}

// --- Control config ---

export type ControlEventType = "active_long_running" | "needs_attention";

export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	needsAttentionAfterMsIsExplicit?: boolean;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

// --- Mutation evidence ---

export type TrackedMutationFingerprint = { kind: "diff"; digest: string };

export interface TrackedMutationSnapshot {
	source: "tracked-files";
	trackedOnly: true;
	cwd: string;
	gitRoot?: string;
	dirtyFiles: string[];
	fingerprints: Record<string, TrackedMutationFingerprint>;
	truncated?: boolean;
	unavailable?: string;
}

export interface TrackedMutationEvidence {
	source: "tracked-files";
	trackedOnly: true;
	changedFiles: string[];
	attemptedMutation: boolean;
	truncated?: boolean;
	unavailable?: string;
}

// --- Artifacts & recovery ---

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export interface TimeoutRecoverySummary {
	termination: "timed-out" | "stopped";
	changedFiles: string[];
	truncated?: boolean;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: ArtifactPaths;
	warning: string;
	message: string;
}

// DiagnosisCategory 已提 @cxmt/protocol 单一来源（refactor febf409），sub 不再定义。避免上游重新 vendor 时同步回潮。
