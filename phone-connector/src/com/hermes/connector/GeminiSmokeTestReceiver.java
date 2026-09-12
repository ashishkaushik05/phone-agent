package com.hermes.connector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Standalone diagnostic entry point for GeminiLiveClient — deliberately NOT
 * gated behind BIND_INCALL_SERVICE (unlike ConnectorService), so it can be
 * triggered directly over adb without needing a live call:
 *
 *   adb shell am broadcast -a com.hermes.connector.TEST_GEMINI \
 *       --es text "Say hello in one short sentence."
 *
 * Opens a Gemini Live session, sends one text turn (no audio/telephony
 * permissions needed for this), logs whatever comes back, and closes. This
 * exists to prove the hand-rolled WebSocket/JSON protocol layer works
 * end-to-end — connect, setupComplete, a real model turn, audio bytes
 * decoded — before wiring it into the real (expensive-to-iterate-on, one
 * shot per phone call) call-audio path in ConnectorService.
 */
public class GeminiSmokeTestReceiver extends BroadcastReceiver {

    private static final String TAG = "HermesGeminiSmoke";

    @Override
    public void onReceive(Context context, Intent intent) {
        String text = intent.getStringExtra("text");
        if (text == null || text.isEmpty()) {
            text = "Say hello in one short sentence.";
        }
        final String prompt = text;
        Log.i(TAG, "smoke test starting, prompt=" + prompt);

        // Do the actual work off the broadcast-receiver's main-thread callback window.
        new Thread(() -> runSmokeTest(prompt), "GeminiSmokeTest").start();
    }

    private void runSmokeTest(String prompt) {
        final Object lock = new Object();
        final boolean[] done = {false};
        long startMs = System.currentTimeMillis();

        GeminiLiveClient client = new GeminiLiveClient(new GeminiLiveClient.Listener() {
            int audioChunks = 0;
            int audioBytes = 0;

            @Override
            public void onReady() {
                Log.i(TAG, "setupComplete received at t+" + (System.currentTimeMillis() - startMs)
                        + "ms, sending text turn");
                // sendClientText is called from the caller after connect() returns, see below —
                // keep this callback log-only to avoid racing GeminiLiveClient's internal state.
            }

            @Override
            public void onAudioChunk(byte[] pcm24k) {
                audioChunks++;
                audioBytes += pcm24k.length;
                Log.i(TAG, "audio chunk #" + audioChunks + ", " + pcm24k.length
                        + " bytes (total " + audioBytes + "), t+" + (System.currentTimeMillis() - startMs) + "ms");
            }

            @Override
            public void onTurnComplete() {
                Log.i(TAG, "turnComplete at t+" + (System.currentTimeMillis() - startMs)
                        + "ms, totalAudioChunks=" + audioChunks + " totalAudioBytes=" + audioBytes);
                synchronized (lock) {
                    done[0] = true;
                    lock.notifyAll();
                }
            }

            @Override
            public void onInterrupted() {
                Log.i(TAG, "interrupted signal received");
            }

            @Override
            public void onTranscript(String text) {
                Log.i(TAG, "transcript: " + text);
            }

            @Override
            public void onClosed(String reason) {
                Log.i(TAG, "closed: " + reason);
                synchronized (lock) {
                    done[0] = true;
                    lock.notifyAll();
                }
            }

            @Override
            public void onError(Exception e) {
                Log.e(TAG, "error", e);
                synchronized (lock) {
                    done[0] = true;
                    lock.notifyAll();
                }
            }
        });

        try {
            client.connect(BuildConfig.GEMINI_API_KEY,
                    "You are a helpful, concise voice assistant answering a phone call on behalf of the device owner.");

            // Wait for setupComplete (onReady) before sending the turn.
            long waitStart = System.currentTimeMillis();
            while (!client.isReady() && System.currentTimeMillis() - waitStart < 10_000) {
                Thread.sleep(50);
            }
            if (!client.isReady()) {
                Log.e(TAG, "setupComplete never arrived within 10s, aborting smoke test");
                client.close();
                return;
            }

            client.sendClientText(prompt);

            synchronized (lock) {
                if (!done[0]) {
                    lock.wait(20_000);
                }
            }
            if (!done[0]) {
                Log.e(TAG, "smoke test timed out waiting for turnComplete (20s)");
            } else {
                Log.i(TAG, "smoke test finished, total elapsed=" + (System.currentTimeMillis() - startMs) + "ms");
            }
        } catch (Exception e) {
            Log.e(TAG, "smoke test threw", e);
        } finally {
            client.close();
        }
    }
}
