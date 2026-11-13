/** Choices offered when a merchant creates or edits a product. */

export const PRODUCT_CURRENCIES = [
  { code: "NGN", label: "Nigerian naira (₦)" },
  { code: "GHS", label: "Ghanaian cedi (GH₵)" },
  { code: "KES", label: "Kenyan shilling (KSh)" },
  { code: "ZAR", label: "South African rand (R)" },
  { code: "XOF", label: "West African CFA franc" },
  { code: "XAF", label: "Central African CFA franc" },
  { code: "EGP", label: "Egyptian pound" },
  { code: "UGX", label: "Ugandan shilling" },
  { code: "TZS", label: "Tanzanian shilling" },
  { code: "RWF", label: "Rwandan franc" },
  { code: "USD", label: "US dollar ($)" },
  { code: "GBP", label: "British pound (£)" },
  { code: "EUR", label: "Euro (€)" },
] as const;

export const DEFAULT_PRODUCT_CURRENCY = "NGN";

/** General retail categories, offered alongside the grocery taxonomy and anything the shop already uses. */
export const PRODUCT_CATEGORIES = [
  "Women's clothing", "Men's clothing", "Children's clothing", "Traditional wear", "Fabrics & textiles", "Shoes", "Bags", "Accessories",
  "Jewellery", "Watches", "Hair & wigs", "Skincare", "Makeup", "Fragrance", "Phones & tablets", "Phone accessories", "Computers",
  "Audio & headphones", "TV & home entertainment", "Gaming", "Cameras", "Home appliances", "Kitchen & dining", "Furniture", "Home decor",
  "Bedding & bath", "Lighting", "Tools & hardware", "Building materials", "Auto parts", "Baby & kids", "Toys", "Books & stationery",
  "Office supplies", "Sports & fitness", "Health & pharmacy", "Fresh produce", "Meat & fish", "Bakery", "Frozen food", "Drinks",
  "Wine & spirits", "Ready meals", "Restaurant food", "Pet supplies", "Garden & outdoor", "Art & crafts", "Party & events", "Gifts",
  "Digital products", "Courses", "Services", "Wholesale lots", "Agricultural produce",
] as const;

export const MAX_PRODUCT_PHOTOS = 8;
