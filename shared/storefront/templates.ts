/**
 * The template library: system-level starting points with no tenant data in them. Each one differs in
 * structure (header, hero, card, section order, footer), not only in colour. Photos are licensed stock
 * for the template itself; the merchant replaces them from the builder.
 */
import { section as s, storeConfigSchema, type StoreConfig, type StoreSection } from "./config";

export const TEMPLATE_CATEGORIES = [
  "Fashion", "Luxury fashion", "Beauty", "Electronics", "Groceries", "Food", "Home", "Jewelry",
  "Lifestyle", "Digital", "Wholesale", "Minimalist", "Boutique", "General",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface StoreTemplate {
  id: string;
  name: string;
  category: TemplateCategory | "Start from scratch";
  description: string;
  /** Which sample products preview this template. */
  demo: DemoKey;
  config: StoreConfig;
}
export type DemoKey = "fashion" | "luxury" | "beauty" | "tech" | "grocery" | "food" | "home" | "jewelry" | "lifestyle" | "digital" | "wholesale" | "minimal";

const large = (id: number) => `/images/store/p${id}-l.webp`;
const small = (id: number) => `/images/store/p${id}.webp`;

const DEFAULT_COLUMNS = [
  { title: "Shop", links: [{ label: "All products", href: "products" }, { label: "New arrivals", href: "products?sort=newest" }] },
  { title: "Help", links: [{ label: "Track an order", href: "track" }, { label: "Delivery", href: "policy/delivery" }, { label: "Returns", href: "policy/returns" }] },
  { title: "Account", links: [{ label: "Sign in", href: "account" }, { label: "My orders", href: "account/orders" }] },
];

type Partial2 = {
  theme: Partial<StoreConfig["theme"]> & Pick<StoreConfig["theme"], "background" | "surface" | "text" | "muted" | "line" | "accent" | "accentText" | "inverse" | "inverseText" | "headingFont" | "bodyFont">;
  header: Partial<StoreConfig["header"]> & Pick<StoreConfig["header"], "variant">;
  footer: Partial<StoreConfig["footer"]> & Pick<StoreConfig["footer"], "variant">;
  product: Partial<StoreConfig["product"]> & Pick<StoreConfig["product"], "card">;
  sections: StoreSection[];
};

function design(templateId: string, d: Partial2): StoreConfig {
  return storeConfigSchema.parse({
    templateId,
    theme: { sale: "#B3261E", ...d.theme },
    header: d.header,
    footer: { columns: DEFAULT_COLUMNS, ...d.footer },
    product: d.product,
    contact: {},
    sections: d.sections,
  });
}

export const STORE_TEMPLATES: StoreTemplate[] = [
  {
    id: "atelier", name: "Atelier", category: "Fashion", demo: "fashion",
    description: "A fashion house lookbook: a full-screen opening, tall portrait photography and quiet serif type.",
    config: design("atelier", {
      theme: { background: "#FBF9F5", surface: "#F2EDE4", text: "#171310", muted: "#6B6359", line: "#DED6C8", accent: "#171310", accentText: "#FBF9F5", inverse: "#171310", inverseText: "#FBF9F5", headingFont: "Cormorant Garamond", bodyFont: "Karla", headingWeight: 400, headingTracking: -0.02, imageRatio: "3/4", width: 1440, spacing: 96 },
      header: { variant: "centered", announcement: "New pieces arrive every month" },
      footer: { variant: "columns", about: "Clothes cut to be kept." },
      product: { card: "editorial", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "fullBleed", eyebrow: "The new collection", title: "Made to be worn for years", ctaLabel: "Shop the collection", ctaHref: "products", imageUrl: large(37550056), align: "left" }),
        s("products", "new", { title: "New in", source: "newArrivals", limit: 6, columns: 3 }),
        s("gallery", "look", { variant: "lookbook", title: "The lookbook", items: [{ title: "Evening", text: "", imageUrl: large(37550214), href: "products" }, { title: "Daywear", text: "", imageUrl: small(36467265), href: "products" }, { title: "Tailoring", text: "", imageUrl: small(8770938), href: "products" }] }),
        s("categories", "cats", { title: "Shop by category", variant: "text" }),
        s("products", "best", { title: "Most loved", source: "bestSellers", limit: 4, columns: 4 }),
        s("about", "about", { title: "Our atelier", body: "Tell your story here: who makes your clothes, where the cloth comes from and why it lasts.", imageUrl: small(33939066) }),
        s("testimonials", "reviews", { title: "From our customers" }),
        s("newsletter", "news", { title: "First look at every collection", body: "One email when something new arrives.", align: "center", tone: "surface" }),
      ],
    }),
  },
  {
    id: "maison-noire", name: "Maison Noire", category: "Luxury fashion", demo: "luxury",
    description: "After-dark luxury: black ground, wide-set capitals, two large pieces per row and a private concierge line.",
    config: design("maison-noire", {
      theme: { background: "#0B0B0B", surface: "#161514", text: "#F2EEE6", muted: "#A39C90", line: "#2E2C29", accent: "#C9A96A", accentText: "#0B0B0B", inverse: "#F2EEE6", inverseText: "#0B0B0B", sale: "#C9A96A", headingFont: "Bodoni Moda", bodyFont: "Manrope", headingCase: "upper", headingWeight: 400, headingTracking: 0.12, imageRatio: "4/5", width: 1500, spacing: 128 },
      header: { variant: "minimal" },
      footer: { variant: "wordmark" },
      product: { card: "plain", listColumns: 2 },
      sections: [
        s("hero", "hero", { variant: "cover", title: "The private collection", ctaLabel: "Enter", ctaHref: "products", imageUrl: large(30975839), align: "center" }),
        s("text", "statement", { body: "Few pieces. Made properly. Yours for a long time.", align: "center", variant: "statement" }),
        s("products", "edit", { title: "The edit", source: "featured", limit: 4, columns: 2 }),
        s("gallery", "detail", { variant: "strip", items: [{ title: "", text: "", imageUrl: large(37465528), href: "products" }, { title: "", text: "", imageUrl: large(20591025), href: "products" }] }),
        s("whatsapp", "concierge", { title: "Private concierge", body: "Speak to us directly about sizing, availability or a special request.", ctaLabel: "Message the concierge", align: "center" }),
      ],
    }),
  },
  {
    id: "glow-room", name: "Glow Room", category: "Beauty", demo: "beauty",
    description: "Soft, rounded and generous: a split hero, a shelf you swipe through, and routines in tinted cards.",
    config: design("glow-room", {
      theme: { background: "#FDF3EF", surface: "#FFFFFF", text: "#3A1F2B", muted: "#7E5E6A", line: "#F0D9D2", accent: "#B8405E", accentText: "#FFFFFF", inverse: "#3A1F2B", inverseText: "#FDF3EF", headingFont: "Fraunces", bodyFont: "Nunito", headingWeight: 600, radius: 22, imageRatio: "1/1", spacing: 64 },
      header: { variant: "classic", announcement: "Free skin consultation on WhatsApp" },
      footer: { variant: "columns", about: "Skin and beauty you can trust." },
      product: { card: "tile", listColumns: 4 },
      sections: [
        s("hero", "hero", { variant: "split", eyebrow: "New routine", title: "Skin that feels like yours again", body: "Gentle formulas, honest ingredients and advice from a real person.", ctaLabel: "Shop skincare", ctaHref: "products", imageUrl: large(7797009) }),
        s("trust", "trust", { items: [{ title: "Checked ingredients", text: "", imageUrl: "", href: "" }, { title: "Advice on WhatsApp", text: "", imageUrl: "", href: "" }, { title: "Careful delivery", text: "", imageUrl: "", href: "" }] }),
        s("products", "shelf", { title: "On everyone's shelf", source: "bestSellers", limit: 8, grid: "rail" }),
        s("categories", "cats", { title: "Find your routine", variant: "tiles" }),
        s("banner", "promo", { title: "Not sure where to start?", body: "Tell us about your skin and we'll build a routine with you.", ctaLabel: "Ask on WhatsApp", ctaHref: "whatsapp", tone: "accent", imageUrl: large(27544691) }),
        s("products", "new", { title: "Just arrived", source: "newArrivals", limit: 4, columns: 4 }),
        s("testimonials", "reviews", { title: "What your skin will say" }),
        s("newsletter", "news", { title: "Tips and early access", align: "center" }),
      ],
    }),
  },
  {
    id: "circuit", name: "Circuit", category: "Electronics", demo: "tech",
    description: "A dark, spec-led gadget shop: search up front, one hero product, deals first and a filter sidebar.",
    config: design("circuit", {
      theme: { background: "#0A0F14", surface: "#121A22", text: "#E6EEF5", muted: "#8B9BAA", line: "#223040", accent: "#2DE2A6", accentText: "#06201A", inverse: "#E6EEF5", inverseText: "#0A0F14", sale: "#FF6B4A", headingFont: "Space Grotesk", bodyFont: "Manrope", headingWeight: 700, headingTracking: -0.03, radius: 4, imageRatio: "1/1", width: 1400, spacing: 56 },
      header: { variant: "searchFirst", announcement: "Original products. Warranty on every device." },
      footer: { variant: "columns", about: "Devices and accessories, tested before they ship." },
      product: { card: "boxed", listColumns: 4, filters: "sidebar" },
      sections: [
        s("hero", "hero", { variant: "spotlight", eyebrow: "Featured device", title: "Sound with nothing in the way", body: "Our most-requested over-ear pair.", ctaLabel: "See details", imageUrl: large(11398246), source: "featured" }),
        s("trust", "trust", { variant: "spec", items: [{ title: "Warranty", text: "On every device", imageUrl: "", href: "" }, { title: "Tested", text: "Before dispatch", imageUrl: "", href: "" }, { title: "Same-day", text: "Where available", imageUrl: "", href: "" }, { title: "Real help", text: "On WhatsApp", imageUrl: "", href: "" }] }),
        s("products", "deals", { title: "Deals", source: "onSale", limit: 5, columns: 5 }),
        s("categories", "cats", { title: "Browse", variant: "chips" }),
        s("products", "new", { title: "Just landed", source: "newArrivals", limit: 8, columns: 4 }),
        s("whatsapp", "help", { title: "Not sure which one?", body: "Send us what you need it for and we'll tell you honestly.", ctaLabel: "Ask an expert", tone: "surface" }),
      ],
    }),
  },
  {
    id: "daily-basket", name: "Daily Basket", category: "Groceries", demo: "grocery",
    description: "Built for repeat shopping: search first, dense rows with one-tap add, and a shopping list you can send on WhatsApp.",
    config: design("daily-basket", {
      theme: { background: "#FFFFFF", surface: "#F3F7F1", text: "#14261B", muted: "#5B6D61", line: "#DFE8DC", accent: "#0F7B3F", accentText: "#FFFFFF", inverse: "#0F7B3F", inverseText: "#FFFFFF", sale: "#D1361D", headingFont: "Poppins", bodyFont: "Poppins", headingWeight: 600, headingTracking: -0.02, radius: 12, imageRatio: "1/1", width: 1400, spacing: 40 },
      header: { variant: "searchFirst", announcement: "Order before 2pm for same-day delivery" },
      footer: { variant: "bar" },
      product: { card: "compact", listColumns: 6, filters: "sidebar" },
      sections: [
        s("hero", "hero", { variant: "search", title: "Your groceries, delivered today", body: "Fresh food and household staples.", imageUrl: large(33624058), tone: "accent" }),
        s("categories", "cats", { title: "Aisles", variant: "tiles" }),
        s("products", "deals", { title: "This week's offers", source: "onSale", limit: 6, columns: 6 }),
        s("products", "best", { title: "Everyone's buying", source: "bestSellers", limit: 12, columns: 6 }),
        s("whatsapp", "list", { title: "Too busy to browse?", body: "Send your shopping list on WhatsApp and we'll pack it for you.", ctaLabel: "Send my list", tone: "accent", imageUrl: small(4177755) }),
      ],
    }),
  },
  {
    id: "buka", name: "Buka", category: "Food", demo: "food",
    description: "A restaurant, not a shop: the menu is the page, laid out in priced lists with opening hours up top.",
    config: design("buka", {
      theme: { background: "#FFF6E9", surface: "#FBE7CC", text: "#2A120B", muted: "#7A5B4B", line: "#EBD3B4", accent: "#C8341C", accentText: "#FFF6E9", inverse: "#2A120B", inverseText: "#FFF6E9", headingFont: "DM Serif Display", bodyFont: "Karla", headingWeight: 400, radius: 2, imageRatio: "1/1", width: 1180, spacing: 72 },
      header: { variant: "split" },
      footer: { variant: "centered" },
      product: { card: "menu", listColumns: 2 },
      sections: [
        s("hero", "hero", { variant: "cover", eyebrow: "Open today", title: "Cooked this morning", body: "Order for delivery or pick up.", ctaLabel: "See the menu", ctaHref: "products", imageUrl: large(13915043), align: "center" }),
        s("products", "menu", { title: "Today's menu", source: "all", limit: 12, columns: 2, grid: "list", align: "center" }),
        s("gallery", "kitchen", { variant: "strip", items: [{ title: "", text: "", imageUrl: large(17952746), href: "products" }, { title: "", text: "", imageUrl: large(37648018), href: "products" }, { title: "", text: "", imageUrl: large(6210449), href: "products" }] }),
        s("whatsapp", "order", { title: "Feeding a crowd?", body: "Tell us the date and how many people. We cater parties and offices.", ctaLabel: "Talk to the kitchen", tone: "inverse", align: "center" }),
        s("testimonials", "reviews", { title: "Regulars say", align: "center" }),
      ],
    }),
  },
  {
    id: "hearth", name: "Hearth", category: "Home", demo: "home",
    description: "Rooms before products: a mosaic opening, wide landscape cards and shopping by room.",
    config: design("hearth", {
      theme: { background: "#EFE9DF", surface: "#F8F4EC", text: "#26241E", muted: "#6D695D", line: "#D6CEBF", accent: "#4B5A3A", accentText: "#F8F4EC", inverse: "#26241E", inverseText: "#F8F4EC", headingFont: "Lora", bodyFont: "Work Sans", headingWeight: 600, radius: 6, imageRatio: "16/10", width: 1400, spacing: 88 },
      header: { variant: "classic" },
      footer: { variant: "columns", about: "Furniture for the way you actually live." },
      product: { card: "editorial", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "mosaic", eyebrow: "Home", title: "Rooms that feel finished", ctaLabel: "Shop furniture", ctaHref: "products", items: [{ title: "", text: "", imageUrl: large(5551824), href: "products" }, { title: "", text: "", imageUrl: large(6480707), href: "products" }, { title: "", text: "", imageUrl: small(3965520), href: "products" }] }),
        s("categories", "rooms", { title: "Shop by room", variant: "photo" }),
        s("products", "best", { title: "Most-loved pieces", source: "bestSellers", limit: 6, columns: 3 }),
        s("banner", "delivery", { eyebrow: "Delivery", title: "Carried in and set up, where it's offered", body: "Ask us what's available for your address.", ctaLabel: "Ask on WhatsApp", ctaHref: "whatsapp", imageUrl: large(8987432), variant: "side" }),
        s("products", "new", { title: "New to the showroom", source: "newArrivals", limit: 3, columns: 3 }),
        s("about", "about", { title: "Made to last", body: "Tell customers about your makers, materials and how you stand behind your furniture.", imageUrl: small(5490341) }),
        s("newsletter", "news", { title: "New pieces, first", tone: "surface" }),
      ],
    }),
  },
  {
    id: "gild", name: "Gild", category: "Jewelry", demo: "jewelry",
    description: "Fine jewellery on quiet ground: everything centred, small objects with room around them, hairline rules.",
    config: design("gild", {
      theme: { background: "#FAF7F0", surface: "#F3EDE0", text: "#1E1A12", muted: "#736A58", line: "#E2D9C5", accent: "#8A6D22", accentText: "#FAF7F0", inverse: "#1E1A12", inverseText: "#FAF7F0", headingFont: "Playfair Display", bodyFont: "DM Sans", headingWeight: 400, headingTracking: 0, imageRatio: "1/1", width: 1200, spacing: 104 },
      header: { variant: "centered", announcement: "Complimentary gift wrapping" },
      footer: { variant: "centered" },
      product: { card: "plain", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "stacked", eyebrow: "Fine jewellery", title: "Gold, kept close", ctaLabel: "View the collection", ctaHref: "products", imageUrl: large(16853521), align: "center" }),
        s("products", "edit", { title: "The collection", source: "featured", limit: 6, columns: 3, align: "center" }),
        s("text", "craft", { title: "Set by hand", body: "Tell customers how each piece is made, the metals you use and how you certify them.", align: "center" }),
        s("gallery", "worn", { variant: "strip", items: [{ title: "", text: "", imageUrl: large(16853521), href: "products" }, { title: "", text: "", imageUrl: large(28933799), href: "products" }] }),
        s("whatsapp", "bespoke", { title: "Something made for you", body: "Rings, sets and gifts made to order.", ctaLabel: "Begin on WhatsApp", align: "center" }),
      ],
    }),
  },
  {
    id: "everyday", name: "Everyday", category: "Lifestyle", demo: "lifestyle",
    description: "Loud and friendly: big colour blocks, oversized type and bright product tiles.",
    config: design("everyday", {
      theme: { background: "#FFFFFF", surface: "#FFF1E8", text: "#12233B", muted: "#55657A", line: "#E5E8EC", accent: "#FF5A1F", accentText: "#FFFFFF", inverse: "#12355B", inverseText: "#FFFFFF", sale: "#FF5A1F", headingFont: "Outfit", bodyFont: "Outfit", headingWeight: 700, headingTracking: -0.03, radius: 14, imageRatio: "1/1", spacing: 56 },
      header: { variant: "ticker", announcement: "New drops weekly   •   Pay online or on delivery where offered   •   Chat with us on WhatsApp" },
      footer: { variant: "wordmark" },
      product: { card: "tile", listColumns: 4 },
      sections: [
        s("hero", "hero", { variant: "split", title: "Good things for ordinary days", ctaLabel: "Shop everything", ctaHref: "products", imageUrl: large(2680272), tone: "accent" }),
        s("categories", "cats", { title: "Pick a lane", variant: "chips" }),
        s("products", "best", { title: "The ones people come back for", source: "bestSellers", limit: 8, columns: 4 }),
        s("banner", "promo", { title: "This week's picks", ctaLabel: "See them", ctaHref: "products?sort=newest", tone: "inverse", imageUrl: large(7061988) }),
        s("products", "new", { title: "Fresh in", source: "newArrivals", limit: 4, columns: 4 }),
        s("newsletter", "news", { title: "Get the good stuff first", tone: "accent", align: "center" }),
      ],
    }),
  },
  {
    id: "vault", name: "Vault", category: "Digital", demo: "digital",
    description: "For downloads and courses: type-led opening, a terminal feel and products as clear, scannable rows.",
    config: design("vault", {
      theme: { background: "#111214", surface: "#1A1C1F", text: "#ECEDEE", muted: "#94989E", line: "#2B2E33", accent: "#C6F135", accentText: "#111214", inverse: "#ECEDEE", inverseText: "#111214", sale: "#C6F135", headingFont: "JetBrains Mono", bodyFont: "Manrope", headingWeight: 700, headingTracking: -0.04, radius: 3, imageRatio: "16/10", width: 1180, spacing: 72 },
      header: { variant: "minimal" },
      footer: { variant: "bar" },
      product: { card: "row", listColumns: 1 },
      sections: [
        s("hero", "hero", { variant: "type", eyebrow: "Digital products", title: "Things you can use the minute you buy them", body: "Templates, guides and courses, delivered straight to you.", ctaLabel: "Browse the library", ctaHref: "products" }),
        s("products", "library", { title: "The library", source: "all", limit: 8, columns: 1, grid: "list" }),
        s("about", "author", { title: "Who makes these", body: "Tell buyers who you are and why they should trust what you've made.", imageUrl: large(30047570) }),
        s("testimonials", "reviews", { title: "Buyers say" }),
        s("whatsapp", "help", { title: "Questions before you buy?", ctaLabel: "Ask on WhatsApp" }),
      ],
    }),
  },
  {
    id: "bulk-co", name: "Bulk & Co", category: "Wholesale", demo: "wholesale",
    description: "A trade counter: dense price tables, quantity entry on every row, and quotes over WhatsApp.",
    config: design("bulk-co", {
      theme: { background: "#F7F7F5", surface: "#FFFFFF", text: "#1F2933", muted: "#5F6C7B", line: "#D8DCE0", accent: "#B45309", accentText: "#FFFFFF", inverse: "#1F2933", inverseText: "#FFFFFF", headingFont: "Archivo", bodyFont: "Archivo", headingWeight: 800, headingTracking: -0.02, radius: 2, imageRatio: "1/1", width: 1400, spacing: 40 },
      header: { variant: "searchFirst", announcement: "Trade prices. Ask us about bulk delivery." },
      footer: { variant: "columns", about: "Supplying shops and businesses." },
      product: { card: "row", listColumns: 1, filters: "sidebar" },
      sections: [
        s("hero", "hero", { variant: "stacked", eyebrow: "Wholesale", title: "Buy by the carton", body: "Trade prices for shops, offices and resellers.", ctaLabel: "See the price list", ctaHref: "products", imageUrl: large(10834810) }),
        s("trust", "trust", { variant: "spec", items: [{ title: "Trade prices", text: "For bulk orders", imageUrl: "", href: "" }, { title: "Invoices", text: "On request", imageUrl: "", href: "" }, { title: "Bulk delivery", text: "Ask for a quote", imageUrl: "", href: "" }] }),
        s("categories", "cats", { title: "Departments", variant: "chips" }),
        s("products", "list", { title: "Price list", source: "all", limit: 16, columns: 1, grid: "list" }),
        s("whatsapp", "quote", { title: "Need a quote for a large order?", body: "Send your list on WhatsApp and we'll price it for you.", ctaLabel: "Request a quote", tone: "inverse" }),
      ],
    }),
  },
  {
    id: "plain", name: "Plain", category: "Minimalist", demo: "minimal",
    description: "Almost nothing: a single sentence, generous white space and products that do the talking.",
    config: design("plain", {
      theme: { background: "#FFFFFF", surface: "#F5F5F4", text: "#111111", muted: "#6F6F6F", line: "#E7E7E7", accent: "#111111", accentText: "#FFFFFF", inverse: "#111111", inverseText: "#FFFFFF", sale: "#111111", headingFont: "Instrument Serif", bodyFont: "DM Sans", headingWeight: 400, headingTracking: -0.02, imageRatio: "4/5", width: 1280, spacing: 120 },
      header: { variant: "minimal" },
      footer: { variant: "bar" },
      product: { card: "plain", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "type", title: "Fewer things, chosen well.", ctaLabel: "Shop", ctaHref: "products" }),
        s("products", "all", { source: "all", limit: 9, columns: 3 }),
        s("about", "about", { body: "A line or two about why this shop exists.", imageUrl: large(8217492) }),
      ],
    }),
  },
  {
    id: "the-row", name: "The Row", category: "Boutique", demo: "fashion",
    description: "A magazine, not a catalogue: asymmetric lookbook grid, wine and stone palette, a shop assistant one tap away.",
    config: design("the-row", {
      theme: { background: "#F3EEE9", surface: "#E9E1D9", text: "#2B1A1F", muted: "#725F62", line: "#D8CCC2", accent: "#5B1A2E", accentText: "#F3EEE9", inverse: "#5B1A2E", inverseText: "#F3EEE9", headingFont: "Fraunces", bodyFont: "Work Sans", headingWeight: 400, headingTracking: -0.02, imageRatio: "4/5", width: 1440, spacing: 88 },
      header: { variant: "centered", announcement: "Styled for you by appointment" },
      footer: { variant: "wordmark" },
      product: { card: "editorial", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "mosaic", eyebrow: "This season", title: "A small shop with a good eye", ctaLabel: "See what's in", ctaHref: "products", items: [{ title: "", text: "", imageUrl: large(19809165), href: "products" }, { title: "", text: "", imageUrl: large(3973748), href: "products" }, { title: "", text: "", imageUrl: small(12512197), href: "products" }] }),
        s("products", "edit", { title: "Our edit", source: "featured", limit: 7, grid: "lookbook" }),
        s("banner", "style", { eyebrow: "Personal styling", title: "Tell us the occasion. We'll put it together.", ctaLabel: "Chat with a stylist", ctaHref: "whatsapp", tone: "inverse", variant: "side", imageUrl: large(16250630) }),
        s("testimonials", "reviews", { title: "Kind words" }),
        s("newsletter", "news", { title: "Letters from the shop" }),
      ],
    }),
  },
  {
    id: "market-square", name: "Market Square", category: "General", demo: "lifestyle",
    description: "The dependable all-rounder: everything a shopper expects, in the place they expect it, for any kind of shop.",
    config: design("market-square", {
      theme: { background: "#FFFFFF", surface: "#F4F6F9", text: "#14233A", muted: "#5A6B80", line: "#DEE4EB", accent: "#14396B", accentText: "#FFFFFF", inverse: "#14396B", inverseText: "#FFFFFF", headingFont: "Manrope", bodyFont: "Manrope", headingWeight: 700, headingTracking: -0.02, radius: 8, imageRatio: "1/1", spacing: 64 },
      header: { variant: "classic", announcement: "Chat with us on WhatsApp for help with your order" },
      footer: { variant: "columns", about: "Thanks for shopping with us." },
      product: { card: "boxed", listColumns: 4 },
      sections: [
        s("hero", "hero", { variant: "fullBleed", title: "Everything you came for", body: "Good prices, real people, delivered to you.", ctaLabel: "Start shopping", ctaHref: "products", imageUrl: large(30019690) }),
        s("trust", "trust", { items: [{ title: "Secure payment", text: "", imageUrl: "", href: "" }, { title: "Order tracking", text: "", imageUrl: "", href: "" }, { title: "Help on WhatsApp", text: "", imageUrl: "", href: "" }] }),
        s("categories", "cats", { title: "Shop by category", variant: "tiles" }),
        s("products", "best", { title: "Best sellers", source: "bestSellers", limit: 8, columns: 4 }),
        s("banner", "promo", { title: "Special offers", body: "See everything that's on sale right now.", ctaLabel: "View offers", ctaHref: "products?sale=1", tone: "accent" }),
        s("products", "new", { title: "New arrivals", source: "newArrivals", limit: 4, columns: 4 }),
        s("about", "about", { title: "About us", body: "Tell customers who you are and what you stand for.", imageUrl: large(4177755) }),
        s("testimonials", "reviews", { title: "What customers say" }),
        s("newsletter", "news", { title: "Offers in your inbox", tone: "surface", align: "center" }),
      ],
    }),
  },
  {
    id: "adire", name: "Adire", category: "Fashion", demo: "fashion",
    description: "Indigo-dyed confidence for African fashion labels: deep blue ground, image-led cards and a strong split opening.",
    config: design("adire", {
      theme: { background: "#121E40", surface: "#1B2A54", text: "#F4EFE3", muted: "#B5BBD0", line: "#2D3D6B", accent: "#E8B04A", accentText: "#121E40", inverse: "#F4EFE3", inverseText: "#121E40", sale: "#E8B04A", headingFont: "Playfair Display", bodyFont: "Archivo", headingWeight: 700, headingTracking: -0.01, imageRatio: "3/4", width: 1400, spacing: 80 },
      header: { variant: "split" },
      footer: { variant: "wordmark" },
      product: { card: "overlay", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "split", eyebrow: "Made in Africa", title: "Worn with intention", body: "Prints and tailoring with a point of view.", ctaLabel: "Shop the label", ctaHref: "products", imageUrl: large(34249446) }),
        s("products", "new", { title: "New season", source: "newArrivals", limit: 6, columns: 3 }),
        s("gallery", "look", { variant: "lookbook", title: "In the wild", items: [{ title: "", text: "", imageUrl: large(12477588), href: "products" }, { title: "", text: "", imageUrl: small(36467265), href: "products" }, { title: "", text: "", imageUrl: small(8770938), href: "products" }] }),
        s("categories", "cats", { title: "The range", variant: "text" }),
        s("whatsapp", "tailor", { title: "Want it made to measure?", ctaLabel: "Talk to the tailor", tone: "surface" }),
      ],
    }),
  },
  {
    id: "concrete", name: "Concrete", category: "Fashion", demo: "lifestyle",
    description: "Streetwear with no manners: giant condensed capitals, hard lines, zero corners and a scrolling ticker.",
    config: design("concrete", {
      theme: { background: "#E9E9E6", surface: "#FFFFFF", text: "#0A0A0A", muted: "#555550", line: "#0A0A0A", accent: "#0A0A0A", accentText: "#E9E9E6", inverse: "#0A0A0A", inverseText: "#E9E9E6", sale: "#E5251B", headingFont: "Anton", bodyFont: "JetBrains Mono", headingCase: "upper", headingWeight: 400, headingTracking: 0, imageRatio: "4/5", width: 1600, spacing: 24 },
      header: { variant: "ticker", announcement: "DROP LIVE NOW   ///   LIMITED RUNS   ///   NO RESTOCKS" },
      footer: { variant: "wordmark" },
      product: { card: "overlay", listColumns: 4 },
      sections: [
        s("hero", "hero", { variant: "stacked", title: "Not for everyone", ctaLabel: "Shop the drop", ctaHref: "products", imageUrl: large(32917956) }),
        s("products", "drop", { title: "The drop", source: "newArrivals", limit: 8, columns: 4 }),
        s("banner", "statement", { title: "Limited runs. When it's gone, it's gone.", tone: "inverse", ctaLabel: "See everything", ctaHref: "products", imageUrl: large(7061988) }),
        s("newsletter", "news", { title: "Get the drop first", tone: "surface" }),
      ],
    }),
  },
  {
    id: "fresh-press", name: "Fresh Press", category: "Food", demo: "food",
    description: "Bakery and juice-bar cheer: butter yellow, rounded shapes and big appetising tiles you can order from.",
    config: design("fresh-press", {
      theme: { background: "#FFF7D6", surface: "#FFFFFF", text: "#2C2412", muted: "#6E6243", line: "#EFE4B5", accent: "#E4572E", accentText: "#FFFFFF", inverse: "#2C2412", inverseText: "#FFF7D6", sale: "#E4572E", headingFont: "Syne", bodyFont: "Nunito", headingWeight: 700, headingTracking: -0.03, radius: 28, imageRatio: "1/1", width: 1240, spacing: 56 },
      header: { variant: "classic", announcement: "Made fresh every morning" },
      footer: { variant: "centered" },
      product: { card: "tile", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "split", title: "Baked, blended and on its way", ctaLabel: "Order now", ctaHref: "products", imageUrl: large(37648018) }),
        s("categories", "cats", { title: "What are you craving?", variant: "chips" }),
        s("products", "fav", { title: "Crowd favourites", source: "bestSellers", limit: 6, columns: 3 }),
        s("banner", "party", { title: "Ordering for an event?", body: "Message us a few days ahead.", ctaLabel: "Plan it on WhatsApp", ctaHref: "whatsapp", tone: "accent", variant: "side", imageUrl: small(37624176) }),
        s("testimonials", "reviews", { title: "Happy mouths" }),
      ],
    }),
  },
  {
    id: "signal", name: "Signal", category: "Electronics", demo: "tech",
    description: "Phones and accessories, poster style: full-bleed opening, huge condensed type and a swipeable shelf.",
    config: design("signal", {
      theme: { background: "#060606", surface: "#141414", text: "#F5F5F0", muted: "#9A9A92", line: "#2A2A2A", accent: "#FFD400", accentText: "#060606", inverse: "#FFD400", inverseText: "#060606", sale: "#FFD400", headingFont: "Bebas Neue", bodyFont: "DM Sans", headingCase: "upper", headingWeight: 400, headingTracking: 0.01, imageRatio: "1/1", width: 1500, spacing: 72 },
      header: { variant: "classic" },
      footer: { variant: "wordmark" },
      product: { card: "overlay", listColumns: 4 },
      sections: [
        s("hero", "hero", { variant: "fullBleed", title: "Loud enough", ctaLabel: "Shop audio", ctaHref: "products", imageUrl: large(11398246), align: "center" }),
        s("products", "shelf", { title: "Hot right now", source: "bestSellers", limit: 8, grid: "rail" }),
        s("banner", "deal", { title: "Deals while stock lasts", ctaLabel: "See deals", ctaHref: "products?sale=1", tone: "accent" }),
        s("products", "new", { title: "New gear", source: "newArrivals", limit: 4, columns: 4 }),
        s("whatsapp", "chat", { title: "Is it in stock? Just ask.", ctaLabel: "Chat now", tone: "surface", align: "center" }),
      ],
    }),
  },
  {
    id: "sage", name: "Sage", category: "Beauty", demo: "beauty",
    description: "Natural and slow: muted greens, thin serif headlines and calm, spacious product stories.",
    config: design("sage", {
      theme: { background: "#E8EDE4", surface: "#F4F6F1", text: "#22301F", muted: "#5F6D5A", line: "#CFD8C8", accent: "#2F4A2B", accentText: "#F4F6F1", inverse: "#2F4A2B", inverseText: "#F4F6F1", sale: "#8C4A2F", headingFont: "Cormorant Garamond", bodyFont: "Manrope", headingWeight: 500, headingTracking: -0.01, imageRatio: "4/5", width: 1280, spacing: 96 },
      header: { variant: "centered" },
      footer: { variant: "centered" },
      product: { card: "editorial", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "stacked", eyebrow: "Slow skincare", title: "Good things take a little time", ctaLabel: "Explore", ctaHref: "products", imageUrl: large(6167866), align: "center" }),
        s("text", "ethos", { body: "Plant-led formulas, made in small batches. Nothing you can't pronounce.", align: "center", variant: "statement" }),
        s("products", "range", { title: "The range", source: "all", limit: 6, columns: 3, align: "center" }),
        s("about", "about", { title: "How we make it", body: "Tell customers where your ingredients come from and how you make your products.", imageUrl: large(8100816) }),
        s("newsletter", "news", { title: "Notes on slow skincare", align: "center" }),
      ],
    }),
  },
  {
    id: "loft", name: "Loft", category: "Home", demo: "home",
    description: "Premium interiors after dark: a full-screen room, image-led cards with captions on top, one strong statement.",
    config: design("loft", {
      theme: { background: "#1C1A17", surface: "#26231F", text: "#F1ECE3", muted: "#A9A295", line: "#39352E", accent: "#D9B48A", accentText: "#1C1A17", inverse: "#F1ECE3", inverseText: "#1C1A17", sale: "#D9B48A", headingFont: "Instrument Serif", bodyFont: "Manrope", headingWeight: 400, headingTracking: -0.02, imageRatio: "4/5", width: 1500, spacing: 96 },
      header: { variant: "minimal" },
      footer: { variant: "wordmark" },
      product: { card: "overlay", listColumns: 3 },
      sections: [
        s("hero", "hero", { variant: "fullBleed", eyebrow: "Interiors", title: "Live with less. Better.", ctaLabel: "See the collection", ctaHref: "products", imageUrl: large(4857757) }),
        s("products", "pieces", { title: "Signature pieces", source: "featured", limit: 6, columns: 3 }),
        s("banner", "consult", { eyebrow: "Design help", title: "Send us a photo of your room", body: "We'll suggest what would work there.", ctaLabel: "Send on WhatsApp", ctaHref: "whatsapp", variant: "side", imageUrl: large(5551824), tone: "surface" }),
        s("categories", "rooms", { title: "By room", variant: "photo" }),
      ],
    }),
  },
];

