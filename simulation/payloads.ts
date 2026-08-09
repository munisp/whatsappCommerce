/**
 * simulation/payloads.ts — Meta webhook payload factory.
 *
 * Builds the exact `entry/changes/value` envelopes Meta POSTs to
 * /api/webhooks/whatsapp: contacts[], messages[] (text / interactive /
 * location / image / audio / reaction) and statuses[] callbacks.
 * Deterministic wamids so journeys can cross-reference outbound sends.
 */

let inboundCounter = 0;
export function nextInboundWamid(tag = "in"): string {
  inboundCounter += 1;
  return `wamid.sim.in.${tag}.${String(inboundCounter).padStart(5, "0")}`;
}

export interface InboundContact {
  waId: string;
  profileName?: string;
}

export type InboundMessage =
  | { kind: "text"; from: string; text: string; id?: string; contextWamid?: string }
  | { kind: "button_reply"; from: string; replyId: string; title: string; id?: string }
  | { kind: "list_reply"; from: string; replyId: string; title: string; description?: string; id?: string }
  | { kind: "location"; from: string; latitude: number; longitude: number; name?: string; address?: string; id?: string }
  | { kind: "image"; from: string; mediaId: string; caption?: string; mimeType?: string; id?: string }
  | { kind: "audio"; from: string; mediaId: string; mimeType?: string; id?: string }
  | { kind: "reaction"; from: string; messageId: string; emoji: string; id?: string };

function buildMessage(m: InboundMessage): Record<string, unknown> {
  const ts = String(Math.floor(Date.now() / 1000));
  switch (m.kind) {
    case "text":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("text"),
        timestamp: ts,
        type: "text",
        text: { body: m.text },
        ...(m.contextWamid ? { context: { id: m.contextWamid } } : {}),
      };
    case "button_reply":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("btn"),
        timestamp: ts,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: m.replyId, title: m.title } },
      };
    case "list_reply":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("list"),
        timestamp: ts,
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: m.replyId, title: m.title, description: m.description ?? "" },
        },
      };
    case "location":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("loc"),
        timestamp: ts,
        type: "location",
        location: {
          latitude: m.latitude,
          longitude: m.longitude,
          ...(m.name ? { name: m.name } : {}),
          ...(m.address ? { address: m.address } : {}),
        },
      };
    case "image":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("img"),
        timestamp: ts,
        type: "image",
        image: {
          id: m.mediaId,
          mime_type: m.mimeType ?? "image/jpeg",
          sha256: "sim-sha256",
          ...(m.caption ? { caption: m.caption } : {}),
        },
      };
    case "audio":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("aud"),
        timestamp: ts,
        type: "audio",
        audio: { id: m.mediaId, mime_type: m.mimeType ?? "audio/ogg; codecs=opus" },
      };
    case "reaction":
      return {
        from: m.from,
        id: m.id ?? nextInboundWamid("rxn"),
        timestamp: ts,
        type: "reaction",
        reaction: { message_id: m.messageId, emoji: m.emoji },
      };
  }
}

export interface StatusCallback {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipientId?: string;
  timestamp?: number;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

/** Wrap messages (+contacts) into the full Meta entry/changes envelope. */
export function messageEnvelope(opts: {
  phoneNumberId: string;
  displayPhone?: string;
  messages: InboundMessage[];
  contacts?: InboundContact[];
}): Record<string, unknown> {
  const contacts =
    opts.contacts ??
    [...new Map(opts.messages.map((m) => [m.from, { profile: { name: `Sim User ${m.from.slice(-4)}` }, wa_id: m.from }])).values()];
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: opts.displayPhone ?? "2347000000000",
                phone_number_id: opts.phoneNumberId,
              },
              contacts,
              messages: opts.messages.map(buildMessage),
            },
          },
        ],
      },
    ],
  };
}

/** Delivery-status callback envelope (statuses[] — no messages). */
export function statusEnvelope(opts: {
  phoneNumberId: string;
  statuses: StatusCallback[];
}): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "2347000000000",
                phone_number_id: opts.phoneNumberId,
              },
              statuses: opts.statuses.map((s) => ({
                id: s.wamid,
                status: s.status,
                timestamp: String(s.timestamp ?? Math.floor(Date.now() / 1000)),
                recipient_id: s.recipientId ?? "2348011111111",
                ...(s.errors ? { errors: s.errors } : {}),
              })),
            },
          },
        ],
      },
    ],
  };
}

// Convenience builders for single-message envelopes.
export const inbound = {
  text(phoneNumberId: string, from: string, text: string, extra?: { profileName?: string; id?: string }) {
    return messageEnvelope({
      phoneNumberId,
      messages: [{ kind: "text", from, text, id: extra?.id }],
      contacts: [{ waId: from, profileName: extra?.profileName ?? `Sim User ${from.slice(-4)}` }],
    });
  },
  buttonReply(phoneNumberId: string, from: string, replyId: string, title: string) {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "button_reply", from, replyId, title }] });
  },
  listReply(phoneNumberId: string, from: string, replyId: string, title: string) {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "list_reply", from, replyId, title }] });
  },
  location(phoneNumberId: string, from: string, lat: number, lng: number, name?: string, address?: string) {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "location", from, latitude: lat, longitude: lng, name, address }] });
  },
  image(phoneNumberId: string, from: string, mediaId: string, caption?: string) {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "image", from, mediaId, caption }] });
  },
  audio(phoneNumberId: string, from: string, mediaId: string) {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "audio", from, mediaId }] });
  },
  reaction(phoneNumberId: string, from: string, messageId: string, emoji = "👍") {
    return messageEnvelope({ phoneNumberId, messages: [{ kind: "reaction", from, messageId, emoji }] });
  },
};
