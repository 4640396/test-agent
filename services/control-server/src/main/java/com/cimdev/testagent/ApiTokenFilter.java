package com.cimdev.testagent;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@Component
class ApiTokenFilter extends OncePerRequestFilter {
    private static final Set<String> ROLES = Set.of("admin", "operator", "viewer", "worker");
    private record Credential(String role, byte[] token) {}
    private final List<Credential> credentials;

    ApiTokenFilter(@Value("${test-agent.api-token:}") String legacyTokens,
                   @Value("${test-agent.role-tokens:}") String roleTokens) {
        var parsed = new ArrayList<Credential>();
        for (var token : legacyTokens.split(",")) add(parsed, "admin", token);
        for (var assignment : roleTokens.split(";")) {
            if (assignment.isBlank()) continue;
            var parts = assignment.split("=", 2);
            if (parts.length != 2 || !ROLES.contains(parts[0].trim())) throw new IllegalArgumentException("非法角色Token配置：" + assignment);
            for (var token : parts[1].split("\\|")) add(parsed, parts[0].trim(), token);
        }
        this.credentials = List.copyOf(parsed);
    }

    private static void add(List<Credential> target, String role, String value) {
        var token = value.trim();
        if (!token.isEmpty()) target.add(new Credential(role, token.getBytes(StandardCharsets.UTF_8)));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        var uri = request.getRequestURI();
        if ((uri.equals("/actuator/health") || uri.startsWith("/actuator/health/"))
                || uri.startsWith("/v3/api-docs") || uri.startsWith("/swagger-ui") || uri.equals("/swagger-ui.html")) {
            chain.doFilter(request, response);
            return;
        }
        var role = authenticate(request.getHeader("Authorization"));
        if (role == null) { reject(response, HttpServletResponse.SC_UNAUTHORIZED, "Unauthorized"); return; }
        if (!authorized(role, request.getMethod(), uri)) { reject(response, HttpServletResponse.SC_FORBIDDEN, "Forbidden"); return; }
        request.setAttribute("test-agent.role", role);
        chain.doFilter(request, response);
    }

    private String authenticate(String supplied) {
        if (supplied == null || !supplied.startsWith("Bearer ")) return null;
        var candidate = supplied.substring("Bearer ".length()).getBytes(StandardCharsets.UTF_8);
        for (var credential : credentials) if (MessageDigest.isEqual(candidate, credential.token())) return credential.role();
        return null;
    }

    private boolean authorized(String role, String method, String uri) {
        if (role.equals("admin")) return true;
        if (role.equals("worker")) return uri.startsWith("/api/worker/") || uri.equals("/api/workers/register")
                || (uri.startsWith("/api/workers/") && uri.endsWith("/heartbeat"));
        if (role.equals("viewer")) return method.equals("GET") && !uri.equals("/api/audit");
        return role.equals("operator") && !uri.equals("/api/audit") && !uri.startsWith("/api/worker/");
    }

    private void reject(HttpServletResponse response, int status, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"error\":\"" + message + "\"}");
    }
}
