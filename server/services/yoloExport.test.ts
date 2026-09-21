/**
 * QA: /api/finetune/export-yolo built its ZIP with the archiver<=7 constructor
 * `new Archiver("zip", opts)`. archiver 8 dropped that; the call produced a
 * base Archiver with no `_module`, `append` threw asynchronously
 * ("this._module.append is not a function"), and the server's
 * uncaughtException handler shut the WHOLE process down. This builds a real
 * ZIP end to end so that class of break fails here instead of in production.
 * It also pins the preview.html escaping (stored XSS) and zip-slip safety.
 */
import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createYoloArchive, buildPreviewHtml, escapeHtml, escapeJsString, type YoloImageRow } from "./yoloExport";

const img = (over: Partial<YoloImageRow> = {}): YoloImageRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  imageUrl: "/api/storage/product-images/rice/1.jpg",
  className: "rice_50kg",
  bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
  qualityScore: 4,
  ...over,
});

/** Finalize into a Buffer. level 0 = stored, so entry contents are greppable. */
async function zipOf(images: YoloImageRow[]): Promise<{ buf: Buffer; errors: Error[] }> {
  const archive = createYoloArchive(images, { zlibLevel: 0 });
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  archive.on("error", (e: Error) => errors.push(e));
  const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const done = new Promise<void>((res) => sink.on("finish", res));
  archive.pipe(sink);
  await archive.finalize();
  await done;
  return { buf: Buffer.concat(chunks), errors };
}

describe("createYoloArchive", () => {
  it("builds a real ZIP without the archiver-8 append crash", async () => {
    const { buf, errors } = await zipOf([img(), img({ id: "22222222-2222-2222-2222-222222222222", className: "sugar_1kg" })]);
    expect(errors).toEqual([]);
    expect(buf.subarray(0, 4).toString("binary")).toBe("PK\x03\x04");
    const text = buf.toString("latin1");
    for (const name of ["classes.txt", "manifest.json", "preview.html",
      "labels/rice_50kg/11111111-1111-1111-1111-111111111111.txt",
      "labels/sugar_1kg/22222222-2222-2222-2222-222222222222.txt"]) {
      expect(text, name).toContain(name);
    }
    // classes are sorted; rice_50kg=0, sugar_1kg=1 -> label content carries the class id
    expect(text).toContain("0 0.5 0.5 1.0 1.0");
    expect(text).toContain("1 0.5 0.5 1.0 1.0");
  });

  it("does not let a hostile class name write outside labels/ (zip-slip)", async () => {
    const { buf } = await zipOf([img({ className: "../../etc/cron.d/evil" })]);
    const text = buf.toString("latin1");
    expect(text).not.toContain("labels/../");
    expect(text).not.toMatch(/labels\/[^\0]*\.\.\//);
    expect(text).toContain("labels/______etc_cron_d_evil/");
  });
});

describe("buildPreviewHtml escaping", () => {
  it("escapes client-controlled className / imageUrl (stored XSS)", () => {
    const html = buildPreviewHtml([img({
      className: `</span><script>alert("x")</script>`,
      imageUrl: `x" onerror="alert(1)`,
    })], { "</span><script>alert(\"x\")</script>": 0 }, 1);
    expect(html).not.toContain(`<script>alert("x")`);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain(`" onerror="alert(1)`);
    expect(html).toContain("&quot; onerror=&quot;alert(1)");
    // the only <script> tags left are the page's own (one per card + the drawBbox helper)
    expect(html.match(/<script>/g)!.length).toBe(2);
  });

  it("orders JS-string escaping before HTML-attribute escaping so an id cannot break out of onload", () => {
    const html = buildPreviewHtml([img({ id: "a');alert(1);//" })], { rice_50kg: 0 }, 1);
    // browser HTML-decodes the attribute first, then parses JS: the quote must still be JS-escaped after decoding
    expect(html).toContain("drawBbox(this,'a\\&#39;);alert(1);//')");
    expect(html).not.toContain("drawBbox(this,'a');alert(1)");
  });

  it("cannot be closed early by </script> in a bbox/id", () => {
    const html = buildPreviewHtml([img({ id: "</script><script>alert(1)</script>" })], { rice_50kg: 0 }, 1);
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    for (const s of scripts) expect(s).not.toContain("alert(1)</script><script>");
    expect(html).toContain("\\u003c/script>");
  });

  it("escapeHtml / escapeJsString basics", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(escapeJsString(`a'b"c\\d\ne`)).toBe(`a\\'b\\"c\\\\d\\ne`);
  });
});
