/**
 * transcribe.ts — Voice-note → text for the WhatsApp ordering pipeline.
 *
 * Pluggable transcriber: when OPENAI_API_KEY is set, audio is sent to the
 * Whisper endpoint (OPENAI_BASE_URL override for proxies/self-hosted); when
 * no key is configured the caller gets a fail-soft { text: null } so the
 * buyer receives a polite "voice notes aren't enabled" reply instead of an
 * error. The transcribed text feeds the SAME text pipeline as typed messages.
 */

export interface TranscribeResult {
  /** Transcribed text, or null when transcription is unavailable/failed. */
  text: string | null;
  /** "not_configured" | "http_error" | "empty" | "fetch_error" */
  error?: string;
  language?: string | null;
}

const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/amr": "amr",
};

/** Best-effort file extension for the multipart upload filename. */
export function extForMime(mimeType: string | null | undefined): string {
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? "ogg";
}

/** True when a real OpenAI key is configured (the platform LLM default key
 * "ollama" for local dev does NOT count as a Whisper-capable key). */
export function isTranscriptionConfigured(apiKey?: string | null): boolean {
  const key = apiKey ?? process.env.OPENAI_API_KEY ?? "";
  return key.trim().length > 0 && key !== "ollama";
}

/**
 * Transcribe an audio buffer with Whisper.
 * Never throws — every failure mode returns { text: null, error }.
 */
export async function transcribeAudio(opts: {
  audio: Buffer;
  mimeType?: string | null;
  /** BCP-47-ish hint (e.g. "yo", "ha", "fr") forwarded to Whisper. */
  languageHint?: string | null;
  apiKey?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<TranscribeResult> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!isTranscriptionConfigured(apiKey)) {
    return { text: null, error: "not_configured" };
  }
  if (!opts.audio || opts.audio.length === 0) {
    return { text: null, error: "empty" };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");

  try {
    const form = new FormData();
    const ext = extForMime(opts.mimeType);
    const blob = new Blob([new Uint8Array(opts.audio)], { type: opts.mimeType ?? "audio/ogg" });
    form.append("file", blob, `voice-note.${ext}`);
    form.append("model", "whisper-1");
    if (opts.languageHint) form.append("language", opts.languageHint);

    const resp = await doFetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      return { text: null, error: `http_error:${resp.status}` };
    }
    const data = (await resp.json()) as { text?: string };
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) return { text: null, error: "empty" };
    return { text, language: opts.languageHint ?? null };
  } catch (e: any) {
    return { text: null, error: `fetch_error:${e?.message ?? "unknown"}` };
  }
}

// ── Inbound voice-note orchestration ─────────────────────────────────────────

export interface VoiceNoteOutcome {
  handled: boolean;
  outcome: "no_credentials" | "download_failed" | "not_configured" | "transcribe_failed" | "transcribed";
  transcript?: string;
}

/** Download a WhatsApp media object as a Buffer (per-tenant credentials). */
async function downloadWaAudio(
  tenantId: string,
  mediaId: string,
): Promise<{ audio: Buffer; mimeType: string } | null> {
  const { resolveTenantWaCredentials } = await import("./waSender");
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(30000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    audio: Buffer.from(bin),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "audio/ogg",
  };
}

/**
 * Full pipeline for one inbound voice note:
 *   Graph API media download → Whisper transcription (fail-soft without a
 *   key) → the transcribed text enters the SAME NLP text pipeline → reply is
 *   delivered via the tenant-aware sender. Never throws.
 */
export async function handleInboundVoiceNote(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
  mimeType?: string | null;
  customerName?: string;
}): Promise<VoiceNoteOutcome> {
  const { tenantId, waPhoneNumber } = opts;
  const { sendWhatsAppText } = await import("./waSender");
  const { getStickyLocale, tr } = await import("./i18n");

  const locale = await getStickyLocale(tenantId, waPhoneNumber).catch(() => null);
  const failSoft = async (outcome: VoiceNoteOutcome["outcome"]): Promise<VoiceNoteOutcome> => {
    await sendWhatsAppText(tenantId, waPhoneNumber, tr(locale, "voiceNotEnabled"), {
      notifType: "voice_note_fallback",
    }).catch((e: any) => console.warn("[transcribe] fail-soft reply failed:", e?.message));
    return { handled: true, outcome };
  };

  if (!isTranscriptionConfigured()) {
    return failSoft("not_configured");
  }

  const downloaded = await downloadWaAudio(tenantId, opts.mediaId).catch(() => null);
  if (!downloaded) {
    return failSoft("download_failed");
  }

  const result = await transcribeAudio({
    audio: downloaded.audio,
    mimeType: opts.mimeType ?? downloaded.mimeType,
    languageHint: locale,
  });
  if (!result.text) {
    return failSoft("transcribe_failed");
  }

  // Feed the SAME text pipeline as typed messages.
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller({ user: null } as any);
  const nlpResult = await caller.nlp.processMessage({
    tenantId,
    waPhoneNumber,
    message: result.text,
    customerName: opts.customerName,
  });
  if (nlpResult?.reply && nlpResult.intent !== "ussd_menu") {
    await sendWhatsAppText(tenantId, waPhoneNumber, nlpResult.reply)
      .catch((e: any) => console.warn("[transcribe] reply send failed:", e?.message));
  }
  return { handled: true, outcome: "transcribed", transcript: result.text };
}
