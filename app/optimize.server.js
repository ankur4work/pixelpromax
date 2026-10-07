// Image-optimization pipeline (server only).
//
// Shared by both the interactive optimizer route AND the background
// products/create webhook. Everything here runs server-side (uses sharp + node
// DNS).
//
// optimizeBatch processes ONE batch of a product's images per call and persists
// per-image + summary metafields. Callers loop it until { done: true }. It also
// enforces the per-shop monthly image quota: pass { shop, remainingQuota } and it
// caps the batch, meters usage, and reports { quotaExceeded } when the cap is hit
// with images still pending.
//
// METAFIELD NAMESPACE: the per-image records and the summary live under
// "image_optimization", and that string is deliberately unchanged from previous
// builds of this app. It is the contract between this writer and three readers
// (catalog.server.js, app.imageoptimizationdashboard.jsx,
// app.pagespeedimpactreports.jsx); renaming it would also discard the
// optimization history of any store that ran an earlier version, making
// already-optimized products look untouched and re-billing the merchant to
// recompress them.
import sharp from "sharp";
import { setDefaultResultOrder } from "node:dns";
import { randomBytes } from "node:crypto";
import { incrementUsage, reserveImages, refundImages } from "./usage.server";
import { entitled } from "./plans.server";
import db from "./db.server";

/* -------------------------------------------------------------------------- */
/*  Encoder tuning                                                            */
/* -------------------------------------------------------------------------- */

const num = (v, dflt, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

// Measured on real Shopify product photos (see the notes below each value).
// All overridable by env so the compression/quality balance can be retuned on
// the running container without a code change.
//
// QUALITY: quality is the lever that actually moves output size; `effort` is
// nearly free to skip. On already-compressed merchant JPEGs, dropping q80 -> q76
// produced 12.6% smaller files for the SAME encode time, while raising effort
// 4 -> 6 bought only 3.1% for 20% more CPU. WebP q76 with smartSubsample is
// visually indistinguishable from q80 on product photography.
const QUALITY = num(process.env.WEBP_QUALITY, 76, 40, 95);
const EFFORT = num(process.env.WEBP_EFFORT, 5, 0, 6);

// Fallback quality for sources that are ALREADY efficiently encoded. These are
// the images that make an optimizer look broken: a pre-optimised JPEG or a WebP
// the merchant uploaded themselves only gives up ~3-10% at q76, because there is
// very little redundancy left to remove. A single lower-quality pass roughly
// doubles the saving (measured 26% -> 45% on pre-compressed JPEGs).
const RETRY_QUALITY = num(process.env.WEBP_RETRY_QUALITY, 66, 40, 95);

// If the first pass saved less than this fraction, spend one more encode trying
// the lower quality. Only poorly-compressing images pay the extra CPU.
const RETRY_BELOW_GAIN = num(process.env.WEBP_RETRY_BELOW, 20, 0, 90) / 100;

// Longest edge. Matches what storefront themes actually render at 2x; images
// already smaller than this are never enlarged.
const MAX_DIM = num(process.env.MAX_IMAGE_DIM, 2048, 512, 5000);

// Below this saving the image is left alone: re-encoding it would burn a quota
// credit, replace the merchant's file and generate a new CDN url, all to shave
// a couple of kilobytes.
const MIN_WORTHWHILE_GAIN = num(process.env.MIN_GAIN_PERCENT, 2, 0, 50) / 100;

// libvips spawns one thread per core by default, and optimizeBatch already runs
// BATCH_CONCURRENCY images at once — on a small container the two multiply into
// thread thrashing. Cap libvips so our own concurrency is the only dial, and
// keep the pixel cache tiny since every buffer here is used exactly once.
sharp.concurrency(num(process.env.SHARP_CONCURRENCY, 2, 1, 16));
sharp.cache({ memory: 64, files: 0, items: 50 });

/* -------------------------------------------------------------------------- */
/*  Networking helpers                                                        */
/* -------------------------------------------------------------------------- */

// The container hangs ~10s per image on IPv6 connect attempts to the Shopify
// CDN (ConnectTimeoutError to 2620:127:f00e::). Prefer IPv4 so fetch connects
// to the reachable address first, and cap every CDN request with an explicit
// timeout so a single bad fetch can never stall the loader or a batch.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder("ipv4first"); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

export async function timedFetch(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run async `fn` over `items` with at most `limit` in flight at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cheaply measure an image's size in bytes via a HEAD request (no body download).
export async function headSizeBytes(url) {
  try {
    const res = await timedFetch(url, { method: "HEAD" }, 8000);
    if (!res.ok) return 0;
    const cl = res.headers.get("content-length");
    return cl ? parseInt(cl, 10) : 0;
  } catch {
    return 0;
  }
}

// Cheaply measure an image's size in MB via a HEAD request (no body download).
export async function headSizeMB(url) {
  return (await headSizeBytes(url)) / (1024 * 1024);
}

// Resolve many image sizes at once, in MB, keyed by url.
//
// This replaces a HEAD request per image on every product-list render. Sizes are
// read from the ImageSize cache first and only the misses go over the network;
// because a Shopify CDN url changes whenever its bytes change, a hit is always
// correct. The cache write is best-effort — if the table isn't migrated yet the
// whole thing silently degrades to the old measure-everything behaviour.
export async function measureSizesMB(urls, concurrency = 40) {
  const unique = [...new Set(urls.filter(Boolean))];
  const bytesByUrl = new Map();
  if (unique.length === 0) return bytesByUrl;

  // Chunked so a large catalog can't build a single enormous IN (...) query.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    try {
      const rows = await db.imageSize.findMany({ where: { url: { in: chunk } } });
      for (const row of rows) bytesByUrl.set(row.url, row.bytes);
    } catch {
      break; // table unavailable — measure everything below
    }
  }

  const missing = unique.filter((u) => !bytesByUrl.has(u));
  if (missing.length > 0) {
    const measured = await mapLimit(missing, concurrency, headSizeBytes);
    const rows = [];
    missing.forEach((url, i) => {
      const bytes = measured[i] || 0;
      bytesByUrl.set(url, bytes);
      if (bytes > 0) rows.push({ url, bytes });
    });
    if (rows.length > 0) {
      try {
        await db.imageSize.createMany({ data: rows, skipDuplicates: true });
      } catch { /* caching is an optimization, never a failure path */ }
    }
  }

  const mbByUrl = new Map();
  for (const [url, bytes] of bytesByUrl) mbByUrl.set(url, bytes / (1024 * 1024));
  return mbByUrl;
}

