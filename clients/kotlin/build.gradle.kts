import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.21"
}

group = "com.pbmp"
version = "0.1.0"

repositories {
    mavenCentral()
}

// Java 17 bytecode runs on current Android and on any recent JVM.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// The checks are a plain main() so they also run with kotlinc alone. Set PBMP_BASE_URL to test a server.
val checkClient = tasks.register<JavaExec>("checkClient") {
    group = "verification"
    description = "Runs the client checks, against PBMP_BASE_URL when a server is reachable."
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("com.pbmp.client.ClientTestKt")
}

tasks.test {
    failOnNoDiscoveredTests.set(false)
}

tasks.check {
    dependsOn(checkClient)
}
