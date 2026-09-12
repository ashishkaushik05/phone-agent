package com.hermes.connector;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.telephony.SmsManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Outbound SMS via the platform {@link SmsManager} (default SMS subscription).
 * Owned by {@link LinkService}. The connector is a non-default SMS app — this
 * only sends.
 *
 * For each {@code sms.send}: split into parts, fire, and report back up the
 * link — {@code sms.sent} once every part is handed to the radio, then
 * {@code sms.delivered} once every part is confirmed (or immediately on the
 * first failure). A {@code client_ref} already handled is dropped, so an
 * {@code sms.send} replayed by hermes-core after a flaky socket is not re-sent.
 */
final class SmsBridge {

    private static final String TAG = "HermesLink";
    private static final String ACTION_SENT = "com.hermes.connector.SMS_SENT";
    private static final String ACTION_DELIVERED = "com.hermes.connector.SMS_DELIVERED";
    private static final int RECENT_MAX = 200;

    private final Context ctx;
    private final String deviceId;
    private final Set<String> recent = Collections.synchronizedSet(new LinkedHashSet<>());
    /** client_ref -> [partsOutstanding, failures] */
    private final Map<String, int[]> sentTally = new HashMap<>();
    private final Map<String, int[]> deliveredTally = new HashMap<>();
    private final Map<String, String> firstError = new HashMap<>();

    SmsBridge(Context ctx, String deviceId) {
        this.ctx = ctx.getApplicationContext();
        this.deviceId = deviceId;
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_SENT);
        f.addAction(ACTION_DELIVERED);
        this.ctx.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
    }

    void close() {
        try {
            ctx.unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
    }

    void send(String to, String body, String clientRef) {
        synchronized (recent) {
            if (!recent.add(clientRef)) {
                Log.i(TAG, "sms.send " + clientRef + " already handled — dropping replay");
                return;
            }
            while (recent.size() > RECENT_MAX) {
                recent.remove(recent.iterator().next());
            }
        }
        SmsManager sm = ctx.getSystemService(SmsManager.class);
        if (sm == null) {
            report(Protocol.smsSent(clientRef, false, "no SmsManager", deviceId));
            return;
        }
        ArrayList<String> parts;
        try {
            parts = sm.divideMessage(body);
        } catch (Exception e) {
            report(Protocol.smsSent(clientRef, false, e.getClass().getSimpleName(), deviceId));
            return;
        }
        int n = parts.size();
        synchronized (this) {
            sentTally.put(clientRef, new int[]{n, 0});
            deliveredTally.put(clientRef, new int[]{n, 0});
        }
        ArrayList<PendingIntent> sentPIs = new ArrayList<>();
        ArrayList<PendingIntent> deliveredPIs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            sentPIs.add(pi(ACTION_SENT, clientRef, i));
            deliveredPIs.add(pi(ACTION_DELIVERED, clientRef, i));
        }
        try {
            sm.sendMultipartTextMessage(to, null, parts, sentPIs, deliveredPIs);
            Log.i(TAG, "sms.send " + clientRef + " -> " + to + " (" + n + " part(s))");
        } catch (Exception e) {
            synchronized (this) {
                sentTally.remove(clientRef);
                deliveredTally.remove(clientRef);
            }
            report(Protocol.smsSent(clientRef, false, e.getClass().getSimpleName(), deviceId));
        }
    }

    private PendingIntent pi(String action, String clientRef, int part) {
        Intent i = new Intent(action)
                .setPackage(ctx.getPackageName())
                .putExtra("client_ref", clientRef);
        int req = (action + clientRef + "#" + part).hashCode();
        return PendingIntent.getBroadcast(ctx, req, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent intent) {
            String clientRef = intent.getStringExtra("client_ref");
            if (clientRef == null) {
                return;
            }
            boolean sentAction = ACTION_SENT.equals(intent.getAction());
            boolean ok = getResultCode() == Activity.RESULT_OK;
            int[] t;
            synchronized (SmsBridge.this) {
                if (!ok) {
                    firstError.putIfAbsent(clientRef, "resultCode=" + getResultCode());
                }
                Map<String, int[]> tally = sentAction ? sentTally : deliveredTally;
                t = tally.get(clientRef);
                if (t == null) {
                    return;
                }
                t[0]--;
                if (!ok) {
                    t[1]++;
                }
                if (t[0] > 0) {
                    return;
                }
                tally.remove(clientRef);
            }
            boolean allOk = t[1] == 0;
            String err;
            synchronized (SmsBridge.this) {
                err = allOk ? null : firstError.get(clientRef);
                if (!sentAction) {
                    firstError.remove(clientRef);
                }
            }
            report(sentAction
                    ? Protocol.smsSent(clientRef, allOk, err, deviceId)
                    : Protocol.smsDelivered(clientRef, allOk, err, deviceId));
        }
    };

    private void report(String frame) {
        HermesLink link = LinkService.LINK;
        if (link != null) {
            link.send(frame);
        } else {
            Log.w(TAG, "no link — dropped sms result: " + frame);
        }
    }
}
