// Client-safe pricing display catalog (marketing copy) for the pricing page and
// the pricing wall. The source of truth for runtime gating/quotas is
// plans.server.js — keep the quotas here in sync with that file and with the
// plans created in the Dev Dashboard.
//
// Note: because this is a Managed Pricing app, every "Choose plan" button sends
// the merchant to Shopify's hosted pricing page where they pick the real plan —
// the per-tier buttons here are purely informational about what they'll get.
//
// EVERY bullet below must name something a merchant on that tier can actually
// do today. Keep this in step with the entitlements in plans.server.js; that
// file is the gate, this one is only the copy.
export const PLAN_TIERS = [
  {
    name: "Free",
    price: 0,
    priceAnnual: 0,
    images: "100",
    tagline: "Try it out",
    features: [
      "100 images / month",
      "WebP conversion & compression",
      "Optimization analytics",
    ],
  },
  {
    name: "Starter",
    price: 19,
    priceAnnual: 190,
    images: "2,000",
    tagline: "For growing stores",
    features: [
      "2,000 images / month",
      "Everything in Free",
      "AI alt text",
      "SEO filenames",
    ],
  },
  {
    name: "Growth",
    price: 49,
    priceAnnual: 490,
    images: "15,000",
    tagline: "Most popular",
    popular: true,
    features: [
      "15,000 images / month",
      "Everything in Starter",
      "Auto-optimize new products",
      "Page Speed reports",
    ],
  },
  {
    name: "Pro",
    price: 499,
    priceAnnual: 2499,
    images: "50,000",
    tagline: "High volume",
    // NOTE: Pro adds no capability over Growth — only quota. At $499/mo against
    // Growth's $49 that is a 10x price for 3.3x the images, which is a hard sell
    // with nothing else in the column. Either build more for this tier, or
    // reprice/reposition it.
    features: [
      "50,000 images / month",
      "Everything in Growth",
    ],
  },
];

// The capability matrix the pricing comparison table renders.
//
// Rows are keyed by the entitlement flags in plans.server.js so the table can
// never claim a tier includes something the gate does not grant. `quota` is the
// one row that is a value rather than a tick.
export const PLAN_MATRIX = [
  { key: "quota", label: "Images per month" },
  { key: "optimize", label: "Compression & replace" },
  { key: "webp", label: "WebP conversion" },
  { key: "altText", label: "AI alt text" },
  { key: "filenameSeo", label: "SEO filenames" },
  { key: "autoOptimize", label: "Auto-optimize new products" },
  { key: "pageSpeed", label: "Page Speed reports" },
];

// Which tiers include which flag — mirrors the `features` objects in
// plans.server.js. Duplicated here rather than imported because that module is
// server-only and this one is bundled into the client.
export const PLAN_MATRIX_VALUES = {
  quota: { Free: "100", Starter: "2,000", Growth: "15,000", Pro: "50,000" },
  optimize: { Free: true, Starter: true, Growth: true, Pro: true },
  webp: { Free: true, Starter: true, Growth: true, Pro: true },
  altText: { Free: false, Starter: true, Growth: true, Pro: true },
  filenameSeo: { Free: false, Starter: true, Growth: true, Pro: true },
  autoOptimize: { Free: false, Starter: false, Growth: true, Pro: true },
  pageSpeed: { Free: false, Starter: false, Growth: true, Pro: true },
};
