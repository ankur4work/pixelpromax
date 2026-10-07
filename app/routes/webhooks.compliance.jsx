// Mandatory privacy (GDPR) webhooks: customers/data_request, customers/redact,
// shop/redact.
//
// Shopify requires every public app to implement all three. Declaring them in
// shopify.app.toml as compliance_topics pointing at the app/uninstalled
// endpoint returns 200 with a valid HMAC but does no redaction work at all — it
// only deletes sessions, and only for the uninstall topic. They land here
// instead and each topic is handled explicitly.
//
// `authenticate.webhook` verifies the HMAC before returning. An invalid
// signature throws a Response, which is what Shopify's automated compliance
// check looks for — so an unsigned POST to this route is rejected, not accepted.
//
// What personal data this app actually stores, which is what makes the handlers
// below so short:
//   Session       — merchant (not customer) identity + access token, keyed by shop
//   ShopSettings  — one autoOptimize boolean, keyed by shop
//   UsageCounter  — monthly image counts, keyed by shop
//   ImageSize     — CDN url -> byte size cache; NOT shop-scoped and carries no
//                   personal data (Shopify CDN urls don't identify a store), so
//                   there is nothing here to redact per-shop.
// No customer records are stored or processed anywhere in the app.
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[COMPLIANCE] Received ${topic} for ${shop}`);

  switch (topic) {
    // "Send me the data you hold on this customer." This app never stores
    // customer records, so there is nothing to hand back. Acknowledged so the
    // merchant's request is resolved rather than left retrying.
    case "CUSTOMERS_DATA_REQUEST":
      console.log(`[COMPLIANCE] ${shop}: no customer data is stored by this app`);
      break;

    // "Erase this customer." Same reason — nothing stored to erase.
    case "CUSTOMERS_REDACT":
      console.log(`[COMPLIANCE] ${shop}: no customer data to redact`);
      break;

    // "Erase this shop." Sent up to 48h after uninstall. This one has real work:
    // drop every row keyed by the shop.
    case "SHOP_REDACT":
      try {
        const [sessions, usage, settings] = await db.$transaction([
          db.session.deleteMany({ where: { shop } }),
          db.usageCounter.deleteMany({ where: { shop } }),
          db.shopSettings.deleteMany({ where: { shop } }),
        ]);
        console.log(
          `[COMPLIANCE] ${shop} redacted: %d sessions, %d usage rows, %d settings`,
          sessions.count,
          usage.count,
          settings.count,
        );
      } catch (err) {
        // Shopify retries a non-2xx, so a transient DB failure is worth
        // surfacing — returning 200 here would silently drop the erasure.
        console.error(`[COMPLIANCE] ${shop} redaction failed:`, err?.message || err);
        return new Response("Redaction failed", { status: 500 });
      }
      break;

    default:
      // A topic routed here that we don't know about is a config mismatch
      // between shopify.app.toml and this file, not a merchant-facing problem.
      console.error(`[COMPLIANCE] Unhandled topic ${topic} for ${shop}`);
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
