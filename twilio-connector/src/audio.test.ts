import { describe, expect, it } from "vitest";
import { mulawToPcm16, pcm16ToMulaw, upsample8kTo16k, downsample24kTo8k } from "./audio.ts";

describe("mulawToPcm16 / pcm16ToMulaw", () => {
  it("round-trips a mid-range PCM16 signal within mu-law's quantization error", () => {
    const original = new Int16Array([0, 1000, -1000, 8000, -8000, 16000, -16000]);
    const encoded = pcm16ToMulaw(original);
    const decoded = mulawToPcm16(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      // mu-law is a lossy log codec; G.711 error is bounded to roughly 2% of the sample
      // magnitude plus a small fixed bias — 5% + 50 comfortably covers every case above.
      const tolerance = Math.abs(original[i]!) * 0.05 + 50;
      expect(Math.abs(decoded[i]! - original[i]!)).toBeLessThanOrEqual(tolerance);
    }
  });

  it("decodes to silence for encoded silence", () => {
    const encoded = pcm16ToMulaw(new Int16Array([0, 0, 0]));
    const decoded = mulawToPcm16(encoded);
    for (const sample of decoded) expect(Math.abs(sample)).toBeLessThanOrEqual(8);
  });
});

describe("upsample8kTo16k", () => {
  it("doubles the sample count", () => {
    const out = upsample8kTo16k(new Int16Array([10, 20, 30, 40]));
    expect(out.length).toBe(8);
  });

  it("holds a constant signal constant", () => {
    const out = upsample8kTo16k(new Int16Array([1000, 1000, 1000]));
    expect([...out]).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
  });

  it("linearly interpolates the inserted sample between each pair", () => {
    const out = upsample8kTo16k(new Int16Array([0, 100, 100]));
    // original samples land at even indices; the odd index between two originals is their average;
    // the last original has no successor to interpolate with, so it's held.
    expect([...out]).toEqual([0, 50, 100, 100, 100, 100]);
  });
});

describe("downsample24kTo8k", () => {
  it("cuts the sample count to a third", () => {
    const out = downsample24kTo8k(new Int16Array([1, 2, 3, 4, 5, 6]));
    expect(out.length).toBe(2);
  });

  it("averages each group of three samples", () => {
    const out = downsample24kTo8k(new Int16Array([0, 3, 6, 9, 12, 15]));
    expect([...out]).toEqual([3, 12]);
  });

  it("drops a trailing partial group", () => {
    const out = downsample24kTo8k(new Int16Array([0, 3, 6, 100]));
    expect([...out]).toEqual([3]);
  });
});
