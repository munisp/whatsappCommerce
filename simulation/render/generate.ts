/**
 * simulation/render/generate.ts — render journey transcripts as a static
 * WhatsApp-style chat gallery.
 *
 * Reads simulation/transcripts/*.json (produced by the runner) and inlines
 * everything into ONE self-contained HTML file — no external fetches, no CDN
 * fonts, inline CSS + minimal inline JS.
 *
 * Usage:  npx tsx simulation/render/generate.ts [outFile]
 * Default outFile: simulation/render/dist/index.html
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { JourneyTranscript, TMessage } from "../transcript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.resolve(HERE, "../transcripts");
const OUT_FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(HERE, "dist/index.html");

const GROUPS: Array<{ name: string; ids: string[] }> = [
  { name: "Onboarding", ids: ["J01", "J16", "J22", "J30"] },
  { name: "Ordering", ids: ["J02", "J03", "J04", "J05", "J09", "J12", "J17", "J18", "J28", "J29"] },
  { name: "Payments", ids: ["J06", "J07", "J08"] },
  { name: "Delivery", ids: ["J10", "J11", "J24", "J25"] },
  { name: "Engagement", ids: ["J13", "J14", "J15", "J19", "J20", "J21"] },
  { name: "Operations", ids: ["J23", "J26", "J27"] },
];

function shortSha(): string {
  // The gallery renders main @ 4e815167 (+ this feature branch); allow override.
  return process.env.SIM_GALLERY_SHA?.trim() || "4e815167";
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** WhatsApp inline formatting: *bold* _italic_ ~strike~ ```mono``` (after escaping). */
const waFmt = (s: unknown): string =>
  esc(s)
    .replace(/```([\s\S]+?)```/g, `<code class="mono">$1</code>`)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>")
    .replace(/\n/g, "<br>");
const nl2br = (s: unknown): string => esc(s).replace(/\n/g, "<br>");
const fmtTime = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const TICK_SINGLE = `<svg viewBox="0 0 16 11" width="16" height="11" class="tick"><path fill="currentColor" d="M11.071.653l-4.937 6.32-2.86-2.163-1.008 1.19 3.868 2.93L12.26 1.843z"/></svg>`;
const TICK_DOUBLE = `<svg viewBox="0 0 18 11" width="18" height="11" class="tick"><path fill="currentColor" d="M11.071.653l-4.937 6.32-2.86-2.163-1.008 1.19 3.868 2.93L12.26 1.843zM15.49.653l-4.937 6.32-.97-.74-1.01 1.19 1.98 1.507L16.68 1.843z"/></svg>`;
const FAIL_ICON = `<svg viewBox="0 0 12 12" width="13" height="13" class="tick fail"><circle cx="6" cy="6" r="5.5" fill="#f15c6d"/><path fill="#fff" d="M6.6 3v4H5.4V3zm0 5v1.2H5.4V8z"/></svg>`;

function ticks(m: TMessage): string {
  if (m.failed) return FAIL_ICON;
  const st = m.statuses ?? [];
  const title = st.length ? ` title="delivery: ${esc(st.join(" → "))}"` : "";
  if (st.includes("read")) return `<span class="ticks read"${title}>${TICK_DOUBLE}</span>`;
  if (st.includes("delivered")) return `<span class="ticks"${title}>${TICK_DOUBLE}</span>`;
  return `<span class="ticks"${title}>${TICK_SINGLE}</span>`;
}

function metaRow(m: TMessage, extra = "", readMark = ""): string {
  const fail = m.failed ? `<span class="fail-tag">send failed — Graph ${m.failStatus}</span>` : "";
  return `<span class="meta">${extra}${fail}<span class="time">${fmtTime(m.at)}</span>${m.dir === "out" ? ticks(m) : readMark}</span>`;
}

