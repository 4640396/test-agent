# CIMDEV Test Agent Java控制服务

## 职责

- MySQL持久化项目、任务、日志、Worker、调度和产物元数据；
- 基于任务状态和Worker租约提供可靠领取与超时重排；
- REST API、SSE日志、取消、重试和版本发布Webhook；
- 报告、截图、Trace和原始日志保存到本地存储目录；
- 不直接访问源码，也不直接运行CimiCode、Codex或测试命令。

## 必要配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TEST_AGENT_MYSQL_URL` | 本机MySQL `cimdev_test_agent` | JDBC地址 |
| `TEST_AGENT_MYSQL_USER` | `root` | 建议生产单独账号 |
| `TEST_AGENT_MYSQL_PASSWORD` | 空 | 必须通过部署环境提供 |
| `TEST_AGENT_STORAGE_ROOT` | `./data` | 报告和截图本地目录 |
| `TEST_AGENT_SERVER_HOST` | `127.0.0.1` | 服务监听地址 |
| `TEST_AGENT_SERVER_PORT` | `8088` | 服务端口 |
| `TEST_AGENT_TASK_LEASE_SECONDS` | `60` | Worker任务租约 |
| `TEST_AGENT_API_TOKEN` | 空 | 非回环部署必须配置，并同步给Electron和Worker |

生产环境对外监听前必须补充公司SSO、TLS、网关鉴权和目录配额。当前版本默认仅监听回环地址。

## 验证

```powershell
mvn test
mvn package
```

集成测试使用H2的MySQL兼容模式，仅验证SQL迁移和业务契约；正式环境上线前仍需在目标MySQL版本执行Flyway迁移与接口回归。
