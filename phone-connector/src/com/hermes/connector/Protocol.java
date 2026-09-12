package com.hermes.connector;

/**
 * Wire codec for the hermes-core link. Pure Java — no {@code android.*} — so
 * it runs under the host-JVM self-test.
 *
 * The contract is {@code hermes-core/src/protocol.ts} after Phase A. Every
 * phone -> core message carries {@code type} and {@code device_id}
 * ({@code hermes-core}'s {@code isPhoneMsg} rejects anything missing either).
 *
 * Encoders build JSON by hand (the messages are flat objects of strings +
 * one number) with correct RFC 8259 string escaping — deliberately not via
 * {@code org.json}, whose host build is a "Stub!". {@link #parse} does use
 * {@code org.json} because it only ever runs on the device.
 */
final class Protocol {

    private Protocol() {}

    // --- phone -> core encoders -------------------------------------------------

    static String hello(String deviceId) {
        return "{" + kv("type", "hello") + "," + kv("device_id", deviceId) + "}";
    }

    static String callInbound(String callId, String from, String deviceId) {
        return "{" + kv("type", "call.inbound") + "," + kv("call_id", callId) + ","
                + kv("from", from) + "," + kv("device_id", deviceId) + "}";
    }

    static String callDialing(String callId, String to, String deviceId) {
        return "{" + kv("type", "call.dialing") + "," + kv("call_id", callId) + ","
                + kv("to", to) + "," + kv("device_id", deviceId) + "}";
    }

    static String callActive(String callId, String deviceId) {
        return "{" + kv("type", "call.active") + "," + kv("call_id", callId) + ","
                + kv("device_id", deviceId) + "}";
    }

    static String transcript(String callId, String role, String text, long ts, String deviceId) {
        return "{" + kv("type", "transcript") + "," + kv("call_id", callId) + ","
                + kv("role", role) + "," + kv("text", text) + ",\"ts\":" + ts + ","
                + kv("device_id", deviceId) + "}";
    }

    static String callEnded(String callId, String reason, String summary, String deviceId) {
        StringBuilder b = new StringBuilder("{");
        b.append(kv("type", "call.ended")).append(",")
                .append(kv("call_id", callId)).append(",")
                .append(kv("reason", reason));
        if (summary != null) {
            b.append(",").append(kv("summary", summary));
        }
        b.append(",").append(kv("device_id", deviceId)).append("}");
        return b.toString();
    }

    static String heartbeat(String deviceId) {
        return "{" + kv("type", "heartbeat") + "," + kv("device_id", deviceId) + "}";
    }

    static String smsInbound(String from, String body, long ts, String deviceId) {
        return "{" + kv("type", "sms.inbound") + "," + kv("from", from) + ","
                + kv("body", body) + ",\"ts\":" + ts + "," + kv("device_id", deviceId) + "}";
    }

    static String smsSent(String clientRef, boolean ok, String error, String deviceId) {
        return smsResult("sms.sent", clientRef, ok, error, deviceId);
    }

    static String smsDelivered(String clientRef, boolean ok, String error, String deviceId) {
        return smsResult("sms.delivered", clientRef, ok, error, deviceId);
    }

    private static String smsResult(String type, String clientRef, boolean ok, String error, String deviceId) {
        StringBuilder b = new StringBuilder("{");
        b.append(kv("type", type)).append(",")
                .append(kv("client_ref", clientRef)).append(",")
                .append("\"ok\":").append(ok);
        if (error != null) {
            b.append(",").append(kv("error", error));
        }
        b.append(",").append(kv("device_id", deviceId)).append("}");
        return b.toString();
    }

    // --- core -> phone parse ---------------------------------------------------

    /** A decoded core -> phone frame. {@code type} is "" when the frame has no string type. */
    static final class Parsed {
        final String type;
        final org.json.JSONObject raw;

        Parsed(String type, org.json.JSONObject raw) {
            this.type = type;
            this.raw = raw;
        }
    }

    static Parsed parse(String json) throws org.json.JSONException {
        org.json.JSONObject o = new org.json.JSONObject(json);
        return new Parsed(o.optString("type", ""), o);
    }

    // --- disconnect cause -> EndReason ---------------------------------------

    // Mirrors android.telecom.DisconnectCause codes (kept local so this class stays android-free).
    static final int CAUSE_ERROR = 1;
    static final int CAUSE_LOCAL = 2;
    static final int CAUSE_REMOTE = 3;
    static final int CAUSE_CANCELED = 4;
    static final int CAUSE_MISSED = 5;
    static final int CAUSE_REJECTED = 6;
    static final int CAUSE_BUSY = 7;

    /**
     * Resolve the end-reason for a call that just disconnected.
     *
     * @param telecomCause    {@code call.getDetails().getDisconnectCause().getCode()}
     * @param weInitiated     true if the agent's local {@code end_call} tool triggered the disconnect
     * @param requestedReason non-null if hermes-core sent {@code call.hangup {reason}} — that reason wins
     * @return one of the end-reason taxonomy strings
     *         ({@code agent_ended | remote_hangup | aborted_off_script | watchdog | far_party | dial_timeout | error})
     */
    static String mapDisconnectCause(int telecomCause, boolean weInitiated, String requestedReason) {
        if (requestedReason != null) {
            return requestedReason;
        }
        switch (telecomCause) {
            case CAUSE_LOCAL:
                return weInitiated ? "agent_ended" : "remote_hangup";
            case CAUSE_REMOTE:
            case CAUSE_BUSY:
            case CAUSE_REJECTED:
            case CAUSE_CANCELED:
                return "far_party";
            default:
                // ERROR / MISSED / UNKNOWN: a dial-timeout on outbound is caught earlier by
                // OutboundCoordinator (it passes requestedReason="dial_timeout"); anything left is an error.
                return "error";
        }
    }

