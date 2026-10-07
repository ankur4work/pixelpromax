# PixelPro Max

Shopify embedded admin app: bulk image optimization (WebP + compression), AI alt
text, auto-optimization of new products, page-speed reporting and optimization
analytics.

Rebuild of **ImageBoost SEO** (previously PixelPerfect / OptiPix / ImageGenie)
under a new Shopify app identity, with a new visual design. The functionality
and the pricing model are carried over unchanged.

- **Stack:** React Router 7 · Shopify App React Router v1 · Polaris 13 · Prisma/PostgreSQL · Sharp
- **Hosting:** Docker on Coolify, health check at `/healthz`

---

## ⚠️ Before this app can run

| Value | Status |
|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | ✅ set (PixelPro Max app credentials) |
| `SHOPIFY_APP_URL` / `application_url` | ✅ `https://pixelpromax.onkra.online`, confirmed |
| `client_id` in `shopify.app.toml` | ✅ set |
| `OPENAI_API_KEY` | ✅ set, and verified with a real completion **and** a real vision call against a Shopify CDN URL |
| `DATABASE_URL` | ❌ **still a placeholder.** The app cannot start without it: `PrismaSessionStorage` checks for the `Session` table at boot and the process exits if it can't reach the database |
| `SHOPIFY_APP_HANDLE` | ⚠️ set to the likely value `pixelpro-max`, **not verified.** Confirm against a real install URL — see below |
| `SUPPORT_EMAIL` | ⚠️ unset; `/privacy` falls back to a personal address |

`DATABASE_URL` must point at a **new** Postgres database. Do not reuse
ImageBoost SEO's: its `Session` rows hold access tokens issued to a different
`client_id` and are unusable here.

`GOOGLE_PAGESPEED_API_KEY` is intentionally left empty: ImageBoost SEO never had
one either, and the app is written to work without it. See below.

If you ever run `npm run config:link`, the CLI rewrites `shopify.app.toml` from
the app you pick — **re-add the `[webhooks]` block afterwards**, because the CLI
does not generate the compliance subscription and the mandatory privacy webhooks
would silently end up unregistered.

---

## ⚠️ Launch-critical: plans must be created in the Dev Dashboard

This is a **Shopify Managed Pricing** app. It **cannot** create charges — the
Billing API is blocked for managed-pricing apps, and there is deliberately no
`billing:` config in `app/shopify.server.js`. Plans live in the Dashboard and
merchants subscribe on Shopify's hosted pricing page.

`app/plans.server.js` resolves a subscription to a tier **by exact name**,
stripping a trailing `" Annual"`. These names must match the Dashboard
**byte-for-byte** — a typo silently drops the merchant to Free:

| Plan name | Monthly | Annual | Images/mo | Adds |
|---|---|---|---|---|
| `Free` | $0 | — | 100 | optimize, webp |
| `Starter` / `Starter Annual` | $19 | $190 | 2,000 | altText, filenameSeo |
| `Growth` / `Growth Annual` | $49 | $490 | 15,000 | autoOptimize, pageSpeed |
| `Pro` / `Pro Annual` | $499 | $2,499 | 50,000 | quota only |

**The `Free` plan is mandatory.** `app/routes/app.jsx` gates the entire app on
`hasActivePlan`; with no subscription the merchant sees only the pricing wall.
If no Free plan exists, an App Store reviewer on a development store hits a wall
they cannot get past — an automatic rejection. Development stores also cannot
approve *paid* managed-pricing subscriptions, which is what `DEV_PLAN_OVERRIDE`
exists for.

`app/planCatalog.js` holds the marketing copy and the comparison matrix shown
in-app. Prices are intentionally **not** rendered — they are owned by the
Dashboard and would go stale in code.

---

## Environment

Copy `.env.example` to `.env` for local work; set the same keys in Coolify for
the deployment. Mark them **runtime-only** in Coolify — nothing here is needed
at build time, and flagging them build-time passes the app secret as a Docker
build ARG, where it persists in image history.