function buttonsHtml(m: TMessage): string {
  if (!m.buttons?.length) return "";
  return `<div class="btn-list">${m.buttons
    .map((b) => `<div class="btn-chip" title="payload id: ${esc(b.id)}"><span class="btn-ico">↩</span>${esc(b.title)}</div>`)
    .join("")}</div>`;
}

function sectionsHtml(m: TMessage): string {
  let out = "";
  if (m.sections?.length) {
    out += `<div class="list-rows">`;
    for (const s of m.sections) {
      if (s.title) out += `<div class="list-section">${esc(s.title)}</div>`;
      for (const r of s.rows) {
        out += `<div class="list-row" title="row id: ${esc(r.id)}"><div class="lr-main"><div class="lr-title">${esc(r.title)}</div>${
          r.description ? `<div class="lr-desc">${esc(r.description)}</div>` : ""
        }</div><div class="lr-chev">›</div></div>`;
      }
    }
    out += `</div>`;
  }
  if (m.listButton) out += `<div class="btn-list"><div class="btn-chip"><span class="btn-ico">☰</span>${esc(m.listButton)}</div></div>`;
  return out;
}

function mediaCard(kind: string, caption?: string, dir: string = "in"): string {
  const icons: Record<string, string> = { image: "📷", document: "📄", audio: "🎤", video: "🎬" };
  const labels: Record<string, string> = { image: "Photo", document: "Document", audio: "Voice note", video: "Video" };
  const ico = icons[kind] ?? "🖼";
  const label = labels[kind] ?? "Media";
  if (kind === "audio") {
    return `<div class="media-card audio"><span class="play">▶</span><span class="wave">${"▂▄▆▅▃▅▇▂▅▄▆▃".split("").map((b) => `<i>${b}</i>`).join("")}</span><span class="media-label">0:0${caption ? "" : "7"}</span></div>`;
  }
  return `<div class="media-card"><div class="media-thumb ${kind}"><span>${ico}</span><em>${label}</em></div>${
    caption ? `<div class="caption">${nl2br(caption)}</div>` : ""
  }</div>`;
}

function locationCard(m: TMessage): string {
  return `<div class="loc-card"><div class="loc-map"><span class="pin">📍</span></div><div class="loc-info">${
    m.locationName ? `<div class="loc-name">${esc(m.locationName)}</div>` : ""
  }${m.address ? `<div class="loc-addr">${esc(m.address)}</div>` : ""}<div class="loc-coords">${m.lat?.toFixed(4)}, ${m.lng?.toFixed(4)}</div></div></div>`;
}

/** Mark inbound messages that the platform read-receipted. */
function markReadReceipts(msgs: TMessage[]): Set<string> {
  const read = new Set<string>();
  for (const m of msgs) if (m.dir === "out" && m.kind === "read_receipt" && m.wamid) read.add(m.wamid);
  return read;
}

