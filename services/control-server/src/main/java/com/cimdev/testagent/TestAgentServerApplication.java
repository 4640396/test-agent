package com.cimdev.testagent;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class TestAgentServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(TestAgentServerApplication.class, args);
    }
}
