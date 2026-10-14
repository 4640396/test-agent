# Protocol

传输协议包，定义 gui ↔ test-agent ↔ worker-mode 之间的通信消息和运行契约。

自包含设计（对齐 pi 的 `packages/protocol/`）：协议包定义自己的领域模型
（`TaskInput`/`AiConfig`/`LocalHostAgentEvent`/`ClientMessage`/`HostMessage`），
不依赖 `@cxmt/test-agent` 产品包，被 gui 和 test-agent 双向引用。

Java 控制服务的 HTTP 契约后续以 OpenAPI 为权威来源，并由生成代码替代手工重复类型。
