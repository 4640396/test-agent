package com.cxmt.testagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.parallel.ExecutionMode;
import org.junit.jupiter.api.parallel.Execution;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.AbstractMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * ReflectTestRunner —— 反射场景驱动测试引擎。
 *
 * 由 test-agent 的 reflect_test 工具注入到被测项目 src/test/java/com/cxmt/testagent/。
 * 读 JSON 场景文件（-DscenarioFile / -DscenarioFiles / -DscenarioDir / -Dscenarios）
 * → 反射调目标方法 → 断言 → 走 surefire 报告。
 *
 * R1 支持：
 * - 方法反射（纯 POJO：new ClassName() 实例化）
 * - 返回值断言（assertion.type=return）
 * - 异常断言（assertion.type=exception）
 *
 * P2-1 支持：
 * - Spring Boot Context 注入（setup.springContext=true 时 SpringApplication.run + getBean，
 *   失败/无 Spring 降级纯 POJO + 标 [需人工复核]）
 * - classpath 扫描 @SpringBootApplication 主类（setup.mainClass 指定时优先使用）
 *
 * P2-2 支持：
 * - 批量场景执行（@TestFactory + DynamicTest，每场景独立 surefire 报告）
 * - -DscenarioFiles=a.json,b.json（逗号分隔）或 -DscenarioDir=<dir>（目录所有 .json）
 * - Spring Context 批量间复用（startSpringContext 预加载 + @AfterAll close）
 *
 * 不支持（留后续）：
 * - 方法签名精确消歧（按方法名 + 参数个数匹配，methodSignature 留 R2）
 *
 * P4-2 支持：
 * - 数据库 fixture（setup.fixtures：事务内 INSERT 预置数据，方法执行后回滚不残留）
 * - Mock bean（setup.mocks：仅 interface，Proxy 创建 stub，字段替换 + finally 还原）
 * - 事务隔离（PlatformTransactionManager 反射开事务，同源 Connection，finally 回滚）
 * - 限制：Mock 仅 interface（Proxy 限制）；fixture 需 DataSourceTransactionManager（JTA/Jpa 降级）
 *
 * 依赖：jackson-databind（test classpath，CIMDEV Spring Boot 自带；sample 项目需加 test 依赖）。
 * Spring 相关调用全用反射 Class.forName，不 import，保证无 Spring 项目也能编译。
 */
@Execution(ExecutionMode.SAME_THREAD)
class ReflectTestRunner {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** P2-1: Spring Context 引用，供 @AfterAll close 防泄漏。 */
    private static final ThreadLocal<Object> springContextRef = new ThreadLocal<>();

