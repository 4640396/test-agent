/**
 * host-cli — desktop app 的本地执行入口。
 *
 * 被 desktop main process 作为子进程 spawn（out/main/host-cli.js），
 * 通过 stdio JSON lines 协议与 desktop app 通信。
 *
 * 实际逻辑在 @cxmt/test-agent 的 host-mode 中。
 */

import { runHostCli } from "@cxmt/test-agent";

runHostCli();
