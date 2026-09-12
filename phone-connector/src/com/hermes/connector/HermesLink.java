package com.hermes.connector;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingDeque;

/**
 * Persistent link to hermes-core over one WebSocket.
 *
 * Lifecycle: connect (background thread) -> send {@code hello {device_id}} ->
 * wait for {@code hello_ack} -> {@link Listener#onUp()} + 20 s heartbeat ->
 * dispatch {@code call.*} frames to the listener. On any close/error:
 * {@link Listener#onDown()}, exponential backoff (1,2,4,8,16,30,30… s),
 * reconnect, re-{@code hello}.
 *
 * Outgoing phone -> core frames go through {@link #send} onto an unbounded
 * deque; a writer thread drains it only while connected and puts a frame back
 * at the head if the send fails, so order survives a reconnect.
 *
 * The transport ({@link WebSocketClient}) touches {@code android.util.Log},
 * so this class is not host-pure — but {@link #backoffMs} is, and that is all
 * {@link #selfTest} exercises.
 */
class HermesLink {

    private static final String TAG = "HermesLink";
    private static final long HEARTBEAT_MS = 20_000L;

    interface Listener {
        void onAccept(String callId, String systemInstruction, JSONObject triggerConfig);
        void onPlace(String callId, String to, String systemInstruction, JSONObject triggerConfig);
        void onInject(String callId, String text);
        void onHangup(String callId, String reason);
        void onSmsSend(String to, String body, String clientRef);
        void onUp();
        void onDown();
    }

    private final String host;
    private final int port;
    private final String path;
    private final boolean secure;
    private final String deviceId;
    private final String token;
    private final Listener listener;

    private final LinkedBlockingDeque<String> outbox = new LinkedBlockingDeque<>();
    private volatile boolean running = false;
    private volatile boolean connected = false;
    private volatile WebSocketClient activeWs;
    private volatile int backoffAttempt = 0;

    private Thread connThread;
    private Thread writerThread;
    private Thread heartbeatThread;

    HermesLink(String wsUrl, String deviceId, String token, Listener listener) {
        this.secure = wsUrl.startsWith("wss://");
        String rest = wsUrl.substring(secure ? 6 : (wsUrl.startsWith("ws://") ? 5 : 0));
        int slash = rest.indexOf('/');
        String hostport = slash >= 0 ? rest.substring(0, slash) : rest;
        this.path = slash >= 0 ? rest.substring(slash) : "/";
        int colon = hostport.indexOf(':');
        this.host = colon >= 0 ? hostport.substring(0, colon) : hostport;
        this.port = colon >= 0
                ? Integer.parseInt(hostport.substring(colon + 1))
                : (secure ? 443 : 80);
        this.deviceId = deviceId;
        this.token = token;
        this.listener = listener;
    }

    void start() {
        if (running) {
            return;
        }
        running = true;
        connThread = new Thread(this::connectLoop, "HermesLink-Conn");
        writerThread = new Thread(this::writerLoop, "HermesLink-Writer");
        heartbeatThread = new Thread(this::heartbeatLoop, "HermesLink-Heartbeat");
        connThread.start();
        writerThread.start();
        heartbeatThread.start();
    }

    void stop() {
        running = false;
        connected = false;
        WebSocketClient w = activeWs;
        if (w != null) {
            w.close();
        }
        interrupt(connThread);
        interrupt(writerThread);
        interrupt(heartbeatThread);
    }

    /** Queue a phone -> core frame (built via {@link Protocol}). Delivered once connected, in order. */
    void send(String json) {
        outbox.addLast(json);
    }

    boolean isConnected() {
        return connected;
    }

    // --- connect / reconnect loop ------------------------------------------

