package com.cimdev.testagent;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApiIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ControlService controlService;
    @Autowired org.flywaydb.core.Flyway flyway;

    private static final String TOKEN = "test-token";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void flywaySchemaIsAtExpectedVersion() {
        assertThat(flyway.info().current()).isNotNull();
        assertThat(flyway.info().current().getVersion().getVersion()).isEqualTo("5");
    }

    @BeforeEach
    void cleanDatabase() {
        jdbc.update("DELETE FROM audit_log");
        jdbc.update("DELETE FROM task_artifacts");
        jdbc.update("DELETE FROM task_run_events");
        jdbc.update("DELETE FROM task_logs");
        jdbc.update("DELETE FROM test_tasks");
        jdbc.update("DELETE FROM schedules");
        jdbc.update("DELETE FROM workers");
        jdbc.update("DELETE FROM projects");
    }

    @Test
    void projectTaskWorkerAndCompletionFlow() throws Exception {
        var projectId = createProject("portal");
        var workerSecret = registerWorker("worker-1", new String[]{"windows", "java"});

        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/{id}/events", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"level":"info","message":"进入阶段：VALIDATING","stage":"VALIDATING"}
                """)).andExpect(status().isOk());

        mvc.perform(get("/api/tasks/{id}", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.stage").value("VALIDATING"));

        var completion = """
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"1 passed"}],"report":{"passed":1,"failed":0,"coverage":80},"artifacts":[]}}
                """;
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content(completion)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("COMPLETED"));
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content(completion)).andExpect(status().isOk());
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content(completion.replace("\"passed\":1", "\"passed\":2")))
                .andExpect(status().isConflict());

        mvc.perform(get("/api/tasks/{id}", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.report.passed").value(1))
                .andExpect(jsonPath("$.stage").value("COMPLETED"))
                .andExpect(jsonPath("$.logs.length()").value(4));

        assertThat(auditCount("task.create")).isGreaterThanOrEqualTo(1);
        assertThat(auditCount("task.complete")).isGreaterThanOrEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE action='task.claim' AND actor='worker:worker-1'", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE action='task.complete' AND actor='worker:worker-1'", Long.class)).isEqualTo(1L);
    }

    @Test
    void needsReviewWhenCoverageGateFails() throws Exception {
        var projectId = createProject("gate");
        var workerSecret = registerWorker("worker-1", new String[]{"windows", "java"});

        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"2 passed"}],"report":{"passed":2,"failed":0,"coverage":40},"gate":{"coverageTarget":60,"coverage":40,"effectiveRate":1,"passed":false,"reason":"覆盖率 40% 未达到目标 60%"}}}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("NEEDS_REVIEW"));

        mvc.perform(get("/api/tasks/{id}", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.stage").value("NEEDS_REVIEW"))
                .andExpect(jsonPath("$.report.coverage").value(40));
    }

    @Test
    void failureIsIdempotentAndCannotContradictAnotherTerminalFact() throws Exception {
        var projectId = createProject("failure-facts");
        var workerSecret = registerWorker("worker-failure", new String[]{"windows", "java"});
        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();
        claim("worker-failure", workerSecret).andExpect(status().isOk());

        var failure = "{\"error\":\"compiler unavailable\"}";
        mvc.perform(post("/api/worker/tasks/{id}/fail", taskId).headers(auth()).headers(worker("worker-failure", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content(failure)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("FAILED"));
        mvc.perform(post("/api/worker/tasks/{id}/fail", taskId).headers(auth()).headers(worker("worker-failure", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content(failure)).andExpect(status().isOk());
        mvc.perform(post("/api/worker/tasks/{id}/fail", taskId).headers(auth()).headers(worker("worker-failure", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("{\"error\":\"different failure\"}"))
                .andExpect(status().isConflict());
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-failure", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[],"report":{"passed":1,"failed":0},"artifacts":[]}}
                """)).andExpect(status().isConflict());

        assertThat(auditCount("task.fail")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM task_logs WHERE task_id=? AND level='error'", Long.class, taskId)).isEqualTo(1L);
    }

    @Test
    void completionRequiresAResultDocument() throws Exception {
        var projectId = createProject("completion-validation");
        var workerSecret = registerWorker("worker-validation", new String[]{"java"});
        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();
        claim("worker-validation", workerSecret).andExpect(status().isOk());
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-validation", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/tasks/{id}", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("RUNNING"));
    }

    @Test
    void auditQueryReturnsEntries() throws Exception {
        var projectId = createProject("audit");
        mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted());

        mvc.perform(get("/api/audit").headers(auth()).param("action", "task.create").param("limit", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].action").value("task.create"))
                .andExpect(jsonPath("$[0].actor").value("role:admin"));
    }

    @Test
    void apiRequiresTokenByDefault() throws Exception {
        mvc.perform(get("/api/projects")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/projects").headers(auth())).andExpect(status().isOk());
        mvc.perform(get("/actuator/health")).andExpect(status().isOk());
        mvc.perform(get("/actuator/health/readiness"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void roleTokensEnforceViewerOperatorAndWorkerBoundaries() throws Exception {
        mvc.perform(get("/api/projects").headers(role("viewer-token"))).andExpect(status().isOk());
        mvc.perform(post("/api/projects").headers(role("viewer-token")).contentType(MediaType.APPLICATION_JSON).content("""
                {"name":"denied","projectPath":"C:/works/denied","defaultVersion":"main","defaultTestTypes":["unit"]}
                """)).andExpect(status().isForbidden());
        mvc.perform(get("/api/audit").headers(role("viewer-token"))).andExpect(status().isForbidden());

        mvc.perform(post("/api/projects").headers(role("operator-token")).contentType(MediaType.APPLICATION_JSON).content("""
                {"name":"allowed","projectPath":"C:/works/allowed","defaultVersion":"main","defaultTestTypes":["unit"]}
                """)).andExpect(status().isOk());
        mvc.perform(get("/api/audit").headers(role("operator-token"))).andExpect(status().isForbidden());
        mvc.perform(post("/api/worker/tasks/claim").headers(role("operator-token")).contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"none","capabilities":["java"]}
                """)).andExpect(status().isForbidden());

        mvc.perform(get("/api/projects").headers(role("worker-token"))).andExpect(status().isForbidden());
        mvc.perform(post("/api/workers/register").headers(role("worker-token")).contentType(MediaType.APPLICATION_JSON).content("""
                {"id":"role-worker","name":"role-worker","capabilities":["java"]}
                """)).andExpect(status().isOk());
        mvc.perform(get("/api/audit").headers(role("admin-token"))).andExpect(status().isOk());
    }

    @Test
    void existingWorkerIdentityRequiresCurrentSecretForRotation() throws Exception {
        var oldSecret = registerWorker("rotating-worker", new String[]{"windows", "java"});
        var registration = """
                {"id":"rotating-worker","name":"rotating-worker","capabilities":["windows","java"]}
                """;

        mvc.perform(post("/api/workers/register").headers(role("worker-token"))
                .contentType(MediaType.APPLICATION_JSON).content(registration))
                .andExpect(status().isForbidden());

        var response = mvc.perform(post("/api/workers/register").headers(role("worker-token"))
                        .headers(worker("rotating-worker", oldSecret))
                        .contentType(MediaType.APPLICATION_JSON).content(registration))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        var newSecret = JSON.readTree(response).path("secret").asText();
        assertThat(newSecret).isNotBlank().isNotEqualTo(oldSecret);

        mvc.perform(post("/api/workers/rotating-worker/heartbeat").headers(role("worker-token"))
                        .headers(worker("rotating-worker", oldSecret)))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/workers/rotating-worker/heartbeat").headers(role("worker-token"))
                        .headers(worker("rotating-worker", newSecret)))
                .andExpect(status().isOk());
    }

    @Test
    void concurrentFirstRegistrationHasExactlyOneWinner() throws Exception {
        var registration = """
                {"id":"contended-worker","name":"contended-worker","capabilities":["java"]}
                """;
        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var requests = java.util.stream.IntStream.range(0, 2)
                    .mapToObj(ignored -> executor.submit(() -> mvc.perform(post("/api/workers/register")
                                    .headers(role("worker-token")).contentType(MediaType.APPLICATION_JSON).content(registration))
                            .andReturn().getResponse()))
                    .toList();
            var responses = new java.util.ArrayList<org.springframework.mock.web.MockHttpServletResponse>();
            for (var request : requests) responses.add(request.get());
            assertThat(responses.stream().map(org.springframework.mock.web.MockHttpServletResponse::getStatus).sorted().toList())
                    .containsExactly(200, 403);
            var winner = responses.stream().filter(response -> response.getStatus() == 200).findFirst().orElseThrow();
            var winnerSecret = JSON.readTree(winner.getContentAsString()).path("secret").asText();
            mvc.perform(post("/api/workers/contended-worker/heartbeat").headers(role("worker-token"))
                            .headers(worker("contended-worker", winnerSecret)))
                    .andExpect(status().isOk());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void workerIdentityAndTaskOwnershipAreEnforced() throws Exception {
        var projectId = createProject("inventory");
        var worker1Secret = registerWorker("worker-1", new String[]{"windows", "java"});
        var worker2Secret = registerWorker("worker-2", new String[]{"windows", "java"});

        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/claim").headers(auth())
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isForbidden());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-2", worker2Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[],"report":{"passed":0,"failed":0,"coverage":null},"artifacts":[]}}
                """)).andExpect(status().isForbidden());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"ok"}],"report":{"passed":1,"failed":0,"coverage":50},"artifacts":[]}}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("COMPLETED"));
    }

    @Test
    void runEventsAreOrderedIdempotentAndOwnerProtected() throws Exception {
        var projectId = createProject("events");
        var worker1Secret = registerWorker("worker-1", new String[]{"windows", "java"});
        var worker2Secret = registerWorker("worker-2", new String[]{"windows", "java"});
        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();
        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk());
        var event = """
                {"schemaVersion":1,"executionId":"%s","sequence":1,"timestamp":"2026-08-15T07:00:00Z","type":"run/started","data":{"source":"worker"}}
                """.formatted(taskId);
        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var uploads = java.util.stream.IntStream.range(0, 2)
                    .mapToObj(ignored -> executor.submit(() -> mvc.perform(post("/api/worker/tasks/{id}/run-events", taskId)
                                    .headers(auth()).headers(worker("worker-1", worker1Secret))
                                    .contentType(MediaType.APPLICATION_JSON).content(event))
                            .andReturn().getResponse().getStatus()))
                    .toList();
            assertThat(uploads.get(0).get()).isEqualTo(202);
            assertThat(uploads.get(1).get()).isEqualTo(202);
        } finally {
            executor.shutdownNow();
        }
        mvc.perform(post("/api/worker/tasks/{id}/run-events", taskId).headers(auth()).headers(worker("worker-2", worker2Secret))
                .contentType(MediaType.APPLICATION_JSON).content(event)).andExpect(status().isForbidden());
        mvc.perform(post("/api/worker/tasks/{id}/run-events", taskId).headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content(event.replace("\"sequence\":1", "\"sequence\":3")))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/tasks/{id}/run-events", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].sequence").value(1))
                .andExpect(jsonPath("$[0].type").value("run/started"))
                .andExpect(jsonPath("$[0].workerId").value("worker-1"));
    }

    @Test
    void expiredLeaseIsReclaimedAndOldWorkerCannotComplete() throws Exception {
        var projectId = createProject("lease");
        var oldSecret = registerWorker("worker-old", new String[]{"windows", "java"});
        var newSecret = registerWorker("worker-new", new String[]{"windows", "java"});
        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();
        claim("worker-old", oldSecret).andExpect(status().isOk());
        jdbc.update("UPDATE test_tasks SET lease_until=? WHERE id=?", Timestamp.from(Instant.now().minusSeconds(5)), taskId);
        controlService.schedule();
        claim("worker-new", newSecret).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));
        var completion = """
                {"result":{"lanes":[],"report":{"passed":1,"failed":0,"coverage":80},"artifacts":[]}}
                """;
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-old", oldSecret))
                .contentType(MediaType.APPLICATION_JSON).content(completion)).andExpect(status().isForbidden());
        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-new", newSecret))
                .contentType(MediaType.APPLICATION_JSON).content(completion)).andExpect(status().isOk());
    }

    @Test
    void concurrentWorkersCannotClaimTheSameTask() throws Exception {
        var projectId = createProject("concurrent-claim");
        var firstSecret = registerWorker("worker-a", new String[]{"windows", "java"});
        var secondSecret = registerWorker("worker-b", new String[]{"windows", "java"});
        mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted());
        var first = CompletableFuture.supplyAsync(() -> claimStatus("worker-a", firstSecret));
        var second = CompletableFuture.supplyAsync(() -> claimStatus("worker-b", secondSecret));
        var statuses = java.util.List.of(first.join(), second.join());
        assertThat(statuses).containsExactlyInAnyOrder(200, 204);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM test_tasks WHERE status='RUNNING'", Long.class)).isEqualTo(1L);
    }

    @Test
    void createTaskAndWebhookAreIdempotent() throws Exception {
        var projectId = createProject("billing");

        var first = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test","idempotencyKey":"manual-key-1"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var second = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test","idempotencyKey":"manual-key-1"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        assertThat(JSON.readTree(first).path("id").asText()).isEqualTo(JSON.readTree(second).path("id").asText());

        var release = mvc.perform(post("/api/webhooks/version-release").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","version":"v1.2.0","testTypes":["unit","regression"]}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var releaseAgain = mvc.perform(post("/api/webhooks/version-release").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","version":"v1.2.0","testTypes":["unit","regression"]}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        assertThat(JSON.readTree(release).path("id").asText()).isEqualTo(JSON.readTree(releaseAgain).path("id").asText());
        assertThat(auditCount("task.create.duplicate")).isGreaterThanOrEqualTo(2);
    }

    @Test
    void concurrentSchedulersCreateOneTaskPerOccurrence() throws Exception {
        var projectId = createProject("scheduled-once");
        mvc.perform(post("/api/schedules").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","intervalMinutes":5,"enabled":true}
                """.formatted(projectId))).andExpect(status().isOk());
        jdbc.update("UPDATE schedules SET next_run_at=?", Timestamp.from(Instant.now().minusSeconds(1)));

        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var first = executor.submit(() -> controlService.schedule());
            var second = executor.submit(() -> controlService.schedule());
            first.get();
            second.get();
        } finally {
            executor.shutdownNow();
        }

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM test_tasks WHERE trigger_type LIKE 'schedule:%'", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE actor='schedule' AND action='task.create'", Long.class)).isEqualTo(1L);
    }

    @Test
    void reportExportSupportsJsonAndJunit() throws Exception {
        var projectId = createProject("report");
        var workerSecret = registerWorker("worker-1", new String[]{"windows", "java"});
        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"ok"}],"report":{"passed":2,"failed":0,"coverage":80},"artifacts":[]}}
                """)).andExpect(status().isOk());

        mvc.perform(get("/api/tasks/{id}/report", taskId).headers(auth()).param("format", "json"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.taskId").value(taskId))
                .andExpect(jsonPath("$.report.passed").value(2));

        mvc.perform(get("/api/tasks/{id}/report", taskId).headers(auth()).param("format", "junit"))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("<testsuite")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("tests=\"2\"")));
    }

    @Test
    void openApiDocsAvailable() throws Exception {
        mvc.perform(get("/v3/api-docs")).andExpect(status().isOk())
                .andExpect(jsonPath("$.info.title").value("CIMDEV Test Agent API"));
    }

    @Test
    void tracingProducesTraceId() {
        var span = applicationContext.getBean(io.micrometer.tracing.Tracer.class).nextSpan().start();
        try {
            var traceId = span.context().traceId();
            org.assertj.core.api.Assertions.assertThat(traceId).isNotBlank();
        } finally {
            span.end();
        }
    }

    @org.springframework.beans.factory.annotation.Autowired
    private org.springframework.context.ApplicationContext applicationContext;

    @org.springframework.beans.factory.annotation.Autowired
    private TaskStore taskStore;

    @Test
    void concurrentLogWritesReturnTheirOwnGeneratedIds() throws Exception {
        var projectId = createProject("concurrent-logs");
        var taskBody = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(taskBody).path("id").asText();

        var executor = java.util.concurrent.Executors.newFixedThreadPool(8);
        try {
            var futures = new java.util.ArrayList<java.util.concurrent.Future<ApiModels.TaskLog>>();
            for (var index = 0; index < 32; index++) {
                var message = "parallel-log-" + index;
                futures.add(executor.submit(() -> taskStore.appendLog(taskId, "info", message)));
            }
            var ids = new java.util.HashSet<Long>();
            for (var future : futures) ids.add(future.get().id());
            assertThat(ids).hasSize(32);
        } finally {
            executor.shutdownNow();
        }
    }

    private String createProject(String name) throws Exception {
        var response = mvc.perform(post("/api/projects").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"name":"%s","projectPath":"C:/works/%s","defaultVersion":"main","defaultTestTypes":["unit"]}
                """.formatted(name, name))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return JSON.readTree(response).path("id").asText();
    }

    private String registerWorker(String id, String[] capabilities) throws Exception {
        var response = mvc.perform(post("/api/workers/register").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"id":"%s","name":"%s","capabilities":%s}
                """.formatted(id, id, JSON.writeValueAsString(capabilities)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        var secret = JSON.readTree(response).path("secret").asText();
        assertThat(secret).isNotBlank();
        return secret;
    }

    private long auditCount(String action) {
        var count = jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE action=?", Long.class, action);
        return count == null ? 0 : count;
    }

    private org.springframework.test.web.servlet.ResultActions claim(String workerId, String secret) throws Exception {
        return mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker(workerId, secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"%s","capabilities":["windows","java"]}
                """.formatted(workerId)));
    }

    private int claimStatus(String workerId, String secret) {
        try { return claim(workerId, secret).andReturn().getResponse().getStatus(); }
        catch (Exception error) { throw new RuntimeException(error); }
    }

    private org.springframework.http.HttpHeaders auth() {
        var headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(TOKEN);
        return headers;
    }

    private org.springframework.http.HttpHeaders role(String token) {
        var headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private org.springframework.http.HttpHeaders worker(String id, String secret) {
        var headers = new org.springframework.http.HttpHeaders();
        headers.set("X-Worker-Id", id);
        headers.set("X-Worker-Secret", secret);
        return headers;
    }
}
