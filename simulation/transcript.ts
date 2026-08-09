/**
 * simulation/transcript.ts — ordered per-journey transcript recorder.
 *
 * Captures the actual wire exchange of every journey:
 *   - inbound buyer messages (parsed from the Meta webhook envelopes that
 *     world.postWebhook delivers to the real handler),
 *   - outbound platform messages (every POST /{phoneNumberId}/messages call
 *     observed by the metaMock fetch interceptor, incl. failure attempts),
 *   - delivery-status tick evolution (statuses[] callbacks keyed by wamid),
 *   - USSD sessions (CON/END request/response pairs).
 *
 * Purely additive: the runner calls begin()/end() around each journey and
 * writeAll() at the end; world.ts/metaMock.ts notify the recorder through
 * small hooks. When no journey is active the hooks are no-ops, so assertions
 * and timing are unaffected.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Model ────────────────────────────────────────────────────────────────────

export interface TButton {
  id: string;
  title: string;
}

export interface TRow {
  id: string;
  title: string;
  description?: string;
}

export interface TSection {
  title?: string;
  rows: TRow[];
}

export interface TMessage {
  dir: "in" | "out" | "ussd";
  /** in: text|button_reply|list_reply|location|image|audio|reaction;
   *  out: text|interactive|template|image|document|audio|video|location_request|read_receipt */
  kind?: string;
  /** ussd only. */
  role?: "user" | "gateway";
  /** Sender (in), recipient (out) or subscriber (ussd) phone. */
  phone?: string;
  profileName?: string;
  /** Primary text: inbound body / ussd line. */
  text?: string;
  /** Outbound body text. */
  body?: string;
  payloadId?: string;
  caption?: string;
  mediaKind?: string;
  mediaId?: string;
  lat?: number;
  lng?: number;
  locationName?: string;
  address?: string;
  emoji?: string;
  buttons?: TButton[];
  listButton?: string;
  sections?: TSection[];
  header?: string;
  footer?: string;
  templateName?: string;
  templateLanguage?: string;
  /** Outbound wamid assigned by the (mock) Graph API. */
  wamid?: string;
  /** Inbound wamid; duplicates flagged on redelivery. */
  inboundId?: string;
  redelivery?: boolean;
  /** Delivery-status evolution for outbound messages: ["sent","delivered","read"]. */
  statuses?: string[];
  failed?: boolean;
  failStatus?: number;
  sessionId?: string;
  at: number;
}

export interface JourneyTranscript {
  id: string;
  title: string;
  feature: string;
  pass: boolean;
  businessName: string;
  messages: TMessage[];
}

export const BUSINESS_NAME = "Simply Green (simulated tenant)";

// ── Recorder ─────────────────────────────────────────────────────────────────

class TranscriptRecorder {
  private active: JourneyTranscript | null = null;
  private byWamid = new Map<string, TMessage>();
  private seenInbound = new Set<string>();
  private completed: JourneyTranscript[] = [];

  begin(id: string, title: string, feature: string): void {
    this.active = { id, title, feature, pass: false, businessName: BUSINESS_NAME, messages: [] };
    this.byWamid.clear();
    this.seenInbound.clear();
  }

