package com.hermes.connector;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Max-call-duration guard (old design §5, "watchdog"). {@link #start()} on
 * {@code STATE_ACTIVE}, {@link #cancel()} on {@code stopSession}. If a call runs
 * past {@code maxMs}, {@code onExpire} fires once — {@link ConnectorService}
 * then disconnects the call with end-reason {@code "watchdog"}.
 *
 * {@code maxMs} comes from {@code BuildConfig.MAX_CALL_MS} ({@code .env}
 * {@code max_call_ms}, default {@link #DEFAULT_MAX_MS}). The fire / no-early-fire
 * / cancel / re-arm behaviour is host-tested in {@link #selfTest()}.
 */
final class Watchdog {

    static final long DEFAULT_MAX_MS = 600_000; // 10 minutes

    private final long maxMs;
    private final Runnable onExpire;
    private final ScheduledExecutorService scheduler;
    private ScheduledFuture<?> future;
    private boolean fired;

    Watchdog(long maxMs, Runnable onExpire) {
        this.maxMs = maxMs > 0 ? maxMs : DEFAULT_MAX_MS;
        this.onExpire = onExpire;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "HermesConnector-Watchdog");
            t.setDaemon(true);
            return t;
        });
    }

    synchronized void start() {
        cancel();
        fired = false;
        future = scheduler.schedule(this::fire, maxMs, TimeUnit.MILLISECONDS);
    }

    synchronized void cancel() {
        if (future != null) {
            future.cancel(false);
            future = null;
        }
    }

    private void fire() {
        synchronized (this) {
            if (fired) {
                return;
            }
            fired = true;
        }
        onExpire.run();
    }

    // --- host-JVM self-test ------------------------------------------------
    // Run: javac ... && java -cp <obj> com.hermes.connector.Watchdog

    static void selfTest() throws InterruptedException {
        final int[] count = {0};

        // fires exactly once, not early
        Watchdog w = new Watchdog(200, () -> count[0]++);
        w.start();
        Thread.sleep(100);
        if (count[0] != 0) {
            throw new AssertionError("watchdog fired early");
        }
        Thread.sleep(250);
        if (count[0] != 1) {
            throw new AssertionError("watchdog did not fire once after maxMs, count=" + count[0]);
        }

        // cancel() prevents the fire
        Watchdog w2 = new Watchdog(200, () -> count[0]++);
        w2.start();
        Thread.sleep(50);
        w2.cancel();
        Thread.sleep(300);
        if (count[0] != 1) {
            throw new AssertionError("cancel() did not prevent the fire, count=" + count[0]);
        }

        // start() re-arms (and only fires once for the live timer)
        Watchdog w3 = new Watchdog(150, () -> count[0]++);
        w3.start();
        w3.start();
        Thread.sleep(300);
        if (count[0] != 2) {
            throw new AssertionError("re-armed watchdog did not fire once, count=" + count[0]);
        }

        System.out.println("OK: Watchdog (fire-once / no-early / cancel / re-arm)");
    }

    public static void main(String[] args) throws InterruptedException {
        selfTest();
    }
}