// Images per batch call. Every batch re-queries the product's media and
// metafields, so a small batch size means paying that query over and over for a
// product with many images.
export const BATCH_SIZE = num(process.env.BATCH_SIZE, 10, 1, 25);
export const BATCH_CONCURRENCY = num(process.env.BATCH_CONCURRENCY, 6, 1, 12);

/* -------------------------------------------------------------------------- */
/*  Per-product media mutation lock                                           */
/* -------------------------------------------------------------------------- */

// Shopify locks a product's media while a mutation on it is in flight, and
// rejects a second concurrent one with "Media cannot be modified at this moment
// because it is currently being modified by another operation". Both the
// per-image API (optimizeOneImage, up to IMAGE_CONCURRENCY at once) and the
// batch path (optimizeBatch, up to BATCH_CONCURRENCY at once) run several images
// of the SAME product in parallel, so their productCreateMedia /
// productDeleteMedia calls collided — images failed mid-run and only succeeded
// on a re-click.
//
// The expensive work (download + WebP encode) must stay parallel; only the
// media MUTATION needs to be serialized, and only against other mutations on the
// same product. This is a per-productId promise chain: a mutation waits for the
// previous one on that product to finish, then runs. A single long-running Node
// instance (the Coolify deployment) shares one module scope, so this in-process
// lock covers every concurrent request. It is advisory only — a second instance
// would not see it — but the batch/per-image concurrency that causes the clash
// originates here, in one process, so that is exactly where the lock belongs.
const productMediaChains = new Map(); // productId -> Promise (tail of the chain)

