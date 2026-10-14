import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrc = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrc = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentCoreSrc = fileURLToPath(new URL("../agent-core/src/index.ts", import.meta.url));
const agentCoreNodeSrc = fileURLToPath(new URL("../agent-core/src/node.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@cxmt\/telemetry$/, replacement: telemetrySrc },
			{ find: /^@cxmt\/ai$/, replacement: aiSrc },
			{ find: /^@cxmt\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@cxmt\/agent-core$/, replacement: agentCoreSrc },
			{ find: /^@cxmt\/agent-core\/node$/, replacement: agentCoreNodeSrc },
		],
	},
});
