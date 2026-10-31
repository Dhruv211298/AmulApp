# ---------------------------------------------------------------------------
# R8 / ProGuard keep rules for Amul Common App (release builds).
#
# React Native and most native modules ship their own "consumer" rules inside
# their AARs, and those are applied automatically — this file only covers the
# gaps. Everything below exists because the code is reached by REFLECTION or
# from native (JNI/JS) code, which R8 cannot see, so without an explicit keep
# it looks unused and gets stripped. The failure then appears at runtime, in
# one feature, as a missing-class or missing-method crash.
#
# Rule of thumb when adding: keep the smallest thing that fixes the crash, and
# write down WHY next to it.
# ---------------------------------------------------------------------------

# --- React Native core -----------------------------------------------------
# Anything annotated @DoNotStrip is called from C++/JNI. Also keep the
# annotation classes themselves so the markers survive.
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.KeepGettersAndSetters
-keep,allowobfuscation @interface com.facebook.common.internal.DoNotStrip

-keep @com.facebook.proguard.annotations.DoNotStrip class * { *; }
-keep @com.facebook.common.internal.DoNotStrip class * { *; }
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
    @com.facebook.common.internal.DoNotStrip *;
}

# Native methods and the classes holding them (JNI resolves these by name).
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

# Native modules / view managers are instantiated reflectively by the bridge.
-keep class * extends com.facebook.react.bridge.NativeModule { *; }
-keep class * extends com.facebook.react.bridge.BaseJavaModule { *; }
-keep class * extends com.facebook.react.uimanager.ViewManager { *; }
-keep class * implements com.facebook.react.bridge.ReactPackage { *; }
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod <methods>;
    @com.facebook.react.uimanager.annotations.ReactProp <methods>;
    @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>;
}
-keep class com.facebook.react.turbomodule.** { *; }

# Hermes
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# The app's own entry points, referenced from AndroidManifest by name.
-keep class com.amulapp.MainActivity { *; }
-keep class com.amulapp.MainApplication { *; }

# --- OkHttp / networking ---------------------------------------------------
# Used by RN's networking stack; these platform classes are optional at
# runtime and generate harmless "missing class" warnings without this.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- react-native-keychain -------------------------------------------------
# Biometric login. Cipher storages are chosen at runtime by class name, so
# stripping any of them breaks Face ID / fingerprint unlock with an obscure
# "cipher storage not found" error rather than a build failure.
-keep class com.oblador.keychain.** { *; }
-keep class androidx.biometric.** { *; }
-dontwarn com.oblador.keychain.**

# --- react-native-vision-camera (QR scanning) ------------------------------
-keep class com.mrousavy.camera.** { *; }
-keep class androidx.camera.** { *; }
-dontwarn com.mrousavy.camera.**

# --- ML Kit barcode scanning (used by VisionCamera's code scanner) ---------
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }
-dontwarn com.google.mlkit.**

# --- react-native-svg (biometric icons) ------------------------------------
-keep public class com.horcrux.svg.** { *; }

# --- react-native-webview (all portal screens) -----------------------------
-keep class com.reactnativecommunity.webview.** { *; }

# --- Other native modules in use -------------------------------------------
-keep class com.learnium.RNDeviceInfo.** { *; }
-keep class com.rnfs.** { *; }
-keep class com.reactnativecommunity.asyncstorage.** { *; }
-keep class com.reactnativecommunity.geolocation.** { *; }
-keep class com.reactnativecommunity.blurview.** { *; }
-keep class com.reactnativeimageresizer.** { *; }
-keep class com.BV.LinearGradient.** { *; }
-keep class com.swmansion.gesturehandler.** { *; }
-keep class com.swmansion.rnscreens.** { *; }
-keep class com.th3rdwave.safeareacontext.** { *; }

# --- Diagnostics -----------------------------------------------------------
# Keep source/line info so Play's crash reports stay readable after
# deobfuscation with the mapping file the AAB ships automatically.
-keepattributes SourceFile,LineNumberTable
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-renamesourcefileattribute SourceFile