  end(pass: boolean): void {
    if (!this.active) return;
    this.active.pass = pass;
    this.completed.push(this.active);
    this.active = null;
    this.byWamid.clear();
    this.seenInbound.clear();
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  private push(m: TMessage): void {
    if (!this.active) return;
    this.active.messages.push(m);
    if (m.dir === "out" && m.wamid) this.byWamid.set(m.wamid, m);
  }

  /** Parse a raw webhook envelope (messages[] and/or statuses[]). */
  recordWebhook(payload: Record<string, unknown>): void {
    if (!this.active) return;
    const entries = Array.isArray((payload as any)?.entry) ? ((payload as any).entry as any[]) : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;
        const profiles = new Map<string, string>();
        for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
          if (c?.wa_id) profiles.set(String(c.wa_id), String(c?.profile?.name ?? ""));
        }
        for (const msg of Array.isArray(value.messages) ? value.messages : []) {
          this.recordInboundMessage(msg, profiles.get(String(msg?.from ?? "")) ?? undefined);
        }
        for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
          if (st?.id && st?.status) this.tick(String(st.id), String(st.status));
        }
      }
    }
  }

  private recordInboundMessage(msg: any, profileName?: string): void {
    const base: TMessage = {
      dir: "in",
      phone: msg?.from ? String(msg.from) : undefined,
      profileName,
      inboundId: msg?.id ? String(msg.id) : undefined,
      at: Date.now(),
    };
    if (base.inboundId) {
      if (this.seenInbound.has(base.inboundId)) base.redelivery = true;
      this.seenInbound.add(base.inboundId);
    }
    switch (msg?.type) {
      case "text":
        this.push({ ...base, kind: "text", text: String(msg?.text?.body ?? "") });
        break;
      case "interactive": {
        const it = msg?.interactive ?? {};
        if (it.type === "button_reply") {
          this.push({
            ...base, kind: "button_reply",
            text: String(it?.button_reply?.title ?? ""),
            payloadId: String(it?.button_reply?.id ?? ""),
          });
        } else if (it.type === "list_reply") {
          this.push({
            ...base, kind: "list_reply",
            text: String(it?.list_reply?.title ?? ""),
            payloadId: String(it?.list_reply?.id ?? ""),
            ...(it?.list_reply?.description ? { caption: String(it.list_reply.description) } : {}),
          });
        } else {
          this.push({ ...base, kind: String(it.type ?? "interactive"), text: JSON.stringify(it).slice(0, 200) });
        }
        break;
      }
      case "location":
        this.push({
          ...base, kind: "location",
          lat: Number(msg?.location?.latitude),
          lng: Number(msg?.location?.longitude),
          locationName: msg?.location?.name ? String(msg.location.name) : undefined,
          address: msg?.location?.address ? String(msg.location.address) : undefined,
        });
        break;
      case "image":
        this.push({
          ...base, kind: "image", mediaKind: "image",
          mediaId: msg?.image?.id ? String(msg.image.id) : undefined,
          caption: msg?.image?.caption ? String(msg.image.caption) : undefined,
        });
        break;
      case "audio":
        this.push({
          ...base, kind: "audio", mediaKind: "audio",
          mediaId: msg?.audio?.id ? String(msg.audio.id) : undefined,
        });
        break;
      case "reaction":
        this.push({
          ...base, kind: "reaction",
          emoji: String(msg?.reaction?.emoji ?? ""),
          payloadId: msg?.reaction?.message_id ? String(msg.reaction.message_id) : undefined,
        });
        break;
      default:
        if (msg?.type) this.push({ ...base, kind: String(msg.type), text: JSON.stringify(msg).slice(0, 200) });
    }
  }

  /** Outbound POST /{phoneNumberId}/messages observed by the fetch mock. */
  recordOutbound(call: { body: any }, wamid: string | undefined, failStatus: number | undefined): void {
    if (!this.active) return;
    const body = call.body ?? {};
    const at = Date.now();
    const fail = failStatus != null ? { failed: true, failStatus } : {};

    // mark-read receipt (body.status === "read")
    if (body?.status === "read") {
      this.push({ dir: "out", kind: "read_receipt", wamid: body?.message_id ? String(body.message_id) : undefined, phone: body?.to, at, ...fail });
      return;
    }

    const type = String(body?.type ?? "unknown");
    const phone = body?.to ? String(body.to) : undefined;
    const base: TMessage = { dir: "out", phone, wamid, statuses: wamid ? ["sent"] : undefined, at, ...fail };

    switch (type) {
      case "text":
        this.push({ ...base, kind: "text", body: String(body?.text?.body ?? "") });
        break;
      case "interactive": {
        const it = body?.interactive ?? {};
        const m: TMessage = { ...base, kind: "interactive" };
        if (typeof it?.body?.text === "string") m.body = it.body.text;
        if (typeof it?.header?.text === "string") m.header = it.header.text;
        if (typeof it?.footer?.text === "string") m.footer = it.footer.text;
        if (it?.type === "button" && Array.isArray(it?.action?.buttons)) {
          m.buttons = it.action.buttons.map((b: any) => ({
            id: String(b?.reply?.id ?? ""),
            title: String(b?.reply?.title ?? ""),
          }));
        } else if (it?.type === "list" && it?.action) {
          m.listButton = it.action.button ? String(it.action.button) : undefined;
          m.sections = (Array.isArray(it.action.sections) ? it.action.sections : []).map((s: any) => ({
            title: s?.title ? String(s.title) : undefined,
            rows: (Array.isArray(s?.rows) ? s.rows : []).map((r: any) => ({
              id: String(r?.id ?? ""),
              title: String(r?.title ?? ""),
              description: r?.description ? String(r.description) : undefined,
            })),
          }));
        } else if (it?.type === "location_request_message") {
          m.kind = "location_request";
        } else if (it?.type === "cta_url" && it?.action) {
          m.buttons = [{ id: String(it?.action?.parameters?.url ?? ""), title: String(it?.action?.name ?? "Open") }];
        }
        this.push(m);
        break;
      }
      case "template": {
        const t = body?.template ?? {};
        const comps = Array.isArray(t?.components) ? t.components : [];
        const bodyComp = comps.find((c: any) => c?.type === "body" || c?.type === "BODY");
        let bodyText: string | undefined;
        const params = bodyComp?.parameters;
        if (Array.isArray(params)) {
          bodyText = params.map((p: any) => String(p?.text ?? p?.payload ?? "")).filter(Boolean).join(" · ");
        }
        this.push({
          ...base, kind: "template",
          templateName: t?.name ? String(t.name) : undefined,
          templateLanguage: t?.language?.code ? String(t.language.code) : undefined,
          body: bodyText,
        });
        break;
      }
      case "image":
      case "document":
      case "audio":
      case "video": {
        const media = body?.[type] ?? {};
        this.push({
          ...base, kind: type, mediaKind: type,
          caption: media?.caption ? String(media.caption) : undefined,
          mediaId: media?.id ? String(media.id) : (media?.link ? String(media.link).slice(0, 120) : undefined),
        });
        break;
      }
      case "location":
        this.push({
          ...base, kind: "location",
          lat: Number(body?.location?.latitude), lng: Number(body?.location?.longitude),
          locationName: body?.location?.name ? String(body.location.name) : undefined,
          address: body?.location?.address ? String(body.location.address) : undefined,
        });
        break;
      default:
        this.push({ ...base, kind: type, body: JSON.stringify(body).slice(0, 300) });
    }
  }

  /** Delivery-status callback keyed by wamid. */
  tick(wamid: string, status: string): void {
    if (!this.active) return;
    const m = this.byWamid.get(wamid);
    if (m) {
      m.statuses = m.statuses ?? [];
      if (m.statuses[m.statuses.length - 1] !== status) m.statuses.push(status);
    }
  }

  /** USSD request/response pair. */
  ussd(sessionId: string, phone: string, input: string, response: string): void {
    if (!this.active) return;
    const at = Date.now();
    this.push({ dir: "ussd", role: "user", phone, sessionId, text: input === "" ? "(dial)" : input, at });
    this.push({ dir: "ussd", role: "gateway", phone, sessionId, text: response, at: at + 1 });
  }

  /** Persist every completed journey transcript + the manifest. */
  writeAll(outDir?: string): string {
    const dir = outDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const manifest: Array<Record<string, unknown>> = [];
    for (const t of this.completed) {
      const file = `${t.id}.json`;
      fs.writeFileSync(path.join(dir, file), JSON.stringify(t, null, 2));
      manifest.push({
        id: t.id, title: t.title, feature: t.feature, pass: t.pass,
        file, messageCount: t.messages.length,
      });
    }
    manifest.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const index = {
      generatedAt: new Date().toISOString(),
      businessName: BUSINESS_NAME,
      journeys: manifest,
    };
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
    return dir;
  }
}

export const recorder = new TranscriptRecorder();
