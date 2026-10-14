import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@cxmt\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@cxmt\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@cxmt\/ai$/, replacement: aiSrcIndex },
			{ find: /^@cxmt\/ai\/compat$/, replacement: aiSrcCompat },
		],
	},
});
