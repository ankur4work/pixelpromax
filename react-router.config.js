/** @type {import('@react-router/dev/config').Config} */
export default {
  // Allowlist the origins Shopify embeds this app under.
  //
  // Shopify renders the app in an iframe whose parent is the Shopify admin, so
  // an action (POST) submitted from a UI route arrives with an `Origin` header
  // of e.g. `admin.shopify.com` — not this app's own origin. React Router 7.18+
  // treats a cross-origin action request as a potential CSRF attack and rejects
  // it with `400 Bad Request` from `singleFetchAction` unless the origin is
  // listed here.
  //
  // Without this, every UI-route action failed: alt-text generate/apply,
  // billing cancel, analytics CSV export, and the auto-optimize toggle. Loaders
  // (GET) were unaffected — the token travels in the URL — and so were resource
  // routes (`/api/optimize`, `/api/catalog`), which this check explicitly skips.
  // That is why the optimizer kept working while the page that threw was the
  // first one to POST to a route action.
  //
  // The list mirrors the frame-ancestors Shopify itself sets in the embedded
  // CSP header (shop domain, unified admin, spin, and the admin preview hosts),
  // so it trusts exactly the parents Shopify already trusts and nothing more.
  // `*` matches a single label; a store origin like `my-store.myshopify.com`
  // is one label in front of `myshopify.com`.
  allowedActionOrigins: [
    "admin.shopify.com",
    "*.myshopify.com",
    "admin.myshopify.io",
    "admin.shop.dev",
    "*.spin.dev",
  ],
};
