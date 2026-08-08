/**
 * transcribe — unit tests
 * Whisper transcription (mocked fetch): success, language hint forwarding,
 * fail-soft without OPENAI_API_KEY, and the full voice-note → NLP pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendWhatsAppTextMock = vi.fn(async () => ({ sent: true }));
const resolveCredsMock = vi.fn(async () => ({ phoneNumberId: "pn-1", accessToken: "tok", source: "tenant" }));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...args: any[]) => sendWhatsAppTextMock(...args),
  resolveTenantWaCredentials: (...args: any[]) => resolveCredsMock(...args),
}));
vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => null) }));

const processMessageMock = vi.fn(async () => ({ reply: "Added to cart!", intent: "add_to_cart", confidence: 1 }));
vi.mock("./routers", () => ({
  appRouter: { createCaller: () => ({ nlp: { processMessage: processMessageMock } }) },
}));

import { transcribeAudio, handleInboundVoiceNote, extForMime, isTranscriptionConfigured } from "./services/transcribe";

beforeEach(() => {
  sendWhatsAppTextMock.mockClear();
  processMessageMock.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("transcribeAudio", () => {
  it("fails soft when no OpenAI key is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await transcribeAudio({ audio: Buffer.from("audio") });
    expect(res.text).toBeNull();
    expect(res.error).toBe("not_configured");
    expect(isTranscriptionConfigured("")).toBe(false);
    expect(isTranscriptionConfigured("sk-x")).toBe(true);
  });

  it("sends the audio to Whisper and forwards the language hint", async () => {
    let captured: FormData | null = null;
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      captured = init.body as FormData;
      return { ok: true, json: async () => ({ text: "two spicy wraps please" }) } as any;
    });
    const res = await transcribeAudio({
      audio: Buffer.from("fake-ogg"),
      mimeType: "audio/ogg",
      languageHint: "yo",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as any,
    });
    expect(res).toEqual({ text: "two spicy wraps please", language: "yo" });
    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(captured!.get("model")).toBe("whisper-1");
    expect(captured!.get("language")).toBe("yo");
    expect((captured!.get("file") as File).name).toBe("voice-note.ogg");
  });

  it("returns http_error on a Whisper failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as any);
    const res = await transcribeAudio({ audio: Buffer.from("x"), apiKey: "sk-test", fetchImpl: fetchImpl as any });
    expect(res.text).toBeNull();
    expect(res.error).toBe("http_error:500");
  });

  it("maps mime types to file extensions", () => {
    expect(extForMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extForMime("audio/mpeg")).toBe("mp3");
    expect(extForMime(undefined)).toBe("ogg");
  });
});

describe("handleInboundVoiceNote", () => {
  const OPTS = { tenantId: "t1", waPhoneNumber: "2348000000001", mediaId: "media-1", mimeType: "audio/ogg" };

  it("fails soft with a polite reply when voice notes aren't enabled", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await handleInboundVoiceNote(OPTS);
    expect(out).toEqual({ handled: true, outcome: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "t1", "2348000000001", expect.stringContaining("voice notes aren't enabled"), expect.anything(),
    );
  });

  it("downloads, transcribes, and feeds the text into the NLP pipeline", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const audioBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchSpy = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("graph.facebook.com/v21.0/media-1")) {
        return { ok: true, json: async () => ({ url: "https://cdn.example/audio.ogg", mime_type: "audio/ogg" }) } as any;
      }
      if (u.includes("cdn.example")) {
        return { ok: true, arrayBuffer: async () => audioBytes } as any;
      }
      if (u.includes("audio/transcriptions")) {
        return { ok: true, json: async () => ({ text: "2 spicy wraps" }) } as any;
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const out = await handleInboundVoiceNote(OPTS);
    expect(out).toEqual({ handled: true, outcome: "transcribed", transcript: "2 spicy wraps" });
    // Transcript enters the SAME text pipeline as typed messages.
    expect(processMessageMock).toHaveBeenCalledWith({
      tenantId: "t1",
      waPhoneNumber: "2348000000001",
      message: "2 spicy wraps",
      customerName: undefined,
    });
    // The NLP reply is delivered back to the buyer.
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith("t1", "2348000000001", "Added to cart!");
  });

  it("fails soft when the media download fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as any));
    const out = await handleInboundVoiceNote(OPTS);
    expect(out).toEqual({ handled: true, outcome: "download_failed" });
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "t1", "2348000000001", expect.stringContaining("voice notes aren't enabled"), expect.anything(),
    );
  });
});
