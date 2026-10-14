package com.cimdev.testagent;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static com.cimdev.testagent.ApiModels.*;

@Service
class ControlService {
    private final TaskStore store;
    private final SseHub events;
    private final Path storageRoot;
    private final int leaseSeconds;
    private final com.fasterxml.jackson.databind.ObjectMapper json;

    ControlService(TaskStore store, SseHub events,
                   @Value("${test-agent.storage-root}") String storageRoot,
                   @Value("${test-agent.task-lease-seconds}") int leaseSeconds,
                   com.fasterxml.jackson.databind.ObjectMapper json) throws IOException {
        this.store = store;
        this.events = events;
        this.storageRoot = Path.of(storageRoot).toAbsolutePath().normalize();
        this.leaseSeconds = leaseSeconds;
        this.json = json;
        Files.createDirectories(this.storageRoot);
    }

    ProjectView saveProject(ProjectRequest request) {
        var now = Instant.now();
        var existing = request.id() == null ? Optional.<ProjectView>empty() : store.project(request.id());
        var project = new ProjectView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.name(), request.projectPath(),
                request.defaultVersion() == null ? "" : request.defaultVersion(), request.defaultTestTypes(), existing.map(ProjectView::createdAt).orElse(now), now);
        store.saveProject(project);
        audit(currentActor(), existing.isPresent() ? "project.update" : "project.create", null, "project=" + project.id());
        return project;
    }

    List<ProjectView> projects() { return store.projects(); }

    TaskView createTask(CreateTaskRequest request) {
        TaskInput input = request.input();
        String projectId = request.projectId();
        if (input == null && projectId != null) {
            var project = store.project(projectId).orElseThrow(() -> new IllegalArgumentException("项目不存在"));
            input = new TaskInput(project.projectPath(), project.name(), project.defaultVersion(), project.defaultTestTypes(), List.of());
        }
        if (input == null) throw new IllegalArgumentException("任务输入不能为空");
        var id = UUID.randomUUID().toString();
        var triggerType = request.triggerType() == null ? "manual" : request.triggerType();
        var existing = store.insertTask(id, projectId, input, triggerType, request.idempotencyKey());
        if (existing.isPresent()) {
            audit(actorFor(triggerType), "task.create.duplicate", existing.get().id(), "idempotency=" + request.idempotencyKey());
            return existing.get();
        }
        log(id, "info", "任务进入中央队列");
        audit(actorFor(triggerType), "task.create", id, "project=" + projectId);
        return task(id);
    }

    TaskView task(String id) { return store.task(id).orElseThrow(() -> new IllegalArgumentException("任务不存在")); }
    List<TaskView> tasks(int limit) { return store.tasks(Math.min(Math.max(limit, 1), 1000)); }
    List<TaskLog> logs(String id) { return store.logs(id); }
    List<AuditEntry> audit(int limit, String actor, String action) { return store.listAudit(Math.min(Math.max(limit, 1), 500), actor, action); }

    String jsonReport(TaskView task) {
        var payload = new java.util.LinkedHashMap<String, Object>();
        payload.put("taskId", task.id());
        payload.put("status", task.status());
        payload.put("stage", task.stage());
        payload.put("projectId", task.projectId());
        payload.put("report", task.report() == null ? java.util.Map.of() : task.report());
        payload.put("errorMessage", task.errorMessage());
        try {
            return json.writeValueAsString(payload);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    String junitReport(TaskView task) {
        var report = task.report();
        int tests = 0;
        int failures = 0;
        if (report != null) {
            tests = report.path("passed").asInt(0) + report.path("failed").asInt(0);
            failures = report.path("failed").asInt(0);
        }
        var sb = new StringBuilder();
        sb.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        sb.append("<testsuite name=\"").append(escape(task.id())).append("\" tests=\"").append(tests)
                .append("\" failures=\"").append(failures).append("\" errors=\"0\" skipped=\"0\">");
        if (report != null && report.has("lanes")) {
            for (var lane : report.path("lanes")) {
                var type = lane.path("type").asText("unknown");
                var status = lane.path("status").asText("unknown");
                var summary = lane.path("summary").asText("");
                sb.append("<testcase classname=\"").append(escape(task.id())).append("\" name=\"").append(escape(type)).append("\" status=\"run\">");
                if ("failed".equals(status)) sb.append("<failure message=\"").append(escape(summary)).append("\"/>");
                sb.append("</testcase>");
            }
        }
        if (task.errorMessage() != null) sb.append("<system-err>").append(escape(task.errorMessage())).append("</system-err>");
        sb.append("</testsuite>");
        return sb.toString();
    }

    private String escape(String value) {
        return value == null ? "" : value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    TaskView cancel(String id) {
        if (store.cancel(id)) {
            log(id, "warning", "任务已取消");
            audit(currentActor(), "task.cancel", id, null);
        }
        return task(id);
    }

    TaskView retry(String id) {
        var old = task(id);
        return createTask(new CreateTaskRequest(old.projectId(), old.input(), "retry:" + id, "retry:" + id));
    }

    WorkerRegisterResponse register(WorkerRegisterRequest request, String currentWorkerId, String currentSecret) {
        var worker = new WorkerView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.name(), request.capabilities(), "ONLINE", Instant.now());
        var secret = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "");
        var newHash = secretHash(worker.id(), secret);
        var rotated = worker.id().equals(currentWorkerId) && currentSecret != null
                && store.rotateWorker(worker, secretHash(worker.id(), currentSecret), newHash);
        if (!rotated && !store.insertWorker(worker, newHash)) {
            throw new ForbiddenException("Existing worker identity requires its current secret for rotation");
        }
        audit(currentWorkerId == null ? currentActor() : "worker:" + worker.id(),
                rotated ? "worker.rotate" : "worker.register", null, "worker=" + worker.id());
        return new WorkerRegisterResponse(worker.id(), worker.name(), worker.capabilities(), worker.status(), worker.lastHeartbeatAt(), secret);
    }

    boolean workerExists(String id) { return id != null && store.workerExists(id); }

    boolean verifyWorkerSecret(String workerId, String secret) {
        return workerId != null && secret != null && store.verifyWorkerSecret(workerId, secretHash(workerId, secret));
    }

    void requireTaskOwner(String taskId, String workerId) {
        var task = task(taskId);
        if (workerId == null || !workerId.equals(task.workerId())) throw new ForbiddenException("Worker 无权操作该任务");
    }

    void heartbeatWorker(String id) { store.heartbeatWorker(id); }
    List<WorkerView> workers() { return store.workers(); }

    Optional<ClaimedTask> claim(ClaimRequest request) {
        store.heartbeatWorker(request.workerId());
        var claimed = store.claim(request.workerId(), request.capabilities(), leaseSeconds);
        claimed.ifPresent(task -> {
            log(task.taskId(), "info", "Worker已领取任务：" + request.workerId());
            audit("worker:" + request.workerId(), "task.claim", task.taskId(), null);
        });
        return claimed;
    }

    void heartbeatTask(String taskId, String workerId) { store.heartbeatTask(taskId, workerId, leaseSeconds); }

    void workerEvent(String taskId, AgentEvent event) {
        if (event.stage() != null && !event.stage().isBlank()) {
            store.updateStage(taskId, event.stage());
            events.publish(taskId, "snapshot", task(taskId));
        }
        log(taskId, event.level(), event.message());
    }

    void appendRunEvent(String taskId, String workerId, RunEventRequest event) {
        if (!taskId.equals(event.executionId())) throw new IllegalArgumentException("executionId必须等于taskId");
        store.appendRunEvent(taskId, workerId, event);
    }

    List<RunEventView> runEvents(String taskId) {
        task(taskId);
        return store.runEvents(taskId);
    }

    TaskView complete(String taskId, String workerId, CompleteTaskRequest request) {
        var completionHash = sha256(request.result().toString());
        if (store.complete(taskId, request.result(), completionHash)) {
            log(taskId, "success", "Worker真实测试执行完成");
            audit("worker:" + workerId, "task.complete", taskId, null);
        }
        return task(taskId);
    }

    TaskView fail(String taskId, String workerId, FailTaskRequest request) {
        if (store.fail(taskId, request.error())) {
            log(taskId, "error", request.error());
            audit("worker:" + workerId, "task.fail", taskId, request.error());
        }
        return task(taskId);
    }

    Map<String, Object> saveArtifact(String taskId, MultipartFile file) throws IOException {
        task(taskId);
        var id = UUID.randomUUID().toString();
        var taskDirectory = storageRoot.resolve("tasks").resolve(taskId).normalize();
        Files.createDirectories(taskDirectory);
        var safeName = Path.of(Optional.ofNullable(file.getOriginalFilename()).orElse("artifact.bin")).getFileName().toString();
        var target = taskDirectory.resolve(id + "-" + safeName).normalize();
        if (!target.startsWith(taskDirectory)) throw new IllegalArgumentException("非法产物路径");
        Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);
        store.saveArtifact(id, taskId, safeName, target.toString(), Optional.ofNullable(file.getContentType()).orElse("application/octet-stream"), file.getSize());
        return Map.of("id", id, "name", safeName, "size", file.getSize());
    }

    List<Map<String, Object>> artifacts(String taskId) { return store.artifacts(taskId); }

    Path artifactPath(String taskId, String artifactId) {
        var row = store.artifact(taskId, artifactId).orElseThrow(() -> new IllegalArgumentException("产物不存在"));
        var path = Path.of(row.get("storage_path").toString()).toAbsolutePath().normalize();
        if (!path.startsWith(storageRoot) || !Files.exists(path)) throw new IllegalArgumentException("产物文件不存在");
        return path;
    }

    ScheduleView saveSchedule(ScheduleRequest request) {
        var now = Instant.now();
        var existing = request.id() == null ? Optional.<ScheduleView>empty() : store.schedules().stream().filter(item -> item.id().equals(request.id())).findFirst();
        store.project(request.projectId()).orElseThrow(() -> new IllegalArgumentException("项目不存在"));
        var schedule = new ScheduleView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.projectId(), request.intervalMinutes(), request.enabled(),
                now.plusSeconds(request.intervalMinutes() * 60L), existing.map(ScheduleView::createdAt).orElse(now), now);
        store.saveSchedule(schedule);
        audit(currentActor(), existing.isPresent() ? "schedule.update" : "schedule.create", null, "schedule=" + schedule.id());
        return schedule;
    }

    List<ScheduleView> schedules() { return store.schedules(); }
    boolean deleteSchedule(String id) {
        var deleted = store.deleteSchedule(id);
        if (deleted) audit(currentActor(), "schedule.delete", null, "schedule=" + id);
        return deleted;
    }

    org.springframework.web.servlet.mvc.method.annotation.SseEmitter subscribe(String taskId) { return events.subscribe(taskId, task(taskId)); }

    @Scheduled(fixedDelayString = "${test-agent.scheduler-delay-ms}")
    void schedule() {
        store.markStaleWorkersOffline(Instant.now().minusSeconds(90));
        store.requeueExpired();
        var now = Instant.now();
        for (var schedule : store.schedules()) {
            if (!schedule.enabled() || schedule.nextRunAt().isAfter(now)) continue;
            var occurrence = "schedule:" + schedule.id() + ":" + schedule.nextRunAt();
            createTask(new CreateTaskRequest(schedule.projectId(), null, "schedule:" + schedule.id(), occurrence));
            store.advanceSchedule(schedule.id(), schedule.nextRunAt(),
                    schedule.nextRunAt().plusSeconds(schedule.intervalMinutes() * 60L), now);
        }
    }

    private void log(String taskId, String level, String message) {
        var log = store.appendLog(taskId, level, message);
        events.publish(taskId, "log", log);
        events.publish(taskId, "snapshot", task(taskId));
    }

    private String actorFor(String triggerType) {
        var trigger = triggerType == null ? "manual" : triggerType;
        if (trigger.startsWith("schedule:")) return "schedule";
        if (trigger.equals("version-release")) return "webhook";
        return currentActor();
    }

    private String currentActor() {
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes requestAttributes) {
            var role = requestAttributes.getRequest().getAttribute("test-agent.role");
            if (role != null) return "role:" + role;
        }
        return "system";
    }

    private String secretHash(String workerId, String secret) {
        return sha256(workerId + ":" + secret);
    }

    private String sha256(String value) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private void audit(String actor, String action, String taskId, String payload) {
        String sourceIp = null;
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes requestAttributes) {
            try { sourceIp = requestAttributes.getRequest().getRemoteAddr(); } catch (Exception ignored) { }
        }
        store.insertAudit(actor, action, taskId, payload, sourceIp);
    }
}