function withProductMediaLock(productId, task) {
  const prev = productMediaChains.get(productId) || Promise.resolve();
  // Run `task` after the previous holder settles, whether it resolved or threw —
  // one image's failure must not wedge the rest of the product's queue.
  const run = prev.then(task, task);
  // The stored tail swallows errors so the chain never rejects; callers still
  // see the real result/rejection through `run`.
  const tail = run.then(() => {}, () => {});
  productMediaChains.set(productId, tail);
  // Drop the map entry once this product's queue drains, so the Map can't grow
  // without bound across a large catalog — but only if no newer mutation has
  // already replaced the tail.
  tail.finally(() => {
    if (productMediaChains.get(productId) === tail) productMediaChains.delete(productId);
  });
  return run;
}

/* -------------------------------------------------------------------------- */
/*  Optimization primitives                                                   */
/* -------------------------------------------------------------------------- */

// One WebP encode at a given quality.
function encode(buffer, quality) {
  return sharp(buffer)
    .rotate() // honor EXIF orientation before stripping metadata
    .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
    // smartSubsample keeps chroma detail (coloured text, fabric edges) that
    // plain 4:2:0 smears, which is what lets the lower quality below stay
    // invisible on product photography.
    .webp({ quality, effort: EFFORT, smartSubsample: true })
    .toBuffer();
}

// Encode to the smallest WebP that still looks right.
//
// A single fixed quality is what makes an optimizer report single-digit savings:
// a source that is ALREADY well compressed (a pre-optimised JPEG, or a WebP the
// merchant uploaded) has little redundancy left, so q76 barely dents it. When
// that happens we spend one more encode at a lower quality, which roughly
// doubles the saving on exactly those images and costs nothing on the images
// that compressed well the first time.
async function encodeBest(originalBuffer) {
  const first = await encode(originalBuffer, QUALITY);
  const gain = 1 - first.byteLength / originalBuffer.byteLength;
  if (gain >= RETRY_BELOW_GAIN) return first;

  const second = await encode(originalBuffer, RETRY_QUALITY);
  return second.byteLength < first.byteLength ? second : first;
}

// Download + compress one image with Sharp. Always re-encodes to WebP, which
// reliably beats JPEG/PNG. Retries the download once to ride out transient CDN
// blips.
export async function optimizeImage(imageUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await timedFetch(imageUrl, {}, 25000);
      if (!response.ok) throw new Error(`Fetch image HTTP ${response.status}`);
      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

      const optimizedBuffer = await encodeBest(originalBuffer);

      const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);
      return {
        originalSizeMB,
        optimizedSizeMB,
        optimizedBuffer,
        compressionRate: originalSizeMB > 0
          ? Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
          : 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Turn a product title into something safe to use as a filename.
//
// NFKD splits accented characters into base + combining mark so the mark can be
// dropped ("Café" -> "cafe") instead of the whole character being lost. Anything
// outside [a-z0-9] then collapses to a hyphen, which is what keeps apostrophes,
// ampersands, slashes and emoji out of a name that Shopify's staged upload has
// to accept.
//
// Returns "" for a title with no Latin characters at all — Devanagari, Arabic
// and CJK titles slugify to nothing, and the caller must fall back rather than
// upload a file called ".webp".
function slugifyTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

// A unique, short suffix. Filenames must stay unique: optimizeBatch replaces up
// to BATCH_CONCURRENCY images at once, so several uploads for the same product
// are in flight together and a bare slug would have them all competing for one
// name.
//
// The randomness has to carry this, not the timestamp. Concurrent uploads land
// in the same millisecond, so Date.now() is effectively a constant across a
// batch — pairing it with only 1296 random variants produced 306 duplicates in
// 2000 names. randomBytes gives 16.7M per millisecond, which keeps a batch
// comfortably clear of a birthday collision.
function uniqueSuffix() {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

// SEO filename for an optimized image: "blue-cotton-shirt-m1k2p3x9.webp".
// Falls back to the generic name when the title yields no usable slug.
export function seoFilename(productTitle, ext) {
  const slug = slugifyTitle(productTitle);
  return `${slug || "pixelpro"}-${uniqueSuffix()}.${ext}`;
}

export async function uploadAndReplaceImage(admin, productId, originalMediaId, optimizedBuffer, altText, opts = {}) {
  const { productTitle = "", seoNames = false } = opts;
  const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
  const mimeType = isWebP ? "image/webp" : "image/jpeg";
  const ext = isWebP ? "webp" : "jpg";
  // SEO filenames are a paid entitlement; without it the generic name is kept.
  const filename = seoNames
    ? seoFilename(productTitle, ext)
    : `pixelpro-${Date.now()}.${ext}`;

  const stagedRes = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "IMAGE",
          fileSize: String(optimizedBuffer.byteLength),
        }],
      },
    }
  );
  const stagedData = await stagedRes.json();
  if (stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(stagedData.data.stagedUploadsCreate.userErrors[0].message);
  }
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Failed to create staged upload target");

  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([optimizedBuffer], { type: mimeType }), filename);
  const uploadRes = await timedFetch(target.url, { method: "POST", body: form }, 40000);
  if (!uploadRes.ok) throw new Error(`Staged upload HTTP ${uploadRes.status}`);

  // Everything above (staged upload) targets a storage bucket, not the product,
  // so it runs in parallel across a product's images. The two mutations below DO
  // touch the product's media and Shopify serializes them itself — so we queue
  // them per product rather than letting Shopify reject the concurrent ones.
  return withProductMediaLock(productId, async () => {
    const mediaRes = await admin.graphql(
      `#graphql
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id } }
            mediaUserErrors { field message }
          }
        }`,
      {
        variables: {
          productId,
          media: [{ alt: altText, mediaContentType: "IMAGE", originalSource: target.resourceUrl }],
        },
      }
    );
    const mediaData = await mediaRes.json();
    if (mediaData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
      throw new Error(mediaData.data.productCreateMedia.mediaUserErrors[0].message);
    }
    const newMedia = mediaData.data?.productCreateMedia?.media?.[0];
    if (!newMedia) throw new Error("Failed to attach media to product");

    await admin.graphql(
      `#graphql
        mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
          }
        }`,
      { variables: { productId, mediaIds: [originalMediaId] } }
    );

    return newMedia.id;
  });
}

