package com.cimdev.testagent;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;

@Component("runtimeReadiness")
class RuntimeReadinessHealthIndicator implements HealthIndicator {
    private final boolean authenticationConfigured;
    private final Path storageRoot;
    private final int leaseSeconds;

    RuntimeReadinessHealthIndicator(@Value("${test-agent.api-token:}") String legacyTokens,
                                    @Value("${test-agent.role-tokens:}") String roleTokens,
                                    @Value("${test-agent.storage-root}") String storageRoot,
                                    @Value("${test-agent.task-lease-seconds}") int leaseSeconds) {
        this.authenticationConfigured = !legacyTokens.isBlank() || !roleTokens.isBlank();
        this.storageRoot = Path.of(storageRoot).toAbsolutePath().normalize();
        this.leaseSeconds = leaseSeconds;
    }

    @Override
    public Health health() {
        var storageWritable = Files.isDirectory(storageRoot) && Files.isWritable(storageRoot);
        // Workers renew every 15 seconds; two intervals tolerate routine scheduling jitter.
        var leaseSafe = leaseSeconds >= 30;
        var builder = authenticationConfigured && storageWritable && leaseSafe
                ? Health.up()
                : Health.down();
        return builder
                .withDetail("authenticationConfigured", authenticationConfigured)
                .withDetail("storageWritable", storageWritable)
                .withDetail("leaseSafe", leaseSafe)
                .build();
    }
}
