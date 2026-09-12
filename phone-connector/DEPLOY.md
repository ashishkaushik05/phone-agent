# Deploying `phone-connector` to the device

Target: Redmi Note 8 `ginkgo`, LineageOS 23.2 / Android 16, rooted, AVB off.
The connector is a **priv-app** — the grant comes from the allowlist file on
`/product`, not from the APK signature.

## First install (full, needs a reboot)

```bash
# 1. root + writable /product
adb root
adb remount                          # or: adb shell mount -o rw,remount /product

# 2. remove the old probe package
adb shell rm -rf /system/product/priv-app/CallTapProbe \
                 /product/etc/permissions/privapp-permissions-calltap.xml
adb shell pm uninstall com.calltap.probe   # ignore "not installed"

# 3. push the connector APK + allowlist to the SAME partition
adb shell mkdir -p /product/priv-app/HermesConnector
adb push phone-connector/build/HermesConnector.apk \
         /product/priv-app/HermesConnector/HermesConnector.apk
adb push phone-connector/privapp-permissions-hermes.xml \
         /product/etc/permissions/privapp-permissions-hermes.xml

# 4. permissions
adb shell chmod 755 /product/priv-app/HermesConnector
adb shell chmod 644 /product/priv-app/HermesConnector/HermesConnector.apk \
                    /product/etc/permissions/privapp-permissions-hermes.xml

# 5. reboot so PackageManager re-scans priv-app + allowlist
adb reboot
# wait for boot to complete, then:
adb root

# 6. grant the runtime (non-priv) permissions
adb shell pm grant com.hermes.connector android.permission.RECORD_AUDIO
adb shell pm grant com.hermes.connector android.permission.CALL_PHONE
adb shell pm grant com.hermes.connector android.permission.READ_PHONE_STATE
adb shell pm grant com.hermes.connector android.permission.SEND_SMS     # SMS (P-SMS-2)
adb shell pm grant com.hermes.connector android.permission.RECEIVE_SMS  # SMS (P-SMS-2)

# 7. dev link to a locally-running hermes-core (do NOT set as default dialer)
adb reverse tcp:8787 tcp:8787
```

**Component-rescan gotcha (seen 2026-09-10, SMS deploy):** pushing a new APK to
`/product/priv-app/` in place + reboot updated the *permission set* but PackageManager
kept the **old component list** — new manifest `<receiver>`s (e.g. `SmsReceiver`) never
registered. Fix: `adb install -r -g phone-connector/build/HermesConnector.apk` once
after the reboot — it lays a `/data/app` update over the base, forcing a full
component rescan, keeps the priv-app grants (base path on `/product` is untouched),
and `-g` re-grants the runtime perms. Verify with
`adb shell dumpsys package com.hermes.connector | grep SmsReceiver`.

The connector is bound by Telecom automatically as a non-UI `InCallService`
once it is an allowlisted priv-app — there is nothing to "enable" in Settings,
and it must **not** be made the default dialer.

## Fast redeploy (APK-only change, no manifest/permission change — no reboot)

```bash
adb root && adb remount
adb push phone-connector/build/HermesConnector.apk \
         /product/priv-app/HermesConnector/HermesConnector.apk
adb shell am force-stop com.hermes.connector
# re-trigger: place/answer a call, or `adb shell am startservice com.hermes.connector/.LinkService`
```

If the manifest, the permission set, or `privapp-permissions-hermes.xml`
changed, do the full install + reboot instead.

## CHECKPOINT B — service binds, captures downlink audio

Capture output to `phone-connector/logs/<date>-B-service-binds.txt`.

```bash
# grants present
adb shell dumpsys package com.hermes.connector \
  | grep -E "versionCode|codePath|CAPTURE_AUDIO_OUTPUT|CONTROL_INCALL|RECORD_AUDIO"
#   -> CAPTURE_AUDIO_OUTPUT: granted=true, CONTROL_INCALL_EXPERIENCE: granted=true

# bound by Telecom (place a normal call, answer on the stock Dialer, keep it up)
adb shell dumpsys telecom | grep -A6 -i "InCallService"
#   -> com.hermes.connector/.ConnectorService listed alongside the Dialer

# real downlink audio on the new package (someone speaks on the far end)
adb logcat -d -s HermesConnector
#   -> onCallAdded  +  "negotiated: sampleRate=16000"  +  non-zero rms= lines
```

**Pass:** the connector binds on the new package and captures real far-end
call audio. Gemini will fail to connect (no key wired for a bare build / no
link yet) and the call proceeds on `DEFAULT_SYSTEM_INSTRUCTION` — that is
expected at Checkpoint B.
