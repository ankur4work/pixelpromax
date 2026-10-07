import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { getUsage } from "../usage.server";
import { entitled } from "../plans.server";
import db from "../db.server";
import { Page, Button } from "@shopify/polaris";
import {
  CommandBar,
  KpiStrip,
  Panel,
  Meter,
  Tag,
  formatNumber,
} from "../components/ui";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let plan = null;
  try {
    plan = (await getBillingStateCached(admin, session.shop)).plan;
  } catch (e) {
    if (e instanceof Response) throw e; // let re-auth propagate
  }

  let usage = { imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready — defaults */ }

  return {
    plan: {
      name: plan?.name || "Free",
      tier: plan?.tier || "free",
      monthlyImages: plan?.monthlyImages ?? 100,
      altText: entitled(plan, "altText"),
      pageSpeed: entitled(plan, "pageSpeed"),
      autoOptimizeAllowed: entitled(plan, "autoOptimize"),
    },
    usage,
    autoOptimize,
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { plan, usage, autoOptimize } = useLoaderData();

  const quota = plan.monthlyImages || 0;
  const used = usage?.imagesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  const autoStatus = !plan.autoOptimizeAllowed
    ? { label: "Growth & up", tone: "warn" }
    : autoOptimize
      ? { label: "On", tone: "ok" }
      : { label: "Off", tone: undefined };

  // The tool index. A dense keyed list — glyph, name + one line, action — so
  // all five tools and their lock state are visible without scrolling, which a
  // grid of equal icon cards could not manage.
  const tools = [
    {
      code: "OP",
      title: "Optimizer",
      desc: "Compress & convert product images to WebP — up to 70% smaller, originals replaced in place.",
      cta: "Open",
      onClick: () => navigate("/app/productoptimization"),
      available: true,
    },
    {
      code: "AN",
      title: "Analytics",
      desc: "Size savings, compression rates and format breakdown across the whole catalog.",
      cta: "View",
      onClick: () => navigate("/app/imageoptimizationdashboard"),
      available: true,
    },
    {
      code: "AI",
      title: "Alt text",
      desc: "One AI caption per product from vision analysis, applied to every image of it.",
      cta: plan.altText ? "Generate" : "Upgrade",
      onClick: () => navigate(plan.altText ? "/app/alttextsuggestions" : "/app/billing"),
      available: plan.altText,
      tag: plan.altText ? undefined : { label: "Starter & up", tone: "warn" },
    },
    {
      code: "AU",
      title: "Auto-optimize",
      desc: "Every newly created product gets optimized automatically in the background.",
      cta: plan.autoOptimizeAllowed ? "Manage" : "Upgrade",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/productoptimization" : "/app/billing"),
      available: plan.autoOptimizeAllowed,
      tag: autoStatus,
    },
    {
      code: "PS",
      title: "Page speed",
      desc: "Core Web Vitals (LCP, CLS, TBT) measured live per product page via Lighthouse.",
      cta: plan.pageSpeed ? "View" : "Upgrade",
      onClick: () => navigate(plan.pageSpeed ? "/app/pagespeedimpactreports" : "/app/billing"),
      available: plan.pageSpeed,
      tag: plan.pageSpeed ? undefined : { label: "Growth & up", tone: "warn" },
    },
  ];

  return (
    <Page>
      <CommandBar
        title="Faster images, better rankings."
        subtitle="Compress and convert your catalog, auto-generate SEO alt text, and track the page-speed gains."
      >
        <Button variant="primary" onClick={() => navigate("/app/productoptimization")}>
          Optimize images
        </Button>
      </CommandBar>

      <KpiStrip
        items={[
          { label: "Plan", value: plan.name, tag: plan.tier === "free" ? true : "brand" },
          { label: "Images used", value: formatNumber(used), note: `of ${formatNumber(quota)} this month` },
          { label: "Images left", value: formatNumber(remaining), tone: remaining === 0 ? "bad" : undefined },
          { label: "Auto-optimize", value: autoStatus.label, tag: autoStatus.tone || true },
        ]}
      />

      <Panel
        title="Monthly quota"
        actions={
          <Button variant="plain" onClick={() => navigate("/app/billing")}>
            Manage plan
          </Button>
        }
        padded
      >
        <div className="px-quota">
          <Meter
            value={pct}
            tone={pct >= 100 ? "bad" : pct >= 80 ? "warn" : undefined}
            label="Monthly image quota used"
          />
          <span className="px-kpi-note">
            {`${formatNumber(used)} of ${formatNumber(quota)} images · ${formatNumber(remaining)} remaining`}
          </span>
        </div>
      </Panel>

      <Panel title="Tools">
        <div className="px-launch">
          {tools.map((tool) => (
            <div className="px-launch-row" key={tool.title}>
              <span
                className={
                  tool.available
                    ? "px-launch-glyph"
                    : "px-launch-glyph px-launch-glyph--locked"
                }
                aria-hidden="true"
              >
                {tool.code}
              </span>
              <div>
                <p className="px-launch-name">
                  {tool.title}
                  {tool.tag && <Tag tone={tool.tag.tone}>{tool.tag.label}</Tag>}
                </p>
                <p className="px-launch-desc">{tool.desc}</p>
              </div>
              <Button
                variant={tool.available ? "primary" : "secondary"}
                onClick={tool.onClick}
              >
                {tool.cta}
              </Button>
            </div>
          ))}
        </div>
      </Panel>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
