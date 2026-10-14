# 备份与恢复

## 备份内容

1. **MySQL 数据**：`cimdev_test_agent` 库（项目、任务、日志、Worker、调度、审计）。
2. **制品目录**：`TEST_AGENT_STORAGE_ROOT`（任务报告、日志、截图、覆盖率）。

## 备份（在部署机上执行）

```bash
# 数据库
docker compose exec -T mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines cimdev_test_agent > backup/cimdev_test_agent_$(date +%Y%m%d).sql

# 制品（挂载卷）
tar -czf backup/artifacts_$(date +%Y%m%d).tar.gz -C <storage-root> .
```

## 恢复

```bash
# 数据库（先停控制服务，避免写入竞争）
docker compose stop control-server
docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "DROP DATABASE IF EXISTS cimdev_test_agent; CREATE DATABASE cimdev_test_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  cimdev_test_agent < backup/cimdev_test_agent_YYYYMMDD.sql

# 制品
tar -xzf backup/artifacts_YYYYMMDD.tar.gz -C <storage-root>
docker compose start control-server
```

> 注意：Flyway 会校验迁移版本，恢复旧库时请保持 jar 版本与迁移一致，必要时先执行 `flyway repair`。

## 验证

- 恢复后调用 `GET /actuator/health` 确认 UP；
- 抽查最近任务与审计记录可查询。
