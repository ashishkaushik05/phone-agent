package com.hermes.connector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.telecom.TelecomManager;
import android.util.Log;

import org.json.JSONObject;

/**
 * Foreground service that owns the one persistent {@link HermesLink} to
 * hermes-core for this device. Started at boot ({@link BootReceiver}) and
 * self-healed from {@link ConnectorService} if it ever isn't running when a
 * call starts.
 *
 * If any {@code HERMES_*} BuildConfig field is empty the link is never
 * started — the connector then runs inbound calls on
 * {@link ConnectorService#DEFAULT_SYSTEM_INSTRUCTION} with no director
 * steering (design decision 7). That is a valid configuration, not an error.
 *
 * The link callbacks here only log for now — {@link ConnectorService} wiring
 * (accept / inject / hangup / place) lands in Phases D–F.
 */
public class LinkService extends Service {

    private static final String TAG = "HermesLink";
    private static final String CHANNEL_ID = "hermes-link";
    private static final int NOTIF_ID = 4711;

    /** Same-process handle so {@link ConnectorService} can reach the link. Null until the link starts. */
    static volatile HermesLink LINK;

    /** Outbound SMS sender. Non-null between onCreate and onDestroy. */
    private SmsBridge smsBridge;

    private final HermesLink.Listener linkListener = new HermesLink.Listener() {
        @Override
        public void onAccept(String callId, String systemInstruction, JSONObject triggerConfig) {
            Log.i(TAG, "onAccept call_id=" + callId + " si.len=" + (systemInstruction == null ? 0 : systemInstruction.length()));
            ConnectorService.deliverAccept(callId, systemInstruction);
        }

        @Override
        public void onPlace(String callId, String to, String systemInstruction, JSONObject triggerConfig) {
            Log.i(TAG, "onPlace call_id=" + callId + " to=" + to);
            placeOutbound(callId, to, systemInstruction);
        }

        @Override
        public void onInject(String callId, String text) {
            Log.i(TAG, "onInject call_id=" + callId);
            ConnectorService.deliverInject(callId, text);
        }

        @Override
        public void onHangup(String callId, String reason) {
            Log.i(TAG, "onHangup call_id=" + callId + " reason=" + reason);
            ConnectorService.deliverHangup(callId, reason);
        }

        @Override
        public void onSmsSend(String to, String body, String clientRef) {
            Log.i(TAG, "onSmsSend client_ref=" + clientRef + " to=" + to);
            SmsBridge b = smsBridge;
            if (b != null) {
                b.send(to, body, clientRef);
            } else {
                Log.w(TAG, "smsBridge not ready — dropping sms.send " + clientRef);
            }
        }

        @Override
        public void onUp() {
            Log.i(TAG, "link up");
        }

        @Override
        public void onDown() {
            Log.i(TAG, "link down");
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        smsBridge = new SmsBridge(this, dev());
        // A dial-timeout (no Telecom call matched the placed number in time) sends call.ended.
        OutboundCoordinator.get().setSink((callId, to) -> {
            Log.w(TAG, "dial-timeout for " + callId + " -> " + to);
            HermesLink link = LINK;
            if (link != null) {
                link.send(Protocol.callEnded(callId, "dial_timeout",
                        "no matching outbound call within " + (OutboundCoordinator.DIAL_TIMEOUT_MS / 1000) + "s", dev()));
            }
        });
    }

    /**
     * Register the expected outbound call, open (and wait — capped — on) the Gemini session,
     * THEN place it on the main thread. Connecting first means the callee's phone starts
     * ringing only once the agent is ready to talk the moment they pick up, instead of racing
     * the ~1-3s Gemini handshake against however fast they answer. Runs on the {@link
     * HermesLink} listener's own thread (not main), so blocking here for the prewarm is fine —
     * only the final {@code placeCall} needs the main thread.
     */
    private void placeOutbound(String callId, String to, String systemInstruction) {
        OutboundCoordinator.get().expect(callId, to, systemInstruction);

        String si = systemInstruction != null ? systemInstruction : ConnectorService.DEFAULT_SYSTEM_INSTRUCTION;
        GeminiLiveClient client = ConnectorService.prewarmOutboundGemini(si);
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < ConnectorService.GEMINI_READY_WAIT_MS) {
            if (client.isReady()) {
                break;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                break;
            }
        }
        Log.i(TAG, "latency: outbound gemini prewarm " + (System.currentTimeMillis() - t0)
                + "ms ready=" + client.isReady() + " (call_id=" + callId + ")");
        // Attach whether ready or not — an unready-but-connecting session still beats none;
        // handleOutbound falls back to opening a fresh one only if this is never attached at all.
        OutboundCoordinator.get().attachClient(callId, client);

        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                TelecomManager tm = getSystemService(TelecomManager.class);
                if (tm == null) {
                    throw new IllegalStateException("TelecomManager unavailable");
                }
                tm.placeCall(Uri.fromParts("tel", to, null), null);
                Log.i(TAG, "placeCall -> " + to + " (call_id=" + callId + ")");
            } catch (Exception e) {
                Log.e(TAG, "placeCall failed for " + callId + " (is CALL_PHONE granted?)", e);
                OutboundCoordinator.get().cancel(callId);
                new Thread(client::close, "HermesConnector-GeminiClose").start(); // close() -> blocking I/O
                HermesLink link = LINK;
                if (link != null) {
                    link.send(Protocol.callEnded(callId, "error", "placeCall failed: " + e.getMessage(), dev()));
                }
            }
        });
    }

    private static String dev() {
        String d = BuildConfig.HERMES_DEVICE_ID;
        return d.isEmpty() ? "unknown-device" : d;
    }

    /** Relay an inbound SMS to hermes-core. Called by {@link SmsReceiver}. */
    static void deliverInboundSms(Context ctx, String from, String body, long ts) {
        HermesLink link = LINK;
        if (link != null) {
            link.send(Protocol.smsInbound(from, body, ts, dev()));
        } else {
            Log.w(TAG, "link down — inbound SMS from " + from + " not relayed; starting service");
            ensureRunning(ctx);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);

        if (LINK == null) {
            String url = BuildConfig.HERMES_WS_URL;
            String dev = BuildConfig.HERMES_DEVICE_ID;
            String tok = BuildConfig.HERMES_TOKEN;
            if (url.isEmpty() || dev.isEmpty() || tok.isEmpty()) {
                Log.w(TAG, "HERMES_* not fully configured (url/device_id/token) — link disabled, "
                        + "inbound calls use the fallback persona");
            } else {
                Log.i(TAG, "starting link: " + url + " device_id=" + dev);
                LINK = new HermesLink(url, dev, tok, linkListener);
                LINK.start();
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (smsBridge != null) {
            smsBridge.close();
            smsBridge = null;
        }
        HermesLink link = LINK;
        if (link != null) {
            link.stop();
            LINK = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Hermes link", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Hermes connector")
                .setContentText("Linked to hermes-core")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build();
    }

    /** Convenience for callers that want to (re)start this service. */
    static void ensureRunning(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, LinkService.class));
    }
}
