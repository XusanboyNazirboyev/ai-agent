import { describe, expect, it } from "vitest";
import { FakeTextToSpeech } from "./fake-tts.js";
import { TtsError } from "./ports.js";
import { parseWav } from "./wav.js";

describe("FakeTextToSpeech", () => {
  it("returns a valid WAV and records calls", async () => {
    const tts = new FakeTextToSpeech({ samples: 4800 });
    const audio = await tts.synthesize({ text: "hi", language: "en" });
    expect(audio.mimeType).toBe("audio/wav");
    expect(parseWav(audio.bytes)?.sampleRateHz).toBe(48_000);
    expect(audio.durationMs).toBe(100);
    expect(tts.calls).toHaveLength(1);
  });

  it("is deterministic", async () => {
    const tts = new FakeTextToSpeech();
    const a = await tts.synthesize({ text: "a", language: "ru" });
    const b = await tts.synthesize({ text: "b", language: "ru" });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("fails with the configured code", async () => {
    const tts = new FakeTextToSpeech({ failWith: "PROVIDER_UNAVAILABLE" });
    await expect(
      tts.synthesize({ text: "x", language: "en" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("honours latency and abort", async () => {
    const tts = new FakeTextToSpeech({ latencyMs: 5000 });
    const controller = new AbortController();
    const pending = tts.synthesize({
      text: "x",
      language: "en",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TtsError);
  });

  it("supports ru and en by locale prefix only by default", () => {
    const tts = new FakeTextToSpeech();
    expect(tts.supportsLanguage("ru-RU")).toBe(true);
    expect(tts.supportsLanguage("uz-Latn")).toBe(false);
  });
});