    // --- helpers -------------------------------------------------------------

    private static String kv(String key, String value) {
        return "\"" + key + "\":\"" + esc(value) + "\"";
    }

    /** RFC 8259 §7 string-content escaping. */
    private static String esc(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.toString();
    }

    // --- host-JVM self-test -------------------------------------------------
    // Run: javac ... && java -cp <obj>[:<org.json.jar>] com.hermes.connector.Protocol

    static void selfTest() {
        check(hello("ginkgo-1"), "hello", "device_id", "ginkgo-1");
        check(callInbound("ginkgo-1-1699999999999", "+15551230000", "ginkgo-1"), "call.inbound", "from", "+15551230000");
        check(callDialing("c1", "+15551230000", "ginkgo-1"), "call.dialing", "to", "+15551230000");
        check(callActive("c1", "ginkgo-1"), "call.active", "call_id", "c1");
        check(transcript("c1", "caller", "plain", 1699999999999L, "ginkgo-1"), "transcript", "role", "caller");
        check(callEnded("c1", "agent_ended", "wrapped up", "ginkgo-1"), "call.ended", "reason", "agent_ended");
        check(heartbeat("ginkgo-1"), "heartbeat", "device_id", "ginkgo-1");

        // callEnded without a summary must omit the key entirely
        if (callEnded("c1", "error", null, "ginkgo-1").contains("summary")) {
            throw new AssertionError("callEnded(null summary) must omit summary");
        }

        // transcript string escaping: no literal newline, quote and newline escaped
        String t = transcript("c1", "agent", "a\"b\nc\\d", 1L, "ginkgo-1");
        if (t.contains("\n") || !t.contains("\\\"") || !t.contains("\\n") || !t.contains("\\\\")) {
            throw new AssertionError("transcript escaping wrong: " + t);
        }
        // ts is an unquoted number
        if (!t.contains("\"ts\":1,")) {
            throw new AssertionError("ts must be an unquoted number: " + t);
        }

        // --- SMS encoders ---
        check(smsInbound("+15551230000", "hi there", 1699999999999L, "ginkgo-1"), "sms.inbound", "from", "+15551230000");
        check(smsSent("42", true, null, "ginkgo-1"), "sms.sent", "client_ref", "42");
        check(smsDelivered("42", false, "resultCode=2", "ginkgo-1"), "sms.delivered", "error", "resultCode=2");
        if (smsSent("42", true, null, "ginkgo-1").contains("\"error\"")) {
            throw new AssertionError("smsSent(ok, null error) must omit error");
        }
        if (!smsSent("42", true, null, "ginkgo-1").contains("\"ok\":true")) {
            throw new AssertionError("smsSent must emit an unquoted ok boolean");
        }
        String si = smsInbound("a\"b", "c\nd", 1L, "ginkgo-1");
        if (si.contains("\n") || !si.contains("\\\"") || !si.contains("\\n")) {
            throw new AssertionError("smsInbound escaping wrong: " + si);
        }
        if (!si.contains("\"ts\":1,")) {
            throw new AssertionError("smsInbound ts must be an unquoted number: " + si);
        }

        // mapDisconnectCause truth table
        eq(mapDisconnectCause(CAUSE_LOCAL, true, "watchdog"), "watchdog");    // hermes-core reason wins
        eq(mapDisconnectCause(CAUSE_LOCAL, true, null), "agent_ended");        // agent end_call tool
        eq(mapDisconnectCause(CAUSE_LOCAL, false, null), "remote_hangup");     // device user hung up
        eq(mapDisconnectCause(CAUSE_REMOTE, false, null), "far_party");
        eq(mapDisconnectCause(CAUSE_BUSY, false, null), "far_party");
        eq(mapDisconnectCause(CAUSE_REJECTED, false, null), "far_party");
        eq(mapDisconnectCause(CAUSE_CANCELED, false, null), "far_party");
        eq(mapDisconnectCause(CAUSE_ERROR, false, null), "error");
        eq(mapDisconnectCause(CAUSE_MISSED, false, null), "error");
        eq(mapDisconnectCause(999, false, null), "error");
        eq(mapDisconnectCause(CAUSE_ERROR, false, "dial_timeout"), "dial_timeout");

        System.out.println("OK: Protocol (encoders + escaping + mapDisconnectCause)");
    }

    private static void check(String json, String type, String key, String val) {
        if (!json.contains("\"type\":\"" + type + "\"")) {
            throw new AssertionError("missing type " + type + " in " + json);
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            if (!type.equals(o.optString("type"))) {
                throw new AssertionError("type mismatch: " + json);
            }
            if (!val.equals(o.optString(key))) {
                throw new AssertionError(key + " mismatch: " + json);
            }
        } catch (org.json.JSONException e) {
            throw new AssertionError("encoder produced invalid JSON: " + json, e);
        } catch (RuntimeException stub) {
            // android.jar's org.json is a "Stub!" on the host — fall back to a substring check
            if (!json.contains("\"" + key + "\":\"" + val + "\"")) {
                throw new AssertionError(key + "=" + val + " not in " + json);
            }
        }
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
