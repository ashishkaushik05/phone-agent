package com.hermes.connector;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Gemini Live API (BidiGenerateContent) client, built on the hand-rolled
 * {@link WebSocketClient}. Speaks the WebSocket JSON protocol directly —
 * see docs/project-plan.md §2.7 / the Gemini agent integration design for
 * the schema this was written against (ai.google.dev/gemini-api/docs/live-api,
 * checked 2026-08-26):
 *
 *   connect:  wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY
 *   setup:    {"setup": {"model": "models/...", "generationConfig": {"responseModalities": ["AUDIO"]}, "systemInstruction": {...}}}
 *   audio in: {"realtimeInput": {"audio": {"data": base64, "mimeType": "audio/pcm;rate=16000"}}}
 *   text in:  {"clientContent": {"turns": [{"role":"user","parts":[{"text": "..."}]}], "turnComplete": true}}
 *   audio out:{"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": base64}}]}, "turnComplete": bool, "interrupted": bool}}
 *   ack:      {"setupComplete": {}}  (no fields, top-level key presence is the whole signal)
 *
 * Schema confirmed against ai.google.dev/api/live (2026-08-26) plus one
 * real round trip via GeminiSmokeTestReceiver, which caught the
 * responseModalities/generationConfig nesting the docs summary alone
 * missed — exactly why that standalone test exists before this touches a
 * live call.
 *
 * Also supports tool/function calling (registerTool before connect()):
 *
 *   setup:      setup.tools = [{"functionDeclarations": [{"name":..., "description":...,
 *               "parameters": {"type":"object","properties":{...},"required":[...]}}]}]
 *   tool call:  {"toolCall": {"functionCalls": [{"id":..., "name":..., "args": {...}}]}}
 *   response:   {"toolResponse": {"functionResponses": [{"id":..., "name":..., "response": {...}}]}}
 *
 * gemini-3.1-flash-live-preview's function calling is synchronous only —
 * the model pauses until every requested call gets a toolResponse. See
 * docs/gemini-tool-calling-and-sheets-report.md for the full design.
 */
class GeminiLiveClient {

    private static final String TAG = "HermesGemini";
    private static final String HOST = "generativelanguage.googleapis.com";
    private static final int PORT = 443;
    private static final String WS_PATH_TEMPLATE =
            "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=%s";
    static final String MODEL = "models/gemini-3.1-flash-live-preview";

    interface Listener {
        /** setupComplete received — safe to start streaming audio/text now. */
        void onReady();

        /** Decoded raw PCM audio from the model (24kHz mono S16LE per the Live API's default output format). */
        void onAudioChunk(byte[] pcm24k);

        /** Model finished speaking for this turn. */
        void onTurnComplete();

        /** The user/far-end spoke over the model — caller should stop/flush any playback immediately. */
        void onInterrupted();

        /** Any transcript text present on the message (input or output transcription), for logging. */
        void onTranscript(String text);

        void onClosed(String reason);

        void onError(Exception e);
    }

    /** A tool the model can call. Runs on its own thread (see handleToolCall) — never on the WS reader thread. */
    interface ToolHandler {
        /** Executes the tool with the model-supplied args, returns the result to send back. May throw. */
        JSONObject execute(JSONObject args) throws Exception;
    }

    private volatile Listener listener;
    private WebSocketClient ws;
    private volatile boolean ready = false;

    // --- latency instrumentation (see LATENCY.md); logging only, no behaviour change ---
    private volatile long connectStartMs;
    private volatile long setupCompleteMs;
    private volatile boolean firstAudioLogged;
    private long sendWindowStartMs;
    private long sendWindowCount;
    private long sendWindowNanos;
    private long sendWindowMaxNanos;

    // Insertion order preserved so setup's declared tool order is stable/predictable in logs.
    private final Map<String, JSONObject> toolDeclarations = new LinkedHashMap<>();
    private final Map<String, ToolHandler> toolHandlers = new LinkedHashMap<>();

    GeminiLiveClient(Listener listener) {
        this.listener = listener;
    }

