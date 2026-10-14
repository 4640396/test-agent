CREATE TABLE projects (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  project_path VARCHAR(700) NOT NULL,
  default_version VARCHAR(255) NOT NULL DEFAULT '',
  default_test_types VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_projects_path (project_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE test_tasks (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NULL,
  input_json LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  trigger_type VARCHAR(128) NOT NULL,
  worker_id VARCHAR(36) NULL,
  lease_until TIMESTAMP(3) NULL,
  report_json LONGTEXT NULL,
  artifacts_json LONGTEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_tasks_status_created (status, created_at),
  CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE task_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(36) NOT NULL,
  level VARCHAR(16) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_logs_task_id (task_id, id),
  CONSTRAINT fk_logs_task FOREIGN KEY (task_id) REFERENCES test_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE workers (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  capabilities_json LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  last_heartbeat_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE schedules (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  interval_minutes INT NOT NULL,
  enabled BOOLEAN NOT NULL,
  next_run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_schedule_due (enabled, next_run_at),
  CONSTRAINT fk_schedules_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE task_artifacts (
  id VARCHAR(36) PRIMARY KEY,
  task_id VARCHAR(36) NOT NULL,
  original_name VARCHAR(512) NOT NULL,
  storage_path VARCHAR(2048) NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_artifacts_task (task_id),
  CONSTRAINT fk_artifacts_task FOREIGN KEY (task_id) REFERENCES test_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