function bubbleHtml(m: TMessage, readIds: Set<string>): string {
  const dir = m.dir;
  if (dir === "out" && m.kind === "read_receipt") return ""; // folded onto the inbound bubble
  const side = dir === "out" ? "out" : "in";
  const tail = `<span class="tail"></span>`;
  const readMark =
    dir === "in" && m.inboundId && readIds.has(m.inboundId)
      ? `<span class="ticks read" title="platform sent a read receipt for this message">${TICK_DOUBLE}</span>`
      : "";

  switch (m.kind) {
    case "text":
      return `<div class="msg ${side}"><div class="bubble">${tail}<span class="text">${waFmt(m.dir === "in" ? m.text : m.body)}</span>${metaRow(m, "", readMark)}</div></div>`;
    case "button_reply":
      return `<div class="msg in"><div class="bubble">${tail}<span class="text">${waFmt(m.text)}</span>${metaRow(m, `<span class="tag" title="interactive button reply · payload id: ${esc(m.payloadId)}">button reply</span>`, readMark)}</div></div>`;
    case "list_reply":
      return `<div class="msg in"><div class="bubble">${tail}<span class="text">${waFmt(m.text)}</span>${metaRow(m, `<span class="tag" title="list reply · row id: ${esc(m.payloadId)}">list reply</span>`, readMark)}</div></div>`;
    case "interactive": {
      const header = m.header ? `<div class="hdr">${esc(m.header)}</div>` : "";
      const footer = m.footer ? `<div class="ftr">${esc(m.footer)}</div>` : "";
      return `<div class="msg out"><div class="bubble">${tail}${header}<span class="text">${waFmt(m.body)}</span>${metaRow(m)}${footer}${buttonsHtml(m)}${sectionsHtml(m)}</div></div>`;
    }
    case "location_request":
      return `<div class="msg out"><div class="bubble">${tail}<span class="text">${waFmt(m.body)}</span>${metaRow(m)}<div class="btn-list"><div class="btn-chip"><span class="btn-ico">📍</span>Send location</div></div></div></div>`;
    case "template":
      return `<div class="msg out"><div class="bubble template">${tail}<div class="tpl-tag">template · ${esc(m.templateName)}${m.templateLanguage ? ` (${esc(m.templateLanguage)})` : ""}</div>${
        m.body ? `<span class="text">${waFmt(m.body)}</span>` : `<span class="text dim">(template parameters resolved server-side)</span>`
      }${metaRow(m)}</div></div>`;
    case "image":
    case "document":
    case "audio":
    case "video": {
      const caption = m.caption;
      return `<div class="msg ${side}"><div class="bubble media">${tail}${mediaCard(m.kind, caption, side)}${metaRow(m, "", readMark)}</div></div>`;
    }
    case "location":
      return `<div class="msg ${side}"><div class="bubble media">${tail}${locationCard(m)}${metaRow(m, "", readMark)}</div></div>`;
    case "reaction":
      return `<div class="sys-line"><span>${esc(m.emoji || "👍")} reacted to a message</span></div>`;
    default:
      return `<div class="msg ${side}"><div class="bubble">${tail}<span class="text">${waFmt(m.text ?? m.body ?? m.kind)}</span>${metaRow(m, "", readMark)}</div></div>`;
  }
}

const AVATAR = `<span class="avatar"><svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#00a884"/><text x="20" y="26" font-size="15" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-weight="600">SG</text></svg></span>`;
const HDR_ICONS = `<span class="hdr-icons"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="#54656f" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg><svg viewBox="0 0 24 24" width="20" height="20"><path fill="#54656f" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg><svg viewBox="0 0 24 24" width="20" height="20"><path fill="#54656f" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg></span>`;

function phoneFrameHtml(t: JourneyTranscript): string {
  const readIds = markReadReceipts(t.messages);
  const parts: string[] = [];
  let lastPhone: string | undefined;
  for (const m of t.messages) {
    const phone = m.phone;
    if (phone && phone !== lastPhone) {
      const who = m.dir === "out" ? `to +${phone}` : `+${phone}${m.profileName ? ` · ${m.profileName}` : ""}`;
      parts.push(`<div class="divider"><span>chat with ${esc(who)}</span></div>`);
      lastPhone = phone;
    }
    parts.push(bubbleHtml(m, readIds));
  }
  return `<div class="phone"><div class="wa-header">${AVATAR}<div class="wa-peer"><div class="wa-name">${esc(t.businessName)}</div><div class="wa-status">online</div></div>${HDR_ICONS}</div><div class="chat"><div class="divider"><span>simulated chat · live platform traffic</span></div>${parts.join("\n")}</div><div class="composer"><span class="compose-hint">Message</span><span class="mic">🎤</span></div></div>`;
}

