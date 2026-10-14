package com.cimdev.testagent;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class OpenApiConfig {
    @Bean
    OpenAPI testAgentOpenApi() {
        return new OpenAPI().info(new Info()
                .title("CIMDEV Test Agent API")
                .version("0.1.0")
                .description("Java 控制面权威 API 契约（阶段 5 OpenAPI 落地）"));
    }
}
