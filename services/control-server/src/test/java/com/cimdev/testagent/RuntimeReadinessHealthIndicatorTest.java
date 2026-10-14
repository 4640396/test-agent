package com.cimdev.testagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.actuate.health.Status;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class RuntimeReadinessHealthIndicatorTest {
    @TempDir Path storageRoot;

    @Test
    void reportsUpOnlyWhenAuthenticationStorageAndLeaseAreSafe() {
        var ready = new RuntimeReadinessHealthIndicator("", "worker=secret", storageRoot.toString(), 60).health();
        assertThat(ready.getStatus()).isEqualTo(Status.UP);
        assertThat(ready.getDetails()).containsEntry("authenticationConfigured", true)
                .containsEntry("storageWritable", true)
                .containsEntry("leaseSafe", true);

        assertThat(new RuntimeReadinessHealthIndicator("", "", storageRoot.toString(), 60).health().getStatus())
                .isEqualTo(Status.DOWN);
        assertThat(new RuntimeReadinessHealthIndicator("token", "", storageRoot.toString(), 15).health().getStatus())
                .isEqualTo(Status.DOWN);
        assertThat(new RuntimeReadinessHealthIndicator("token", "", storageRoot.resolve("missing").toString(), 60).health().getStatus())
                .isEqualTo(Status.DOWN);
    }
}
