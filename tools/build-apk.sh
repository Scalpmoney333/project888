#!/usr/bin/env bash
# Build a signed Android APK: a fullscreen WebView serving the normal web build (dist/) from
# the APK assets through a virtual https origin (see android/.../MainActivity.java).
# Needs: JDK 17 and an Android SDK with "platforms;android-34" and "build-tools;34.0.0"
# (ANDROID_HOME, default /opt/android-sdk). Output: dist-single/touge-drift.apk
set -euo pipefail
cd "$(dirname "$0")/.."

SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
OUT=android/build
KS="${APK_KEYSTORE:-android/debug.keystore}"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets" "$OUT/res/mipmap"

npx vite build
mkdir -p dist-single "$OUT/assets/www"
cp -r dist/. "$OUT/assets/www/"
node tools/make-icon.mjs "$OUT/res/mipmap"

"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest android/AndroidManifest.xml \
  -A "$OUT/assets" "$OUT/res.zip" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 4 --version-name 1.3

javac -nowarn -source 11 -target 11 -classpath "$JAR" -d "$OUT/classes" \
  android/src/com/tougedrift/game/MainActivity.java 2>&1 | grep -v "bootstrap classpath" || true
"$BT/d8" --lib "$JAR" --min-api 24 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

(cd "$OUT/dex" && "$BT/aapt" add ../base.apk classes.dex >/dev/null)
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias touge \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Touge Drift" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out dist-single/touge-drift.apk "$OUT/aligned.apk"
"$BT/apksigner" verify dist-single/touge-drift.apk
ls -la dist-single/touge-drift.apk