    /**
     * Swap the listener after construction — used for outbound prewarm (see
     * {@link OutboundCoordinator}), where the client is created and connected before the
     * {@link ConnectorService} that owns the real listener exists. Safe up to setupComplete:
     * the model has nothing to say until it hears the caller, so the no-op prewarm listener
     * never actually misses real audio in practice.
     */
    void setListener(Listener l) {
        this.listener = l;
    }

    /**
     * Registers a tool the model may call during this session. Must be called before
     * {@link #connect}, since declarations are sent as part of the initial `setup` message.
     *
     * @param declaration a FunctionDeclaration object: {"name":..., "description":...,
     *                    "parameters": {"type":"object", "properties": {...}, "required": [...]}}
     */
    void registerTool(String name, JSONObject declaration, ToolHandler handler) {
        toolDeclarations.put(name, declaration);
        toolHandlers.put(name, handler);
    }

    void connect(String apiKey, String systemInstruction) throws IOException {
        String path = String.format(WS_PATH_TEMPLATE, urlEncode(apiKey));
        connectStartMs = System.currentTimeMillis();
        ws = new WebSocketClient(HOST, PORT, path, new WebSocketClient.Listener() {
            @Override
            public void onOpen() {
                Log.i(TAG, "latency: ws open +" + (System.currentTimeMillis() - connectStartMs) + "ms"
                        + " (si.len=" + (systemInstruction == null ? 0 : systemInstruction.length()) + ")");
                try {
                    sendSetup(systemInstruction);
                } catch (Exception e) {
                    listener.onError(e);
                }
            }

            @Override
            public void onText(String message) {
                handleServerMessage(message);
            }

            @Override
            public void onBinary(byte[] data) {
                // The Live API sends its JSON server messages over binary WS frames (opcode 0x2),
                // not text frames (0x1) — found live via GeminiSmokeTestReceiver: a 26-byte binary
                // frame arrived immediately after `setup`, matching {"setupComplete":{}}, and was
                // being silently dropped here before this fix. UTF-8 decode + same JSON path as text.
                try {
                    handleServerMessage(new String(data, "UTF-8"));
                } catch (Exception e) {
                    Log.e(TAG, "failed to decode binary WS frame as UTF-8 JSON, " + data.length + " bytes", e);
                }
            }

            @Override
            public void onClose(int code, String reason) {
                ready = false;
                listener.onClosed("code=" + code + " reason=" + reason);
            }

            @Override
            public void onError(Exception e) {
                ready = false;
                listener.onError(e);
            }
        });
        ws.connect();
    }

    private void sendSetup(String systemInstruction) throws JSONException, IOException {
        JSONObject setup = new JSONObject();
        setup.put("model", MODEL);
        JSONObject generationConfig = new JSONObject();
        generationConfig.put("responseModalities", new JSONArray().put("AUDIO"));
        setup.put("generationConfig", generationConfig);
        if (systemInstruction != null && !systemInstruction.isEmpty()) {
            JSONObject si = new JSONObject();
            JSONArray parts = new JSONArray();
            parts.put(new JSONObject().put("text", systemInstruction));
            si.put("parts", parts);
            setup.put("systemInstruction", si);
        }
        if (!toolDeclarations.isEmpty()) {
            JSONArray functionDeclarations = new JSONArray();
            for (JSONObject decl : toolDeclarations.values()) {
                functionDeclarations.put(decl);
            }
            JSONObject tool = new JSONObject().put("functionDeclarations", functionDeclarations);
            setup.put("tools", new JSONArray().put(tool));
        }
        JSONObject root = new JSONObject();
        root.put("setup", setup);
        Log.i(TAG, "sending setup: " + root);
        ws.sendText(root.toString());
    }

