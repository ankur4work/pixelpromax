import { PLAN_TIERS, PLAN_MATRIX, PLAN_MATRIX_VALUES } from "../planCatalog";

// 4-tier pricing comparison used by both the standalone pricing page and the
// in-app pricing wall.
//
// Presentational only: every plan CTA is a real top-frame link (`target="_top"`)
// to Shopify's hosted managed-pricing page, where the actual price/cycle live
// and are picked. A direct anchor is used rather than a form POST +
// reauthorize-header redirect, because a user click is a reliable
// user-activation that can navigate the top frame out of the embedded iframe —
// the POST-based redirect intermittently fails during initial setup and loops
// the merchant back to the app index.
//
// NOTE: we intentionally do NOT show prices here. Prices are owned by the plans
// in the Dev Dashboard and can be changed there without a code deploy;
// rendering them in-app would risk showing a stale amount. The merchant sees
// the real price on Shopify's pricing page after clicking through.
//
// Layout: a single bordered comparison matrix, so a merchant reads DOWN a
// capability row to see where it starts being included. Four separate cards
// force them to hold one column in their head while scanning the next, and the
// per-card bullet lists ("Everything in Starter") only make sense if you have
// already read the column to the left.
//
// Colours come from the CSS variables in app/styles/pixelpro.css rather than
// literals, so a rebrand cannot leave this file on the old brand colour while
// the rest of the app changes.
export default function PricingTiers({ pricingUrl }) {
  return (
    <main className="px-page">
      <div className="px-page-inner">
        <p className="px-page-eyebrow">PixelPro Max</p>
        <h1 className="px-page-h1">Pick the plan that fits your catalog.</h1>
        <p className="px-page-lead">
          Compress and convert every product image, generate SEO alt text, and track the
          page-speed gains. Every plan includes the optimizer — the paid tiers add
          automation and headroom.
        </p>

        <div className="px-matrix-wrap">
          <table className="px-matrix">
            <thead>
              <tr>
                {/* Empty corner cell: the row labels below are the row headers,
                    so this one names nothing and is left blank for screen
                    readers rather than given a misleading label. */}
                <th scope="col" aria-label="Capability" />
                {PLAN_TIERS.map((tier) => (
                  <th
                    key={tier.name}
                    scope="col"
                    className={tier.popular ? "px-col-pop" : undefined}
                  >
                    <p className="px-tier-name">{tier.name}</p>
                    <p className="px-tier-tag">
                      {tier.popular ? "Most popular · " : ""}
                      {tier.tagline}
                    </p>
                    <a
                      href={pricingUrl}
                      target="_top"
                      className={
                        tier.popular ? "px-tier-cta px-tier-cta--primary" : "px-tier-cta"
                      }
                    >
                      {tier.price === 0 ? "Start free" : "Choose plan"}
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLAN_MATRIX.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {PLAN_TIERS.map((tier) => {
                    const value = PLAN_MATRIX_VALUES[row.key]?.[tier.name];
                    return (
                      <td
                        key={tier.name}
                        className={tier.popular ? "px-col-pop" : undefined}
                      >
                        {typeof value === "string" ? (
                          value
                        ) : value ? (
                          <span className="px-yes" aria-label="Included">
                            ✓
                          </span>
                        ) : (
                          <span className="px-no" aria-label="Not included">
                            –
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="px-matrix-foot">
          Secure billing through Shopify · Cancel anytime · Prices are shown on Shopify&rsquo;s
          checkout page when you choose a plan.
        </p>
      </div>
    </main>
  );
}