// Alt text is generated with OpenAI only (gpt-4o-mini vision). There is
// deliberately no second provider and no provider switch: one vision API is one
// thing to fund, hold a key for, and disclose in the App Store listing.
//
// Width of the image variant handed to the vision model.
//
// OpenAI prices vision by how much image it has to ingest, and a
// full-resolution Shopify product photo is expensive: one measured at 14,245
// tokens for a single caption, roughly $0.0022 an image, which at the Growth
// quota of 15,000 images is about $33/month against a $49 plan.
//
// Shopify's CDN resizes on request, so asking for a 512px variant cuts the
// token count several times over while leaving more than enough detail for the
// colour / material / style questions the prompt asks. 512 is deliberately not
// smaller: below roughly 400px the model starts guessing at fabric and pattern
// instead of reading them.
const VISION_WIDTH = num(process.env.VISION_IMAGE_WIDTH, 512, 128, 2048);

// Rewrite a Shopify CDN url to a narrower variant, for the vision call ONLY.
//
// This must never be used for the download in optimizeImage(): that one needs
// the original bytes, because it is the thing being compressed and replaced.
// Shrinking the source there would silently degrade every merchant image.
export function visionUrl(imageUrl, width = VISION_WIDTH) {
  try {
    const u = new URL(imageUrl);
    const shopifyCdn =
      u.hostname === "cdn.shopify.com" ||
      u.hostname.endsWith(".shopify.com") ||
      u.hostname.endsWith(".shopifycdn.net");
    // A non-Shopify host has no documented resize parameter; sending the url
    // untouched costs more but still works, which beats a broken request.
    if (!shopifyCdn) return imageUrl;
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return imageUrl; // unparseable url — hand it over as-is
  }
}

const ALT_PROMPT = (productTitle) =>
  `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Describe what you actually see. Keep under 125 characters. Don't use "image of". Return only the alt text.`;

