CREATE TABLE task_run_events (
  task_id VARCHAR(36) NOT NULL,
  sequence_no BIGINT NOT NULL,
  schema_version INT NOT NULL,
  execution_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  event_time DATETIME(3) NOT NULL,
  event_data LONGTEXT NOT NULL,
  worker_id VARCHAR(36) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  PRIMARY KEY (task_id, sequence_no),
  INDEX idx_run_events_execution (execution_id, sequence_no),
  CONSTRAINT fk_run_events_task FOREIGN KEY (task_id) REFERENCES test_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