    /** Feed one chunk of raw 16-bit PCM, 16kHz, mono, little-endian audio (matches VOICE_DOWNLINK capture format). */
    void sendAudioChunk(byte[] pcm16kMono, int offset, int length) {
        if (!ready) {
            return; // drop pre-setupComplete audio rather than queueing; caller retries next chunk
        }
        try {
            byte[] slice = (offset == 0 && length == pcm16kMono.length)
                    ? pcm16kMono
                    : java.util.Arrays.copyOfRange(pcm16kMono, offset, offset + length);
            String b64 = Base64.getEncoder().encodeToString(slice);
            JSONObject audio = new JSONObject();
            audio.put("data", b64);
            audio.put("mimeType", "audio/pcm;rate=16000");
            JSONObject realtimeInput = new JSONObject();
            realtimeInput.put("audio", audio);
            JSONObject root = new JSONObject();
            root.put("realtimeInput", realtimeInput);
            long t = System.nanoTime();
            ws.sendText(root.toString());
            recordSend(System.nanoTime() - t);
        } catch (Exception e) {
            listener.onError(e);
        }
    }

    /**
     * Tracks how long {@code ws.sendText} blocks per audio chunk. A rising max/avg means the
     * uplink is congesting and the capture thread is stalling on it (LATENCY.md §1).
     */
    private void recordSend(long nanos) {
        long now = System.currentTimeMillis();
        synchronized (this) {
            if (sendWindowStartMs == 0) {
                sendWindowStartMs = now;
            }
            sendWindowCount++;
            sendWindowNanos += nanos;
            if (nanos > sendWindowMaxNanos) {
                sendWindowMaxNanos = nanos;
            }
            if (now - sendWindowStartMs >= 5000) {
                Log.i(TAG, String.format("latency: audio send over %dms — n=%d avg=%.1fms max=%.1fms",
                        now - sendWindowStartMs, sendWindowCount,
                        sendWindowNanos / 1e6 / Math.max(1, sendWindowCount), sendWindowMaxNanos / 1e6));
                sendWindowStartMs = now;
                sendWindowCount = 0;
                sendWindowNanos = 0;
                sendWindowMaxNanos = 0;
            }
        }
    }

    /**
     * Send a plain text user turn (turnComplete=true). Two callers:
     * GeminiSmokeTestReceiver (standalone check) and ConnectorService's director-inject
     * path, which passes the already-wrapped {@code <<DIRECTOR …>>} note verbatim.
     */
    void sendClientText(String text) {
        try {
            JSONObject part = new JSONObject().put("text", text);
            JSONObject turn = new JSONObject()
                    .put("role", "user")
                    .put("parts", new JSONArray().put(part));
            JSONObject clientContent = new JSONObject()
                    .put("turns", new JSONArray().put(turn))
                    .put("turnComplete", true);
            JSONObject root = new JSONObject().put("clientContent", clientContent);
            Log.i(TAG, "sending text turn: " + root);
            ws.sendText(root.toString());
        } catch (Exception e) {
            listener.onError(e);
        }
    }

    private void handleServerMessage(String message) {
        try {
            JSONObject root = new JSONObject(message);
            Log.d(TAG, "server message: " + trimForLog(message));

            if (root.has("setupComplete")) {
                ready = true;
                setupCompleteMs = System.currentTimeMillis();
                Log.i(TAG, "latency: setupComplete +" + (setupCompleteMs - connectStartMs) + "ms from connect start");
                listener.onReady();
                return;
            }
            if (root.has("error")) {
                listener.onError(new IOException("server error: " + root.get("error")));
                return;
            }
            if (root.has("toolCall")) {
                handleToolCall(root.getJSONObject("toolCall"));
                return;
            }
            if (!root.has("serverContent")) {
                return;
            }
            JSONObject serverContent = root.getJSONObject("serverContent");

            if (serverContent.optBoolean("interrupted", false)) {
                listener.onInterrupted();
            }

            if (serverContent.has("modelTurn")) {
                JSONObject modelTurn = serverContent.getJSONObject("modelTurn");
                JSONArray parts = modelTurn.optJSONArray("parts");
                if (parts != null) {
                    for (int i = 0; i < parts.length(); i++) {
                        JSONObject part = parts.getJSONObject(i);
                        if (part.has("inlineData")) {
                            String b64 = part.getJSONObject("inlineData").optString("data", null);
                            if (b64 != null) {
                                byte[] pcm = Base64.getDecoder().decode(b64);
                                if (!firstAudioLogged) {
                                    firstAudioLogged = true;
                                    long ref = setupCompleteMs > 0 ? setupCompleteMs : connectStartMs;
                                    Log.i(TAG, "latency: first model audio +"
                                            + (System.currentTimeMillis() - ref) + "ms from setupComplete");
                                }
                                listener.onAudioChunk(pcm);
                            }
                        }
                        if (part.has("text")) {
                            listener.onTranscript(part.getString("text"));
                        }
                    }
                }
            }

            String inputTranscript = optNestedText(serverContent, "inputTranscription");
            if (inputTranscript != null) {
                listener.onTranscript("[input] " + inputTranscript);
            }
            String outputTranscript = optNestedText(serverContent, "outputTranscription");
            if (outputTranscript != null) {
                listener.onTranscript("[output] " + outputTranscript);
            }

            if (serverContent.optBoolean("turnComplete", false)) {
                listener.onTurnComplete();
            }
        } catch (JSONException e) {
            Log.e(TAG, "failed to parse server message: " + trimForLog(message), e);
        }
    }

