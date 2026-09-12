/**
 * Audio format bridging between Twilio Media Streams (G.711 mu-law, 8kHz, mono) and
 * Gemini Live (PCM16, 16kHz mono in / PCM16, 24kHz mono out — see
 * phone-connector/src/com/hermes/connector/GeminiLiveClient.java's wire-format docblock,
 * which this connector's Gemini side is ported from).
 */
import { mulaw } from "alawmulaw";

export const mulawToPcm16 = (bytes: Uint8Array): Int16Array => mulaw.decode(bytes);
export const pcm16ToMulaw = (samples: Int16Array): Uint8Array => mulaw.encode(samples);

/**
 * 8kHz -> 16kHz: insert one linearly-interpolated sample between each original pair.
 * The last original sample has no successor, so it's held rather than interpolated.
 */
export function upsample8kTo16k(samples: Int16Array): Int16Array {
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i]!;
    const next = i + 1 < samples.length ? samples[i + 1]! : cur;
    out[2 * i] = cur;
    out[2 * i + 1] = Math.round((cur + next) / 2);
  }
  return out;
}

/** 24kHz -> 8kHz: average each group of three samples; a trailing partial group is dropped. */
export function downsample24kTo8k(samples: Int16Array): Int16Array {
  const groups = Math.floor(samples.length / 3);
  const out = new Int16Array(groups);
  for (let i = 0; i < groups; i++) {
    const a = samples[3 * i]!;
    const b = samples[3 * i + 1]!;
    const c = samples[3 * i + 2]!;
    out[i] = Math.round((a + b + c) / 3);
  }
  return out;
}
