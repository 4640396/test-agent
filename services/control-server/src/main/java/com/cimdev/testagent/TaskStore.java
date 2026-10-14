package com.cimdev.testagent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Optional;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

import static com.cimdev.testagent.ApiModels.*;

@Repository
class TaskStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ObjectMapper json;

    TaskStore(JdbcTemplate jdbc, TransactionTemplate transactions, ObjectMapper json) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.json = json;
    }

    Optional<TaskView> insertTask(String id, String projectId, TaskInput input, String triggerType, String idempotencyKey) {
        var now = Timestamp.from(Instant.now());
        try {
            jdbc.update("INSERT INTO test_tasks(id,project_id,input_json,status,trigger_type,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    id, projectId, write(input), "QUEUED", triggerType, idempotencyKey, now, now);
            return Optional.empty();
        } catch (DataIntegrityViolationException duplicate) {
            if (idempotencyKey != null) {
                var rows = jdbc.query("SELECT id FROM test_tasks WHERE idempotency_key=?", (rs, row) -> rs.getString(1), idempotencyKey);
                if (!rows.isEmpty()) return Optional.of(task(rows.get(0)).orElseThrow());
            }
            throw duplicate;
        }
    }

    Optional<TaskView> task(String id) {
        var rows = jdbc.query("SELECT * FROM test_tasks WHERE id=?", (rs, row) -> mapTask(rs), id);
        if (rows.isEmpty()) return Optional.empty();
        var task = rows.get(0);
        return Optional.of(new TaskView(task.id(), task.projectId(), task.input(), task.status(), task.triggerType(), task.workerId(),
                task.report(), task.artifacts(), task.errorMessage(), task.createdAt(), task.updatedAt(), logs(id), task.stage()));
    }

    List<TaskView> tasks(int limit) {
        return jdbc.query("SELECT * FROM test_tasks ORDER BY created_at DESC LIMIT ?", (rs, row) -> mapTask(rs), limit);
    }

    List<TaskLog> logs(String taskId) {
        return jdbc.query("SELECT * FROM task_logs WHERE task_id=? ORDER BY id", (rs, row) ->
                new TaskLog(rs.getLong("id"), rs.getString("level"), rs.getString("message"), rs.getTimestamp("created_at").toInstant()), taskId);
    }

    TaskLog appendLog(String taskId, String level, String message) {
        var now = Timestamp.from(Instant.now());
        var key = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement(
                    "INSERT INTO task_logs(task_id,level,message,created_at) VALUES(?,?,?,?)",
                    new String[]{"id"});
            statement.setString(1, taskId);
            statement.setString(2, level);
            statement.setString(3, message);
            statement.setTimestamp(4, now);
            return statement;
        }, key);
        var id = key.getKey();
        if (id == null) throw new IllegalStateException("Database did not return a generated task log id");
        return new TaskLog(id.longValue(), level, message, now.toInstant());
    }

    boolean appendRunEvent(String taskId, String workerId, RunEventRequest event) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            jdbc.queryForObject("SELECT id FROM test_tasks WHERE id=? FOR UPDATE", String.class, taskId);
            var existing = jdbc.query("SELECT schema_version,execution_id,event_type,event_data,worker_id FROM task_run_events WHERE task_id=? AND sequence_no=?",
                    (rs, row) -> List.of(rs.getInt(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)), taskId, event.sequence());
            if (!existing.isEmpty()) {
                var row = existing.get(0);
                var same = row.get(0).equals(event.schemaVersion()) && row.get(1).equals(event.executionId())
                        && row.get(2).equals(event.type()) && row.get(3).equals(event.data().toString()) && row.get(4).equals(workerId);
                if (same) return false;
                throw new IllegalStateException("运行事件序号冲突：" + event.sequence());
            }
            var maximum = jdbc.queryForObject("SELECT COALESCE(MAX(sequence_no),0) FROM task_run_events WHERE task_id=?", Long.class, taskId);
            var expected = (maximum == null ? 0 : maximum) + 1;
            if (event.sequence() != expected) throw new IllegalArgumentException("运行事件必须连续，期望序号：" + expected);
            jdbc.update("INSERT INTO task_run_events(task_id,sequence_no,schema_version,execution_id,event_type,event_time,event_data,worker_id,received_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    taskId, event.sequence(), event.schemaVersion(), event.executionId(), event.type(), Timestamp.from(event.timestamp()),
                    event.data().toString(), workerId, Timestamp.from(Instant.now()));
            return true;
        }));
    }

    List<RunEventView> runEvents(String taskId) {
        return jdbc.query("SELECT * FROM task_run_events WHERE task_id=? ORDER BY sequence_no", (rs, row) ->
                new RunEventView(rs.getInt("schema_version"), rs.getString("execution_id"), rs.getLong("sequence_no"),
                        rs.getTimestamp("event_time").toInstant(), rs.getString("event_type"), tree(rs.getString("event_data")),
                        rs.getString("worker_id"), rs.getTimestamp("received_at").toInstant()), taskId);
    }

    void updateStage(String taskId, String stage) {
        jdbc.update("UPDATE test_tasks SET stage=?,updated_at=? WHERE id=?", stage, Timestamp.from(Instant.now()), taskId);
    }

    Optional<ClaimedTask> claim(String workerId, List<String> capabilities, int leaseSeconds) {
        return transactions.execute(status -> {
            for (var id : jdbc.query("SELECT id FROM test_tasks WHERE status='QUEUED' ORDER BY created_at LIMIT 10", (rs, row) -> rs.getString(1))) {
                var queued = task(id).orElseThrow();
                var required = queued.input().requiredCapabilities() == null ? List.<String>of() : queued.input().requiredCapabilities();
                if (!capabilities.containsAll(required)) continue;
                var updated = jdbc.update("UPDATE test_tasks SET status='RUNNING',worker_id=?,lease_until=?,error_message=NULL,updated_at=? WHERE id=? AND status='QUEUED'",
                        workerId, Timestamp.from(Instant.now().plusSeconds(leaseSeconds)), Timestamp.from(Instant.now()), id);
                if (updated == 1) {
                    return Optional.of(new ClaimedTask(id, queued.input()));
                }
            }
            return Optional.<ClaimedTask>empty();
        });
    }

    void heartbeatTask(String taskId, String workerId, int leaseSeconds) {
        jdbc.update("UPDATE test_tasks SET lease_until=?,updated_at=? WHERE id=? AND worker_id=? AND status='RUNNING'",
                Timestamp.from(Instant.now().plusSeconds(leaseSeconds)), Timestamp.from(Instant.now()), taskId, workerId);
    }

    boolean complete(String id, JsonNode result, String completionHash) {
        var report = result.path("report");
        var artifacts = result.path("artifacts");
        var gatePassed = result.path("gate").path("passed").asBoolean(true);
        var status = gatePassed ? "COMPLETED" : "NEEDS_REVIEW";
        var updated = jdbc.update("UPDATE test_tasks SET status=?,stage=?,report_json=?,artifacts_json=?,completion_hash=?,lease_until=NULL,updated_at=? WHERE id=? AND status='RUNNING'",
                status, status, report.isMissingNode() ? null : report.toString(), artifacts.isMissingNode() ? null : artifacts.toString(), completionHash, Timestamp.from(Instant.now()), id);
        if (updated == 1) return true;
        var hashes = jdbc.query("SELECT completion_hash FROM test_tasks WHERE id=? AND status IN ('COMPLETED','NEEDS_REVIEW')", (rs, row) -> rs.getString(1), id);
        if (hashes.size() == 1 && completionHash.equals(hashes.get(0))) return false;
        throw new ConflictException("任务已由不同结果完成");
    }

    boolean fail(String id, String error) {
        var updated = jdbc.update("UPDATE test_tasks SET status='FAILED',stage='FAILED',error_message=?,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('RUNNING','QUEUED')",
                error, Timestamp.from(Instant.now()), id);
        if (updated == 1) return true;
        var terminal = jdbc.query("SELECT status,error_message FROM test_tasks WHERE id=?", (rs, row) -> List.of(rs.getString(1), Optional.ofNullable(rs.getString(2)).orElse("")), id);
        if (terminal.size() == 1 && "FAILED".equals(terminal.get(0).get(0)) && error.equals(terminal.get(0).get(1))) return false;
        throw new ConflictException("Task is already in a different terminal state");
    }

    boolean cancel(String id) {
        return jdbc.update("UPDATE test_tasks SET status='CANCELLED',stage='CANCELLED',lease_until=NULL,updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')", Timestamp.from(Instant.now()), id) == 1;
    }

    void requeueExpired() {
        jdbc.update("UPDATE test_tasks SET status='QUEUED',worker_id=NULL,lease_until=NULL,error_message='Worker lease expired',updated_at=? WHERE status='RUNNING' AND lease_until<?",
                Timestamp.from(Instant.now()), Timestamp.from(Instant.now()));
    }

    void saveProject(ProjectView project) {
        jdbc.update("INSERT INTO projects(id,name,project_path,default_version,default_test_types,created_at,updated_at) VALUES(?,?,?,?,?,?,?) " +
                        "ON DUPLICATE KEY UPDATE name=VALUES(name),project_path=VALUES(project_path),default_version=VALUES(default_version),default_test_types=VALUES(default_test_types),updated_at=VALUES(updated_at)",
                project.id(), project.name(), project.projectPath(), project.defaultVersion(), write(project.defaultTestTypes()),
                Timestamp.from(project.createdAt()), Timestamp.from(project.updatedAt()));
    }

    List<ProjectView> projects() {
        return jdbc.query("SELECT * FROM projects ORDER BY name", (rs, row) -> new ProjectView(rs.getString("id"), rs.getString("name"), rs.getString("project_path"),
                rs.getString("default_version"), read(rs.getString("default_test_types"), new TypeReference<>() {}), rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant()));
    }

    Optional<ProjectView> project(String id) { return projects().stream().filter(item -> item.id().equals(id)).findFirst(); }

    boolean insertWorker(WorkerView worker, String secretHash) {
        var now = Timestamp.from(Instant.now());
        try {
            jdbc.update("INSERT INTO workers(id,name,capabilities_json,status,last_heartbeat_at,created_at,updated_at,secret_hash) VALUES(?,?,?,?,?,?,?,?)",
                    worker.id(), worker.name(), write(worker.capabilities()), worker.status(), Timestamp.from(worker.lastHeartbeatAt()), now, now, secretHash);
            return true;
        } catch (DataIntegrityViolationException duplicate) {
            return false;
        }
    }

    boolean rotateWorker(WorkerView worker, String expectedSecretHash, String newSecretHash) {
        return jdbc.update("UPDATE workers SET name=?,capabilities_json=?,status=?,last_heartbeat_at=?,secret_hash=?,updated_at=? WHERE id=? AND secret_hash=?",
                worker.name(), write(worker.capabilities()), worker.status(), Timestamp.from(worker.lastHeartbeatAt()), newSecretHash,
                Timestamp.from(Instant.now()), worker.id(), expectedSecretHash) == 1;
    }

    boolean workerExists(String id) {
        var count = jdbc.queryForObject("SELECT COUNT(*) FROM workers WHERE id=?", Long.class, id);
        return count != null && count == 1;
    }

    boolean verifyWorkerSecret(String id, String secretHash) {
        var rows = jdbc.query("SELECT secret_hash FROM workers WHERE id=?", (rs, row) -> rs.getString(1), id);
        return rows.size() == 1 && rows.get(0) != null && rows.get(0).equals(secretHash);
    }

    void heartbeatWorker(String id) { jdbc.update("UPDATE workers SET status='ONLINE',last_heartbeat_at=?,updated_at=? WHERE id=?", Timestamp.from(Instant.now()), Timestamp.from(Instant.now()), id); }

    void markStaleWorkersOffline(Instant cutoff) { jdbc.update("UPDATE workers SET status='OFFLINE',updated_at=? WHERE status='ONLINE' AND last_heartbeat_at<?", Timestamp.from(Instant.now()), Timestamp.from(cutoff)); }

    List<WorkerView> workers() {
        return jdbc.query("SELECT * FROM workers ORDER BY name", (rs, row) -> new WorkerView(rs.getString("id"), rs.getString("name"),
                read(rs.getString("capabilities_json"), new TypeReference<>() {}), rs.getString("status"), rs.getTimestamp("last_heartbeat_at").toInstant()));
    }

    void saveSchedule(ScheduleView schedule) {
        jdbc.update("INSERT INTO schedules(id,project_id,interval_minutes,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?) " +
                        "ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),interval_minutes=VALUES(interval_minutes),enabled=VALUES(enabled),next_run_at=VALUES(next_run_at),updated_at=VALUES(updated_at)",
                schedule.id(), schedule.projectId(), schedule.intervalMinutes(), schedule.enabled(), Timestamp.from(schedule.nextRunAt()), Timestamp.from(schedule.createdAt()), Timestamp.from(schedule.updatedAt()));
    }

    boolean advanceSchedule(String id, Instant expectedNextRunAt, Instant nextRunAt, Instant updatedAt) {
        return jdbc.update("UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=? AND enabled=TRUE AND next_run_at=?",
                Timestamp.from(nextRunAt), Timestamp.from(updatedAt), id, Timestamp.from(expectedNextRunAt)) == 1;
    }

    List<ScheduleView> schedules() {
        return jdbc.query("SELECT * FROM schedules ORDER BY created_at DESC", (rs, row) -> new ScheduleView(rs.getString("id"), rs.getString("project_id"),
                rs.getInt("interval_minutes"), rs.getBoolean("enabled"), rs.getTimestamp("next_run_at").toInstant(), rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant()));
    }

    boolean deleteSchedule(String id) { return jdbc.update("DELETE FROM schedules WHERE id=?", id) == 1; }

    void saveArtifact(String id, String taskId, String name, String path, String type, long size) {
        jdbc.update("INSERT INTO task_artifacts(id,task_id,original_name,storage_path,content_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)",
                id, taskId, name, path, type, size, Timestamp.from(Instant.now()));
    }

    void insertAudit(String actor, String action, String taskId, String payload, String sourceIp) {
        jdbc.update("INSERT INTO audit_log(actor,action,task_id,payload,source_ip,created_at) VALUES(?,?,?,?,?,?)",
                actor, action, taskId, payload, sourceIp, Timestamp.from(Instant.now()));
    }

    List<AuditEntry> listAudit(int limit, String actor, String action) {
        var sql = new StringBuilder("SELECT id, actor, action, task_id, payload, source_ip, created_at FROM audit_log");
        var conditions = new java.util.ArrayList<String>();
        var params = new java.util.ArrayList<Object>();
        if (actor != null && !actor.isBlank()) { conditions.add("actor=?"); params.add(actor); }
        if (action != null && !action.isBlank()) { conditions.add("action=?"); params.add(action); }
        if (!conditions.isEmpty()) sql.append(" WHERE ").append(String.join(" AND ", conditions));
        sql.append(" ORDER BY id DESC LIMIT ?");
        params.add(limit);
        return jdbc.query(sql.toString(), (rs, row) -> new AuditEntry(rs.getLong("id"), rs.getString("actor"), rs.getString("action"),
                rs.getString("task_id"), rs.getString("payload"), rs.getString("source_ip"), rs.getTimestamp("created_at").toInstant()), params.toArray());
    }

    List<java.util.Map<String, Object>> artifacts(String taskId) {
        return jdbc.queryForList("SELECT id,original_name,content_type,size_bytes,created_at FROM task_artifacts WHERE task_id=? ORDER BY created_at", taskId);
    }

    Optional<java.util.Map<String, Object>> artifact(String taskId, String id) {
        return jdbc.queryForList("SELECT * FROM task_artifacts WHERE task_id=? AND id=?", taskId, id).stream().findFirst();
    }

    private TaskView mapTask(ResultSet rs) throws SQLException {
        return new TaskView(rs.getString("id"), rs.getString("project_id"), read(rs.getString("input_json"), TaskInput.class), rs.getString("status"),
                rs.getString("trigger_type"), rs.getString("worker_id"), tree(rs.getString("report_json")), tree(rs.getString("artifacts_json")),
                rs.getString("error_message"), rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant(), List.of(), rs.getString("stage"));
    }

    private String write(Object value) { try { return json.writeValueAsString(value); } catch (JsonProcessingException e) { throw new IllegalArgumentException(e); } }
    private <T> T read(String value, Class<T> type) { try { return json.readValue(value, type); } catch (JsonProcessingException e) { throw new IllegalStateException(e); } }
    private <T> T read(String value, TypeReference<T> type) { try { return json.readValue(value, type); } catch (JsonProcessingException e) { throw new IllegalStateException(e); } }
    private JsonNode tree(String value) { try { return value == null ? null : json.readTree(value); } catch (JsonProcessingException e) { throw new IllegalStateException(e); } }
}
