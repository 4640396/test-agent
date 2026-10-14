import { AssistantMessageEventStream } from "@cxmt/ai";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	StopReason,
	Context,
	SimpleStreamOptions,
} from "@cxmt/ai";

/** Minimal model used for testing. */
export const TEST_MODEL: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test-provider",
	baseUrl: "https://test.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

export const REASONING_MODEL: Model<"anthropic-messages"> = {
	...TEST_MODEL,
	id: "reasoning-model",
	reasoning: true,
};

/** Empty usage object for assistant messages. */
export function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Create an assistant message with given content and stop reason. */
export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
	extra?: Partial<AssistantMessage>,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "test-provider",
		model: "test-model",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
		...extra,
	};
}

/** Create a tool call content block. */
export function createToolCall(id: string, name: string, args: Record<string, any> = {}) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

/** Create a text content block. */
export function createText(text: string) {
	return { type: "text" as const, text };
}

export type MockStreamFnHandler = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessage;

/**
 * Create a mock stream function that returns the given responses in order.
 * The last response is repeated if there are more calls than responses.
 */
export function mockStreamFn(responses: AssistantMessage[]): import("@cxmt/agent-core").StreamFn {
	let callIndex = 0;
	return (model, context, options) => {
		const response = responses[Math.min(callIndex++, responses.length - 1)];
		return createMockStream(response);
	};
}

/** Create a mock stream function with a custom handler. */
export function mockStreamFnHandler(handler: MockStreamFnHandler): import("@cxmt/agent-core").StreamFn {
	return (model, context, options) => {
		const response = handler(model, context, options);
		return createMockStream(response);
	};
}

/** Create an AssistantMessageEventStream that emits events for the given message. */
export function createMockStream(response: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	queueMicrotask(() => {
		stream.push({ type: "start", partial: response });

		let contentIndex = 0;
		for (const content of response.content) {
			if (content.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial: response });
				stream.push({ type: "text_delta", contentIndex, delta: content.text, partial: response });
				stream.push({ type: "text_end", contentIndex, content: content.text, partial: response });
			} else if (content.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial: response });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: content, partial: response });
			}
			contentIndex++;
		}

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			stream.push({ type: "error", reason: response.stopReason, error: response });
		} else {
			const reason = response.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			stream.push({ type: "done", reason, message: response });
		}
	});

	return stream;
}

/** Collect all events from an EventStream/async iterable into an array. */
export async function collectEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** Create a simple user message. */
export function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

/** Create a simple tool result message. */
export function createToolResultMessage(toolCallId: string, toolName: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}
