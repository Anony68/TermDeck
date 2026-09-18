rootProject.name = "termdeck-android"

// The :vault module is pure Kotlin/JVM (crypto + sync), so it builds and unit-tests without
// the Android SDK or an emulator. The Compose :app module (added next) will depend on it.
include(":vault")