function tidyAlt(raw, productTitle) {
  let altText = (raw || "").trim().replace(/^["']|["']$/g, "").replace(/\n/g, " ");
  if (altText.length > 125) altText = altText.substring(0, 122) + "...";
  return altText || `${productTitle} - product image`;
}

async function altTextOpenAI(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  // OpenAI vision fetches the image URL itself, so no base64 download needed.
  const response = await timedFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0.4,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: ALT_PROMPT(productTitle) },
          { type: "image_url", image_url: { url: visionUrl(imageUrl) } },
        ],
      }],
    }),
  }, 25000);
  if (!response.ok) {
    // The body carries the only useful diagnosis. An exhausted account returns
    // 429 insufficient_quota while the key still authenticates fine, so a bare
    // status code reads as a rate limit that will pass on its own — and it
    // never does.
    throw new Error(`OpenAI API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const result = await response.json();
  return tidyAlt(result.choices?.[0]?.message?.content, productTitle);
}

export async function generateAIAltText(imageUrl, productTitle) {
  try {
    return await altTextOpenAI(imageUrl, productTitle);
  } catch (error) {
    // Never fail the optimization over alt text — the image is still worth
    // compressing. The generic caption is the signal that generation failed.
    console.error("[ALT] OpenAI generation failed:", error?.message || error);
    return `${productTitle} - product image`;
  }
}

// Recompute product totals from the parsed per-image metafield records and
// persist the optimization_summary metafield.
export async function writeSummary(admin, productId, totalImages, records) {
  const processed = records.length;
  const totalOriginalSizeMB = records.reduce((s, r) => s + (r.originalSizeMB || 0), 0);
  const totalOptimizedSizeMB = records.reduce((s, r) => s + (r.optimizedSizeMB ?? r.originalSizeMB ?? 0), 0);
  const totalSizeSavedMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const compressed = records.filter(r => r.status === "optimized");
  const avgCompressionRate = compressed.length > 0
    ? Math.round(compressed.reduce((s, r) => s + (r.compressionRate || 0), 0) / compressed.length)
    : 0;

  await admin.graphql(
    `#graphql
      mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key: "optimization_summary",
          type: "json",
          value: JSON.stringify({
            totalImages,
            optimizedImages: processed,
            totalOriginalSizeMB,
            totalOptimizedSizeMB,
            totalSizeSavedMB,
            avgCompressionRate,
            lastOptimizedAt: new Date().toISOString(),
          }),
        }],
      },
    }
  );

  return { processed, totalOriginalSizeMB, totalOptimizedSizeMB, totalSizeSavedMB, avgCompressionRate };
}

/* -------------------------------------------------------------------------- */
/*  Batch — processes ONE batch per call, returns live progress               */
/* -------------------------------------------------------------------------- */