| Variable | Required | Purpose |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | App client ID |
| `SHOPIFY_API_SECRET` | yes | App client secret |
| `SHOPIFY_APP_URL` | yes | Public HTTPS origin |
| `SCOPES` | yes | `write_products,write_files` |
| `SHOPIFY_APP_HANDLE` | yes | Path segment in the hosted pricing URL — see below |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `OPENAI_API_KEY` | feature | AI alt text (the only provider). Unset **or unfunded** ⇒ falls back to `"<title> - product image"` |
| `GOOGLE_PAGESPEED_API_KEY` | optional | Raises PageSpeed quota. Unset ⇒ keyless endpoint (low shared daily cap) |
| `SUPPORT_EMAIL` | listing | Contact address on the public `/privacy` page |
| `DEV_PLAN_OVERRIDE` | dev only | Force a tier (`starter`/`growth`/`pro`). **Never set in production** |
| `DEV_PLAN_OVERRIDE_SHOP` | dev only | Scope the override to one shop |

### AI alt text runs on OpenAI only

`gpt-4o-mini` vision, in both `app/optimize.server.js` (during an optimization
run) and `app/routes/app.alttextsuggestions.jsx` (the bulk generator). There is
no second provider by design.

**An unfunded OpenAI key looks identical to a working one.** It still
authenticates — `/v1/models` returns 200 — but every completion returns
`429 insufficient_quota`, so the app appears configured while every image falls
back to its product title. Both call sites include the response body in the
error for this reason; a bare `429` reads as a transient rate limit that will
clear on its own, and it never does. The "Test API key" button on the alt text
page makes a real completion call, not an auth check, for exactly this reason.

Only the full-resolution original is compressed; the **vision** call is sent a
512px CDN variant (`visionUrl()`), which cuts the token cost several times over.
A full-size product photo measured 14,245 tokens for one caption — about $33/mo
of OpenAI spend against a $49 Growth plan.

### `GOOGLE_PAGESPEED_API_KEY` is optional, and a wrong key is worse than none

`runPageSpeedTest` falls back to the keyless PageSpeed Insights endpoint and
retries with backoff. Only 429 and 5xx are retryable — a **403 breaks out
immediately**. So a key that lacks the PageSpeed Insights API (Google returns
`API_KEY_SERVICE_BLOCKED`) turns a degraded-but-working feature into a hard
failure. Enable the PageSpeed Insights API for the key before setting it.

Encoder tuning (`WEBP_QUALITY`, `MAX_IMAGE_DIM`, `BATCH_CONCURRENCY`, …) is
documented inline in `app/optimize.server.js`; all have working defaults.

### `SHOPIFY_APP_HANDLE`

The handle is the path segment in
`admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`. Shopify
derives it from the app name but **appends a numeric suffix on collision** —
previous builds ended up as `optipix-3` and `imageboost-seo-1`. Read the real
value off the Dashboard URL. A wrong handle makes every "Choose plan" CTA 404.

At runtime the app prefers the handle Shopify itself reports
(`currentAppInstallation.app.handle`); this env var is the fallback used when
that query is unavailable — which is exactly when the pricing wall shows, so it
still has to be correct.

---

## Local development

```bash
npm install
cp .env.example .env     # then fill it in
npm run dev              # shopify app dev
```

`npm run build` must pass before deploying. Note `npm run lint` is
non-functional: the ESLint dependencies are present but there is no config file
in the repo (inherited gap).

## Deployment

The Dockerfile runs `npm run setup && npm run start`, where `setup` is
`prisma migrate deploy`.

**`prisma/migrations/0001_init` is the schema.** Regenerate it with:

