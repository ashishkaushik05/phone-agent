package com.hermes.connector;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Correlates an outbound {@code call.place} (from hermes-core, or the dev
 * broadcast) with the Telecom {@code onCallAdded(DIRECTION_OUTGOING)} that
 * follows, by the last 10 digits of the dialed number — replacing probe-app's
 * single {@code static volatile String pendingOutboundScript} (design
 * decision 8). Also arms a per-call dial-timeout: if nothing {@link #match}es a
 * pending entry within {@link #DIAL_TIMEOUT_MS}, {@link TimeoutSink#onDialTimeout}
 * fires and the entry is dropped.
 *
 * Process-wide singleton ({@link #get()}) because the {@link InCallService} that
 * reads it ({@link ConnectorService}) is only bound by Telecom while a call
 * exists — the pending entry has to outlive that. The {@code last10} + map logic
 * is pure and host-tested via {@link #selfTest()} (which uses a no-timer instance).
 */
final class OutboundCoordinator {

    private static final String TAG = "HermesConnector";

    static final long DIAL_TIMEOUT_MS = 20_000;

    private static final OutboundCoordinator INSTANCE = new OutboundCoordinator(true);

    /** The process-wide coordinator. */
    static OutboundCoordinator get() {
        return INSTANCE;
    }

    interface TimeoutSink {
        /** No {@code onCallAdded} consumed {@code callId} within the dial-timeout window. */
        void onDialTimeout(String callId, String to);
    }

    static final class Pending {
        final String callId;
        final String to;
        /** null -> the call runs on {@link ConnectorService#DEFAULT_SYSTEM_INSTRUCTION}. */
        final String systemInstruction;
        ScheduledFuture<?> timer;
        /** Set by {@link #attachClient} once {@link LinkService} has pre-connected Gemini,
         *  before Telecom is asked to place the call. {@link ConnectorService#handleOutbound}
         *  adopts this instead of opening a fresh session. Null if the prewarm never got a
         *  chance to run or hasn't reached this point yet. */
        volatile GeminiLiveClient prewarmedClient;

        Pending(String callId, String to, String systemInstruction) {
            this.callId = callId;
            this.to = to;
            this.systemInstruction = systemInstruction;
        }
    }

    private final Map<String, Pending> byLast10 = new HashMap<>();
    private final ScheduledExecutorService scheduler; // null in the selfTest instance
    private volatile TimeoutSink sink;

    private OutboundCoordinator(boolean armTimers) {
        this.scheduler = armTimers
                ? Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "HermesConnector-DialTimeout");
                    t.setDaemon(true);
                    return t;
                })
                : null;
    }

    /** Wired once by {@link LinkService} so a dial-timeout can send {@code call.ended}. */
    void setSink(TimeoutSink s) {
        this.sink = s;
    }

    /** Register an expected outbound call and arm its dial-timeout. */
    synchronized void expect(String callId, String toNumber, String systemInstruction) {
        String key = last10(toNumber);
        Pending prev = byLast10.remove(key);
        if (prev != null && prev.timer != null) {
            prev.timer.cancel(false);
        }
        Pending p = new Pending(callId, toNumber, systemInstruction);
        byLast10.put(key, p);
        if (scheduler != null) {
            p.timer = scheduler.schedule(
                    () -> fireTimeout(key, callId, toNumber), DIAL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        }
    }

    private void fireTimeout(String key, String callId, String to) {
        GeminiLiveClient prewarmed;
        synchronized (this) {
            Pending p = byLast10.remove(key);
            if (p == null) {
                return; // already matched / cancelled
            }
            prewarmed = p.prewarmedClient;
        }
        closeIfPresent(prewarmed); // never got a Telecom call to attach to — don't leak the WS
        TimeoutSink s = sink;
        if (s != null) {
            s.onDialTimeout(callId, to);
        }
    }

    /** {@code close()} does blocking WS I/O — never on the caller's thread (timer / cancel callers
     *  may be on the main thread). */
    private static void closeIfPresent(GeminiLiveClient client) {
        if (client != null) {
            new Thread(client::close, "HermesConnector-GeminiClose").start();
        }
    }

    /** Return + remove the pending entry whose last-10 matches {@code dialedHandle}, else null. */
    synchronized Pending match(String dialedHandle) {
        Pending p = byLast10.remove(last10(dialedHandle));
        if (p != null && p.timer != null) {
            p.timer.cancel(false);
        }
        return p;
    }

    /** Attach a prewarmed Gemini session to the still-pending entry for {@code callId}, found
     *  by scanning (mirrors {@link #cancel}) since only the dialed number keys the map. No-op if
     *  the entry already matched/timed out/was cancelled before the prewarm finished connecting. */
    synchronized void attachClient(String callId, GeminiLiveClient client) {
        for (Pending p : byLast10.values()) {
            if (p.callId.equals(callId)) {
                p.prewarmedClient = client;
                return;
            }
        }
    }

    /** Drop a pending entry by call id (e.g. {@code placeCall} threw). */
    void cancel(String callId) {
        GeminiLiveClient prewarmed = null;
        synchronized (this) {
            for (Iterator<Pending> it = byLast10.values().iterator(); it.hasNext(); ) {
                Pending p = it.next();
                if (p.callId.equals(callId)) {
                    if (p.timer != null) {
                        p.timer.cancel(false);
                    }
                    prewarmed = p.prewarmedClient;
                    it.remove();
                }
            }
        }
        closeIfPresent(prewarmed);
    }

    /** Digits of {@code s}, last 10 (or all, if fewer). Normalises {@code +1 (555) 123-4567} and {@code tel:...}. */
    static String last10(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder d = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= '0' && c <= '9') {
                d.append(c);
            }
        }
        String digits = d.toString();
        return digits.length() <= 10 ? digits : digits.substring(digits.length() - 10);
    }

    // --- host-JVM self-test ------------------------------------------------
    // Run: javac ... && java -cp <obj> com.hermes.connector.OutboundCoordinator

    static void selfTest() {
        eq(last10("+1 (555) 123-4567"), "5551234567");
        eq(last10("+91 98765 43210"), "9876543210");
        eq(last10("tel:+15551234567"), "5551234567");
        eq(last10("12345"), "12345");
        eq(last10(null), "");
        eq(last10(""), "");

        OutboundCoordinator c = new OutboundCoordinator(false); // no real timers

        c.expect("c1", "+15551234567", "si-1");
        Pending m = c.match("5551234567");
        if (m == null || !m.callId.equals("c1") || !"si-1".equals(m.systemInstruction) || !m.to.equals("+15551234567")) {
            throw new AssertionError("expect/match c1 failed: " + m);
        }
        if (c.match("5551234567") != null) {
            throw new AssertionError("second match must be null — entry consumed");
        }
        if (c.match("9999999999") != null) {
            throw new AssertionError("unknown number must not match");
        }

        // match by a punctuated / prefixed handle string
        c.expect("c2", "+1 555 000 1111", null);
        Pending m2 = c.match("tel:+1-555-000-1111");
        if (m2 == null || !m2.callId.equals("c2") || m2.systemInstruction != null) {
            throw new AssertionError("match by punctuated handle failed: " + m2);
        }

        // cancel by call id
        c.expect("c3", "+15552223333", "si-3");
        c.cancel("c3");
        if (c.match("5552223333") != null) {
            throw new AssertionError("cancel(c3) must remove the pending entry");
        }

        // re-expect on the same number replaces the prior entry
        c.expect("c4a", "+15554445555", "a");
        c.expect("c4b", "+15554445555", "b");
        Pending m4 = c.match("5554445555");
        if (m4 == null || !m4.callId.equals("c4b")) {
            throw new AssertionError("re-expect must replace: " + m4);
        }

        // timeout sink fires for an unmatched entry (drive fireTimeout directly — no scheduler here)
        final String[] timedOut = {null};
        c.setSink((callId, to) -> timedOut[0] = callId + "|" + to);
        c.expect("c5", "+15559998888", null);
        c.fireTimeout(last10("+15559998888"), "c5", "+15559998888");
        eq(timedOut[0], "c5|+15559998888");
        // a matched entry must NOT then time out
        timedOut[0] = null;
        c.expect("c6", "+15551112222", null);
        c.match("5551112222");
        c.fireTimeout(last10("+15551112222"), "c6", "+15551112222");
        if (timedOut[0] != null) {
            throw new AssertionError("matched entry must not fire the timeout sink");
        }

        System.out.println("OK: OutboundCoordinator (last10 + expect/match/cancel + dial-timeout)");
    }

    private static void eq(String got, String want) {
        if (!want.equals(got)) {
            throw new AssertionError("expected \"" + want + "\" got \"" + got + "\"");
        }
    }

    public static void main(String[] args) {
        selfTest();
    }
}