    private void connectLoop() {
        while (running) {
            final Object closedLatch = new Object();
            final boolean[] done = {false};
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Authorization", "Bearer " + token);
                WebSocketClient w = new WebSocketClient(host, port, path, secure, headers,
                        new WebSocketClient.Listener() {
                            @Override
                            public void onOpen() {
                                WebSocketClient s = activeWs;
                                try {
                                    if (s != null) {
                                        s.sendText(Protocol.hello(deviceId));
                                        Log.i(TAG, "hello sent (device_id=" + deviceId + ")");
                                    }
                                } catch (IOException e) {
                                    Log.w(TAG, "hello send failed: " + e.getMessage());
                                }
                            }

                            @Override
                            public void onText(String message) {
                                handleMessage(message);
                            }

                            @Override
                            public void onBinary(byte[] data) {
                                handleMessage(new String(data, StandardCharsets.UTF_8));
                            }

                            @Override
                            public void onClose(int code, String reason) {
                                Log.i(TAG, "link closed code=" + code + " reason=" + reason);
                                signal(closedLatch, done);
                            }

                            @Override
                            public void onError(Exception e) {
                                Log.w(TAG, "link error: " + e.getMessage());
                                signal(closedLatch, done);
                            }
                        });
                activeWs = w;
                Log.i(TAG, "connecting to " + (secure ? "wss" : "ws") + "://" + host + ":" + port + path);
                w.connect();
                synchronized (closedLatch) {
                    while (running && !done[0]) {
                        closedLatch.wait();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "connect attempt failed: " + e.getMessage());
            }

            connected = false;
            WebSocketClient w = activeWs;
            activeWs = null;
            if (w != null) {
                w.close();
            }
            listener.onDown();
            if (!running) {
                break;
            }
            long wait = backoffMs(backoffAttempt++);
            Log.i(TAG, "reconnect in " + wait + "ms (attempt " + backoffAttempt + ")");
            try {
                Thread.sleep(wait);
            } catch (InterruptedException ie) {
                // stop() or shutdown — loop re-checks `running`
            }
        }
        Log.i(TAG, "connectLoop exited");
    }

    private void handleMessage(String raw) {
        Protocol.Parsed p;
        try {
            p = Protocol.parse(raw);
        } catch (JSONException e) {
            Log.w(TAG, "unparseable frame: " + raw);
            return;
        }
        JSONObject o = p.raw;
        switch (p.type) {
            case "hello_ack":
                backoffAttempt = 0;
                connected = true;
                Log.i(TAG, "hello_ack device_id=" + o.optString("device_id"));
                listener.onUp();
                break;
            case "call.accept":
                listener.onAccept(o.optString("call_id"), o.optString("system_instruction"),
                        o.optJSONObject("trigger_config"));
                break;
            case "call.place":
                listener.onPlace(o.optString("call_id"), o.optString("to"),
                        o.optString("system_instruction"), o.optJSONObject("trigger_config"));
                break;
            case "call.inject":
                listener.onInject(o.optString("call_id"), o.optString("text"));
                break;
            case "call.hangup":
                listener.onHangup(o.optString("call_id"), o.optString("reason"));
                break;
            case "sms.send":
                listener.onSmsSend(o.optString("to"), o.optString("body"), o.optString("client_ref"));
                break;
            default:
                Log.d(TAG, "ignoring frame type=" + p.type);
        }
    }

    private void writerLoop() {
        while (running) {
            String m;
            try {
                m = outbox.takeFirst();
            } catch (InterruptedException e) {
                continue;
            }
            boolean sent = false;
            while (running && !sent) {
                WebSocketClient w = activeWs;
                if (connected && w != null) {
                    try {
                        w.sendText(m);
                        sent = true;
                    } catch (IOException e) {
                        connected = false;
                    }
                }
                if (!sent) {
                    try {
                        Thread.sleep(200);
                    } catch (InterruptedException e) {
                        // fall through — `running` re-checked
                    }
                }
            }
            if (!sent) {
                outbox.addFirst(m); // shutting down before it went out — keep it at the head
            }
        }
    }

    private void heartbeatLoop() {
        while (running) {
            try {
                Thread.sleep(HEARTBEAT_MS);
            } catch (InterruptedException e) {
                continue;
            }
            if (connected) {
                send(Protocol.heartbeat(deviceId));
            }
        }
    }

    // --- helpers ----------------------------------------------------------

    private static void signal(Object latch, boolean[] done) {
        synchronized (latch) {
            done[0] = true;
            latch.notifyAll();
        }
    }

    private static void interrupt(Thread t) {
        if (t != null) {
            t.interrupt();
        }
    }

    /** Reconnect backoff: 1,2,4,8,16 s then a 30 s ceiling. */
    static long backoffMs(int attempt) {
        if (attempt < 0) {
            return 1000L;
        }
        if (attempt >= 5) {
            return 30_000L;
        }
        return 1000L << attempt;
    }

    // --- host-JVM self-test (backoffMs only) -----------------------------

    static void selfTest() {
        long[] want = {1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000};
        for (int i = 0; i < want.length; i++) {
            long got = backoffMs(i);
            if (got != want[i]) {
                throw new AssertionError("backoffMs(" + i + ")=" + got + " want " + want[i]);
            }
        }
        if (backoffMs(20) != 30_000L) {
            throw new AssertionError("backoffMs(large) must cap at 30000");
        }
        if (backoffMs(-3) != 1000L) {
            throw new AssertionError("backoffMs(negative) must floor at 1000");
        }
        System.out.println("OK: HermesLink (backoffMs schedule)");
    }

    public static void main(String[] args) {
        selfTest();
    }
}