function ussdCardHtml(t: JourneyTranscript): string {
  const lines = t.messages
    .map((m) => {
      if (m.role === "user") return `<div class="u"><span class="pfx">&gt;</span> ${esc(m.text)}</div>`;
      const cls = m.text?.startsWith("END") ? "g end" : "g";
      return `<div class="${cls}">${nl2br(m.text)}</div>`;
    })
    .join("\n");
  return `<div class="ussd-card"><div class="ussd-top"><span class="ussd-dot"></span><span class="ussd-dot"></span><span class="ussd-dot"></span><span class="ussd-title">ussd · *928*77# · Africa's Talking gateway</span></div><div class="ussd-body">${lines}</div></div>`;
}

function journeySection(t: JourneyTranscript): string {
  const isUssd = t.messages.length > 0 && t.messages.every((m) => m.dir === "ussd");
  const badge = t.pass ? `<span class="badge pass">PASS</span>` : `<span class="badge failb">FAIL</span>`;
  const counts = `${t.messages.filter((m) => m.dir === "in").length} in / ${t.messages.filter((m) => m.dir === "out" && m.kind !== "read_receipt").length} out`;
  return `<section class="journey" id="${esc(t.id)}" data-name="${esc(`${t.id} ${t.title} ${t.feature}`.toLowerCase())}">
  <div class="j-head"><span class="j-id">${esc(t.id)}</span><h2>${esc(t.title)}</h2><span class="j-feature">${esc(t.feature)}</span>${badge}<span class="j-counts">${counts}</span></div>
  ${isUssd ? ussdCardHtml(t) : phoneFrameHtml(t)}
</section>`;
}

// ── CSS / JS ─────────────────────────────────────────────────────────────────