/** Blank Store: same shopping features, no design decisions made. Only a simple product grid to start. */
export const BLANK_TEMPLATE: StoreTemplate = {
  id: "blank", name: "Blank Store", category: "Start from scratch", demo: "lifestyle",
  description: "A clean page and every building block. Add, arrange and style your own sections. Checkout, accounts and WhatsApp work the same.",
  config: design("blank", {
    theme: { background: "#FFFFFF", surface: "#F5F5F5", text: "#1A1A1A", muted: "#6B6B6B", line: "#E5E5E5", accent: "#1A1A1A", accentText: "#FFFFFF", inverse: "#1A1A1A", inverseText: "#FFFFFF", headingFont: "DM Sans", bodyFont: "DM Sans", headingWeight: 700, imageRatio: "1/1", spacing: 64 },
    header: { variant: "classic" },
    footer: { variant: "bar" },
    product: { card: "boxed", listColumns: 4 },
    sections: [s("products", "products", { title: "Products", source: "all", limit: 12, columns: 4 })],
  }),
};

export const ALL_TEMPLATES: StoreTemplate[] = [...STORE_TEMPLATES, BLANK_TEMPLATE];

export function findTemplate(id: string | null | undefined): StoreTemplate | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id);
}

/** What a store looks like before its owner has chosen anything. */
export const DEFAULT_TEMPLATE_ID = "market-square";