    /**
     * P2-2: @TestFactory 统一入口（单场景 + 批量）。
     *
     * 删除 R1 的 @Test runScenario()——@Test + @TestFactory 共存会导致单场景双重执行
     * （Tests run: 2），破坏 R1 向后兼容。单场景 + 批量统一走 @TestFactory。
     *
     * scenarioFile → 1 个 DynamicTest（等价 R1 单场景）
     * scenarioFiles/scenarioDir → N 个 DynamicTest
     * scenarios（内联）→ 由工具层持久化为文件后走 scenarioFiles 路径
     */
    @TestFactory
    @DisplayName("reflect-test")
    List<DynamicTest> runScenarios() throws Exception {
        // 1. 解析场景来源
        List<String> files = resolveScenarioFiles();

        // 2. 无任何参数 → 抛异常（不应发生，工具层已守卫）
        if (files.isEmpty()) {
            throw new IllegalStateException(
                "reflect_test 需要 scenarioFile / scenarioFiles / scenarioDir / scenarios 参数（至少一个）");
        }

        // 3. 加载全部场景 JSON
        List<JsonNode> scenarios = new ArrayList<>();
        for (String file : files) {
            JsonNode s = MAPPER.readTree(new String(
                Files.readAllBytes(Paths.get(file)), StandardCharsets.UTF_8));
            scenarios.add(s);
        }

        // 4. 预加载 Spring Context（只启动 Context，不调 getBean）
        //    各场景独立 getBean + 独立降级
        boolean anySpringNeeded = false;
        for (JsonNode s : scenarios) {
            if (s.at("/setup/springContext").asBoolean(false)) {
                anySpringNeeded = true;
                break;
            }
        }
        if (anySpringNeeded && springContextRef.get() == null) {
            try {
                startSpringContext();
            } catch (Exception e) {
                // Context 启动失败 → 不阻断，各场景独立降级
                System.err.println("[需人工复核] Spring Context 启动失败: " + e.getMessage());
            }
        }

        // 5. 构造 DynamicTest 列表（每场景独立 getBean + 独立降级）
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode scenario : scenarios) {
            String scenarioId = textAt(scenario, "id", "(unknown)");
            tests.add(DynamicTest.dynamicTest(scenarioId, () -> {
                String className = textAt(scenario, "/target/className", null);
                String method = textAt(scenario, "/target/method", null);
                if (className == null || method == null) {
                    throw new IllegalArgumentException(
                        "场景 " + scenarioId + " 缺 target.className 或 target.method");
                }
                runScenarioInternal(scenario, scenarioId, className, method);
            }));
        }
        return tests;
    }

    /**
     * P2-2: 启动 Spring ApplicationContext（不调 getBean）。
     * 启动失败不抛异常，由调用方决定是否降级。
     * 各场景在 runScenarioInternal 里独立调 getBean，独立降级。
     */
    private static void startSpringContext() throws Exception {
        String mainClass = System.getProperty("springMainClass");
        if (mainClass == null || mainClass.trim().isEmpty()) {
            mainClass = scanForSpringBootApplicationClassName();
        }
        if (mainClass == null) {
            throw new IllegalStateException("未找到 @SpringBootApplication 主类");
        }
        Class<?> appClass = Class.forName(mainClass);
        Class<?> springAppClass = Class.forName("org.springframework.boot.SpringApplication");
        Method runMethod = springAppClass.getMethod("run", Class.class, String[].class);
        Object ctx = runMethod.invoke(null, appClass, new String[0]);
        springContextRef.set(ctx);  // set 在 getBean 前，防 getBean 失败时 Context 泄漏
    }

    /** P2-2: @AfterAll 关闭 Spring Context 防泄漏。 */
    @AfterAll
    static void tearDownSpringContext() {
        Object ctx = springContextRef.get();
        if (ctx != null) {
            try {
                ctx.getClass().getMethod("close").invoke(ctx);
            } catch (Exception ignored) {
                // 关闭失败不影响测试结果
            }
            springContextRef.remove();
        }
    }

    /**
     * P2-2: 解析场景文件列表（统一处理 scenarioFile + scenarioFiles + scenarioDir）。
     *
     * @return 场景文件路径列表（可能为空）
     */
    private static List<String> resolveScenarioFiles() {
        List<String> files = new ArrayList<>();

        // 0. -DscenarioFile=<file>（单条，R1 兼容）
        String scenarioFile = System.getProperty("scenarioFile");
        if (scenarioFile != null && !scenarioFile.trim().isEmpty()) {
            files.add(scenarioFile.trim());
        }

        // 1. -DscenarioFiles=a.json,b.json（逗号分隔）
        String scenarioFilesProp = System.getProperty("scenarioFiles");
        if (scenarioFilesProp != null && !scenarioFilesProp.trim().isEmpty()) {
            for (String f : scenarioFilesProp.split(",")) {
                String trimmed = f.trim();
                if (!trimmed.isEmpty()) files.add(trimmed);
            }
        }

        // 2. -DscenarioDir=<dir>（目录内所有 .json）
        String scenarioDir = System.getProperty("scenarioDir");
        if (scenarioDir != null && !scenarioDir.trim().isEmpty()) {
            Path dir = Paths.get(scenarioDir);
            if (Files.isDirectory(dir)) {
                try (java.util.stream.Stream<Path> stream = Files.list(dir)) {
                    List<String> dirFiles = stream
                        .filter(p -> p.toString().endsWith(".json"))
                        .sorted()
                        .map(Path::toString)
                        .collect(Collectors.toList());
                    files.addAll(dirFiles);
                } catch (Exception ignored) { }
            }
        }

        return files;
    }

    private void runScenarioInternal(JsonNode scenario, String scenarioId, String className, String method) throws Exception {
        // 1. 实例化目标（Spring 可选降级）
        Class<?> targetClass = Class.forName(className);
        Object target;
        boolean springDegraded = false;
        boolean springRequested = scenario.at("/setup/springContext").asBoolean(false);
        if (springRequested) {
            // P2-2: 检查预加载的 Context（批量模式 startSpringContext 已启动）
            Object existingCtx = springContextRef.get();
            if (existingCtx != null) {
                // Context 已预加载——每条场景独立 getBean，独立降级
                try {
                    Class<?> ctxClass = Class.forName("org.springframework.context.ApplicationContext");
                    Method getBeanMethod = ctxClass.getMethod("getBean", Class.class);
                    target = getBeanMethod.invoke(existingCtx, targetClass);
                } catch (Exception e) {
                    // bean 不存在或 getBean 失败 → 该场景独立降级，不影响其他场景
                    springDegraded = true;
                    target = newInstanceOf(targetClass);
                }
            } else {
                // Context 未启动（预加载失败或单场景首次）→ 照 P2-1 逻辑尝试启动 + getBean
                try {
                    target = trySpringGetBean(targetClass, scenario.at("/setup"));
                    if (target == null) {
                        springDegraded = true;
                        target = newInstanceOf(targetClass);
                    }
                } catch (Exception e) {
                    springDegraded = true;
                    target = newInstanceOf(targetClass);
                }
            }
        } else {
            target = newInstanceOf(targetClass);
        }

        // 2. 解析参数
        JsonNode paramsNode = scenario.at("/params");
        List<Object> paramValues = new ArrayList<>();
        List<Class<?>> paramTypes = new ArrayList<>();
        if (paramsNode.isArray()) {
            for (JsonNode p : paramsNode) {
                String ptype = textAt(p, "type", null);
                if (ptype == null) throw new IllegalArgumentException("场景 " + scenarioId + " 参数缺 type");
                Class<?> pclazz = resolveClass(ptype);
                paramTypes.add(pclazz);
                JsonNode valueNode = p.get("value");
                if (valueNode == null || valueNode.isNull()) {
                    paramValues.add(null);
                } else {
                    paramValues.add(MAPPER.convertValue(valueNode, pclazz));
                }
            }
        }

        // 3. P4-2: 判断是否需要 fixture/Mock/事务
        JsonNode setupNode = scenario.at("/setup");
        JsonNode fixturesNode = setupNode.at("/fixtures");
        JsonNode mocksNode = setupNode.at("/mocks");
        boolean hasFixtures = fixturesNode.isArray() && !fixturesNode.isEmpty();
        boolean hasMocks = mocksNode.isArray() && !mocksNode.isEmpty();
        boolean needsTxOrMock = hasFixtures || hasMocks;

        // 纯 POJO 场景 + fixtures → 矛盾，忽略 + warning
        if (!springRequested && hasFixtures) {
            System.err.println("[warning] 场景 " + scenarioId + ": fixtures 需要 springContext=true，已忽略");
            hasFixtures = false;
            needsTxOrMock = hasMocks; // Mock 在纯 POJO 下也尝试
        }

        // 4. P4-2: 开启事务 + 插入 fixture + Mock 替换（如果需要）
        Object txStatus = null;
        Object txManager = null;
        List<Map.Entry<Field, Object>> originalFieldValues = new ArrayList<>();
        boolean fixtureDegraded = false;

        if (needsTxOrMock && springContextRef.get() != null) {
            Object ctx = springContextRef.get();

            // 4a. 开启事务（全反射，不 import Spring）——仅当有 fixtures 时
            if (hasFixtures) {
                try {
                    Class<?> txManagerClass = Class.forName("org.springframework.transaction.PlatformTransactionManager");
                    Class<?> ctxClass = Class.forName("org.springframework.context.ApplicationContext");
                    Method ctxGetBean = ctxClass.getMethod("getBean", Class.class);
                    txManager = ctxGetBean.invoke(ctx, txManagerClass);

                    // R3 边界：检查是否 DataSourceTransactionManager（JTA/Jpa 降级）
                    Class<?> dstmClass = Class.forName("org.springframework.jdbc.datasource.DataSourceTransactionManager");
                    if (!dstmClass.isInstance(txManager)) {
                        System.err.println("[需人工复核] 场景 " + scenarioId + ": 事务管理器非 DataSourceTransactionManager (" + txManager.getClass().getName() + ")，fixture 回滚不保证，已跳过 fixture");
                        fixtureDegraded = true;
                        hasFixtures = false;
                        txManager = null;
                    }
                } catch (Exception e) {
                    System.err.println("[需人工复核] 场景 " + scenarioId + ": 获取 PlatformTransactionManager 失败: " + e.getMessage() + "，fixture 已跳过");
                    fixtureDegraded = true;
                    hasFixtures = false;
                    txManager = null;
                }

                if (txManager != null) {
                    try {
                        Class<?> tdClass = Class.forName("org.springframework.transaction.TransactionDefinition");
                        Class<?> dtdClass = Class.forName("org.springframework.transaction.support.DefaultTransactionDefinition");
                        Object td = dtdClass.getDeclaredConstructor().newInstance();
                        Class<?> txManagerClass = Class.forName("org.springframework.transaction.PlatformTransactionManager");
                        Method getTransaction = txManagerClass.getMethod("getTransaction", tdClass);
                        txStatus = getTransaction.invoke(txManager, td);
                    } catch (Exception e) {
                        System.err.println("[需人工复核] 场景 " + scenarioId + ": 开启事务失败: " + e.getMessage() + "，fixture 已跳过");
                        fixtureDegraded = true;
                        hasFixtures = false;
                        txManager = null;
                    }
                }
            }

            // 4b. 插入 fixture（用事务绑定的 Connection，R3 修复）
            if (hasFixtures && txStatus != null) {
                try {
                    Object ctx2 = springContextRef.get();
                    Class<?> ctxClass2 = Class.forName("org.springframework.context.ApplicationContext");
                    Method ctxGetBean2 = ctxClass2.getMethod("getBean", Class.class);
                    Class<?> dsClass = Class.forName("javax.sql.DataSource");
                    Object dataSource = ctxGetBean2.invoke(ctx2, dsClass);

                    // 用 DataSourceUtils 拿事务绑定的 Connection（不是裸 dataSource.getConnection()）
                    Class<?> dsuClass = Class.forName("org.springframework.jdbc.datasource.DataSourceUtils");
                    Method getConnection = dsuClass.getMethod("getConnection", dsClass);
                    Connection conn = (Connection) getConnection.invoke(null, dataSource);

                    for (JsonNode fx : fixturesNode) {
                        String table = textAt(fx, "table", null);
                        if (table == null) throw new IllegalArgumentException("场景 " + scenarioId + " fixture 缺 table");
                        JsonNode rowsNode = fx.at("/rows");
                        if (!rowsNode.isArray()) continue;
                        for (JsonNode row : rowsNode) {
                            List<String> columns = new ArrayList<>();
                            List<String> placeholders = new ArrayList<>();
                            row.fieldNames().forEachRemaining(columns::add);
                            for (int i = 0; i < columns.size(); i++) placeholders.add("?");
                            String sql = "INSERT INTO " + table + " (" + String.join(", ", columns) + ") VALUES (" + String.join(", ", placeholders) + ")";
                            try (PreparedStatement ps = conn.prepareStatement(sql)) {
                                int i = 1;
                                for (String col : columns) {
                                    JsonNode valNode = row.get(col);
                                    if (valNode == null || valNode.isNull()) {
                                        ps.setNull(i++, java.sql.Types.NULL);
                                    } else if (valNode.isNumber()) {
                                        ps.setObject(i++, MAPPER.convertValue(valNode, Object.class));
                                    } else if (valNode.isBoolean()) {
                                        ps.setBoolean(i++, valNode.asBoolean());
                                    } else {
                                        ps.setString(i++, valNode.asText());
                                    }
                                }
                                ps.executeUpdate();
                            }
                        }
                    }
                    // 不关 conn——事务绑定的 Connection 由 PlatformTransactionManager.rollback 管理
                } catch (Exception e) {
                    // fixture INSERT 失败 → 场景失败（不降级，用户明确要求 fixture）
                    throw new AssertionError("场景 " + scenarioId + " fixture 插入失败: " + e.getMessage(), e);
                }
            }

            // 4c. Mock 字段替换（R4：记录原值，finally 还原）
            if (hasMocks) {
                applyMocks(target, mocksNode, scenarioId, originalFieldValues);
            }
        } else if (needsTxOrMock && springContextRef.get() == null) {
            // Spring Context 不可用 → fixture/Mock 不可执行
            if (hasFixtures) {
                System.err.println("[需人工复核] 场景 " + scenarioId + ": Spring Context 不可用，fixture 已跳过");
                fixtureDegraded = true;
            }
            if (hasMocks) {
                System.err.println("[需人工复核] 场景 " + scenarioId + ": Spring Context 不可用，Mock 已跳过");
            }
        }

        // 5. 反射调方法（P5: 优先按 methodSignature 精确消歧，未提供时按方法名 + 参数个数匹配）
        String methodSignature = textAt(scenario, "/target/methodSignature", null);
        Method reflectMethod;
        if (methodSignature != null && !methodSignature.trim().isEmpty()) {
            reflectMethod = findMethodBySignature(targetClass, method, methodSignature, paramTypes.size(), scenarioId);
        } else {
            reflectMethod = findMethod(targetClass, method, paramTypes.size());
        }
        reflectMethod.setAccessible(true);
        Object returnValue;
        try {
            returnValue = reflectMethod.invoke(target, paramValues.toArray());
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause();
            // 异常断言：检查是否是期望异常
            JsonNode assertion = scenario.at("/assertion");
            String assertType = textAt(assertion, "type", null);
            if ("exception".equals(assertType) && cause != null) {
                checkException(assertion, cause, scenarioId, springDegraded);
                return; // 异常断言通过
            }
            // 非期望异常：重抛让 surefire 记录
            if (cause != null) {
              throw new AssertionError("场景 " + scenarioId + " 抛非期望异常: " + cause, cause);
            } else {
              throw e;
            }
        } finally {
            // P4-2: finally 回滚事务 + 还原 Mock 字段
            if (txStatus != null && txManager != null) {
                try {
                    Class<?> txManagerClass = Class.forName("org.springframework.transaction.PlatformTransactionManager");
                    Class<?> tsClass = Class.forName("org.springframework.transaction.TransactionStatus");
                    Method rollback = txManagerClass.getMethod("rollback", tsClass);
                    rollback.invoke(txManager, txStatus);
                } catch (Exception e) {
                    System.err.println("[warning] 场景 " + scenarioId + ": 事务回滚失败: " + e.getMessage());
                }
            }
            // R4: 还原 Mock 字段
            if (!originalFieldValues.isEmpty()) {
                restoreMockedFields(target, originalFieldValues);
            }
        }

        // 6. 返回值断言
        JsonNode assertion = scenario.at("/assertion");
        String assertType = textAt(assertion, "type", null);
        if ("return".equals(assertType)) {
            checkReturn(assertion, returnValue, scenarioId, springDegraded || fixtureDegraded);
        } else if ("exception".equals(assertType)) {
            throw new AssertionError("场景 " + scenarioId + " 期望抛异常但正常返回: " + returnValue);
        }
    }

    // --- Spring 反射加载（不 import Spring，无 Spring 时 ClassNotFoundException 降级）---

    /**
     * P2-1: 真实实现 Spring Boot Context 注入。
     *
     * 1. 检查 classpath 有无 Spring Boot（Class.forName SpringApplication）
     * 2. 找主类：setup.mainClass 优先，未指定时扫 target/classes/
     * 3. SpringApplication.run(mainClass, args) 启动 Context
     * 4. springContextRef.set(ctx) —— 在 getBean 之前注册，防止 getBean 失败时 Context 泄漏
     * 5. ctx.getBean(targetClass) 拿依赖注入的 bean
     *
     * 任一步骤失败返回 null（降级 POJO）或抛异常（外层 catch 降级）。
     */
    private static Object trySpringGetBean(Class<?> targetClass, JsonNode setup) throws Exception {
        // 1. 检查 classpath 有无 Spring Boot
        Class<?> springAppClass;
        try {
            springAppClass = Class.forName("org.springframework.boot.SpringApplication");
        } catch (ClassNotFoundException e) {
            return null; // 无 Spring Boot → 降级
        }

        // 2. 找主类：setup.mainClass 优先，未指定时扫 target/classes/
        String mainClassName = textAt(setup, "/mainClass", null);
        Class<?> mainClass;
        if (mainClassName != null && !mainClassName.isEmpty()) {
            mainClass = Class.forName(mainClassName);
        } else {
            String foundClassName = scanForSpringBootApplicationClassName();
            if (foundClassName == null) return null; // 找不到主类 → 降级
            mainClass = Class.forName(foundClassName);
        }

        // 3. SpringApplication.run(mainClass, args) 启动 Context
        Method runMethod = springAppClass.getMethod("run", Class.class, String[].class);
        Object ctx = runMethod.invoke(null, mainClass, new String[0]);

        // 4. springContextRef.set(ctx) —— 在 getBean 之前注册，防止 getBean 失败时 Context 泄漏
        springContextRef.set(ctx);

        // 5. ctx.getBean(targetClass) 拿依赖注入的 bean
        Class<?> ctxClass = Class.forName("org.springframework.context.ApplicationContext");
        Method getBeanMethod = ctxClass.getMethod("getBean", Class.class);
        return getBeanMethod.invoke(ctx, targetClass);
    }

    /**
     * 扫 target/classes/ 和 target/test-classes/ 目录，找 @SpringBootApplication 主类。
     * 只扫编译输出目录（Maven 标准），不扫 JAR。classpath 扫描仅支持 Maven 标准输出目录，Gradle 不支持。
     * @return 主类全限定名，未找到返回 null
     */
    private static String scanForSpringBootApplicationClassName() {
        try {
            Class<?> springBootAppAnnotation = Class.forName("org.springframework.boot.autoconfigure.SpringBootApplication");
            String classPath = System.getProperty("java.class.path");
            String separator = System.getProperty("path.separator");
            ClassLoader cl = Thread.currentThread().getContextClassLoader();
            if (cl == null) cl = ClassLoader.getSystemClassLoader();
            for (String entry : classPath.split(separator)) {
                if (!entry.endsWith("target/classes") && !entry.endsWith("target\\\\classes")
                    && !entry.endsWith("target/test-classes") && !entry.endsWith("target\\\\test-classes")) {
                    continue;
                }
                Path base = Paths.get(entry);
                if (!Files.isDirectory(base)) continue;
                List<String> classNames = new ArrayList<>();
                scanClassFiles(base, base, classNames);
                for (String cn : classNames) {
                    try {
                        Class<?> c = Class.forName(cn, false, cl);
                        @SuppressWarnings("unchecked")
                        Class<? extends java.lang.annotation.Annotation> annClass =
                            (Class<? extends java.lang.annotation.Annotation>) springBootAppAnnotation;
                        if (c.getAnnotation(annClass) != null) {
                            return cn;
                        }
                    } catch (Throwable ignored) {
                        // 跳过无法加载的类
                    }
                }
            }
        } catch (Exception ignored) {
            // 扫描失败 → 返回 null 降级
        }
        return null;
    }

    /** 递归扫 .class 文件转类名（跳过内部类 $）。 */
    private static void scanClassFiles(Path base, Path dir, List<String> result) throws Exception {
        try (java.util.stream.Stream<Path> stream = Files.list(dir)) {
            for (Path p : (Iterable<Path>) stream::iterator) {
                if (Files.isDirectory(p)) {
                    scanClassFiles(base, p, result);
                } else if (p.toString().endsWith(".class") && !p.getFileName().toString().contains("$")) {
                    String relative = base.relativize(p).toString().replace(File.separatorChar, '.');
                    String className = relative.substring(0, relative.length() - 6); // 去掉 .class
                    result.add(className);
                }
            }
        }
    }

    // --- P4-2: Mock bean + fixture 辅助方法 ---

    /**
     * P4-2: Mock 字段替换（路径 A：Field.set + Proxy，仅 interface）。
     * 遍历 target 字段，类型匹配 mocks[].bean 的 → 替换为 Proxy 实例 + 记录原值。
     */
    private static void applyMocks(Object target, JsonNode mocksNode, String scenarioId,
                                    List<Map.Entry<Field, Object>> originalFieldValues) throws Exception {
        ClassLoader cl = Thread.currentThread().getContextClassLoader();
        if (cl == null) cl = ClassLoader.getSystemClassLoader();

        for (JsonNode mockCfg : mocksNode) {
            String beanName = textAt(mockCfg, "bean", null);
            if (beanName == null) {
                System.err.println("[warning] 场景 " + scenarioId + ": mock 缺 bean 字段，跳过");
                continue;
            }
            Class<?> mockType;
            try {
                mockType = Class.forName(beanName);
            } catch (ClassNotFoundException e) {
                System.err.println("[warning] 场景 " + scenarioId + ": Mock bean 类未找到: " + beanName + "，跳过");
                continue;
            }
            if (mockType.isInterface()) {
                // interface 路径：Proxy.newProxyInstance（P4-2 原路径，不变）
                Object mockProxy = buildInterfaceMock(mockType, mockCfg.at("/stubs"), cl, scenarioId, beanName);
                replaceMockFields(target, mockType, mockProxy, originalFieldValues);
            } else {
                // P5: class 路径——ByteBuddy subclassing（全反射，不 import ByteBuddy）
                Object classMock = buildClassMock(mockType, mockCfg.at("/stubs"), cl, scenarioId, beanName);
                if (classMock != null) {
                    replaceMockFields(target, mockType, classMock, originalFieldValues);
                }
                // classMock == null → buildClassMock 已打 warning，跳过
            }
        }
    }

    /** P5: interface Mock——Proxy.newProxyInstance（原 P4-2 逻辑抽方法）。 */
    private static Object buildInterfaceMock(Class<?> mockType, JsonNode stubsNode, ClassLoader cl,
                                              String scenarioId, String beanName) {
        return Proxy.newProxyInstance(
            cl, new Class<?>[]{mockType},
            (proxy, method, args) -> {
                if (stubsNode != null && stubsNode.isArray()) {
                    for (JsonNode stub : stubsNode) {
                        String stubMethod = textAt(stub, "method", null);
                        if (method.getName().equals(stubMethod)) {
                            JsonNode retValNode = stub.get("returnValue");
                            if (retValNode == null || retValNode.isNull()) return null;
                            return MAPPER.convertValue(retValNode, method.getReturnType());
                        }
                    }
                }
                return defaultReturnValue(method.getReturnType());
            }
        );
    }

    /**
     * P5: class Mock——ByteBuddy subclassing（全反射 Class.forName，不 import ByteBuddy）。
     * 对每个 stub.method 配 FixedValue.value(returnValue)。未配 stub 的方法走 super 原实现。
     * 降级：final/sealed class、ByteBuddy 不在 classpath、构造不可达 → warning + 返回 null。
     */
    private static Object buildClassMock(Class<?> mockType, JsonNode stubsNode, ClassLoader cl,
                                          String scenarioId, String beanName) {
        // final/sealed class 不能 subclass
        if (java.lang.reflect.Modifier.isFinal(mockType.getModifiers())) {
            System.err.println("[需人工复核] 场景 " + scenarioId + ": class Mock 不支持 final class，跳过 " + beanName);
            return null;
        }
        Object byteBuddy;
        try {
            byteBuddy = Class.forName("net.bytebuddy.ByteBuddy").getDeclaredConstructor().newInstance();
        } catch (Exception e) {
            System.err.println("[需人工复核] 场景 " + scenarioId + ": ByteBuddy 不在 classpath，class Mock 跳过 " + beanName + "（interface Mock 不受影响）");
            return null;
        }
        try {
            // new ByteBuddy().subclass(mockType)
            Method subclassMethod = byteBuddy.getClass().getMethod("subclass", Class.class);
            Object dynamicType = subclassMethod.invoke(byteBuddy, mockType);
            // 对每个 stub 配 method(name).intercept(FixedValue.value(retVal))
            if (stubsNode != null && stubsNode.isArray()) {
                for (JsonNode stub : stubsNode) {
                    String stubMethod = textAt(stub, "method", null);
                    if (stubMethod == null) continue;
                    JsonNode retValNode = stub.get("returnValue");
                    Object fixedValue = (retValNode == null || retValNode.isNull())
                        ? null : MAPPER.convertValue(retValNode, Object.class);
                    // ElementMatchers.named(stubMethod)
                    Class<?> elementMatchersClass = Class.forName("net.bytebuddy.matcher.ElementMatchers");
                    Method namedMethod = elementMatchersClass.getMethod("named", String.class);
                    Object matcher = namedMethod.invoke(null, stubMethod);
                    // FixedValue.value(fixedValue)
                    Class<?> fixedValueClass = Class.forName("net.bytebuddy.implementation.FixedValue");
                    Method valueMethod = fixedValueClass.getMethod("value", Object.class);
                    Object implementation = valueMethod.invoke(null, fixedValue);
                    // dynamicType = dynamicType.method(matcher).intercept(implementation)
                    Method methodMethod = dynamicType.getClass().getMethod("method",
                        Class.forName("net.bytebuddy.matcher.ElementMatcher"));
                    dynamicType = methodMethod.invoke(dynamicType, matcher);
                    Method interceptMethod = dynamicType.getClass().getMethod("intercept",
                        Class.forName("net.bytebuddy.implementation.Implementation"));
                    dynamicType = interceptMethod.invoke(dynamicType, implementation);
                }
            }
            // .make().load(cl).getLoaded() → newInstance()
            Method makeMethod = dynamicType.getClass().getMethod("make");
            Object unloadedType = makeMethod.invoke(dynamicType);
            Method loadMethod = unloadedType.getClass().getMethod("load", ClassLoader.class);
            Object loadedType = loadMethod.invoke(unloadedType, cl);
            Method getLoadedMethod = loadedType.getClass().getMethod("getLoaded");
            Class<?> mockSubclass = (Class<?>) getLoadedMethod.invoke(loadedType);
            return newInstanceOf(mockSubclass);
        } catch (Exception e) {
            System.err.println("[需人工复核] 场景 " + scenarioId + ": class Mock 生成失败: " + beanName + " — " + e.getMessage() + "，跳过");
            return null;
        }
    }

    /** P5: 遍历 target 字段替换 mock 实例 + 记录原值（interface/class 共用）。 */
    private static void replaceMockFields(Object target, Class<?> mockType, Object mockInstance,
                                           List<Map.Entry<Field, Object>> originalFieldValues) throws Exception {
        for (Field f : target.getClass().getDeclaredFields()) {
            if (mockType.isAssignableFrom(f.getType())) {
                f.setAccessible(true);
                originalFieldValues.add(new AbstractMap.SimpleEntry<>(f, f.get(target)));
                f.set(target, mockInstance);
            }
        }
    }

    /** P4-2: R4 还原 Mock 字段（finally 调，防单例字段残留跨场景）。 */
    private static void restoreMockedFields(Object target, List<Map.Entry<Field, Object>> originalFieldValues) {
        for (Map.Entry<Field, Object> entry : originalFieldValues) {
            try {
                entry.getKey().set(target, entry.getValue());
            } catch (Exception ignored) {
                // 还原失败不影响测试结果
            }
        }
    }

    /** P4-2: 无匹配 stub 时返回方法返回类型默认值。 */
    private static Object defaultReturnValue(Class<?> returnType) {
        if (returnType == boolean.class) return false;
        if (returnType == int.class) return 0;
        if (returnType == long.class) return 0L;
        if (returnType == double.class) return 0.0;
        if (returnType == float.class) return 0.0f;
        if (returnType == short.class) return (short) 0;
        if (returnType == byte.class) return (byte) 0;
        if (returnType == char.class) return '\0';
        return null;
    }

    // --- 工具方法 ---
    private static Object newInstanceOf(Class<?> clazz) throws Exception {
        Constructor<?> ctor = clazz.getDeclaredConstructor();
        ctor.setAccessible(true);
        return ctor.newInstance();
    }

    private static Class<?> resolveClass(String name) throws ClassNotFoundException {
        // 基本类型 + 包装类映射
        switch (name) {
            case "int": return int.class;
            case "long": return long.class;
            case "double": return double.class;
            case "float": return float.class;
            case "boolean": return boolean.class;
            case "char": return char.class;
            case "byte": return byte.class;
            case "short": return short.class;
            default: return Class.forName(name);
        }
    }

    private static Method findMethod(Class<?> clazz, String name, int paramCount) throws NoSuchMethodException {
        // 按方法名 + 参数个数匹配（R1 弱消歧，同名同参数个数不同类型重载会匹配错；P5 起建议用 methodSignature 精确消歧）
        for (Method m : clazz.getDeclaredMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == paramCount) {
                return m;
            }
        }
        // 父类
        Class<?> sup = clazz.getSuperclass();
        if (sup != null) return findMethod(sup, name, paramCount);
        throw new NoSuchMethodException(clazz.getName() + "." + name + "(参数个数=" + paramCount + ") 未找到；重载消歧需 methodSignature");
    }

    /**
     * P5: 按 methodSignature 精确消歧。
     * 格式 `(全限定类型,全限定类型)`，基本类型 int/long/double 等，无参 ()。
     * 解析失败 → 降级回 findMethod（名 + 参数个数）+ warning，不阻断。
     */
    private static Method findMethodBySignature(Class<?> clazz, String name, String methodSignature,
                                                  int fallbackParamCount, String scenarioId) throws NoSuchMethodException {
        // 解析签名：去括号 + 按逗号分割
        String inner = methodSignature.trim();
        if (!inner.startsWith("(") || !inner.endsWith(")")) {
            System.err.println("[warning] 场景 " + scenarioId + ": methodSignature 格式非法（需 (type,type)）: " + methodSignature + "，降级按名+参数个数");
            return findMethod(clazz, name, fallbackParamCount);
        }
        inner = inner.substring(1, inner.length() - 1).trim();
        List<Class<?>> sigTypes = new ArrayList<>();
        if (!inner.isEmpty()) {
            String[] typeNames = inner.split(",");
            for (String tn : typeNames) {
                String trimmed = tn.trim();
                if (trimmed.isEmpty()) continue;
                try {
                    sigTypes.add(resolveClass(trimmed));
                } catch (ClassNotFoundException e) {
                    System.err.println("[warning] 场景 " + scenarioId + ": methodSignature 类型未找到: " + trimmed + "，降级按名+参数个数");
                    return findMethod(clazz, name, fallbackParamCount);
                }
            }
        }
        // 优先用 getMethod（精确匹配，public）
        try {
            return clazz.getMethod(name, sigTypes.toArray(new Class<?>[0]));
        } catch (NoSuchMethodException e) {
            // getMethod 找不到（可能是 private 或父类）→ 遍历 getDeclaredMethods 精确匹配
            for (Method m : clazz.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == sigTypes.size()) {
                    Class<?>[] actualTypes = m.getParameterTypes();
                    boolean match = true;
                    for (int i = 0; i < sigTypes.size(); i++) {
                        if (!actualTypes[i].getName().equals(sigTypes.get(i).getName())
                            && !actualTypes[i].equals(sigTypes.get(i))) {
                            match = false;
                            break;
                        }
                    }
                    if (match) return m;
                }
            }
            // 父类
            Class<?> sup = clazz.getSuperclass();
            if (sup != null) {
                try { return findMethodBySignature(sup, name, methodSignature, fallbackParamCount, scenarioId); }
                catch (NoSuchMethodException ignored) { }
            }
            System.err.println("[warning] 场景 " + scenarioId + ": methodSignature 未匹配到方法: " + methodSignature + "，降级按名+参数个数");
            return findMethod(clazz, name, fallbackParamCount);
        }
    }

    /**
     * P5: 返回值断言。按 assertion.match 分支，默认 exact（向后兼容）。
     * match: exact(默认) / prefix / contains / regex / null / ignore
     */
    private static void checkReturn(JsonNode assertion, Object actual, String scenarioId, boolean springDegraded) throws Exception {
        String match = textAt(assertion, "match", "exact");

        // ignore: 跳过返回值断言，只验不抛异常（已在调用处保证未抛异常）
        if ("ignore".equals(match)) {
            return;
        }
        // null: 只验 actual == null
        if ("null".equals(match)) {
            if (actual != null) {
                throw new AssertionError(degradePrefix(springDegraded) + "场景 " + scenarioId + " 返回值断言失败: 期望 null actual=" + actual);
            }
            return;
        }

        // 取 expected 值
        String expectedType = textAt(assertion, "expectedType", null);
        Object expected;
        if (expectedType != null) {
            Class<?> eclazz = resolveClass(expectedType);
            expected = MAPPER.convertValue(assertion.get("expected"), eclazz);
        } else {
            JsonNode expNode = assertion.get("expected");
            expected = expNode == null || expNode.isNull() ? null : MAPPER.treeToValue(expNode, Object.class);
        }

        boolean ok;
        if ("exact".equals(match)) {
            if (actual == null) {
                ok = expected == null;
            } else if (actual instanceof java.math.BigDecimal && expected instanceof java.math.BigDecimal) {
                ok = ((java.math.BigDecimal) actual).compareTo((java.math.BigDecimal) expected) == 0;
            } else {
                ok = actual.equals(expected);
            }
        } else if ("prefix".equals(match)) {
            ok = actual != null && expected != null && actual.toString().startsWith(expected.toString());
        } else if ("contains".equals(match)) {
            ok = actual != null && expected != null && actual.toString().contains(expected.toString());
        } else if ("regex".equals(match)) {
            if (actual == null || expected == null) {
                ok = actual == null && expected == null;
            } else {
                ok = java.util.regex.Pattern.compile(expected.toString())
                        .matcher(actual.toString()).matches();
            }
        } else {
            System.err.println("[warning] 场景 " + scenarioId + ": assertion.match 未知值: " + match + "，降级 exact");
            if (actual == null) {
                ok = expected == null;
            } else {
                ok = actual.equals(expected);
            }
        }
        if (!ok) {
            throw new AssertionError(degradePrefix(springDegraded) + "场景 " + scenarioId + " 返回值断言失败(match=" + match + "): expected=" + expected + " actual=" + actual);
        }
    }

    private static void checkException(JsonNode assertion, Throwable cause, String scenarioId, boolean springDegraded) throws Exception {
        String expectedException = textAt(assertion, "expectedException", null);
        String expectedMessage = textAt(assertion, "expectedMessage", null);
        if (expectedException == null) {
            throw new IllegalArgumentException("场景 " + scenarioId + " exception 断言缺 expectedException");
        }
        Class<?> eclazz = Class.forName(expectedException);
        if (!eclazz.isAssignableFrom(cause.getClass())) {
            throw new AssertionError(degradePrefix(springDegraded) + "场景 " + scenarioId + " 异常类型不符: expected=" + expectedException + " actual=" + cause.getClass().getName());
        }
        if (expectedMessage != null && !expectedMessage.trim().isEmpty()) {
            String msg = cause.getMessage();
            if (msg == null || !msg.contains(expectedMessage)) {
                throw new AssertionError(degradePrefix(springDegraded) + "场景 " + scenarioId + " 异常消息不符: expected contains=\"" + expectedMessage + "\" actual=\"" + msg + "\"");
            }
        }
        // 异常断言通过（surefire 记录 pass）
    }

    private static String degradePrefix(boolean springDegraded) {
        return springDegraded ? "[需人工复核] Spring 上下文不可用已降级纯 POJO，依赖注入字段为 null。 " : "";
    }

    private static String textAt(JsonNode node, String jsonPointer, String defaultValue) {
        String ptr = jsonPointer.startsWith("/") ? jsonPointer : "/" + jsonPointer;
        JsonNode at = node.at(ptr);
        if (at == null || at.isMissingNode() || at.isNull()) return defaultValue;
        return at.asText();
    }
}
