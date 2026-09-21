/**
 * YOLO label export ZIP (GET /api/finetune/export-yolo).
 *
 * Extracted from server/_core/index.ts so it can be unit-tested. Two bugs
 * lived inline in the route and neither had any test:
 *
 *  1. It built the archive with `new Archiver("zip", opts)` — the archiver
 *     <=7 constructor. archiver 8 (ESM) dropped the format-dispatching base
 *     constructor in favour of per-format classes, so that call produced a base
 *     Archiver with no `_module`; `append` then threw asynchronously
 *     ("this._module.append is not a function"), outside the route's
 *     try/catch, and the process-level uncaughtException handler shut the
 *     WHOLE server down. Anyone who could reach the route with at least one
 *     image in scope could take the platform down.
 *  2. className / imageUrl (client-controlled strings) were interpolated into
 *     preview.html unescaped — stored XSS for whoever opens the preview.
 */
import { ZipArchive } from "archiver";

export interface YoloImageRow {
  id: string;
  imageUrl: string;
  className: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  qualityScore: number | null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

/** Escape for a single-quoted JS string literal. When that literal sits inside
 *  an HTML attribute, apply escapeHtml to the RESULT (the browser HTML-decodes
 *  the attribute before the JS parser sees it), not the other way round. */
export function escapeJsString(s: string): string {
  return s.replace(/[\\'"\n\r]/g, (c) => ({
    "\\": "\\\\", "'": "\\'", '"': '\\"', "\n": "\\n", "\r": "\\r",
  }[c] as string));
}

/** Filesystem-safe label file stem. */
function safeStem(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "_");
}

export function buildPreviewHtml(
  images: YoloImageRow[],
  classMap: Record<string, number>,
  classCount: number,
): string {
  const rows = images.map((img) => {
    const classId = classMap[img.className] ?? 0;
    const bboxData = img.bbox ? JSON.stringify(img.bbox) : "null";
    return `<div class="card">
  <div class="img-wrap">
    <img src="${escapeHtml(img.imageUrl)}" crossorigin="anonymous" onload="drawBbox(this,'${escapeHtml(escapeJsString(img.id))}')" onerror="this.style.opacity='0.3'"/>
    <canvas id="c-${escapeHtml(img.id)}" class="overlay"></canvas>
  </div>
  <div class="meta"><span class="cls">${escapeHtml(img.className)}</span> <span class="cid">#${classId}</span>${img.qualityScore ? ` ⭐${img.qualityScore}` : ""}</div>
  <script>window.__bbox=window.__bbox||{};window.__bbox[${JSON.stringify(img.id).replace(/</g, "\\u003c")}]=${bboxData.replace(/</g, "\\u003c")};</script>
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>YOLO Dataset Preview</title>
<style>
body{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:16px}
h1{font-size:18px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.card{background:#1e1e1e;border-radius:6px;overflow:hidden;padding:6px}
.img-wrap{position:relative;width:100%;aspect-ratio:1}
.img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.overlay{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
.meta{font-size:11px;padding:4px 2px;display:flex;gap:6px;align-items:center}
.cls{font-weight:600;color:#7dd3fc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cid{color:#94a3b8}
</style></head><body>
<h1>YOLO Dataset Preview — ${images.length} images, ${classCount} classes</h1>
<div class="grid">${rows}</div>
<script>
function drawBbox(img,id){
  var bbox=window.__bbox&&window.__bbox[id];
  if(!bbox)return;
  var wrap=img.parentElement;
  var c=document.getElementById('c-'+id);
  if(!c)return;
  c.width=wrap.offsetWidth;c.height=wrap.offsetHeight;
  var ctx=c.getContext('2d');
  ctx.strokeStyle='#22c55e';ctx.lineWidth=2;ctx.setLineDash([4,2]);
  ctx.strokeRect(bbox.x*c.width,bbox.y*c.height,bbox.w*c.width,bbox.h*c.height);
}
</script></body></html>`;
}

/**
 * Build (but do not pipe or finalize) the export archive. The caller MUST
 * attach an "error" listener before finalizing: an unhandled stream error is
 * an uncaught exception, which this server treats as fatal.
 */
export function createYoloArchive(images: YoloImageRow[], opts: { zlibLevel?: number } = {}): ZipArchive {
  const archive = new ZipArchive({ zlib: { level: opts.zlibLevel ?? 6 } });
  const classNames = Array.from(new Set(images.map((i) => i.className))).sort();
  const classMap: Record<string, number> = Object.fromEntries(classNames.map((c, idx) => [c, idx]));

  archive.append(classNames.join("\n"), { name: "classes.txt" });

  // One YOLO label per image: <class_id> 0.5 0.5 1.0 1.0 (full-image box).
  for (const img of images) {
    const classId = classMap[img.className] ?? 0;
    archive.append(`${classId} 0.5 0.5 1.0 1.0\n`, {
      name: `labels/${safeStem(img.className)}/${safeStem(img.id)}.txt`,
    });
  }

  const manifest = classNames.map((cn) => {
    const inClass = images.filter((i) => i.className === cn);
    return {
      className: cn,
      classId: classMap[cn],
      imageCount: inClass.length,
      images: inClass.map((i) => ({ id: i.id, imageUrl: i.imageUrl, qualityScore: i.qualityScore })),
    };
  });
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  archive.append(buildPreviewHtml(images, classMap, classNames.length), { name: "preview.html" });
  return archive;
}