    /**
     * gemini-3.1-flash-live-preview's function calling is synchronous: the model pauses
     * generation until sendToolResponse() is called for every requested functionCall (see
     * docs/gemini-tool-calling-and-sheets-report.md §1). Each call is dispatched to its own
     * thread — never run inline here, since this method runs on the WebSocketClient reader
     * thread, and a tool that blocked (the connector's only tool, end_call, does not)
     * would stall delivery of every subsequent server message, including audio, for as long as it took.
     */
    private void handleToolCall(JSONObject toolCall) {
        JSONArray functionCalls = toolCall.optJSONArray("functionCalls");
        if (functionCalls == null) {
            return;
        }
        for (int i = 0; i < functionCalls.length(); i++) {
            JSONObject call;
            try {
                call = functionCalls.getJSONObject(i);
            } catch (JSONException e) {
                continue;
            }
            String id = call.optString("id", null);
            String name = call.optString("name", null);
            JSONObject args = call.optJSONObject("args");
            if (args == null) {
                args = new JSONObject();
            }
            final JSONObject finalArgs = args;
            new Thread(() -> runToolCall(id, name, finalArgs), "GeminiLiveClient-Tool-" + name).start();
        }
    }

    private void runToolCall(String id, String name, JSONObject args) {
        Log.i(TAG, "tool call requested: name=" + name + " id=" + id + " args=" + args);
        ToolHandler handler = toolHandlers.get(name);
        JSONObject response;
        if (handler == null) {
            Log.e(TAG, "no handler registered for tool \"" + name + "\"");
            response = new JSONObject();
            try {
                response.put("error", "no handler registered for tool \"" + name + "\"");
            } catch (JSONException ignored) {
            }
        } else {
            try {
                response = handler.execute(args);
                Log.i(TAG, "tool \"" + name + "\" succeeded: " + response);
            } catch (Exception e) {
                Log.e(TAG, "tool \"" + name + "\" threw", e);
                response = new JSONObject();
                try {
                    response.put("error", String.valueOf(e.getMessage()));
                } catch (JSONException ignored) {
                }
            }
        }
        sendToolResponse(id, name, response);
    }

    private void sendToolResponse(String id, String name, JSONObject response) {
        try {
            JSONObject functionResponse = new JSONObject();
            if (id != null) {
                functionResponse.put("id", id);
            }
            functionResponse.put("name", name);
            functionResponse.put("response", response);
            JSONObject toolResponse = new JSONObject()
                    .put("functionResponses", new JSONArray().put(functionResponse));
            JSONObject root = new JSONObject().put("toolResponse", toolResponse);
            Log.i(TAG, "sending tool response: " + root);
            ws.sendText(root.toString());
        } catch (Exception e) {
            listener.onError(e);
        }
    }

    private static String optNestedText(JSONObject obj, String key) {
        JSONObject nested = obj.optJSONObject(key);
        return nested != null ? nested.optString("text", null) : null;
    }

    private static String trimForLog(String s) {
        return s.length() > 300 ? s.substring(0, 300) + "...(" + s.length() + " chars)" : s;
    }

    private static String urlEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    boolean isReady() {
        return ready;
    }

    void close() {
        if (ws != null) {
            ws.close();
        }
        ready = false;
    }
}
