import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { productTaxonomy } from "../../drizzle/schema";
import { eq, ilike, or, and, isNull } from "drizzle-orm";

// ── Nigerian FMCG Seed Data ────────────────────────────────────────────────────
const NIGERIAN_FMCG_SEED = [
  // ── Beverages: Carbonated ──────────────────────────────────────────────────
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Coca-Cola", productName: "Coca-Cola", variants: ["350ml", "500ml", "600ml", "1L", "1.5L", "2L"], aliases: ["Coke", "Coca Cola", "Coke bottle"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Bigi", productName: "Bigi Cola", variants: ["350ml", "500ml", "1L", "1.5L"], aliases: ["Bigi", "Bigi drink"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Bigi", productName: "Bigi Orange", variants: ["350ml", "500ml", "1L"], aliases: ["Bigi orange", "Bigi citrus"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Pepsi", productName: "Pepsi Cola", variants: ["350ml", "500ml", "1L", "1.5L"], aliases: ["Pepsi", "Pepsi bottle"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Fanta", productName: "Fanta Orange", variants: ["350ml", "500ml", "1L"], aliases: ["Fanta", "Fanta orange"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Sprite", productName: "Sprite", variants: ["350ml", "500ml", "1L"], aliases: ["Sprite", "Sprite bottle"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "7UP", productName: "7UP", variants: ["350ml", "500ml", "1L"], aliases: ["Seven Up", "7 up"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Carbonated Drinks", brand: "Mirinda", productName: "Mirinda Orange", variants: ["350ml", "500ml"], aliases: ["Mirinda", "Mirinda orange"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  // ── Beverages: Malt ───────────────────────────────────────────────────────
  { category: "Beverages", subcategory: "Malt Drinks", brand: "Malta Guinness", productName: "Malta Guinness", variants: ["330ml", "500ml"], aliases: ["Malta", "Malta Guinness", "Malt Guinness"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Malt Drinks", brand: "Amstel Malta", productName: "Amstel Malta", variants: ["330ml", "500ml"], aliases: ["Amstel", "Amstel malt"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Malt Drinks", brand: "Grand Malt", productName: "Grand Malt", variants: ["330ml", "500ml"], aliases: ["Grand malt"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  // ── Beverages: Water ──────────────────────────────────────────────────────
  { category: "Beverages", subcategory: "Water", brand: "Eva Water", productName: "Eva Water", variants: ["33cl", "50cl", "75cl", "1.5L"], aliases: ["Eva", "Eva water bottle"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Water", brand: "Ragolis", productName: "Ragolis Water", variants: ["33cl", "50cl", "75cl", "1.5L"], aliases: ["Ragolis", "Ragolis water"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Water", brand: "Swan", productName: "Swan Water", variants: ["33cl", "50cl", "1.5L"], aliases: ["Swan", "Swan water"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Beverages", subcategory: "Water", brand: "Pure Water", productName: "Pure Water Sachet", variants: ["50cl"], aliases: ["pure water", "sachet water", "pure wata"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Beverages", subcategory: "Water", brand: "Table Water", productName: "Table Water Sachet", variants: ["50cl"], aliases: ["table water", "water sachet"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  // ── Beverages: Juice ──────────────────────────────────────────────────────
  { category: "Beverages", subcategory: "Juice", brand: "Chivita", productName: "Chivita Fruit Juice", variants: ["200ml", "500ml", "1L"], aliases: ["Chivita", "Chivita juice"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  { category: "Beverages", subcategory: "Juice", brand: "Five Alive", productName: "Five Alive Citrus Burst", variants: ["200ml", "500ml", "1L"], aliases: ["Five Alive", "5 alive"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Beverages", subcategory: "Juice", brand: "Capri-Sun", productName: "Capri-Sun", variants: ["200ml"], aliases: ["Capri Sun", "Caprisun"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  // ── Noodles ───────────────────────────────────────────────────────────────
  { category: "Noodles & Pasta", subcategory: "Instant Noodles", brand: "Indomie", productName: "Indomie Chicken Flavour", variants: ["70g", "120g", "200g"], aliases: ["Indomie chicken", "Indomie noodles", "noodles"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Noodles & Pasta", subcategory: "Instant Noodles", brand: "Indomie", productName: "Indomie Onion Chicken", variants: ["70g", "120g"], aliases: ["Indomie onion", "Indomie OC"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Noodles & Pasta", subcategory: "Instant Noodles", brand: "Indomie", productName: "Indomie Jollof", variants: ["70g", "120g"], aliases: ["Indomie jollof", "Jollof noodles"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Noodles & Pasta", subcategory: "Instant Noodles", brand: "Dangote Noodles", productName: "Dangote Noodles", variants: ["70g", "120g"], aliases: ["Dangote noodles", "Dangote pasta"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  { category: "Noodles & Pasta", subcategory: "Instant Noodles", brand: "Nasco", productName: "Nasco Noodles", variants: ["70g", "120g"], aliases: ["Nasco", "Nasco noodles"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  // ── Seasoning & Condiments ────────────────────────────────────────────────
  { category: "Seasoning & Condiments", subcategory: "Bouillon Cubes", brand: "Maggi", productName: "Maggi Chicken Cube", variants: ["4g cube", "8g cube", "100 cubes pack"], aliases: ["Maggi", "Maggi cube", "Maggi seasoning"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Seasoning & Condiments", subcategory: "Bouillon Cubes", brand: "Knorr", productName: "Knorr Chicken Cube", variants: ["4g cube", "8g cube"], aliases: ["Knorr", "Knorr cube", "Knorr seasoning"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Seasoning & Condiments", subcategory: "Bouillon Cubes", brand: "Royco", productName: "Royco Beef Cube", variants: ["4g cube", "8g cube"], aliases: ["Royco", "Royco cube"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Seasoning & Condiments", subcategory: "Tomato Products", brand: "Gino", productName: "Gino Tomato Paste", variants: ["70g sachet", "400g tin", "800g tin"], aliases: ["Gino tomato", "Gino paste", "Gino"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Seasoning & Condiments", subcategory: "Tomato Products", brand: "Tasty Tom", productName: "Tasty Tom Tomato Paste", variants: ["70g sachet", "400g tin"], aliases: ["Tasty Tom", "Tastytom"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Seasoning & Condiments", subcategory: "Tomato Products", brand: "Tomatina", productName: "Tomatina Tomato Paste", variants: ["70g sachet", "400g tin"], aliases: ["Tomatina"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Seasoning & Condiments", subcategory: "Salt", brand: "Dangote Salt", productName: "Dangote Iodized Salt", variants: ["500g", "1kg", "2kg"], aliases: ["Dangote salt", "table salt"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  // ── Dairy & Milk ──────────────────────────────────────────────────────────
  { category: "Dairy & Milk", subcategory: "Powdered Milk", brand: "Dano", productName: "Dano Full Cream Milk", variants: ["360g", "900g", "1.8kg", "sachet 20g"], aliases: ["Dano milk", "Dano", "Dano full cream"], isLocal: false, isSachet: true, typicalUnit: "tin" },
  { category: "Dairy & Milk", subcategory: "Powdered Milk", brand: "Peak Milk", productName: "Peak Full Cream Milk", variants: ["360g", "900g", "sachet 20g"], aliases: ["Peak milk", "Peak", "Peak full cream"], isLocal: false, isSachet: true, typicalUnit: "tin" },
  { category: "Dairy & Milk", subcategory: "Powdered Milk", brand: "Cowbell", productName: "Cowbell Milk Sachet", variants: ["8g sachet", "15g sachet"], aliases: ["Cowbell", "Cowbell milk", "cowbell sachet"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Dairy & Milk", subcategory: "Evaporated Milk", brand: "Carnation", productName: "Carnation Evaporated Milk", variants: ["170g tin", "410g tin"], aliases: ["Carnation milk", "Carnation"], isLocal: false, isSachet: false, typicalUnit: "tin" },
  { category: "Dairy & Milk", subcategory: "Evaporated Milk", brand: "Three Crowns", productName: "Three Crowns Evaporated Milk", variants: ["170g tin", "410g tin"], aliases: ["Three Crowns", "3 crowns milk"], isLocal: false, isSachet: false, typicalUnit: "tin" },
  // ── Grains & Staples ──────────────────────────────────────────────────────
  { category: "Grains & Staples", subcategory: "Rice", brand: "Mama Gold", productName: "Mama Gold Parboiled Rice", variants: ["1kg", "5kg", "10kg", "25kg", "50kg"], aliases: ["Mama Gold rice", "Mama Gold", "mama gold"], isLocal: true, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Rice", brand: "Caprice", productName: "Caprice Rice", variants: ["1kg", "5kg", "10kg", "25kg", "50kg"], aliases: ["Caprice rice", "Caprice"], isLocal: true, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Rice", brand: "Royal Stallion", productName: "Royal Stallion Rice", variants: ["5kg", "10kg", "25kg", "50kg"], aliases: ["Royal Stallion", "Royal stallion rice"], isLocal: false, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Rice", brand: "Uncle Ben's", productName: "Uncle Ben's Parboiled Rice", variants: ["1kg", "2kg", "5kg"], aliases: ["Uncle Bens", "Uncle Ben rice"], isLocal: false, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Flour", brand: "Dangote Flour", productName: "Dangote Wheat Flour", variants: ["1kg", "2kg", "5kg", "10kg", "25kg", "50kg"], aliases: ["Dangote flour", "wheat flour"], isLocal: true, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Garri", brand: "Garri", productName: "White Garri", variants: ["500g", "1kg", "5kg", "10kg"], aliases: ["garri", "white garri", "ijebu garri"], isLocal: true, isSachet: false, typicalUnit: "bag" },
  { category: "Grains & Staples", subcategory: "Garri", brand: "Garri", productName: "Yellow Garri", variants: ["500g", "1kg", "5kg"], aliases: ["yellow garri", "eba"], isLocal: true, isSachet: false, typicalUnit: "bag" },
  // ── Cooking Oil ───────────────────────────────────────────────────────────
  { category: "Cooking Oil & Fats", subcategory: "Vegetable Oil", brand: "Devon King's", productName: "Devon King's Vegetable Oil", variants: ["500ml", "1L", "2L", "3L", "5L"], aliases: ["Devon Kings", "Devon King oil", "Devon Kings oil"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Cooking Oil & Fats", subcategory: "Vegetable Oil", brand: "Mamador", productName: "Mamador Vegetable Oil", variants: ["500ml", "1L", "2L", "3L", "5L"], aliases: ["Mamador", "Mamador oil"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Cooking Oil & Fats", subcategory: "Vegetable Oil", brand: "Kings", productName: "Kings Vegetable Oil", variants: ["500ml", "1L", "2L", "5L"], aliases: ["Kings oil", "Kings vegetable oil"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  { category: "Cooking Oil & Fats", subcategory: "Palm Oil", brand: "Zomi", productName: "Zomi Palm Oil", variants: ["500ml", "1L", "2L", "5L"], aliases: ["Zomi", "Zomi oil", "palm oil"], isLocal: true, isSachet: false, typicalUnit: "bottle" },
  // ── Detergent & Cleaning ──────────────────────────────────────────────────
  { category: "Detergent & Cleaning", subcategory: "Laundry Powder", brand: "Omo", productName: "Omo Washing Powder", variants: ["35g sachet", "200g", "500g", "1kg", "2kg", "5kg"], aliases: ["Omo", "Omo detergent", "Omo powder"], isLocal: false, isSachet: true, typicalUnit: "sachet" },
  { category: "Detergent & Cleaning", subcategory: "Laundry Powder", brand: "Ariel", productName: "Ariel Washing Powder", variants: ["35g sachet", "200g", "500g", "1kg"], aliases: ["Ariel", "Ariel detergent", "Ariel powder"], isLocal: false, isSachet: true, typicalUnit: "sachet" },
  { category: "Detergent & Cleaning", subcategory: "Laundry Powder", brand: "Klin", productName: "Klin Detergent", variants: ["35g sachet", "200g", "500g", "1kg"], aliases: ["Klin", "Klin detergent"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Detergent & Cleaning", subcategory: "Soap", brand: "Sunlight", productName: "Sunlight Bar Soap", variants: ["200g", "400g"], aliases: ["Sunlight soap", "Sunlight"], isLocal: false, isSachet: false, typicalUnit: "bar" },
  { category: "Detergent & Cleaning", subcategory: "Soap", brand: "Key Soap", productName: "Key Soap", variants: ["200g", "400g"], aliases: ["Key soap", "Key"], isLocal: true, isSachet: false, typicalUnit: "bar" },
  // ── Personal Care ─────────────────────────────────────────────────────────
  { category: "Personal Care", subcategory: "Antiseptic", brand: "Dettol", productName: "Dettol Antiseptic Liquid", variants: ["50ml", "100ml", "250ml", "500ml", "1L"], aliases: ["Dettol", "Dettol antiseptic", "Dettol liquid"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Personal Care", subcategory: "Antiseptic", brand: "Izal", productName: "Izal Disinfectant", variants: ["250ml", "500ml", "1L"], aliases: ["Izal", "Izal disinfectant"], isLocal: false, isSachet: false, typicalUnit: "bottle" },
  { category: "Personal Care", subcategory: "Petroleum Jelly", brand: "Vaseline", productName: "Vaseline Petroleum Jelly", variants: ["50ml sachet", "100g", "250g", "450g"], aliases: ["Vaseline", "Vaseline jelly", "petroleum jelly"], isLocal: false, isSachet: true, typicalUnit: "jar" },
  { category: "Personal Care", subcategory: "Analgesic", brand: "Robb", productName: "Robb Mentholated Balm", variants: ["12g sachet", "25g", "50g"], aliases: ["Robb", "Robb balm", "robb pain"], isLocal: true, isSachet: true, typicalUnit: "sachet" },
  { category: "Personal Care", subcategory: "Analgesic", brand: "Panadol", productName: "Panadol Paracetamol", variants: ["8 tablets", "16 tablets", "24 tablets"], aliases: ["Panadol", "paracetamol", "pain tablet"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Personal Care", subcategory: "Toothpaste", brand: "Close-Up", productName: "Close-Up Toothpaste", variants: ["75ml", "100ml", "150ml"], aliases: ["Close Up", "Closeup toothpaste"], isLocal: false, isSachet: false, typicalUnit: "tube" },
  { category: "Personal Care", subcategory: "Toothpaste", brand: "Macleans", productName: "Macleans Toothpaste", variants: ["75ml", "100ml"], aliases: ["Macleans", "Maclean toothpaste"], isLocal: false, isSachet: false, typicalUnit: "tube" },
  // ── Snacks & Confectionery ────────────────────────────────────────────────
  { category: "Snacks & Confectionery", subcategory: "Biscuits", brand: "Digestive", productName: "McVitie's Digestive Biscuits", variants: ["200g", "400g"], aliases: ["Digestive", "Digestive biscuit"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Snacks & Confectionery", subcategory: "Biscuits", brand: "Cabin Biscuit", productName: "Cabin Biscuit", variants: ["small pack", "large pack"], aliases: ["Cabin biscuit", "Cabin"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  { category: "Snacks & Confectionery", subcategory: "Biscuits", brand: "Shortcake", productName: "Shortcake Biscuit", variants: ["small pack", "large pack"], aliases: ["Shortcake", "short cake biscuit"], isLocal: true, isSachet: false, typicalUnit: "pack" },
  { category: "Snacks & Confectionery", subcategory: "Sweets & Candy", brand: "Trebor", productName: "Trebor Peppermint", variants: ["pack"], aliases: ["Trebor", "Trebor sweet", "peppermint"], isLocal: false, isSachet: false, typicalUnit: "pack" },
  { category: "Snacks & Confectionery", subcategory: "Crisps", brand: "Pringles", productName: "Pringles Original", variants: ["40g", "165g"], aliases: ["Pringles", "Pringles crisps"], isLocal: false, isSachet: false, typicalUnit: "can" },
  { category: "Snacks & Confectionery", subcategory: "Crisps", brand: "Lays", productName: "Lays Potato Chips", variants: ["28g", "56g"], aliases: ["Lays", "Lays chips", "potato chips"], isLocal: false, isSachet: false, typicalUnit: "pack" },
];

// ── Router ─────────────────────────────────────────────────────────────────────
export const taxonomyRouter = router({
  // List all taxonomy items (global + tenant-specific), with optional filters
  list: publicProcedure
    .input(z.object({
      category: z.string().optional(),
      search: z.string().optional(),
      isLocal: z.boolean().optional(),
      isSachet: z.boolean().optional(),
      tenantId: z.string().optional(),
      limit: z.number().min(1).max(200).default(100),
    }).optional())
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const items = await db.select().from(productTaxonomy).limit(input?.limit ?? 100);
      // Apply filters in memory for flexibility
      let filtered = items;
      if (input?.category) filtered = filtered.filter((i: typeof items[0]) => i.category === input.category);
      if (input?.isLocal !== undefined) filtered = filtered.filter((i: typeof items[0]) => i.isLocal === input.isLocal);
      if (input?.isSachet !== undefined) filtered = filtered.filter((i: typeof items[0]) => i.isSachet === input.isSachet);
      if (input?.tenantId) filtered = filtered.filter((i: typeof items[0]) => !i.tenantId || i.tenantId === input.tenantId);
      if (input?.search) {
        const q = input.search.toLowerCase();
        filtered = filtered.filter((i: typeof items[0]) =>
          i.productName.toLowerCase().includes(q) ||
          i.brand.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q) ||
          (i.aliases as string[]).some((a: string) => a.toLowerCase().includes(q))
        );
      }
      return { items: filtered, total: filtered.length };
    }),

  // Get all distinct categories
  categories: publicProcedure.query(async () => {
    const db = (await getDb())!;
    const items = await db.select({ category: productTaxonomy.category, subcategory: productTaxonomy.subcategory }).from(productTaxonomy);
    const cats = new Map<string, Set<string>>();
    for (const item of items) {
      if (!cats.has(item.category)) cats.set(item.category, new Set());
      if (item.subcategory) cats.get(item.category)!.add(item.subcategory);
    }
    return Array.from(cats.entries()).map(([category, subs]) => ({
      category,
      subcategories: Array.from(subs),
    }));
  }),

  // Search for VLM hints — returns matching product names + aliases for a given query
  searchHints: publicProcedure
    .input(z.object({ query: z.string().min(1), limit: z.number().default(20) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const items = await db.select().from(productTaxonomy).where(eq(productTaxonomy.isActive, true));
      const q = input.query.toLowerCase();
      const scored = items
        .map((item: typeof items[0]) => {
          let score = 0;
          if (item.productName.toLowerCase().includes(q)) score += 3;
          if (item.brand.toLowerCase().includes(q)) score += 2;
          if ((item.aliases as string[]).some((a: string) => a.toLowerCase().includes(q))) score += 2;
          if (item.category.toLowerCase().includes(q)) score += 1;
          return { item, score };
        })
        .filter((x: {item: typeof items[0]; score: number}) => x.score > 0)
        .sort((a: {score: number}, b: {score: number}) => b.score - a.score)
        .slice(0, input.limit)
        .map((x: {item: typeof items[0]; score: number}) => ({
          id: x.item.id,
          label: x.item.productName,
          brand: x.item.brand,
          category: x.item.category,
          variants: x.item.variants as string[],
          aliases: x.item.aliases as string[],
          isSachet: x.item.isSachet,
          typicalUnit: x.item.typicalUnit,
        }));
      return { hints: scored };
    }),

  // Add a custom product to the taxonomy (tenant-specific)
  addCustom: protectedProcedure
    .input(z.object({
      category: z.string().min(1),
      subcategory: z.string().optional(),
      brand: z.string().min(1),
      productName: z.string().min(1),
      variants: z.array(z.string()).default([]),
      aliases: z.array(z.string()).default([]),
      isSachet: z.boolean().default(false),
      typicalUnit: z.string().default("unit"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const [inserted] = await db.insert(productTaxonomy).values({
        ...input,
        isCustom: true,
        isLocal: true,
        tenantId,
      }).returning();
      return { item: inserted };
    }),

  // Seed the taxonomy with Nigerian FMCG data (idempotent — skips if already seeded)
  seed: protectedProcedure.mutation(async () => {
    const db = (await getDb())!;
    const existing = await db.select({ id: productTaxonomy.id }).from(productTaxonomy).limit(1);
    if (existing.length > 0) return { seeded: 0, message: "Already seeded" };
    const rows = NIGERIAN_FMCG_SEED.map(item => ({
      category: item.category,
      subcategory: item.subcategory ?? null,
      brand: item.brand,
      productName: item.productName,
      variants: item.variants,
      aliases: item.aliases,
      isLocal: item.isLocal,
      isSachet: item.isSachet,
      typicalUnit: item.typicalUnit,
      isCustom: false,
      isActive: true,
    }));
    await db.insert(productTaxonomy).values(rows);
    return { seeded: rows.length, message: `Seeded ${rows.length} Nigerian FMCG products` };
  }),

  // Stats
  stats: publicProcedure.query(async () => {
    const db = (await getDb())!;
    const items = await db.select().from(productTaxonomy);
    const cats = new Set(items.map((i: typeof items[0]) => i.category));
    const brands = new Set(items.map((i: typeof items[0]) => i.brand));
    return {
      total: items.length,
      categories: cats.size,
      brands: brands.size,
      local: items.filter((i: typeof items[0]) => i.isLocal).length,
      sachet: items.filter((i: typeof items[0]) => i.isSachet).length,
      custom: items.filter((i: typeof items[0]) => i.isCustom).length,
    };
  }),
});
