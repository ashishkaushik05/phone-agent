#!/usr/bin/env bash
# Host-JVM self-tests for the pure-logic connector classes.
# Compiles the whole source tree against android.jar, then runs each class's
# static main() (which calls selfTest()). No device, no Gradle.
#
# org.json in android.jar is a "Stub!" on the host, so if a real org.json jar
# is found (gradle/maven cache or a distro package) it goes on the RUN
# classpath — the encoders' JSON round-trip assertions then run for real.
# Protocol.selfTest() falls back to substring checks when only the stub is present.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
AJ="$SDK/platforms/android-36/android.jar"
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT

REAL_JSON=""
for c in \
    "$HOME"/.gradle/caches/modules-2/files-2.1/org.json/json/*/*/json-*.jar \
    "$HOME"/.m2/repository/org/json/json/*/json-*.jar \
    /usr/share/java/json.jar /usr/share/java/org.json.jar ; do
    for f in $c; do
        [ -f "$f" ] && REAL_JSON="$f" && break 2
    done
done

echo "== compile =="
javac -source 11 -target 11 -classpath "$AJ" -d "$OBJ" "$HERE"/src/com/hermes/connector/*.java 2>&1 \
    | grep -vE 'system modules path|^[0-9]+ warning' || true

RUN_CP="$OBJ:$AJ"
if [ -n "$REAL_JSON" ]; then
    # real org.json must PRECEDE android.jar so it wins class resolution
    RUN_CP="$OBJ:$REAL_JSON:$AJ"
    echo "== org.json: $REAL_JSON =="
else
    echo "== org.json: stub only (android.jar) — Protocol uses substring fallback =="
fi

rc=0
for cls in WebSocketClient Protocol HermesLink InjectGate OutboundCoordinator Watchdog ; do
    if ! java -cp "$RUN_CP" "com.hermes.connector.$cls" ; then
        echo "FAIL: $cls" >&2
        rc=1
    fi
done
exit $rc
