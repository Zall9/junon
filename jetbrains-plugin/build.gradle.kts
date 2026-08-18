import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.20"
    id("org.jetbrains.intellij.platform")
}

group = "com.idebridge"
version = "0.1.0-SNAPSHOT"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(providers.gradleProperty("platformType"), providers.gradleProperty("platformVersion"))
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
        // Java PSI. `<depends>com.intellij.modules.java</depends>` declares the runtime
        // requirement; this is what puts PsiClass and friends on the compile classpath.
        bundledPlugin("com.intellij.java")
    }
    // Provided by the platform (`lib/util-8.jar`), so it must not be bundled: a second copy is
    // loaded ahead of the platform's by the PathClassLoader and breaks platform code that uses it.
    compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("junit:junit:4.13.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.junit.vintage:junit-vintage-engine:5.10.2")
}

// The platform supplies the Kotlin stdlib at runtime (`lib/util-8.jar`), and `kotlin("test")`
// drags in its own copy transitively. Two copies means the PathClassLoader loads ours first, and
// platform code compiled against the newer stdlib then dies mid-indexing with NoSuchMethodError —
// which leaves a test fixture waiting on indexes that will never finish.
configurations.testRuntimeClasspath {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
}

/*
 * Build with JDK 21 **or newer**; produce Java 21 bytecode either way.
 *
 * The bytecode level is not a preference. PhpStorm 2025.3 ships JBR 21.0.10, and a JBR 21 refuses a
 * class file above major 65 — so while `sinceBuild` is 252, `jvmTarget` stays 21. What used to be
 * pinned alongside it was the *toolchain*, which is a different thing: the JDK that runs the
 * compiler. Pinning it meant a machine with only a newer JDK could not build at all, and the newer
 * JDK is not hypothetical — GoLand 2026.1 ships JBR 25.0.2, PyCharm 2026.2 ships 25.0.3.
 *
 * Measured before removing it: Gradle run on JBR 25 with no toolchain declared compiles all 555
 * classes to major 65, and the full test suite passes. CI still installs 21, which is now the floor
 * rather than the requirement.
 */
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

java {
    // The level the classes are emitted at, not the JDK that emits them. See the comment above.
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

intellijPlatform {
    /*
     * The sandbox lives outside the project, and that is not housekeeping.
     *
     * By default it goes to `<project>/.intellijPlatform/sandbox`, which had grown to 1.9 GB. Every
     * `runIde` on this repository then hands the IDE a project containing the IDE's own index, logs
     * and caches — so it indexes them, and indexing writes more of them. Measured: a sandbox opened
     * on `jetbrains-plugin` was still walking `.intellijPlatform/.../system/index/` a quarter of an
     * hour in, `diagnostics/getSnapshot` returned nothing that whole time, and a TODO search came
     * back 190 hits from thread dumps and bundled plugin lists against 10 from source.
     *
     * Moving it out is what makes the sandbox usable for verifying anything. Outside the whole
     * repository rather than merely outside this module: opening the repository root as a project
     * is an ordinary thing to do, and a sandbox under it would reintroduce the same recursion one
     * directory up.
     */
    sandboxContainer = layout.dir(
        provider { File(System.getProperty("user.home"), ".cache/ide-bridge/sandbox") },
    )

    // Binary-compatibility verification against the target IDE. This is what proves that the
    // classes the plugin no longer bundles — the Kotlin stdlib and kotlinx-serialization — are
    // genuinely resolvable from the platform, rather than merely resolvable in the test runtime.
    pluginVerification {
        // Internal-API usage is checked by `checkInternalApiSurface` against a baseline instead,
        // because this flag cannot express "these known entries and no others" — dropping it here
        // and asserting the exact surface is stricter than leaving it on and muting the task.
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.NOT_DYNAMIC,
        )

        ides {
            // The IDEs actually installed on this machine, none of which ships the Java module —
            // which is exactly what makes them the test of the optional dependency.
            val home = System.getProperty("user.home")
            for (ide in listOf("GoLand", "PhpStorm", "PyCharm")) {
                val installed = File(home, "Applications/" + ide + ".app")
                if (installed.isDirectory) local(installed)
            }
            select {
                types = listOf(
                    org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity,
                )
                channels = listOf(org.jetbrains.intellij.platform.gradle.models.ProductRelease.Channel.RELEASE)
                sinceBuild = providers.gradleProperty("pluginSinceBuild")
                untilBuild = "252.*"
            }
        }
    }

    pluginConfiguration {
        name = providers.gradleProperty("pluginDisplayName")
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
        }
    }
}

