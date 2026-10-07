// Public privacy policy, served at /privacy.
//
// Hosted inside the app rather than as a separate site so the URL lives on the
// same domain Shopify already knows about, and so it can never drift out of
// sync with what the code actually does. Deliberately unauthenticated: the App
// Store listing links here and a reviewer must be able to read it without
// installing anything.
//
// Everything below is a factual description of the app's behaviour. If the
// data flows change, change this page in the same commit.

import { useLoaderData } from "react-router";

const UPDATED = "7 October 2026";

// Set SUPPORT_EMAIL in the environment. The fallback keeps the page from ever
// being contactless, but a role address is better for a public listing — set
// the env var before submitting the App Store listing.
export const loader = () => ({
  email: process.env.SUPPORT_EMAIL || "a4ankur.mail@gmail.com",
});

export default function Privacy() {
  const { email } = useLoaderData();
  return (
    <main className="px-page">
      <div className="px-prose">
        <p className="px-page-eyebrow">PixelPro Max</p>
        <h1>Privacy Policy</h1>
        <p className="px-prose-meta">Last updated: {UPDATED}</p>

        <p>
          PixelPro Max is a Shopify app that compresses product images, converts them to
          WebP, and generates alt text. This policy explains exactly what data the app
          handles, where it goes, and how long it is kept.
        </p>

        <h2>What the app stores</h2>
        <p>The app keeps the following in its own database:</p>
        <ul>
          <li>
            <strong>Store session data</strong> — your myshopify.com domain, the access token
            Shopify issues to the app, and, when Shopify provides them, the name, email
            address and locale of the staff member who installed the app. This is what lets
            the app talk to your store.
          </li>
          <li>
            <strong>Usage counts</strong> — the number of images optimized by your store each
            calendar month, used to enforce your plan&rsquo;s limit.
          </li>
          <li>
            <strong>Your settings</strong> — currently a single on/off preference for
            automatically optimizing newly created products.
          </li>
          <li>
            <strong>An image size cache</strong> — a record of how many bytes a given Shopify
            CDN image URL is, so the app does not have to re-measure the same file repeatedly.
            This is keyed by URL only and is not linked to any store or person.
          </li>
        </ul>

        <h2>What the app does not collect</h2>
        <p>
          The app does not collect, store or process any data about your customers. It
          requests only the <code>write_products</code> and <code>write_files</code>{" "}
          permissions, which do not grant access to orders, customers or payment information.
        </p>

        <h2>Your images</h2>
        <p>
          To optimize an image, the app downloads it from Shopify&rsquo;s CDN into memory,
          re-encodes it, uploads the smaller version back to your store, and discards the
          temporary copy. Your images are never written to disk on our servers and are never
          retained after the operation finishes.
        </p>

        <h2>Third parties the app shares data with</h2>
        <ul>
          <li>
            <strong>OpenAI</strong> — when AI alt text is generated, the app sends the product
            title and a link to a reduced-size copy of the product image to OpenAI&rsquo;s API,
            which returns a written description. OpenAI retrieves the image from Shopify&rsquo;s
            CDN. This happens only for images you choose to caption, and only on plans that
            include the alt text feature. Handled under OpenAI&rsquo;s own privacy terms.
          </li>
          <li>
            <strong>Google PageSpeed Insights</strong> — when you run a page speed report, the
            app sends the public URL of the product page being tested to Google, which loads
            that page and returns performance measurements. Only public store URLs are sent.
          </li>
          <li>
            <strong>Shopify</strong> — the app reads and writes your product images, their alt
            text, and optimization records stored as product metafields, through Shopify&rsquo;s
            Admin API.
          </li>
        </ul>
        <p>
          Data is not sold, rented, or shared with anyone else. There is no advertising or
          analytics tracking in the app.
        </p>

        <h2>Where data is held</h2>
        <p>
          Application data is stored in a PostgreSQL database on servers operated on our
          behalf by our hosting provider. All traffic between your browser, Shopify and the
          app is encrypted with TLS.
        </p>

        <h2>How long data is kept</h2>
        <ul>
          <li>Your session is deleted as soon as the app is uninstalled.</li>
          <li>
            All remaining data for your store — usage counts and settings — is deleted when
            Shopify sends its shop redaction request, which it does within 48 hours of
            uninstall.
          </li>
          <li>
            Image size cache entries hold only a URL and a byte count, contain no personal
            data, and are not associated with any store.
          </li>
        </ul>
        <p>
          The app implements Shopify&rsquo;s mandatory privacy webhooks for customer data
          requests, customer redaction and shop redaction.
        </p>

        <h2>Your rights</h2>
        <p>
          You can remove all of your data at any time by uninstalling the app. If you would
          like a copy of the data held about your store, or want it erased sooner, contact us
          and we will action the request.
        </p>

        <h2>Changes</h2>
        <p>
          If this policy changes, the date at the top of this page is updated. Material
          changes to how data is handled will be communicated to installed stores.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy or about your data:{" "}
          <a href={`mailto:${email}`}>{email}</a>
        </p>
      </div>
    </main>
  );
}