const CSS = `
:root{--wall:#ECE5DD;--out:#D9FDD3;--in:#ffffff;--ink:#111b21;--sub:#667781;--teal:#00a5f4;--green:#00a884;--hair:#e9edef;}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f0f2f5;color:var(--ink);font-size:14px;line-height:1.45}
a{color:inherit;text-decoration:none}
.layout{display:flex;min-height:100vh}
/* sidebar */
.sidebar{width:290px;flex:0 0 290px;background:#fff;border-right:1px solid var(--hair);position:sticky;top:0;height:100vh;overflow-y:auto;padding:18px 14px 40px}
.brand{padding:4px 8px 14px;border-bottom:1px solid var(--hair);margin-bottom:12px}
.brand h1{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.brand h1 .dot{width:10px;height:10px;border-radius:50%;background:var(--green);display:inline-block}
.brand .repo{font-size:12px;color:var(--sub);margin-top:6px}
.brand .summary{margin-top:10px;font-size:12px;background:#e7f6ec;color:#0b6e4f;border:1px solid #bfe6cd;border-radius:8px;padding:7px 9px;font-weight:600}
.filter{width:100%;margin:4px 0 12px;padding:8px 10px;border:1px solid #d1d7db;border-radius:8px;font-size:13px;background:#f0f2f5;outline:none}
.group{margin-bottom:10px}
.group>h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--sub);padding:8px 8px 4px}
.group a{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:13px;color:#3b4a54}
.group a:hover{background:#f0f2f5}
.group a .jid{font-weight:700;color:#8696a0;font-size:11px;width:28px;flex:0 0 28px}
.group a .ok{margin-left:auto;color:var(--green);font-size:11px;font-weight:700}
/* main */
.main{flex:1;padding:0 34px 80px;min-width:0}
.topbar{padding:22px 0 8px}
.topbar h2{font-size:20px;font-weight:700}
.topbar p{color:var(--sub);font-size:13px;margin-top:4px}
.journey{margin:26px auto;max-width:560px;scroll-margin-top:18px}
.j-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;padding:0 4px}
.j-id{font-weight:800;font-size:13px;color:#fff;background:#8696a0;border-radius:6px;padding:2px 7px}
.j-head h2{font-size:17px;font-weight:700}
.j-feature{color:var(--sub);font-size:12.5px}
.j-counts{color:#aebac1;font-size:11px;margin-left:auto}
.badge{font-size:10.5px;font-weight:800;border-radius:20px;padding:2.5px 9px;letter-spacing:.04em}
.badge.pass{background:#d3f2df;color:#0b6e4f;border:1px solid #a5ddba}
.badge.failb{background:#f8d7da;color:#842029}
/* phone frame */
.phone{border:10px solid #202c33;border-radius:34px;overflow:hidden;background:var(--wall);box-shadow:0 12px 32px rgba(11,20,26,.18);max-width:430px;margin:0 auto}
.wa-header{background:#f0f2f5;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--hair)}
.avatar svg{display:block;border-radius:50%}
.wa-peer{flex:1;min-width:0}
.wa-name{font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-status{font-size:12px;color:var(--sub)}
.hdr-icons{display:flex;gap:14px;align-items:center}
.chat{background-color:var(--wall);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%23d6cfc4' stroke-width='1.1' opacity='.55'%3E%3Ccircle cx='18' cy='22' r='4'/%3E%3Cpath d='M40 14l6 10h-12z'/%3E%3Crect x='78' y='16' width='9' height='9' rx='2'/%3E%3Cpath d='M20 60q6-8 12 0t12 0'/%3E%3Ccircle cx='95' cy='58' r='5'/%3E%3Cpath d='M52 84l8 8m0-8l-8 8'/%3E%3Cpath d='M86 96q4-6 8 0t8 0'/%3E%3Crect x='12' y='98' width='8' height='8' rx='2'/%3E%3C/g%3E%3C/svg%3E");padding:14px 10px 18px;min-height:220px;max-height:640px;overflow-y:auto}
.divider{display:flex;justify-content:center;margin:10px 0}
.divider span{background:#fdf3c6;color:#5d5330;font-size:11px;border-radius:8px;padding:4px 10px;box-shadow:0 1px 1px rgba(11,20,26,.08)}
.sys-line{display:flex;justify-content:center;margin:6px 0}
.sys-line span{font-size:11.5px;color:var(--sub);background:rgba(255,255,255,.75);border-radius:10px;padding:2px 9px}
.msg{display:flex;margin:3px 0}
.msg.in{justify-content:flex-start}
.msg.out{justify-content:flex-end}
.bubble{position:relative;max-width:78%;border-radius:7.5px;padding:6px 8px 6px 9px;box-shadow:0 1px .5px rgba(11,20,26,.13);font-size:14.2px}
.msg.in .bubble{background:var(--in);border-top-left-radius:0}
.msg.out .bubble{background:var(--out);border-top-right-radius:0}
.tail{position:absolute;top:0;width:0;height:0;border:6px solid transparent}
.msg.in .tail{left:-8px;border-top-color:var(--in);border-right-color:var(--in)}
.msg.out .tail{right:-8px;border-top-color:var(--out);border-left-color:var(--out)}
.bubble .text{white-space:pre-wrap;word-wrap:break-word}
.bubble .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:rgba(11,20,26,.05);border-radius:4px;padding:0 3px}
.bubble .hdr{font-weight:700;margin-bottom:2px}
.bubble .ftr{color:var(--sub);font-size:12px;margin-top:4px}
.bubble .meta{float:right;display:inline-flex;align-items:center;gap:3px;margin:8px 0 -2px 12px;font-size:11px;color:var(--sub);position:relative;top:2px}
.msg.in .bubble .meta{color:#8696a0}
.time{white-space:nowrap}
.ticks{display:inline-flex;color:#8696a0}
.ticks.read{color:#53bdeb}
.tick{display:block}
.in-read{display:block;text-align:right;font-size:10px;color:#53bdeb;margin-top:1px}
.tag{display:inline-block;font-size:10px;color:#0b6e4f;background:#e3f4ea;border-radius:5px;padding:1px 6px;margin-right:5px;vertical-align:1px}
.tpl-tag{display:inline-block;font-size:10.5px;font-weight:700;color:#7a5b00;background:#fdf3c6;border-radius:5px;padding:1.5px 7px;margin-bottom:4px}
.dim{color:#8696a0;font-style:italic;font-size:12.5px}
.fail-tag{color:#c81e2b;font-size:10.5px;font-weight:700;margin-right:5px}
.btn-list{margin:6px -8px -6px -9px;border-top:1px solid rgba(11,20,26,.08)}
.btn-chip{display:flex;align-items:center;justify-content:center;gap:6px;color:var(--teal);font-size:14px;font-weight:500;padding:7.5px 8px;cursor:default}
.btn-chip+.btn-chip{border-top:1px solid rgba(11,20,26,.08)}
.btn-ico{font-size:13px}
.list-rows{margin:6px -8px 0 -9px;border-top:1px solid rgba(11,20,26,.08)}
.list-section{font-size:11px;font-weight:700;color:var(--sub);text-transform:uppercase;padding:7px 10px 2px;letter-spacing:.05em}
.list-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid rgba(11,20,26,.05)}
.lr-main{flex:1;min-width:0}
.lr-title{font-size:14px}
.lr-desc{font-size:12px;color:var(--sub)}
.lr-chev{color:#aebac1;font-size:18px}
/* media */
.bubble.media{padding:5px}
.bubble.media .meta{margin:2px 4px 2px 10px}
.media-card{border-radius:6px;overflow:hidden}
.media-thumb{width:250px;height:150px;background:linear-gradient(135deg,#cfd8dc,#b0bec5);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#54656f;border-radius:6px}
.media-thumb span{font-size:34px}
.media-thumb em{font-style:normal;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em}
.media-thumb.document{height:90px;background:linear-gradient(135deg,#e1e8ed,#cfd8dc)}
.caption{padding:6px 4px 2px;font-size:14.2px}
.media-card.audio{display:flex;align-items:center;gap:10px;padding:8px 10px;min-width:220px}
.play{width:32px;height:32px;border-radius:50%;background:#00a884;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;flex:0 0 32px}
.wave{display:flex;gap:2px;color:#8696a0;font-size:13px}
.wave i{font-style:normal}
.media-label{font-size:11px;color:var(--sub)}
/* location */
.loc-card{border-radius:6px;overflow:hidden;width:250px}
.loc-map{height:120px;background:linear-gradient(135deg,#d7e8d4,#b9d9c9);display:flex;align-items:center;justify-content:center;position:relative}
.loc-map:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 18px,rgba(255,255,255,.5) 18px,rgba(255,255,255,.5) 19px),repeating-linear-gradient(90deg,transparent,transparent 18px,rgba(255,255,255,.5) 18px,rgba(255,255,255,.5) 19px)}
.pin{font-size:30px;position:relative;filter:drop-shadow(0 2px 2px rgba(0,0,0,.25))}
.loc-info{background:rgba(255,255,255,.65);padding:7px 9px;border-radius:0 0 6px 6px}
.loc-name{font-weight:700;font-size:13.5px}
.loc-addr{font-size:12.5px;color:#3b4a54}
.loc-coords{font-size:11px;color:var(--sub)}
/* composer */
.composer{background:#f0f2f5;display:flex;align-items:center;gap:10px;padding:9px 14px;border-top:1px solid var(--hair)}
.compose-hint{flex:1;background:#fff;border-radius:20px;padding:7px 14px;color:#8696a0;font-size:13.5px}
.mic{color:#54656f}
/* ussd terminal */
.ussd-card{max-width:520px;margin:0 auto;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(11,20,26,.18);background:#101418}
.ussd-top{background:#1d242b;display:flex;align-items:center;gap:6px;padding:9px 12px}
.ussd-dot{width:10px;height:10px;border-radius:50%;background:#3a4650}
.ussd-dot:first-child{background:#f15c6d}.ussd-dot:nth-child(2){background:#f4bf4f}.ussd-dot:nth-child(3){background:#61c454}
.ussd-title{margin-left:8px;color:#8b98a5;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ussd-body{padding:16px 16px 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.6;max-height:560px;overflow-y:auto}
.ussd-body .u{color:#9fd3ff;margin-top:8px}
.ussd-body .u .pfx{color:#5d6b78}
.ussd-body .g{color:#8ce99a;white-space:pre-wrap;margin-top:4px}
.ussd-body .g.end{color:#ffd166}
footer{color:#8696a0;font-size:12px;text-align:center;padding:30px 0 10px}
@media(max-width:860px){.sidebar{display:none}.main{padding:0 14px 60px}}
`;

