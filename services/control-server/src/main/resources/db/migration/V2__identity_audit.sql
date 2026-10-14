ALTER TABLE workers ADD COLUMN secret_hash VARCHAR(255) NULL;

ALTER TABLE test_tasks ADD COLUMN idempotency_key VARCHAR(128) NULL;
ALTER TABLE test_tasks ADD CONSTRAINT uk_tasks_idempotency UNIQUE (idempotency_key);

CREATE TABLE audit_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  task_id VARCHAR(36) NULL,
  payload TEXT NULL,
  source_ip VARCHAR(64) NULL,
  created_at TIMESTAMP(3) NOT NULL,
  INDEX idx_audit_task (task_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
