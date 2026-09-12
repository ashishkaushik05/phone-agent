package com.hermes.connector;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal hand-rolled RFC 6455 WebSocket client.
 *
 * No Gradle / no external libraries, matching this project's existing manual
 * toolchain (build.sh compiles this alongside everything else). The Android
 * platform (checked against android-36) ships javax.net.ssl.SSLSocket,
 * java.util.Base64, org.json — but not java.net.http.WebSocket, so this is
 * the missing piece: TLS handshake, the HTTP/1.1 Upgrade handshake, and
 * RFC 6455 frame encode/decode (client frames masked, server frames read
 * unmasked, ping/pong/close handled, continuation frames reassembled).
 *
 * Two transports:
 *   secure=true  — TLS over SSLSocket + hostname verification (Gemini Live,
 *                  and later wss:// to hermes-core through a Cloudflare tunnel).
 *   secure=false — a plain Socket, no verification — for ws://localhost:8787
 *                  reached over `adb reverse` on the dev cable.
 * extraHeaders are appended to the Upgrade request (e.g. Authorization: Bearer).
 *
 * Deliberately not a general-purpose library — just enough correctness for
 * one long-lived connection.
 */
class WebSocketClient {

    private static final String TAG = "HermesWS";
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    interface Listener {
        void onOpen();
        void onText(String message);
        void onBinary(byte[] data);
        void onClose(int code, String reason);
        void onError(Exception e);
    }

    private final String host;
    private final int port;
    private final String path;
    private final boolean secure;
    private final Map<String, String> extraHeaders;
    private final Listener listener;

    private Socket socket;
    private OutputStream out;
    private InputStream in;
    private Thread readerThread;
    private volatile boolean open = false;
    private final Object writeLock = new Object();
    private final SecureRandom random = new SecureRandom();

    /** TLS transport, no extra headers — the original Gemini Live path. */
    WebSocketClient(String host, int port, String path, Listener listener) {
        this(host, port, path, true, null, listener);
    }

    WebSocketClient(String host, int port, String path, boolean secure,
                    Map<String, String> extraHeaders, Listener listener) {
        this.host = host;
        this.port = port;
        this.path = path;
        this.secure = secure;
        this.extraHeaders = extraHeaders;
        this.listener = listener;
    }

    /** Blocks until the transport + HTTP Upgrade handshake completes, then starts the reader thread. */
    void connect() throws IOException {
        if (secure) {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket tls = (SSLSocket) factory.createSocket(host, port);
            tls.startHandshake();
            SSLSession session = tls.getSession();
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)) {
                tls.close();
                throw new IOException("TLS hostname verification failed for " + host);
            }
            socket = tls;
        } else {
            socket = new Socket(host, port);
        }

        out = socket.getOutputStream();
        in = socket.getInputStream();

        byte[] keyBytes = new byte[16];
        random.nextBytes(keyBytes);
        String secWebSocketKey = Base64.getEncoder().encodeToString(keyBytes);

        StringBuilder req = new StringBuilder();
        req.append("GET ").append(path).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(host).append("\r\n");
        req.append("Upgrade: websocket\r\n");
        req.append("Connection: Upgrade\r\n");
        req.append("Sec-WebSocket-Key: ").append(secWebSocketKey).append("\r\n");
        req.append("Sec-WebSocket-Version: 13\r\n");
        if (extraHeaders != null) {
            for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
                req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        req.append("\r\n");
        out.write(req.toString().getBytes("UTF-8"));
        out.flush();

        String statusLine = readLine(in);
        Log.i(TAG, "handshake status: " + statusLine);
        if (statusLine == null || !statusLine.contains(" 101 ")) {
            throw new IOException("WebSocket handshake failed, status line: " + statusLine);
        }

        String acceptHeader = null;
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                String name = line.substring(0, colon).trim();
                String value = line.substring(colon + 1).trim();
                if (name.equalsIgnoreCase("Sec-WebSocket-Accept")) {
                    acceptHeader = value;
                }
            }
        }

        String expectedAccept = computeAcceptKey(secWebSocketKey);
        if (acceptHeader == null || !acceptHeader.equals(expectedAccept)) {
            throw new IOException("Sec-WebSocket-Accept mismatch: got " + acceptHeader
                    + " expected " + expectedAccept);
        }

        open = true;
        readerThread = new Thread(this::readLoop, "WebSocketClient-Reader");
        readerThread.start();
        listener.onOpen();
    }

    private static String computeAcceptKey(String clientKey) throws IOException {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((clientKey + GUID).getBytes("UTF-8"));
            return Base64.getEncoder().encodeToString(digest);
        } catch (Exception e) {
            throw new IOException("failed to compute Sec-WebSocket-Accept", e);
        }
    }

    /** RFC 6455 §5.3 masking transform. Symmetric: applyMask(applyMask(p, k), k) == p. */
    static byte[] applyMask(byte[] payload, byte[] key) {
        byte[] out = new byte[payload.length];
        for (int i = 0; i < payload.length; i++) {
            out[i] = (byte) (payload[i] ^ key[i % 4]);
        }
        return out;
    }

    /** Reads a single CRLF-terminated line as bytes (not a BufferedReader, to avoid over-reading past headers). */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int prev = -1;
        int b;
        while ((b = in.read()) != -1) {
            if (prev == '\r' && b == '\n') {
                byte[] bytes = line.toByteArray();
                return new String(bytes, 0, bytes.length - 1, "UTF-8");
            }
            line.write(b);
            prev = b;
        }
        return null; // stream closed
    }

    void sendText(String message) throws IOException {
        sendFrame(0x1, message.getBytes("UTF-8"));
    }

    void sendBinary(byte[] data) throws IOException {
        sendFrame(0x2, data);
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        synchronized (writeLock) {
            if (!open) {
                throw new IOException("WebSocket not open");
            }
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            header.write(0x80 | (opcode & 0x0F)); // FIN=1, no compression/extensions
            long len = payload.length;
            int maskBit = 0x80;
            if (len <= 125) {
                header.write(maskBit | (int) len);
            } else if (len <= 0xFFFF) {
                header.write(maskBit | 126);
                header.write((int) ((len >> 8) & 0xFF));
                header.write((int) (len & 0xFF));
            } else {
                header.write(maskBit | 127);
                for (int i = 7; i >= 0; i--) {
                    header.write((int) ((len >> (8 * i)) & 0xFF));
                }
            }
            byte[] maskKey = new byte[4];
            random.nextBytes(maskKey);
            header.write(maskKey, 0, 4);

            out.write(header.toByteArray());
            out.write(applyMask(payload, maskKey));
            out.flush();
        }
    }

    private void readLoop() {
        try {
            ByteArrayOutputStream messageBuf = null; // accumulates across continuation frames
            int messageOpcode = -1;
            long lastFrameMs = System.currentTimeMillis(); // latency: gap between inbound frames (LATENCY.md §3)

            while (open) {
                int b0 = in.read();
                if (b0 == -1) {
                    break;
                }
                long nowFrameMs = System.currentTimeMillis();
                if (nowFrameMs - lastFrameMs > 3000) {
                    Log.i(TAG, "latency: " + (nowFrameMs - lastFrameMs) + "ms gap with no inbound frame");
                }
                lastFrameMs = nowFrameMs;
                int b1 = in.read();
                if (b1 == -1) {
                    break;
                }
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0; // servers should not mask; handled anyway for robustness
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = (readByte() << 8) | readByte();
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) {
                        len = (len << 8) | readByte();
                    }
                }
                byte[] maskKey = null;
                if (masked) {
                    maskKey = new byte[4];
                    readFully(maskKey);
                }
                if (len > Integer.MAX_VALUE - 8) {
                    throw new IOException("frame too large: " + len);
                }
                byte[] payload = new byte[(int) len];
                readFully(payload);
                if (masked) {
                    payload = applyMask(payload, maskKey);
                }

                switch (opcode) {
                    case 0x0: // continuation
                        if (messageBuf != null) {
                            messageBuf.write(payload);
                            if (fin) {
                                deliver(messageOpcode, messageBuf.toByteArray());
                                messageBuf = null;
                                messageOpcode = -1;
                            }
                        }
                        break;
                    case 0x1: // text
                    case 0x2: // binary
                        if (fin) {
                            deliver(opcode, payload);
                        } else {
                            messageBuf = new ByteArrayOutputStream();
                            messageBuf.write(payload);
                            messageOpcode = opcode;
                        }
                        break;
                    case 0x8: // close
                        int code = payload.length >= 2 ? ((payload[0] & 0xFF) << 8 | (payload[1] & 0xFF)) : 1000;
                        String reason = payload.length > 2 ? new String(payload, 2, payload.length - 2, "UTF-8") : "";
                        Log.i(TAG, "server sent close, code=" + code + " reason=" + reason);
                        try {
                            sendFrame(0x8, payload.length >= 2
                                    ? new byte[]{payload[0], payload[1]}
                                    : new byte[]{0x03, (byte) 0xE8});
                        } catch (IOException ignored) {
                        }
                        open = false;
                        listener.onClose(code, reason);
                        return;
                    case 0x9: // ping -> pong
                        sendFrame(0xA, payload);
                        break;
                    case 0xA: // pong
                        break;
                    default:
                        Log.w(TAG, String.format(Locale.US, "unhandled opcode 0x%X, len=%d", opcode, payload.length));
                }
            }
            if (open) {
                open = false;
                listener.onClose(1006, "connection closed without a close frame");
            }
        } catch (IOException e) {
            if (open) {
                open = false;
                listener.onError(e);
            }
        }
    }

    private void deliver(int opcode, byte[] payload) throws IOException {
        if (opcode == 0x1) {
            listener.onText(new String(payload, "UTF-8"));
        } else {
            listener.onBinary(payload);
        }
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b == -1) {
            throw new IOException("unexpected end of stream");
        }
        return b;
    }

    private void readFully(byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n == -1) {
                throw new IOException("unexpected end of stream, wanted " + buf.length + " got " + off);
            }
            off += n;
        }
    }

    void close() {
        if (!open) {
            return;
        }
        try {
            sendFrame(0x8, new byte[]{0x03, (byte) 0xE8}); // 1000 = normal closure
        } catch (IOException ignored) {
        }
        open = false;
        try {
            if (socket != null) {
                socket.close();
            }
        } catch (IOException ignored) {
        }
    }

    boolean isOpen() {
        return open;
    }

    // --- host-JVM self-test (pure framing helpers only; no android.*, no sockets) ---
    // Run: javac ... && java -cp <obj>[:<android.jar>] com.hermes.connector.WebSocketClient

    static void selfTest() {
        String accept;
        try {
            accept = computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==");
        } catch (IOException e) {
            throw new AssertionError(e);
        }
        // RFC 6455 §1.3 worked example.
        if (!accept.equals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")) {
            throw new AssertionError("computeAcceptKey: got " + accept);
        }

        byte[] payload = "hermes-connector -> core".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] key = {0x37, (byte) 0xfa, 0x21, 0x3d};
        byte[] once = applyMask(payload, key);
        if (java.util.Arrays.equals(once, payload)) {
            throw new AssertionError("applyMask was a no-op");
        }
        if (!java.util.Arrays.equals(applyMask(once, key), payload)) {
            throw new AssertionError("applyMask does not round-trip");
        }

        byte[] empty = applyMask(new byte[0], key);
        if (empty.length != 0) {
            throw new AssertionError("applyMask([]) should be []");
        }

        System.out.println("OK: WebSocketClient (computeAcceptKey + applyMask round-trip)");
    }

    public static void main(String[] args) {
        selfTest();
    }
}