const JS = `
const filter=document.getElementById('filter');
if(filter){filter.addEventListener('input',()=>{const q=filter.value.trim().toLowerCase();
document.querySelectorAll('.journey').forEach(s=>{s.style.display=!q||s.dataset.name.includes(q)?'':'none'});
document.querySelectorAll('.group a').forEach(a=>{a.style.display=!q||a.textContent.toLowerCase().includes(q)?'':'none'});});}
const links=new Map();document.querySelectorAll('.group a[href^="#"]').forEach(a=>links.set(a.getAttribute('href').slice(1),a));
const obs=new IntersectionObserver(es=>{es.forEach(e=>{const a=links.get(e.target.id);if(!a)return;if(e.isIntersecting){document.querySelectorAll('.group a').forEach(x=>x.classList.remove('active'));a.classList.add('active');}})},{rootMargin:'-20% 0px -70% 0px'});
document.querySelectorAll('.journey').forEach(s=>obs.observe(s));
`;

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    throw new Error(`transcripts not found at ${TRANSCRIPTS_DIR} — run 'npm run simulate' first`);
  }
  const index = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, "index.json"), "utf8"));
  const journeys: JourneyTranscript[] = (index.journeys as Array<{ file: string }>).map((j) =>
    JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, j.file), "utf8")),
  );
  const pass = journeys.filter((j) => j.pass).length;
  const sha = shortSha();
  const byId = new Map(journeys.map((j) => [j.id, j]));

  const nav = GROUPS.map((g) => {
    const links = g.ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const j = byId.get(id)!;
        return `<a href="#${j.id}"><span class="jid">${j.id}</span>${esc(j.title)}<span class="ok">✓</span></a>`;
      })
      .join("\n");
    return `<div class="group"><h3>${esc(g.name)}</h3>${links}</div>`;
  }).join("\n");

  const sections = GROUPS.flatMap((g) => g.ids)
    .filter((id) => byId.has(id))
    .map((id) => journeySection(byId.get(id)!))
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Simulation Gallery — munisp/whatsappCommerce</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<nav class="sidebar">
  <div class="brand">
    <h1><span class="dot"></span>WA Simulation Gallery</h1>
    <div class="repo">munisp/whatsappCommerce @ ${esc(sha)}</div>
    <div class="summary">${pass}/${journeys.length} PASS — full WhatsApp feature simulation</div>
  </div>
  <input id="filter" class="filter" placeholder="Filter journeys…">
  ${nav}
</nav>
<main class="main">
  <div class="topbar">
    <h2>Journey chat gallery</h2>
    <p>${pass}/${journeys.length} PASS — full WhatsApp feature simulation, munisp/whatsappCommerce @ ${esc(sha)}. Every bubble below is a real message captured from the live platform (Meta Cloud API mocked at the wire).</p>
  </div>
  ${sections}
  <footer>generated ${esc(new Date().toISOString())} · simulation/render/generate.ts · tenant: ${esc(index.businessName ?? "Simply Green (simulated tenant)")}</footer>
</main>
</div>
<script>${JS}</script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, html);
  console.log(`gallery → ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB, ${journeys.length} journeys, ${pass} pass)`);
}

main();
