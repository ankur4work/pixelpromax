import { redirect } from "react-router";

// Public landing page, shown when someone opens the app URL directly.
//
// There is deliberately NO "enter your shop domain" form here. App Store
// requirement 2.3.1 forbids asking a merchant to type their myshopify.com
// address: installation has to start from a Shopify surface and the shop must
// be identified through OAuth or a session token. The Shopify template ships
// that form by default and it must not be carried over.
//
// The redirect below is the supported path — Shopify sends ?shop= when it
// opens the app, and that is forwarded into the embedded app with the rest of
// the parameters intact.
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <main className="px-page">
      <div className="px-prose">
        <p className="px-page-eyebrow">PixelPro Max</p>
        <h1>Faster images, better rankings.</h1>
        <p className="px-prose-meta">Image optimization and SEO for Shopify stores.</p>

        <p>
          PixelPro Max compresses your product images, converts them to WebP, generates SEO
          alt text, and measures the page-speed gains — without changing how your catalog is
          organised. Install it from the Shopify App Store to get started.
        </p>

        <h2>What it does</h2>
        <ul>
          <li>
            <strong>Smart compression.</strong> Two-pass WebP encoding replaces the original
            file in place, keeps your image order intact, and skips any image that would not
            get meaningfully smaller — so a run never costs you anything for nothing.
          </li>
          <li>
            <strong>AI alt text.</strong> One vision-generated caption per product, written to
            every image on it, editable before you apply.
          </li>
          <li>
            <strong>Measured reporting.</strong> Size saved and compression rate from the real
            before/after file sizes, plus live Lighthouse tests on your product pages.
          </li>
          <li>
            <strong>Set and forget.</strong> Newly created products are optimized
            automatically in the background.
          </li>
        </ul>

        <h2>Legal</h2>
        <p>
          <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </main>
  );
}
