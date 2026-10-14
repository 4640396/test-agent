package com.cimdev.testagent;

import jakarta.validation.Valid;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;

import static com.cimdev.testagent.ApiModels.*;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = {"http://127.0.0.1", "http://localhost"})
class ApiController {
    private final ControlService service;

    ApiController(ControlService service) { this.service = service; }

    @GetMapping("/runtime") Map<String, Object> runtime() {
        return Map.of("service", "java-control-plane", "database", "mysql", "storage", "local", "workers", service.workers());
    }

    @GetMapping("/projects") List<ProjectView> projects() { return service.projects(); }
    @PostMapping("/projects") ProjectView saveProject(@Valid @RequestBody ProjectRequest request) { return service.saveProject(request); }

    @GetMapping("/tasks") List<TaskView> tasks(@RequestParam(defaultValue = "100") int limit) { return service.tasks(limit); }
    @PostMapping("/tasks") ResponseEntity<TaskView> createTask(@Valid @RequestBody CreateTaskRequest request) { return ResponseEntity.accepted().body(service.createTask(request)); }
    @GetMapping("/tasks/{id}") TaskView task(@PathVariable String id) { return service.task(id); }
    @GetMapping(value = "/tasks/{id}/report", produces = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<String> report(@PathVariable String id, @RequestParam(defaultValue = "json") String format) {
        var task = service.task(id);
        if ("junit".equalsIgnoreCase(format)) {
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_XML).body(service.junitReport(task));
        }
        return ResponseEntity.ok(service.jsonReport(task));
    }
    @GetMapping("/tasks/{id}/logs") List<TaskLog> logs(@PathVariable String id) { return service.logs(id); }
    @GetMapping("/tasks/{id}/run-events") List<RunEventView> runEvents(@PathVariable String id) { return service.runEvents(id); }
    @PostMapping("/tasks/{id}/cancel") TaskView cancel(@PathVariable String id) { return service.cancel(id); }
    @PostMapping("/tasks/{id}/retry") ResponseEntity<TaskView> retry(@PathVariable String id) { return ResponseEntity.accepted().body(service.retry(id)); }
    @GetMapping(value = "/tasks/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE) SseEmitter events(@PathVariable String id) { return service.subscribe(id); }
    @GetMapping("/tasks/{id}/artifacts") List<Map<String, Object>> artifacts(@PathVariable String id) { return service.artifacts(id); }
    @GetMapping("/tasks/{taskId}/artifacts/{artifactId}") ResponseEntity<FileSystemResource> artifact(@PathVariable String taskId, @PathVariable String artifactId) {
        var path = service.artifactPath(taskId, artifactId);
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + path.getFileName() + "\"").body(new FileSystemResource(path));
    }

