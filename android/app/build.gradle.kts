plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ir.javadxpro.volexturn"
    compileSdk = 35

    defaultConfig {
        applicationId = "ir.javadxpro.volexturn"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "4.0.0"
        // کلید شبکه باید با کلاینت وب یکی باشد
        buildConfigField("String", "MQTT_NETWORK_KEY", "\"volexturn4\"")
        buildConfigField("String", "MQTT_BROKER", "\"wss://broker.emqx.io:8084/mqtt\"")
    }

    buildFeatures { compose = true; buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel)
    implementation(libs.paho.mqtt)
    implementation(libs.stream.webrtc)
}
