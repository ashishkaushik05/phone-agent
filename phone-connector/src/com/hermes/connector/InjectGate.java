package com.hermes.connector;

/**
 * The barge-in-safe gate for director injects (spec §0 findings): a
 * {@code <<DIRECTOR …>>} note is fed to Gemini only at a turn boundary —
 * either the model just finished a turn, or it has been idle (no output
 * audio) long enough that pushing a user turn now won't cut it off.
 *
 * Pure logic, host-tested.
 */
final class InjectGate {

    private InjectGate() {}

    /** Model counts as idle after this long with no output audio chunk. */
    static final long IDLE_MS = 1200;

    static boolean shouldFlushNow(boolean turnComplete, long msSinceLastAudio) {
        return turnComplete || msSinceLastAudio >= IDLE_MS;
    }

    static void selfTest() {
        if (!shouldFlushNow(true, 50)) {
            throw new AssertionError("turnComplete must flush regardless of audio recency");
        }
        if (!shouldFlushNow(false, 2000)) {
            throw new AssertionError("2s idle must flush");
        }
        if (shouldFlushNow(false, 200)) {
            throw new AssertionError("200ms since audio is mid-turn — must NOT flush");
        }
        if (shouldFlushNow(false, IDLE_MS - 1)) {
            throw new AssertionError("just under IDLE_MS must NOT flush");
        }
        if (!shouldFlushNow(false, IDLE_MS)) {
            throw new AssertionError("at IDLE_MS must flush");
        }
        System.out.println("OK: InjectGate (shouldFlushNow)");
    }

    public static void main(String[] args) {
        selfTest();
    }
}