    @GetMapping("/workers") List<WorkerView> workers() { return service.workers(); }
    @GetMapping("/audit") List<AuditEntry> audit(@RequestParam(defaultValue = "100") int limit,
                                                @RequestParam(required = false) String actor,
                                                @RequestParam(required = false) String action) {
        return service.audit(limit, actor, action);
    }
    @PostMapping("/workers/register")
    ResponseEntity<?> register(@Valid @RequestBody WorkerRegisterRequest request,
                               @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                               @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (request.id() != null && service.workerExists(request.id())
                && (!request.id().equals(headerWorkerId) || !isWorker(headerWorkerId, secret))) {
            return forbidden("已有Worker身份必须使用当前secret轮换");
        }
        return ResponseEntity.ok(service.register(request, headerWorkerId, secret));
    }
    @PostMapping("/workers/{id}/heartbeat")
    ResponseEntity<?> heartbeat(@PathVariable String id,
                                @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                                @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret) || !id.equals(headerWorkerId)) return forbidden("Worker 身份校验失败");
        service.heartbeatWorker(id);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/worker/tasks/claim")
    ResponseEntity<?> claim(@Valid @RequestBody ClaimRequest request,
                            @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                            @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret) || !request.workerId().equals(headerWorkerId)) return forbidden("Worker 身份校验失败");
        return service.claim(request).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PostMapping("/worker/tasks/{taskId}/heartbeat")
    ResponseEntity<?> taskHeartbeat(@PathVariable String taskId, @RequestParam String workerId,
                                    @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                                    @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret) || !workerId.equals(headerWorkerId)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, workerId);
        service.heartbeatTask(taskId, workerId);
        return ResponseEntity.ok().build();
    }

    @GetMapping("/worker/tasks/{taskId}/status")
    ResponseEntity<?> workerTaskStatus(@PathVariable String taskId,
                                       @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                                       @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        return ResponseEntity.ok(Map.of("status", service.task(taskId).status()));
    }

    @PostMapping("/worker/tasks/{taskId}/events")
    ResponseEntity<?> workerEvent(@PathVariable String taskId, @Valid @RequestBody AgentEvent event,
                                  @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                                  @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        service.workerEvent(taskId, event);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/worker/tasks/{taskId}/run-events")
    ResponseEntity<?> runEvent(@PathVariable String taskId, @Valid @RequestBody RunEventRequest event,
                               @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                               @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        service.appendRunEvent(taskId, headerWorkerId, event);
        return ResponseEntity.accepted().build();
    }

    @PostMapping("/worker/tasks/{taskId}/complete")
    ResponseEntity<?> complete(@PathVariable String taskId, @Valid @RequestBody CompleteTaskRequest request,
                               @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                               @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        return ResponseEntity.ok(service.complete(taskId, headerWorkerId, request));
    }

    @PostMapping("/worker/tasks/{taskId}/fail")
    ResponseEntity<?> fail(@PathVariable String taskId, @Valid @RequestBody FailTaskRequest request,
                           @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                           @RequestHeader(value = "X-Worker-Secret", required = false) String secret) {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        return ResponseEntity.ok(service.fail(taskId, headerWorkerId, request));
    }

    @PostMapping(value = "/worker/tasks/{taskId}/artifacts", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<?> upload(@PathVariable String taskId, @RequestPart MultipartFile file,
                             @RequestHeader(value = "X-Worker-Id", required = false) String headerWorkerId,
                             @RequestHeader(value = "X-Worker-Secret", required = false) String secret) throws Exception {
        if (!isWorker(headerWorkerId, secret)) return forbidden("Worker 身份校验失败");
        service.requireTaskOwner(taskId, headerWorkerId);
        return ResponseEntity.ok(service.saveArtifact(taskId, file));
    }

    @GetMapping("/schedules") List<ScheduleView> schedules() { return service.schedules(); }
    @PostMapping("/schedules") ScheduleView schedule(@Valid @RequestBody ScheduleRequest request) { return service.saveSchedule(request); }
    @PutMapping("/schedules/{id}") ScheduleView updateSchedule(@PathVariable String id, @Valid @RequestBody ScheduleRequest request) {
        return service.saveSchedule(new ScheduleRequest(id, request.projectId(), request.intervalMinutes(), request.enabled()));
    }
    @DeleteMapping("/schedules/{id}") ResponseEntity<Void> deleteSchedule(@PathVariable String id) { return service.deleteSchedule(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build(); }

    @PostMapping("/webhooks/version-release") ResponseEntity<TaskView> release(@RequestBody Map<String, Object> request,
                                                                               @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        var projectId = String.valueOf(request.get("projectId"));
        var project = service.projects().stream().filter(item -> item.id().equals(projectId)).findFirst().orElseThrow(() -> new IllegalArgumentException("项目不存在"));
        @SuppressWarnings("unchecked") var types = request.get("testTypes") instanceof List<?> values ? (List<String>) values : project.defaultTestTypes();
        @SuppressWarnings("unchecked") var capabilities = request.get("requiredCapabilities") instanceof List<?> values ? (List<String>) values : List.<String>of();
        var version = String.valueOf(request.getOrDefault("version", project.defaultVersion()));
        var input = new TaskInput(project.projectPath(), project.name(), version, types, capabilities);
        var key = idempotencyKey == null || idempotencyKey.isBlank()
                ? releaseIdempotencyKey(projectId, version, types)
                : "release:" + idempotencyKey;
        return ResponseEntity.accepted().body(service.createTask(new CreateTaskRequest(projectId, input, "version-release", key)));
    }

    private boolean isWorker(String workerId, String secret) {
        return service.verifyWorkerSecret(workerId, secret);
    }

    private ResponseEntity<Map<String, String>> forbidden(String message) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", message));
    }

    private String releaseIdempotencyKey(String projectId, String version, List<String> types) {
        var raw = String.join("|", projectId, version == null ? "" : version, String.join(",", types));
        try {
            return "release:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