// opts:
//   shop           — when set, optimized images are metered via incrementUsage
//   remainingQuota — max images this call may optimize (default: unlimited).
//                    When 0 with images still pending, returns { quotaExceeded }.
//   genAlt         — generate AI alt text for images missing it (default true).
//                    Pass false for plans without the alt-text entitlement (Free).
export async function optimizeBatch(admin, productId, opts = {}) {
  const { shop = null, remainingQuota = Infinity, genAlt = true, seoNames = false } = opts;

  // Query current media (MediaImage gids) + existing optimization metafields.
  const response = await admin.graphql(
    `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { ... on MediaImage { id image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Parse existing per-image records and the set of already-processed media ids.
  const records = [];
  const doneIds = new Set();
  for (const e of product.metafields.edges) {
    if (!e.node.key.startsWith("image_")) continue;
    try {
      const rec = JSON.parse(e.node.value);
      records.push(rec);
      doneIds.add(e.node.key.slice("image_".length));
    } catch { /* ignore malformed */ }
  }

  if (total === 0) {
    return { success: true, productId, total: 0, optimized: 0, remaining: 0, advanced: false, done: true,
      score: 0, sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "No images to optimize" };
  }

  const pending = images.filter(img => !doneIds.has(img.id.split("/").pop()));

  // Quota exhausted but images still need work — stop and signal the caller.
  if (pending.length > 0 && remainingQuota <= 0) {
    const processedNow = Math.min(records.length, total);
    return {
      success: true, productId, title: product.title, total,
      optimized: processedNow, remaining: total - processedNow,
      advanced: false, done: false, quotaExceeded: true,
      score: total > 0 ? Math.round((processedNow / total) * 100) : 0,
      sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "Monthly image quota reached",
    };
  }

  // Cap the batch to both the per-call batch size and the remaining quota.
  const cap = Math.max(0, Math.min(BATCH_SIZE, remainingQuota));
  const batch = pending.slice(0, cap);

  // Process this batch in parallel. Each result is a per-image metafield record.
  const newRecords = (await mapLimit(batch, BATCH_CONCURRENCY, async (image) => {
    try {
      const opt = await optimizeImage(image.url);

      // Not worth replacing: re-encoding an already-tiny image can grow it, and
      // a saving of a couple of kilobytes isn't worth burning a quota credit,
      // swapping the merchant's file and invalidating its CDN url. Mark as
      // processed so it isn't retried on the next run.
      const gain = opt.originalSizeMB > 0
        ? (opt.originalSizeMB - opt.optimizedSizeMB) / opt.originalSizeMB
        : 0;
      if (gain < MIN_WORTHWHILE_GAIN) {
        const key = `image_${image.id.split("/").pop()}`;
        return {
          key,
          record: { status: "skipped", originalSizeMB: opt.originalSizeMB, optimizedSizeMB: opt.originalSizeMB, compressionRate: 0, optimizedAt: new Date().toISOString() },
        };
      }

      // Auto alt text is a Starter+ feature; Free plans (genAlt=false) keep the
      // image's existing alt and skip AI generation.
      let altText = image.altText;
      if (genAlt && (!altText || altText.length < 10)) {
        altText = await generateAIAltText(image.url, product.title);
      }

      const newId = await uploadAndReplaceImage(
        admin, productId, image.id, opt.optimizedBuffer, altText,
        { productTitle: product.title, seoNames }
      );
      const key = `image_${newId.split("/").pop()}`;
      return {
        key,
        record: {
          status: "optimized",
          originalSizeMB: opt.originalSizeMB,
          optimizedSizeMB: opt.optimizedSizeMB,
          compressionRate: opt.compressionRate,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
      console.error(`[OPTIMIZE] ${image.id}:`, detail);
      return null; // failure — leave pending, don't write a metafield
    }
  })).filter(Boolean);

  // Persist the per-image metafields written this batch (up to 25 per call).
  if (newRecords.length > 0) {
    await admin.graphql(
      `#graphql
        mutation CreateMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        variables: {
          metafields: newRecords.map(r => ({
            ownerId: productId,
            namespace: "image_optimization",
            key: r.key,
            type: "json",
            value: JSON.stringify(r.record),
          })),
        },
      }
    );
  }

  // Meter only images that were actually re-encoded (not skipped) against quota.
  const optimizedCount = newRecords.filter(r => r.record.status === "optimized").length;
  if (shop && optimizedCount > 0) {
    try { await incrementUsage(shop, optimizedCount); }
    catch (e) { console.error("[USAGE] increment failed:", e?.message || e); }
  }

  const allRecords = [...records, ...newRecords.map(r => r.record)];
  const totals = await writeSummary(admin, productId, total, allRecords);

  const processed = Math.min(totals.processed, total);
  const remaining = total - processed;
  const advanced = newRecords.length > 0;
  // We hit the quota cap (not the batch-size cap) yet images still remain.
  const quotaExceeded = remaining > 0 && cap < BATCH_SIZE;

  return {
    success: true,
    productId,
    title: product.title,
    total,
    optimized: processed,
    remaining,
    advanced,
    done: remaining === 0,
    quotaExceeded,
    score: total > 0 ? Math.round((processed / total) * 100) : 0,
    sizeSavedMB: totals.totalSizeSavedMB,
    originalSizeMB: totals.totalOriginalSizeMB,
    optimizedSizeMB: totals.totalOptimizedSizeMB,
    compressionRate: totals.totalOriginalSizeMB > 0
      ? Math.round((totals.totalSizeSavedMB / totals.totalOriginalSizeMB) * 100)
      : 0,
    batchFailures: batch.length - newRecords.length,
    message: remaining === 0
      ? `Optimized "${product.title}" — ${processed}/${total} images`
      : `Optimizing "${product.title}" — ${processed}/${total} images`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Per-image — one image per call, so the browser can show real progress     */
/* -------------------------------------------------------------------------- */

// optimizeBatch above does up to BATCH_SIZE images per call, which means a
// product with fewer images than that is a SINGLE request: the page could only
// jump from 0/8 to 8/8 with nothing in between. These three functions move the
// unit of work down to one image, so every response is a progress event and the
// browser decides how many run at once.
//
//   listProductImages  -> what to work through, in the merchant's order
//   optimizeOneImage   -> one image, replaced, recorded and metered
//   finalizeProduct    -> rewrite the summary, restore the image order

const imageKey = (mediaId) => `image_${String(mediaId).split("/").pop()}`;

// Parse the per-image records on a product, keyed by short media id.
function parseRecords(product) {
  const byShortId = {};
  for (const edge of product?.metafields?.edges || []) {
    const key = edge.node.key;
    if (!key.startsWith("image_")) continue;
    try {
      byShortId[key.slice("image_".length)] = JSON.parse(edge.node.value);
    } catch { /* a malformed record just means no history */ }
  }
  return byShortId;
}

// The images on a product, in order, each flagged with whether it already has
// an optimization record. Keeping the `done` flag preserves the resumable
// behaviour optimizeBatch had: a re-run skips what is already processed.
export async function listProductImages(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query ProductImagesForRun($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { ... on MediaImage { id image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return null;

  const records = parseRecords(product);
  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({
      id: n.id,
      url: n.image.url,
      altText: n.image.altText || "",
      done: !!records[n.id.split("/").pop()],
    }));

  return { id: product.id, title: product.title, images };
}

// Optimize exactly one image and replace it on the product.
//
// Returns a result object rather than throwing, so one bad image never takes
// down the rest of a run.
export async function optimizeOneImage({ admin, productId, imageId, shop, plan, genAlt = true }) {
  // One query for everything this image needs. The URL and alt text come from
  // Shopify, never from the browser, and the previous record carries the TRUE
  // original size forward so re-optimizing does not report ~0 saving.
  const key = imageKey(imageId);
  const response = await admin.graphql(
    `#graphql
      query OneImageContext($imageId: ID!, $productId: ID!, $key: String!) {
        node(id: $imageId) {
          ... on MediaImage { id image { url altText } }
        }
        product(id: $productId) {
          id
          title
          metafield(namespace: "image_optimization", key: $key) { value }
        }
      }`,
    { variables: { imageId, productId, key } }
  );
  const data = await response.json();
  const node = data.data?.node;
  const product = data.data?.product;

  if (!node?.image?.url || !product) {
    return { success: false, imageId, error: "That image is no longer on the product." };
  }

  const imageUrl = node.image.url;
  const currentAlt = node.image.altText || "";

  let previousOriginalMB = 0;
  if (product.metafield?.value) {
    try {
      previousOriginalMB = Number(JSON.parse(product.metafield.value).originalSizeMB) || 0;
    } catch { /* unreadable record - nothing to carry forward */ }
  }

  const reserved = await reserveImages(shop, plan, 1);
  if (!reserved.allowed) {
    return {
      success: false,
      imageId,
      // Flagged so the browser stops the run instead of asking for every
      // remaining image and collecting the same refusal each time.
      quotaExceeded: true,
      error: "Monthly image quota reached.",
    };
  }

  let spent = false;

  try {
    const opt = await optimizeImage(imageUrl);
    const trueOriginalMB = Math.max(previousOriginalMB, opt.originalSizeMB);

    // Not worth replacing: re-encoding an already-tiny image can grow it, and a
    // couple of kilobytes is not worth burning a credit, swapping the merchant
    // file and invalidating its CDN url. Recorded so it is not retried.
    const gain = opt.originalSizeMB > 0
      ? (opt.originalSizeMB - opt.optimizedSizeMB) / opt.originalSizeMB
      : 0;

    if (gain < MIN_WORTHWHILE_GAIN) {
      await writeImageRecord(admin, productId, key, {
        status: "skipped",
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: opt.originalSizeMB,
        compressionRate: 0,
        optimizedAt: new Date().toISOString(),
      });
      return {
        success: true,
        imageId,
        newImageId: imageId,
        skipped: true,
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: opt.originalSizeMB,
        compressionRate: 0,
      };
    }

    // Auto alt text is a paid entitlement; genAlt=false keeps the existing alt.
    let altText = currentAlt;
    if (genAlt && (!altText || altText.length < 10)) {
      altText = await generateAIAltText(imageUrl, product.title);
    }

    const newImageId = await uploadAndReplaceImage(
      admin, productId, imageId, opt.optimizedBuffer, altText,
      { productTitle: product.title, seoNames: entitled(plan, "filenameSeo") }
    );

    // The optimized copy is attached, so the credit is genuinely spent from here
    // even if the bookkeeping below misbehaves.
    spent = true;

    const compressionRate = trueOriginalMB > 0
      ? Math.round(((trueOriginalMB - opt.optimizedSizeMB) / trueOriginalMB) * 100)
      : opt.compressionRate;

    await writeImageRecord(admin, productId, imageKey(newImageId), {
      status: "optimized",
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: opt.optimizedSizeMB,
      compressionRate,
      altText,
      optimizedAt: new Date().toISOString(),
      originalImageId: imageId,
      newImageId,
    });

    return {
      success: true,
      imageId,
      newImageId,
      skipped: false,
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: opt.optimizedSizeMB,
      savedMB: Math.max(trueOriginalMB - opt.optimizedSizeMB, 0),
      compressionRate,
      altText,
    };
  } catch (err) {
    const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
    console.error(`[OPTIMIZE] ${imageId}:`, detail);
    return { success: false, imageId, error: detail };
  } finally {
    // Nothing replaced means nothing consumed - a skipped or failed image is
    // free, which is what keeps re-running the optimizer safe.
    if (!spent) await refundImages(shop, 1);
  }
}

async function writeImageRecord(admin, productId, key, record) {
  await admin.graphql(
    `#graphql
      mutation SetImageRecord($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key,
          type: "json",
          value: JSON.stringify(record),
        }],
      },
    }
  );
}

// Close out a product: rewrite the summary from what is actually on it now, and
// put the image order back.
//
// The order matters. Replacing an image appends the copy at the end and deletes
// the original, and several of those run at once - so images finish in arbitrary
// order and the merchant sequence (and featured image) would get shuffled.
// `desiredOrder` is the order before the run.
export async function finalizeProduct(admin, productId, desiredOrder = []) {
  const response = await admin.graphql(
    `#graphql
      query ProductRunState($id: ID!) {
        product(id: $id) {
          id
          media(first: 250) {
            edges { node { ... on MediaImage { id } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return null;

  const currentIds = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.id)
    .map(n => n.id);

  // Only records for an image STILL on the product count. Records left behind by
  // replaced images would otherwise be counted again, inflating both the
  // processed count and the reported savings.
  const records = parseRecords(product);
  const live = currentIds
    .map(id => records[id.split("/").pop()])
    .filter(Boolean);

  const totals = await writeSummary(admin, productId, currentIds.length, live);

  // Unknown ids make the mutation fail outright, so only ids still present are
  // moved, and anything the caller did not mention is appended rather than lost.
  const wanted = desiredOrder.filter(id => currentIds.includes(id));
  const ordered = [...wanted, ...currentIds.filter(id => !wanted.includes(id))];
  const changed = ordered.some((id, i) => id !== currentIds[i]);

  if (changed && ordered.length > 1) {
    try {
      await admin.graphql(
        `#graphql
          mutation ReorderMedia($id: ID!, $moves: [MoveInput!]!) {
            productReorderMedia(id: $id, moves: $moves) {
              job { id }
              mediaUserErrors { field message }
            }
          }`,
        {
          variables: {
            id: productId,
            moves: ordered.map((id, i) => ({ id, newPosition: String(i) })),
          },
        }
      );
    } catch (err) {
      // Cosmetic. A failed reorder must not fail a successful optimization.
      console.error("[OPTIMIZE] reorder failed (non-fatal):", err?.message || err);
    }
  }

  return { ...totals, totalImages: currentIds.length };
}
