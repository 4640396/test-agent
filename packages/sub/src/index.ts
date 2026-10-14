// @cxmt/sub — Vendored pi-subagents isolation/evidence/budget infrastructure
// MIT, Copyright (c) 2025 Nico Bailon

export * from "./types.ts";
export * from "./capability-ceiling.ts";
export * from "./task-intent.ts";
export * from "./long-running-guard.ts";
export * from "./completion-guard.ts";
export * from "./tool-budget.ts";
export * from "./turn-budget.ts";
export * from "./mutation-evidence.ts";
export * from "./structured-output.ts";
export * from "./permissions.ts";
export * from "./tool-timeout.ts";
export * from "./context-mode.ts";

// expectsImplementationMutation is exported by both task-intent.ts (origin) and
// completion-guard.ts (re-export). export * makes ambiguous names unavailable, so
// add an explicit re-export from the origin to keep it accessible.
export { expectsImplementationMutation } from "./task-intent.ts";
