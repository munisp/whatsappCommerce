/**
 * Sample products for template previews only. Client-side, never written to any tenant's data, and the
 * preview says plainly that they are samples.
 */
import type { DemoKey } from "./templates";

export interface DemoProduct {
  id: string; name: string; description: string; category: string; price: string; compareAtPrice: string | null;
  imageUrl: string; images: string[]; inStock: boolean; lowStock: boolean; sold: number; isNew: boolean; featured: boolean;
  options: { name: string; values: string[] }[];
}

type Row = [name: string, category: string, price: number, compareAt: number | null, photo: number, options?: Record<string, string[]>];

const SIZES = { Size: ["S", "M", "L", "XL"] };

const ROWS: Record<DemoKey, Row[]> = {
  fashion: [
    ["Ruffle sleeve Ankara set", "Sets", 48000, null, 33939066, SIZES], ["Wax print peplum top", "Tops", 26000, 32000, 34249446, SIZES],
    ["Printed kaftan", "Menswear", 42000, null, 8770938, SIZES], ["Blue wax print gown", "Dresses", 65000, null, 37550056, SIZES],
    ["Column dress, leather finish", "Dresses", 72000, 90000, 19809165, SIZES], ["Long sleeve wrap dress", "Dresses", 54000, null, 36467265, SIZES],
    ["Tube dress in cream print", "Dresses", 31000, null, 7428504, SIZES], ["Tailored black jumpsuit", "Tailoring", 58000, null, 12512197, SIZES],
    ["Denim wide leg set", "Sets", 39000, null, 914667, SIZES],
  ],
  luxury: [
    ["Structured croc-embossed hobo", "Bags", 385000, null, 30975839], ["Quilted chain shoulder bag", "Bags", 310000, null, 20591025],
    ["Ivory flap bag", "Bags", 295000, 340000, 31929486], ["Oxford in black calf", "Shoes", 210000, null, 37465528, { Size: ["41", "42", "43", "44", "45"] }],
    ["Brogue in polished leather", "Shoes", 195000, null, 15557045, { Size: ["41", "42", "43", "44"] }], ["Pair of tote bags", "Bags", 270000, null, 27046143],
    ["Evening trio, three colours", "Bags", 420000, null, 7953286], ["Wingtip in black", "Shoes", 225000, null, 10352336, { Size: ["42", "43", "44"] }],
  ],
  beauty: [
    ["Botanical face oil", "Skincare", 14500, null, 7797734], ["Vitamin glow serum", "Skincare", 18000, 22000, 7797009],
    ["Daily repair cream", "Skincare", 12500, null, 4735904], ["Satin lipstick duo", "Makeup", 9500, null, 30408335, { Shade: ["Nude", "Rose", "Berry"] }],
    ["Barrier cleanser", "Skincare", 8800, null, 7691161], ["Cheek and lip set", "Makeup", 16500, 19000, 4938508],
    ["Twelve-pan eye palette", "Makeup", 11000, null, 1327689], ["Clarifying tonic", "Skincare", 7600, null, 6167866], ["Overnight mask", "Skincare", 15000, null, 8100816],
  ],
  tech: [
    ["Studio over-ear headphones", "Audio", 89000, 115000, 15487609], ["Light-ring gaming headset", "Audio", 72000, null, 11398246],
    ["Pro wireless earbuds", "Audio", 45000, 58000, 18573074], ["Leather-band headphones", "Audio", 68000, null, 4721569],
    ["Dual-camera phone", "Phones", 410000, null, 33632627, { Storage: ["128GB", "256GB"] }], ["Colour-case phone pair", "Phones", 365000, 399000, 12359130],
    ["Fast-charge power bank", "Accessories", 24000, 29000, 5208777], ["Charger and cable kit", "Accessories", 12500, null, 5208307],
    ["Desk setup bundle", "Computing", 520000, null, 17689342], ["VR gaming kit", "Gaming", 240000, null, 5208874],
  ],
  grocery: [
    ["Vegetable box", "Fresh produce", 9500, 11500, 33624058], ["Mixed market basket", "Fresh produce", 14000, null, 17302468],
    ["Leafy greens bunch", "Fresh produce", 1800, null, 8805170], ["Salad greens basket", "Fresh produce", 2600, 3200, 8422681],
    ["Bread and vegetables pack", "Bakery", 6400, null, 7879896], ["Sweet peppers, 1kg", "Fresh produce", 3200, null, 7129143],
    ["Bananas, per bunch", "Fruit", 2400, null, 8476592], ["Weekly staples box", "Household", 32000, 36000, 36764001], ["Fruit and veg mix", "Fruit", 8500, null, 17302468],
    ["Herb bundle", "Fresh produce", 1200, null, 8805170], ["Green salad pack", "Fresh produce", 2100, null, 8422681], ["Family veg box", "Fresh produce", 17000, 19500, 33624058],
  ],
  food: [
    ["Jollof rice with grilled chicken and fish", "Mains", 7500, null, 13915043], ["Party jollof with plantain", "Mains", 5500, null, 17952746],
    ["Ofe with pounded yam", "Soups", 6500, null, 37648018], ["Jollof trio for sharing", "Platters", 18000, 21000, 33434010],
    ["Akara and pap breakfast box", "Breakfast", 3500, null, 37624176], ["Spiced grilled lamb and flatbread", "Grills", 9500, null, 28160385],
    ["Sides: plantain and skewers", "Sides", 4000, null, 36458103], ["Peppered chicken", "Grills", 5000, null, 6210449], ["Fried rice with boiled egg", "Mains", 4800, null, 18805640],
  ],
  home: [
    ["Green velvet three-seater", "Living room", 780000, 860000, 5551824], ["Oak frame armchair", "Living room", 240000, null, 5490341],
    ["Yellow accent chair", "Living room", 165000, null, 3965520], ["Tan leather sofa", "Living room", 920000, null, 6480707],
    ["Curved cream daybed", "Bedroom", 540000, null, 8987432], ["Grey corner sectional", "Living room", 1150000, 1290000, 6588592],
    ["Teal lounge set", "Living room", 880000, null, 4846450], ["Low sideboard", "Dining", 310000, null, 12277201], ["Rustic den sofa", "Study", 610000, null, 7539830],
  ],
  jewelry: [
    ["Layered gold necklaces", "Necklaces", 145000, null, 6604737], ["Hand-chased cuff", "Bracelets", 380000, null, 16853521],
    ["Stacking rings, set of five", "Rings", 210000, 240000, 28933799], ["Woven gold bangle", "Bracelets", 165000, null, 28933800],
    ["Rose gold link bracelet", "Bracelets", 195000, null, 25283496], ["Chandelier earrings", "Earrings", 260000, null, 32989030],
    ["Solitaire ring", "Rings", 520000, null, 2732096], ["Textured band", "Rings", 120000, null, 4943485],
  ],
  lifestyle: [
    ["Yellow track set", "Clothing", 34000, 42000, 2680272, SIZES], ["Washed denim jacket", "Clothing", 29000, null, 7061988, SIZES],
    ["Black hoodie", "Clothing", 22000, null, 8782539, SIZES], ["Studio over-ear headphones", "Tech", 89000, null, 15487609],
    ["Cream two-piece bag set", "Accessories", 41000, 48000, 35666033], ["Ceramic vase trio", "Home", 18000, null, 6805522],
    ["Everyday tote pair", "Accessories", 36000, null, 27046143], ["Fast-charge power bank", "Tech", 24000, 29000, 5208777],
  ],
  digital: [
    ["Small shop bookkeeping template", "Templates", 6500, null, 30234378], ["WhatsApp selling playbook", "Guides", 9500, 12000, 36123568],
    ["Brand starter kit", "Templates", 15000, null, 30234382], ["Pricing masterclass", "Courses", 35000, null, 5998739],
    ["Product photo presets", "Design", 8000, null, 30047570], ["Customer service scripts", "Guides", 5500, null, 8092461],
  ],
  wholesale: [
    ["Carton of assorted provisions (x24)", "Provisions", 42000, null, 30019690], ["Rice, 50kg bag", "Grains", 78000, 82000, 4820731],
    ["Packaging cartons, bundle of 50", "Packaging", 36000, null, 5025503], ["Mixed household carton", "Household", 56000, null, 10834810],
    ["Shipping boxes, pallet", "Packaging", 145000, null, 6169055], ["Bulk stationery boxes", "Office", 68000, 74000, 38195854],
    ["Sealed goods, bale", "Provisions", 112000, null, 29653988],
  ],
  minimal: [
    ["Ribbed vase and candle", "Objects", 28000, null, 8217492], ["Three small jugs", "Objects", 22000, null, 5040767],
    ["Tall white bottle vase", "Objects", 16000, null, 10006407], ["Sculptural ceramic set", "Objects", 54000, null, 6805522],
    ["Autumn ceramics", "Objects", 46000, 52000, 27180805], ["Stone and clay pair", "Objects", 31000, null, 6825578], ["Dried stem still life", "Objects", 19000, null, 11507900],
  ],
};

export function demoProducts(key: DemoKey): DemoProduct[] {
  return ROWS[key].map(([name, category, price, compareAt, photo, options], index) => ({
    id: `demo-${key}-${index}`,
    name,
    description: "A sample product for this preview. Your own products, photos and prices appear here on your store.",
    category,
    price: price.toFixed(2),
    compareAtPrice: compareAt ? compareAt.toFixed(2) : null,
    imageUrl: `/images/store/p${photo}.webp`,
    images: [`/images/store/p${photo}.webp`],
    inStock: index !== 7,
    lowStock: index === 2,
    sold: 100 - index * 7,
    isNew: index % 3 === 0,
    featured: index % 2 === 0,
    options: Object.entries(options ?? {}).map(([name, values]) => ({ name, values })),
  }));
}

export const DEMO_REVIEWS = [
  { rating: 5, text: "Sample review: this is where real reviews from your customers appear.", author: "Sample" },
  { rating: 5, text: "Sample review: only genuine, published reviews ever show on your store.", author: "Sample" },
  { rating: 4, text: "Sample review: this section stays hidden until you have some.", author: "Sample" },
];
