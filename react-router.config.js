/** @type {import('@react-router/dev/config').Config} */
export default {
  // Allow action (POST) submissions from the context Shopify embeds this app in.
  //
  // React Router 7.18+ rejects a cross-origin action request with `400 Bad
  // Request` (from `singleFetchAction` → `throwIfPotentialCSRFAttack`) unless
  // the request's `Origin` is listed here. Loaders (GET) and resource routes
  // (`/api/optimize`, `/api/catalog`) are exempt — which is why the optimizer
  // worked while every UI-route action (alt-text generate/apply, billing
  // cancel, analytics CSV export, auto-optimize toggle) returned 400.
  //
  // App Bridge issues these POSTs from inside the embedded iframe, and the
  // browser sends an OPAQUE origin — the literal string "null" — not the shop
  // or admin host. So allowlisting admin.shopify.com alone is not enough; the
  // "null" entry below is the one that actually matches, and "**" is a
  // belt-and-braces catch-all for any other host Shopify may forward from
  // (shop domain, admin preview hosts, spin, future surfaces).
  //
  // Disabling this origin check is safe for THIS app specifically: every action
  // handler calls `authenticate.admin(request)`, which requires a valid Shopify
  // session token. A cross-site attacker cannot mint that token, so the request
  // is rejected on auth grounds regardless of origin — the origin check adds no
  // protection a session-token-authenticated embedded app doesn't already have.
  allowedActionOrigins: [
    "admin.shopify.com",
    "*.myshopify.com",
    "admin.myshopify.io",
    "admin.shop.dev",
    "*.spin.dev",
    "null",
    "**",
  ],
};
