import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { setDefaultResultOrder } from "node:dns";
import prisma from "./db.server";

// Prefer IPv4 for every outbound request in this process.
//
// The container hangs on IPv6 connect attempts (ConnectTimeoutError to
// 2620:127:f00e::), which is why optimize.server also sets this. But it sets it
// LAZILY, from inside timedFetch — and timedFetch is only used for image
// downloads, never for admin.graphql. So on a freshly started container the
// first Shopify Admin API call would still go out with Node's default
// resolution order. Setting it here, where every route's authenticate/graphql
// comes from, means it is in place before any request can be made.
try {
  setDefaultResultOrder("ipv4first");
} catch {
  /* older runtimes don't have it */
}

// NOTE: there is intentionally no `billing: {...}` option below.
//
// This is a Managed Pricing app, so the Billing API is blocked for it —
// appSubscriptionCreate cannot be called, and plans are defined in the Dev
// Dashboard instead. Registering a billing config here would be doubly wrong:
// the library could never act on it, and it would become a second place that
// describes a plan, competing with the Free/Starter/Growth/Pro model that
// plans.server.js actually resolves against.
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: { expiringOfflineAccessTokens: true },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
