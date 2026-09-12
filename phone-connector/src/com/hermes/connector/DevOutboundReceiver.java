package com.hermes.connector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.telecom.TelecomManager;
import android.util.Log;

/**
 * Dev-only outbound-call trigger — an {@code adb am broadcast} into the same
 * {@link OutboundCoordinator} + {@code TelecomManager.placeCall} path the real
 * flow ({@code call.place} from hermes-core, via {@link LinkService}) uses, so
 * the outbound pipeline can be exercised without hermes-core.
 *
 * Usage:
 *   adb shell am broadcast -n com.hermes.connector/.DevOutboundReceiver \
 *       -a com.hermes.connector.DEV_OUTBOUND_CALL --es to +15551230000 [--es script "short persona"]
 *
 * {@code to} is required (E.164-ish, no spaces — {@code am broadcast} mangles
 * spaces in {@code --es} values). {@code script} is optional; omitted -> the
 * call runs on {@link ConnectorService#DEFAULT_SYSTEM_INSTRUCTION}.
 */
public class DevOutboundReceiver extends BroadcastReceiver {

    private static final String TAG = "HermesConnector";

    @Override
    public void onReceive(Context context, Intent intent) {
        String to = intent.getStringExtra("to");
        if (to == null || to.isEmpty()) {
            Log.e(TAG, "DevOutboundReceiver: no 'to' extra — aborting");
            return;
        }
        String script = intent.getStringExtra("script");
        String si = (script == null || script.isEmpty()) ? null : script;
        String callId = "dev-" + System.currentTimeMillis();
        Log.i(TAG, "DevOutboundReceiver: placing " + callId + " -> " + to + " (script=" + (si != null) + ")");

        OutboundCoordinator.get().expect(callId, to, si);
        try {
            TelecomManager tm = context.getSystemService(TelecomManager.class);
            if (tm == null) {
                throw new IllegalStateException("TelecomManager unavailable");
            }
            tm.placeCall(Uri.fromParts("tel", to, null), null);
        } catch (Exception e) {
            Log.e(TAG, "DevOutboundReceiver: placeCall failed (is CALL_PHONE granted?)", e);
            OutboundCoordinator.get().cancel(callId);
        }
    }
}
