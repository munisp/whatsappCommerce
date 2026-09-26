/**
 * The WhatsApp → Telegram conversion, pure functions (no database, no network). What matters:
 *  - nothing a customer or merchant typed can break a message: Telegram drops the WHOLE message on a stray < or &;
 *  - WhatsApp's *bold* / _italic_ show as formatting, but `snake_case`, ids and arithmetic are left alone;
 *  - a button list that Telegram could not carry (callback_data over 64 bytes) is refused, so the caller sends the
 *    plain text instead of a keyboard whose buttons silently do nothing.
 */
import { describe, it, expect } from "vitest";
import { renderInteractiveForTelegram, waMarkdownToTelegramHtml as md } from "./services/telegramRender";

describe("waMarkdownToTelegramHtml — escaping", () => {
  it("escapes the characters Telegram treats as markup", () => {
    expect(md("R&D Kit under <5 minutes > 2")).toBe("R&amp;D Kit under &lt;5 minutes &gt; 2");
  });
  it("a message a customer typed as HTML is shown as text, never interpreted", () => {
    expect(md("<b>hi</b> <script>x</script>")).toBe("&lt;b&gt;hi&lt;/b&gt; &lt;script&gt;x&lt;/script&gt;");
  });
  it("tolerates empty and non-string input", () => {
    expect(md("")).toBe("");
    expect(md(undefined as unknown as string)).toBe("");
  });
  it("strips NUL so user text cannot forge the placeholders code spans use", () => {
    expect(md("`a` \u00000\u0000")).toBe("<code>a</code> 0");
  });
});

describe("waMarkdownToTelegramHtml — formatting", () => {
  it("converts WhatsApp bold, italic, strikethrough and code", () => {
    expect(md("*bold* and _italic_ and ~gone~ and `x`")).toBe("<b>bold</b> and <i>italic</i> and <s>gone</s> and <code>x</code>");
  });
  it("converts a fenced block", () => {
    expect(md("```\nline 1\nline 2```")).toBe("<pre>line 1\nline 2</pre>");
  });
  it("marks must hug their text: a bullet, a spaced star and arithmetic are not formatting", () => {
    expect(md("* item")).toBe("* item");
    expect(md("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(md("a*b*c")).toBe("a*b*c");
  });
  it("leaves identifiers alone: snake_case words and ids are not italic", () => {
    expect(md("send menu_more_8 or order_track:abc_def")).toBe("send menu_more_8 or order_track:abc_def");
  });
  it("does not format inside code", () => {
    expect(md("`*not bold*` and `a_b_c`")).toBe("<code>*not bold*</code> and <code>a_b_c</code>");
  });
  it("nests bold around italic", () => {
    expect(md("*_both_*")).toBe("<b><i>both</i></b>");
  });
  it("formatting never spans lines", () => {
    expect(md("*one\ntwo*")).toBe("*one\ntwo*");
  });
  it("formats at the ends of lines and next to punctuation", () => {
    expect(md("Total: *NGN 4,500*.\n(_paid_)")).toBe("Total: <b>NGN 4,500</b>.\n(<i>paid</i>)");
  });
  it("every tag it emits is closed (Telegram rejects unbalanced HTML)", () => {
    const out = md("*a* _b_ ~c~ `d` ```e``` *f _g_ h*");
    for (const tag of ["b", "i", "s", "code", "pre"]) {
      expect((out.match(new RegExp(`<${tag}>`, "g")) ?? []).length).toBe((out.match(new RegExp(`</${tag}>`, "g")) ?? []).length);
    }
  });
});

describe("renderInteractiveForTelegram", () => {
  const buttons = (n: number, id = (i: number) => `menu_${i + 1}`) => ({
    bodyText: "Hi! *Welcome* to R&D Store",
    footerText: "Tap an option, or reply with its number.",
    action: { type: "button" as const, buttons: Array.from({ length: n }, (_, i) => ({ id: id(i), title: `Option ${i + 1}` })) },
  });

  it("reply buttons become an inline keyboard, ids kept verbatim", () => {
    const r = renderInteractiveForTelegram(buttons(3));
    expect(r?.kind).toBe("keyboard");
    if (r?.kind !== "keyboard") return;
    expect(r.buttons.map((b) => b.id)).toEqual(["menu_1", "menu_2", "menu_3"]);
    expect(r.text).toBe("Hi! <b>Welcome</b> to R&amp;D Store\n\n<i>Tap an option, or reply with its number.</i>");
  });

  it("a list becomes one list with its sections flattened, in order", () => {
    const r = renderInteractiveForTelegram({
      bodyText: "Pick one",
      action: {
        type: "list",
        sections: [
          { title: "A", rows: [{ id: "menu_1", title: "One" }, { id: "menu_2", title: "Two" }] },
          { title: "B", rows: [{ id: "menu_3", title: "Three" }] },
        ],
      },
    });
    expect(r?.kind).toBe("list");
    if (r?.kind !== "list") return;
    expect(r.rows.map((x) => x.id)).toEqual(["menu_1", "menu_2", "menu_3"]);
  });

  it("a header is shown, escaped, in bold", () => {
    const r = renderInteractiveForTelegram({ ...buttons(1), headerText: "Orders & more" });
    expect(r?.text.startsWith("<b>Orders &amp; more</b>\n\n")).toBe(true);
  });

  it("refuses what Telegram cannot carry, so the caller sends text instead", () => {
    const tooLong = "order_track:" + "x".repeat(60);
    expect(renderInteractiveForTelegram(buttons(2, () => tooLong))).toBeNull();
    expect(renderInteractiveForTelegram(buttons(0))).toBeNull();
    expect(renderInteractiveForTelegram({ ...buttons(1), bodyText: "   " })).toBeNull();
    expect(renderInteractiveForTelegram({ bodyText: "x", action: { type: "list", sections: [{ rows: [] }] } })).toBeNull();
  });

  it("an id of exactly 64 bytes is carried; 65 is not", () => {
    expect(renderInteractiveForTelegram(buttons(1, () => "a".repeat(64)))).not.toBeNull();
    expect(renderInteractiveForTelegram(buttons(1, () => "a".repeat(65)))).toBeNull();
  });

  it("a blank title falls back to the id rather than an empty button", () => {
    const r = renderInteractiveForTelegram({ bodyText: "x", action: { type: "button", buttons: [{ id: "menu_1", title: "  " }] } });
    expect(r?.kind === "keyboard" && r.buttons[0].title).toBe("menu_1");
  });
});
