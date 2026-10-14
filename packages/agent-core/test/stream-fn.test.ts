import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setDefaultStreamFn } from "@cxmt/agent-core";
import { getDefaultStreamFn } from "../src/stream-fn.ts";
import type { StreamFn } from "@cxmt/agent-core";

describe("stream-fn", () => {
	// Reset state after each test
	afterEach(() => {
		setDefaultStreamFn(undefined);
	});

	it("0c525acd898518f6 | setDefaultStreamFn then getDefaultStreamFn returns the function", () => {
		const mockFn = (() => ({})) as unknown as StreamFn;
		setDefaultStreamFn(mockFn);
		expect(getDefaultStreamFn()).toBe(mockFn);
	});

	it("cc2ac13b61817061 | passing undefined clears the previously set default stream function", () => {
		const mockFn = (() => ({})) as unknown as StreamFn;
		setDefaultStreamFn(mockFn);
		setDefaultStreamFn(undefined);
		expect(() => getDefaultStreamFn()).toThrow();
	});

	it("d7ed205d8278a993 | getDefaultStreamFn throws descriptive error when no default is set", () => {
		expect(() => getDefaultStreamFn()).toThrow("No default stream function configured");
	});
});
