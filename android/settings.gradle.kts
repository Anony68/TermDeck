pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "termdeck-android"

// :vault is pure Kotlin/JVM (crypto + sync), unit-tested without the SDK.
// :app is the Android/Compose client, depending on :vault.
include(":vault")
include(":app")
