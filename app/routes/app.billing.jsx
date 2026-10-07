import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  cancelSubscription,
} from "../billing.server";
import { getUsage } from "../usage.server";
import { Page, Button, Banner } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  CommandBar,
  KpiStrip,
  Panel,
  Meter,
  Tag,
  Dot,
  formatNumber,
} from "../components/ui";

// Human labels for the entitlement flags, shown as the current plan's
// inclusions. One label per flag that exists in plans.server.js FEATURES.
//
// This list is what a paying merchant reads as the definition of what they
// bought, so it must never run ahead of the code: add a label here only in the
// change that ships the feature behind it.
const FEATURE_LABELS = {
  optimize: "Image optimization & WebP conversion",
  altText: "AI alt text",
  filenameSeo: "SEO filenames",
  autoOptimize: "Auto-optimize new products",
  pageSpeed: "Page Speed reports",
};

// Every flag, in display order, so the plan panel can show what is NOT included
// as well as what is. A list of only the included items tells a Starter
// subscriber nothing about what upgrading would buy them.
const ALL_FEATURES = Object.keys(FEATURE_LABELS);

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let state = { hasActivePlan: false, plan: null, appHandle: undefined };
  try {
    state = await getBillingState(admin, session.shop);
  } catch (e) {
    if (e instanceof Response) throw e;
  }

  let usage = { imagesUsed: 0 };
  try { usage = await getUsage(session.shop); } catch { /* table not ready */ }

  const plan = state.plan || { name: "Free", tier: "free", monthlyImages: 100, features: {} };
  const included = ALL_FEATURES.filter((k) => plan.features?.[k]);

  return {
    hasActivePlan: state.hasActivePlan,
    planName: plan.name,
    tier: plan.tier,
    monthlyImages: plan.monthlyImages,
    included,
    imagesUsed: usage.imagesUsed || 0,
    // Direct top-frame link target for the Change/Choose-plan CTA.
    pricingUrl: managedPricingUrl(session.shop, state.appHandle),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  const state = await getBillingState(admin);
  const pricingUrl = managedPricingUrl(session.shop, state.appHandle);

  // Cancel: try the in-app cancel mutation first; if managed pricing blocks it,
  // fall back to the hosted page to cancel there.
  if (actionType === "cancel") {
    const sub = state.activeSubscription;
    if (!sub) return { cancelled: true };
    try {
      await cancelSubscription(admin, sub.id);
      return { cancelled: true };
    } catch (e) {
      console.error("[BILLING] in-app cancel failed, redirecting:", e?.message);
      throw appBridgeRedirect(pricingUrl);
    }
  }

  return null;
};

export default function BillingPage() {
  const {
    hasActivePlan, planName, tier, monthlyImages, included, imagesUsed, pricingUrl,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isBusy = navigation.state !== "idle";

  const post = (actionType) => {
    const fd = new FormData();
    fd.append("actionType", actionType);
    submit(fd, { method: "post" });
  };

  const quota = monthlyImages || 0;
  const used = imagesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  return (
    <Page>
      <CommandBar
        title="Plan & usage"
        subtitle="Plans and prices are managed on Shopify's billing page. Upgrade, downgrade, or switch between monthly and yearly there and it is reflected here automatically."
      >
        <Button variant="primary" url={pricingUrl} target="_top">
          {hasActivePlan ? "Change plan" : "Choose a plan"}
        </Button>
        {hasActivePlan && (
          <Button tone="critical" variant="plain" loading={isBusy} onClick={() => post("cancel")}>
            Cancel
          </Button>
        )}
      </CommandBar>

      {actionData?.cancelled && !hasActivePlan && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Subscription cancelled" tone="info">
            Your plan has been cancelled. Choose a plan any time to unlock more.
          </Banner>
        </div>
      )}

      <KpiStrip
        items={[
          {
            label: "Current plan",
            value: planName,
            tag: hasActivePlan ? "brand" : true,
            note: hasActivePlan ? "active" : "no active subscription",
          },
          { label: "Monthly quota", value: formatNumber(quota), note: "images per month" },
          { label: "Used this month", value: formatNumber(used), tone: pct >= 100 ? "bad" : undefined },
          { label: "Remaining", value: formatNumber(remaining), tone: remaining === 0 ? "bad" : "ok" },
        ]}
      />

      <Panel
        title="Images this month"
        note={pct >= 100 ? "Quota reached — change plan to optimize more this month." : undefined}
        padded
      >
        <div className="px-quota">
          <Meter
            value={pct}
            tone={pct >= 100 ? "bad" : pct >= 80 ? "warn" : undefined}
            label="Monthly image quota used"
          />
          <span className="px-kpi-note">
            {`${formatNumber(used)} of ${formatNumber(quota)} · resets on the 1st`}
          </span>
        </div>
      </Panel>

      {/* Both halves of the plan, not just the included half. A subscriber who
          only sees ticks has no idea what the next tier adds. */}
      <Panel title={`What ${planName} includes`}>
        <div className="px-notes">
          {ALL_FEATURES.map((key) => {
            const has = included.includes(key);
            return (
              <div className="px-note" key={key}>
                <Dot tone={has ? "ok" : undefined} className="px-note-dot" />
                <div>
                  <p className="px-note-title" style={has ? undefined : { color: "var(--px-muted)" }}>
                    {FEATURE_LABELS[key]}
                  </p>
                </div>
                {has ? (
                  <Tag tone="ok">Included</Tag>
                ) : (
                  <Tag>Not on {planName}</Tag>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {tier === "free" && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="info" title="You're on the Free plan">
            Free covers 100 images a month with WebP conversion and analytics. AI alt text starts
            on Starter; auto-optimization and Page Speed reports start on Growth.
          </Banner>
        </div>
      )}
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