```bash
prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

Once any database has it applied, add forward migrations instead of editing it.
Do **not** switch container start to `prisma db push --accept-data-loss`: push
reconciles against `schema.prisma` directly and never reads migration history,
which is how the previous app's migrations rotted unnoticed.

### Pushing app config to Shopify

`shopify.app.toml` (URLs, scopes, webhook subscriptions) only takes effect once
deployed to Shopify:

```bash
export SHOPIFY_APP_AUTOMATION_TOKEN=<app automation token>
shopify app deploy --allow-updates
```

`SHOPIFY_APP_AUTOMATION_TOKEN` is the Dev Dashboard app automation token; it
replaces the older `SHOPIFY_CLI_PARTNERS_TOKEN`. `--allow-updates` is required
in non-interactive environments.

---

## Architecture notes

| File | Role |
|---|---|
| `app/optimize.server.js` | Encode pipeline. Two-pass WebP (q76, retrying at q66 when the first pass gains <20%), skips images gaining <2% so a credit is never burned to shave kilobytes. Per-image entry points let the browser drive a real progress bar. |
| `app/catalog.server.js` | Product catalog for the optimizer. Deliberately behind `/api/catalog` rather than in the page loader — building it inline makes "Open optimizer" appear dead for 4–10s. |
| `app/usage.server.js` | Monthly quota metering, keyed `shop` + `YYYY-MM`. Reserve-then-refund so concurrent per-image requests cannot overshoot the quota. Depends on the `UsageCounter(shop, period)` unique index. |
| `app/billing.server.js` | Reads live subscription state; caches **positive** results for 120s only, so a fresh subscribe unlocks instantly while a cancel relocks within the TTL. |
| `app/plans.server.js` | Tier catalog and feature entitlements — the single source of truth for gating. |
| `app/components/ui.jsx` | The shared presentational primitives (CommandBar, KpiStrip, Segmented, Table, Meter, Tag, ActionBar). Pages must build from these rather than re-rolling their own stat blocks. |
| `app/styles/pixelpro.css` | The whole design system. Every colour, radius and border is a `--px-*` variable in the `:root` block and nowhere else. |
| `prisma/schema.prisma` | `Session`, `UsageCounter`, `ShopSettings`, `ImageSize` (a CDN-url → byte-size cache that removes a HEAD request per image per page render). |

Features are gated **server-side** on entitlements, not just hidden in the nav —
`app.alttextsuggestions.jsx` and `app.pagespeedimpactreports.jsx` both fail
closed if the plan lookup throws.

### The `image_optimization` metafield namespace is a contract

`optimize.server.js` writes `image_<MediaImage id>` per image plus
`optimization_summary` per product, under namespace `image_optimization`. Three
readers depend on that exact shape: `catalog.server.js`,
`app.imageoptimizationdashboard.jsx` and `app.pagespeedimpactreports.jsx`. The
namespace is unchanged from previous builds on purpose — renaming it would
discard the optimization history of any store that ran an earlier version,
making already-optimized products look untouched and re-charging the merchant to
recompress them.

Two sharp edges in those readers, both of which have bitten before:

- Query **`media`, not `images`**. `product.images` returns the legacy
  ProductImage id, a different id space for the same photo, so the metafield
  lookup can never match.
- Request **250 metafields, not 20**. `image_…` sorts before
  `optimization_summary`, so a product with ten or more images pushes its
  summary off the first page.

## Design system

The UI is deliberately **flat**: no gradients, no drop shadows, no elevation.
Depth comes from 1px hairline borders and one surface wash; hierarchy from the
type scale, uppercase micro-labels and tabular numerals. Teal `#0D9488` on slate
neutrals, a single 6px radius.

Structurally, lists are **dense tables with segmented filters and a sticky bulk
action bar**, not stacks of per-item cards: a 500-product catalog has to be
scannable. Figures live in one horizontal `KpiStrip` rail rather than a grid of
equal stat cards, and the pricing page is a single comparison matrix rather than
four floating tier cards.

If you are adding a `linear-gradient` or a `box-shadow`, it belongs in a
different design.

## Privacy / compliance

`app/routes/webhooks.compliance.jsx` handles `customers/data_request`,
`customers/redact` and `shop/redact`. The app stores no customer records, so
the first two acknowledge; `shop/redact` deletes the shop's sessions, usage
counters and settings. Unsigned requests are rejected (HMAC verified before the
handler runs).

The app sends image URLs to OpenAI (`gpt-4o-mini` vision) for alt-text
generation, and product URLs to the Google PageSpeed Insights API. **Both must
be disclosed in the App Store listing and privacy policy** — they are, in
`app/routes/privacy.jsx`, which is served unauthenticated at `/privacy` so a
reviewer can read it without installing.