// --- Test configuration ---
//
// The IntelliJ Platform Gradle Plugin 2.x preconfigures the `test` task to
// run with the IntelliJ Platform runtime (PathClassLoader, sandbox). The
// platform provides JUnit 4 at runtime but the PathClassLoader doesn't expose
// it to the Gradle test executor's bootstrap classpath.
//
// We add JUnit 4 explicitly so the PathClassLoader can find TestRule, and
// use the JUnit Vintage engine to allow both JUnit 4 and JUnit 5 tests to
// coexist. The `useJUnitPlatform()` configuration with the vintage engine
// ensures JUnit 5 tests run via Jupiter and any platform-internal JUnit 4
// references resolve.

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
    // Everything this suite reads at run time, declared so Gradle knows when its answer is stale.
    //
    // None of it is on the classpath, so none of it was tracked: changing any of these left `:test`
    // "up to date" and the suite reported success without having looked. Measured on 2026-08-15 with
    // the fixtures — five notification fixtures were added for which the Kotlin side had no
    // serializer at all, and the run went green; only a forced rerun showed the failure.
    //
    // The daemon binary is the one that matters most. `RealDaemonHandshakeTest` and its siblings
    // spawn it to prove this plugin talks to the actual daemon; without this, rebuilding the daemon
    // left those tests vouching for a binary that no longer existed — the stale-build trap that has
    // produced confident wrong verdicts in this project more than once (ADR-0037). It is declared as
    // a file *collection* rather than a file because it is legitimately absent before a first build,
    // and those tests then report themselves skipped.
    inputs.dir(layout.projectDirectory.dir("../packages/protocol/fixtures"))
        .withPropertyName("protocolFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.dir(layout.projectDirectory.dir("../packages/protocol/schemas"))
        .withPropertyName("protocolSchemas")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.files(layout.projectDirectory.file("../packages/cli/dist/bin.js"))
        .withPropertyName("daemonBinary")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

/**
 * Fails when the plugin uses internal platform API beyond the reviewed baseline.
 *
 * Every entry in `internal-api-baseline.txt` carries a reason and an ADR. Anything the verifier
 * reports that no entry accounts for is a new dependency on API the platform reserves the right to
 * remove, and it fails here rather than being discovered by a user on an IDE upgrade.
 */
val checkInternalApiSurface by tasks.registering {
    dependsOn(tasks.named("verifyPlugin"))
    val baselineFile = layout.projectDirectory.file("internal-api-baseline.txt")
    val reports = layout.buildDirectory.dir("reports/pluginVerifier")
    inputs.file(baselineFile)
    doLast {
        val baseline = baselineFile.asFile.readLines()
            .map { it.substringBefore('#').trim() }
            .filter { it.isNotEmpty() }
            .map { line -> line.split('|').map { it.trim() } }

        val reported = reports.get().asFile.walkTopDown()
            .filter { it.name == "internal-api-usages.txt" }
            .flatMap { it.readLines().asSequence() }
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toList()

        if (reported.isEmpty()) {
            error("No internal-api-usages report found; verifyPlugin must run before this check.")
        }

        val unaccounted = reported.filterNot { usage ->
            baseline.any { entry -> entry.all { usage.contains(it) } }
        }
        if (unaccounted.isNotEmpty()) {
            error(
                buildString {
                    appendLine("Internal platform API used beyond the reviewed baseline:")
                    unaccounted.forEach { appendLine("  - " + it.take(220)) }
                    appendLine("Add it to internal-api-baseline.txt with a reason, or use public API.")
                },
            )
        }
        // Both numbers, because one alone misleads: "16 entries" reads as a baseline of sixteen,
        // when it is sixteen reported usages — the same two entries seen across four verified IDEs.
        logger.lifecycle(
            "Internal API: ${reported.size} usage(s) reported, all accounted for by " +
                "${baseline.size} baseline entr${if (baseline.size == 1) "y" else "ies"}.",
        )
    }
}

// Sandboxed IDE run. The discovery file is passed by environment so the plugin talks to a daemon
// started outside Gradle, and the project to open is given as an argument — a `ProjectActivity`
// only runs once a project is open, so an empty sandbox would exercise nothing.
tasks.named<org.jetbrains.intellij.platform.gradle.tasks.RunIdeTask>("runIde") {
    providers.environmentVariable("IDE_BRIDGE_DISCOVERY_FILE").orNull?.let {
        environment("IDE_BRIDGE_DISCOVERY_FILE", it)
    }
    providers.environmentVariable("IDE_BRIDGE_SAMPLE_PROJECT").orNull?.let { args(it) }
}

/**
 * Runs the plugin inside a locally installed IDE other than the one it compiles against.
 *
 * The point is to observe behaviour where compatibility was only measured: PhpStorm ships no Java
 * module, so this is the run that shows whether symbols really come from that IDE's own engine.
 * Its sandbox is separate from the developer's own PhpStorm configuration.
 */
intellijPlatformTesting {
    runIde {
        // One registration per locally installed IDE. Each is a different set of language engines
        // behind the same platform APIs, which is the only way to tell a plugin that uses the host
        // IDE's engines from one that merely compiles against them.
        listOf("PhpStorm", "GoLand", "PyCharm").forEach { ide ->
            register("run$ide") {
                localPath = file(System.getProperty("user.home") + "/Applications/$ide.app")
                task {
                    providers.environmentVariable("IDE_BRIDGE_DISCOVERY_FILE").orNull?.let {
                        environment("IDE_BRIDGE_DISCOVERY_FILE", it)
                    }
                    providers.environmentVariable("IDE_BRIDGE_SAMPLE_PROJECT").orNull?.let {
                        args(it)
                    }
                }
            }
        }
    }
}
