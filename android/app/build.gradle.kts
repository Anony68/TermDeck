plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.termdeck.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.termdeck.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "0.1.0"
        // Bumped each build so the on-screen tag confirms which APK is installed.
        buildConfigField("String", "BUILD_TAG", "\"x25519-fix-3\"")
    }

    // Signing keystore is committed in-repo (dev/personal use, per project decision).
    signingConfigs {
        create("release") {
            storeFile = file("../keystore.jks")
            storePassword = "termdeck"
            keyAlias = "termdeck"
            keyPassword = "termdeck"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1,versions/9/OSGI-INF/MANIFEST.MF}"
    }
}

dependencies {
    implementation(project(":vault"))

    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // OkHttp is used transitively via OkHttpServer's default client, so it must be on the
    // app classpath too. (org.json is provided by the Android platform.)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // SSH terminal + SFTP.
    implementation("com.hierynomus:sshj:0.38.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    implementation("org.slf4j:slf4j-api:2.0.13")
    implementation("org.slf4j:slf4j-simple:2.0.13")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
