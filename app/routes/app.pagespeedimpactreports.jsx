import { useState, useCallback, useEffect } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData, redirect } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { entitled } from '../plans.server';
import { Page, Button, Banner } from '@shopify/polaris';
import {
  CommandBar,
  KpiStrip,
  Panel,
  Tag,
  Table,
  Thead,
  Row,
  EmptyState,
  formatBytes,
  formatNumber,
} from '../components/ui';

// Page Speed reports are a Growth+ feature. Resolve the shop's plan and return
// its entitlement; lets a Response (re-auth) propagate, treats any other failure
// as "not entitled" so the feature fails closed rather than leaking.
async function pageSpeedAllowed(admin, shop) {
  try {
    const { plan } = await getBillingStateCached(admin, shop);
    return entitled(plan, 'pageSpeed');
  } catch (e) {
    if (e instanceof Response) throw e;
    return false;
  }
}

/**
 * Fetch all products from Shopify with optimization data
 */
async function getAllProductHandles(admin) {
  const query = `#graphql
    query GetProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            onlineStoreUrl
            # 250, not 10. The optimizer writes one metafield per image plus
            # optimization_summary, and this page only wants the summary — but
            # "image_..." sorts before "optimization_summary", so on any
            # product with ten or more images the summary falls outside the
            # page and getOptimizationData() below sees nothing to report.
            metafields(first: 250, namespace: "image_optimization") {
              edges {
                node {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(query, {
      variables: { cursor }
    });

    const data = await response.json();
    const products = data.data.products.edges.map(edge => edge.node);
    // push rather than rebuild: spreading the accumulator each page re-copies
    // every product already fetched, which is quadratic on a large catalog.
    for (const product of products) allProducts.push(product);

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return allProducts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One PSI attempt. Throws { retryable } so the caller can decide to retry.
async function pageSpeedAttempt(apiUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(apiUrl, { signal: controller.signal });
  } catch (e) {
    // Network error or our 45s abort — transient, worth retrying.
    const err = new Error(e?.name === 'AbortError' ? 'PageSpeed request timed out' : `PageSpeed network error: ${e?.message || e}`);
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error?.message || ''; } catch { /* non-JSON */ }
    const err = new Error(`PageSpeed API request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    // 429 (rate limit) and 5xx are transient; other 4xx (bad/unreachable URL) are not.
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  const lighthouseResult = data.lighthouseResult;
  if (!lighthouseResult) {
    // Sometimes PSI returns 200 with a lighthouse runtime error (e.g. page slow
    // to load) — treat as retryable, a re-run often succeeds.
    const err = new Error('No Lighthouse data in response');
    err.retryable = true;
    throw err;
  }

  const performanceScore = Math.round((lighthouseResult.categories.performance?.score || 0) * 100);
  const audits = lighthouseResult.audits;
  const lcpAudit = audits['largest-contentful-paint'];
  const tbtAudit = audits['total-blocking-time'];
  const clsAudit = audits['cumulative-layout-shift'];
  const ttfbAudit = audits['server-response-time'];
  const speedIndexAudit = audits['speed-index'];
  const interactiveAudit = audits['interactive'];

  return {
    score: performanceScore,
    lcp: lcpAudit?.numericValue ? parseFloat((lcpAudit.numericValue / 1000).toFixed(2)) : 0,
    tbt: tbtAudit?.numericValue ? Math.round(tbtAudit.numericValue) : 0,
    cls: clsAudit?.numericValue ? parseFloat(clsAudit.numericValue.toFixed(3)) : 0,
    ttfb: ttfbAudit?.numericValue ? parseFloat((ttfbAudit.numericValue / 1000).toFixed(2)) : 0,
    loadTime: interactiveAudit?.numericValue ? parseFloat((interactiveAudit.numericValue / 1000).toFixed(2)) : 0,
    speedIndex: speedIndexAudit?.numericValue ? parseFloat((speedIndexAudit.numericValue / 1000).toFixed(2)) : 0,
    timestamp: new Date().toISOString()
  };
}

/**
 * Run a real Lighthouse performance test via Google PageSpeed Insights API.
 *
 * The keyless endpoint is rate-limited, so failures are often transient — we
 * retry with backoff (up to 3 attempts) on 429/5xx/timeout, which makes the
 * test reliable without requiring a GOOGLE_PAGESPEED_API_KEY (one still raises
 * the limits further if set). Returns null only after all attempts fail.
 *
 * A 403 deliberately breaks out without retrying, which means a key that lacks
 * the PageSpeed Insights API enabled (Google answers API_KEY_SERVICE_BLOCKED)
 * turns a degraded-but-working feature into a hard failure. A wrong key is
 * worse than no key — leave the env var unset unless the key is enabled.
 */
async function runPageSpeedTest(url) {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const keyParam = apiKey ? `&key=${apiKey}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&strategy=mobile${keyParam}`;

  const backoffs = [0, 2000, 5000]; // before attempts 1, 2, 3
  let lastErr;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      return await pageSpeedAttempt(apiUrl);
    } catch (e) {
      lastErr = e;
      console.error(`PageSpeed attempt ${attempt + 1} failed:`, e?.message || e);
      if (!e?.retryable) break; // bad/unreachable URL — retrying won't help
    }
  }
  console.error('PageSpeed test failed after retries:', lastErr?.message || lastErr);
  return null;
}

/**
 * Read the real optimization results stored on the product's metafields
 * (written by the optimizer after actual compression runs).
 */
function getOptimizationData(product) {
  const metafields = product.metafields?.edges || [];
  const optimizationSummary = metafields.find(
    mf => mf.node.key === 'optimization_summary'
  );

  if (!optimizationSummary) {
    return null;
  }

  try {
    const data = JSON.parse(optimizationSummary.node.value);

    return {
      totalSizeSavedMB: parseFloat((data.totalSizeSavedMB || 0).toFixed(2)),
      totalOriginalSizeMB: parseFloat((data.totalOriginalSizeMB || 0).toFixed(2)),
      totalOptimizedSizeMB: parseFloat((data.totalOptimizedSizeMB || 0).toFixed(2)),
      compressionRate: data.avgCompressionRate || 0,
      optimizedImages: data.optimizedImages || 0
    };
  } catch (e) {
    console.error('Error parsing optimization summary:', e);
    return null;
  }
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: only Growth+ may view Page Speed reports. Others go back to
  // the app home (where they see their plan + an upgrade path).
  if (!(await pageSpeedAllowed(admin, session.shop))) throw redirect('/app');
  const url = new URL(request.url);
  const selectedPage = url.searchParams.get('page') || 'all';

  try {
    const products = await getAllProductHandles(admin);

    const shop = session.shop;
    // Use the full myshopify domain — stripping ".myshopify.com" produces an
    // invalid host (e.g. "https://mystore") that PageSpeed can never load. The
    // myshopify URL is publicly reachable and redirects to the primary domain.
    const shopUrl = `https://${shop}`;

    const pages = [];

    for (const product of products) {
      const optimization = getOptimizationData(product);

      if (optimization && optimization.totalSizeSavedMB > 0) {
        pages.push({
          id: product.handle,
          url: `/products/${product.handle}`,
          fullUrl: product.onlineStoreUrl || `${shopUrl}/products/${product.handle}`,
          name: product.title,
          productId: product.id,
          optimization
        });
      }
    }

    const totalSaved = pages.reduce((sum, p) => sum + p.optimization.totalSizeSavedMB, 0);
    const totalOriginal = pages.reduce((sum, p) => sum + p.optimization.totalOriginalSizeMB, 0);
    const totalImages = pages.reduce((sum, p) => sum + p.optimization.optimizedImages, 0);
    const avgCompression = pages.length > 0
      ? pages.reduce((sum, p) => sum + p.optimization.compressionRate, 0) / pages.length
      : 0;

    const insights = [];

    if (totalSaved > 0) {
      insights.push({
        id: '1',
        type: 'success',
        title: 'Image payload reduced',
        description: `Total image payload reduced by ${totalSaved.toFixed(1)} MB across ${pages.length} product pages (${avgCompression.toFixed(0)}% average compression, ${totalImages} images optimized). These figures are measured from the actual file sizes before and after compression.`,
        impact: 'high',
        status: 'completed'
      });

      insights.push({
        id: '2',
        type: 'info',
        title: 'Smaller images generally improve Core Web Vitals',
        description: 'Reducing image transfer size typically improves load time and Largest Contentful Paint, especially on mobile connections. To see the measured impact on your store, run a live PageSpeed test above — results vary by theme, hosting, and other page content.',
        impact: 'medium',
        status: 'pending'
      });
    }

    const unoptimizedCount = products.length - pages.length;
    if (unoptimizedCount > 0) {
      insights.push({
        id: '3',
        type: 'warning',
        title: 'Additional optimization opportunities',
        description: `${unoptimizedCount} product pages have not been optimized yet. Run the optimizer on these pages to reduce their image payload as well.`,
        impact: 'medium',
        status: 'pending'
      });
    }

    insights.push({
      id: '4',
      type: 'info',
      title: 'Ongoing performance monitoring',
      description: 'Keep an eye on Core Web Vitals and re-run the optimizer as new products are added. Lazy loading below-the-fold images in your theme is the usual next win after image size.',
      impact: 'low',
      status: 'pending'
    });

    return {
      pages,
      insights,
      selectedPage,
      shopUrl,
      totalProducts: products.length,
      optimizedProducts: pages.length,
      totalSavedMB: totalSaved,
      totalOriginalMB: totalOriginal,
      totalImagesOptimized: totalImages,
      avgCompression,
      error: null
    };
  } catch (error) {
    console.error('Error loading page speed data:', error);
    return {
      pages: [],
      insights: [{
        id: 'error',
        type: 'critical',
        title: 'Error loading data',
        description: error.message || 'Failed to load optimization data. Please try refreshing the page.',
        impact: 'high',
        status: 'error'
      }],
      selectedPage,
      shopUrl: '',
      totalProducts: 0,
      optimizedProducts: 0,
      totalSavedMB: 0,
      totalOriginalMB: 0,
      totalImagesOptimized: 0,
      avgCompression: 0,
      error: 'Failed to load optimization data'
    };
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: block report runs for non-entitled plans (defends the action
  // even if the UI were bypassed).
  if (!(await pageSpeedAllowed(admin, session.shop))) {
    return { error: 'Page Speed reports are available on the Growth plan and above.' };
  }
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'runLighthouseAnalysis') {
    const pageUrl = formData.get('pageUrl');
    const pageName = formData.get('pageName');

    try {
      const result = await runPageSpeedTest(pageUrl);

      if (!result) {
        throw new Error('Failed to run PageSpeed test');
      }

      return {
        success: true,
        message: `PageSpeed test completed for ${pageName || pageUrl}. Performance score: ${result.score}/100`,
        pageUrl,
        pageName,
        result
      };
    } catch (error) {
      console.error('Error running PageSpeed analysis:', error);
      const detail = error?.message ? ` (${error.message})` : '';
      return {
        success: false,
        error: `Google PageSpeed couldn't analyze this page right now${detail}. This is usually temporary (Google rate limits) or because the page isn't publicly reachable yet (an unpublished or password-protected storefront). Your measured optimization savings below are unaffected — please try the live test again in a moment.`
      };
    }
  }

  return { success: false, error: 'Invalid action type' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

const PAGE_COLUMNS = [
  { key: 'page', label: 'Product page' },
  { key: 'images', label: 'Imgs', align: 'right' },
  { key: 'before', label: 'Before', className: 'px-col-before', align: 'right' },
  { key: 'after', label: 'After', className: 'px-col-after', align: 'right' },
  { key: 'saved', label: 'Saved', align: 'right' },
  { key: 'rate', label: 'Compression', align: 'right' },
];

// Lighthouse's own published thresholds. Kept in one table so a metric can't be
// rated "Good" in the figure and "Poor" in the dot.
const RATINGS = [
  { key: 'lcp', label: 'LCP', unit: 's', good: 2.5, ok: 4.0, help: 'Largest Contentful Paint' },
  { key: 'tbt', label: 'TBT', unit: 'ms', good: 200, ok: 600, help: 'Total Blocking Time' },
  { key: 'cls', label: 'CLS', unit: '', good: 0.1, ok: 0.25, help: 'Cumulative Layout Shift' },
  { key: 'ttfb', label: 'TTFB', unit: 's', good: 0.8, ok: 1.8, help: 'Time to First Byte' },
  { key: 'speedIndex', label: 'Speed Index', unit: 's', good: 3.4, ok: 5.8, help: 'Speed Index' },
  { key: 'loadTime', label: 'Interactive', unit: 's', good: 3.8, ok: 7.3, help: 'Time to Interactive' },
];

function rate(value, good, ok) {
  if (value <= good) return { tone: 'ok', label: 'Good' };
  if (value <= ok) return { tone: 'warn', label: 'Needs improvement' };
  return { tone: 'bad', label: 'Poor' };
}

function scoreRating(score) {
  if (score >= 90) return { tone: 'ok', label: 'Good' };
  if (score >= 50) return { tone: 'warn', label: 'Needs improvement' };
  return { tone: 'bad', label: 'Poor' };
}

const NOTE_TONE = {
  success: 'ok',
  warning: 'warn',
  critical: 'bad',
  info: 'info',
};

export default function PageSpeedImpactReports() {
  const {
    pages,
    insights,
    selectedPage: initialSelectedPage,
    totalProducts,
    optimizedProducts,
    totalSavedMB,
    totalImagesOptimized,
    avgCompression,
    error: loadError
  } = useLoaderData();

  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();

  const [selectedPage, setSelectedPage] = useState(
    initialSelectedPage !== 'all' && pages.some(p => p.id === initialSelectedPage)
      ? initialSelectedPage
      : (pages[0]?.id || '')
  );
  const [showResult, setShowResult] = useState(false);

  const isRunningAnalysis = navigation.state === 'submitting';

  useEffect(() => {
    if (actionData?.success) setShowResult(true);
  }, [actionData]);

  const handleRunLighthouse = useCallback(() => {
    const currentPage = pages.find(p => p.id === selectedPage);
    if (!currentPage) return;

    const formData = new FormData();
    formData.append('actionType', 'runLighthouseAnalysis');
    formData.append('pageUrl', currentPage.fullUrl);
    formData.append('pageName', currentPage.name);
    submit(formData, { method: 'post' });
  }, [selectedPage, pages, submit]);

  const liveResult = actionData?.success ? actionData.result : null;
  const scoreR = liveResult ? scoreRating(liveResult.score) : null;

  return (
    <Page>
      <CommandBar
        title="Page speed"
        subtitle="Measured image savings from your optimization runs, plus live Lighthouse tests run on Google's servers against your public product pages."
      >
        <Button url="/app/productoptimization">Open optimizer</Button>
      </CommandBar>

      {loadError && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Error" tone="critical">{loadError}</Banner>
        </div>
      )}
      {actionData?.error && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Live test couldn't complete" tone="warning">{actionData.error}</Banner>
        </div>
      )}

      <KpiStrip
        items={[
          {
            label: 'Pages optimized',
            value: `${formatNumber(optimizedProducts)} / ${formatNumber(totalProducts)}`,
          },
          { label: 'Measured saving', value: formatBytes(totalSavedMB), tone: 'ok' },
          { label: 'Images optimized', value: formatNumber(totalImagesOptimized) },
          { label: 'Avg compression', value: `${avgCompression.toFixed(0)}%`, tone: 'ok' },
        ]}
      />

      {/* ── Live test ─────────────────────────────────────────────────── */}
      <Panel
        title="Live Lighthouse test"
        note="Runs on Google's servers against the live page. Takes 30–60 seconds; rate limits apply."
        padded
      >
        {pages.length > 0 ? (
          <div className="px-bar-aside" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="px-field">
              <label className="px-field-label" htmlFor="px-page-select">Product page</label>
              <select
                id="px-page-select"
                className="px-select"
                value={selectedPage}
                disabled={isRunningAnalysis}
                onChange={(e) => setSelectedPage(e.target.value)}
              >
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name || page.url}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="primary"
              onClick={handleRunLighthouse}
              loading={isRunningAnalysis}
              disabled={isRunningAnalysis || !selectedPage}
            >
              {isRunningAnalysis ? 'Running test…' : 'Run test'}
            </Button>
          </div>
        ) : (
          <p className="px-empty-body" style={{ margin: 0 }}>
            Optimize at least one product page first, then come back here to measure its
            performance. Running a test before and after a run is how you see the difference.
          </p>
        )}
      </Panel>

      {/* ── Live results — flat vitals cells, not a table of strings ──── */}
      {showResult && liveResult && (
        <Panel
          title={`Measured results · ${actionData.pageName || actionData.pageUrl}`}
          note={`Lighthouse, mobile · tested ${new Date(liveResult.timestamp).toLocaleString()}`}
          padded
        >
          <div className="px-score" style={{ marginBottom: 14 }}>
            <span className="px-score-n">{liveResult.score}</span>
            <span className="px-score-d">/ 100 performance</span>
            <Tag tone={scoreR.tone} dot>{scoreR.label}</Tag>
          </div>

          <div className="px-vitals">
            {RATINGS.map((metric) => {
              const value = liveResult[metric.key];
              const r = rate(value, metric.good, metric.ok);
              return (
                <div className="px-vital" key={metric.key}>
                  <p className="px-vital-k">
                    <span className={`px-dot px-dot--${r.tone}`} aria-hidden="true" />
                    {metric.label}
                  </p>
                  <p className="px-vital-v">{`${value}${metric.unit}`}</p>
                  <p className="px-vital-r">{`${r.label} · ${metric.help}`}</p>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ── Measured savings by page ──────────────────────────────────── */}
      <Panel
        title="Measured image savings by page"
        note={
          pages.length > 20
            ? `Showing the 20 largest of ${pages.length} optimized pages.`
            : 'From your store’s actual images, before and after optimization.'
        }
      >
        {pages.length === 0 ? (
          <EmptyState title="No optimized pages yet">
            Run the optimizer on a product and its measured saving will be listed here.
          </EmptyState>
        ) : (
          <Table variant="pages">
            <Thead columns={PAGE_COLUMNS} />
            {pages.slice(0, 20).map((page) => (
              <Row key={page.id}>
                <div className="px-td">
                  <p className="px-td-strong" title={page.name}>{page.name}</p>
                  <p className="px-td-meta">{page.url}</p>
                </div>
                <div className="px-td px-td--num">{page.optimization.optimizedImages}</div>
                <div className="px-td px-td--num px-col-before">
                  {formatBytes(page.optimization.totalOriginalSizeMB)}
                </div>
                <div className="px-td px-td--num px-col-after">
                  {formatBytes(page.optimization.totalOptimizedSizeMB)}
                </div>
                <div className="px-td px-td--num px-td-ok">
                  {formatBytes(page.optimization.totalSizeSavedMB)}
                </div>
                <div className="px-td px-td--right">
                  <Tag tone="ok">{`${Math.round(page.optimization.compressionRate)}%`}</Tag>
                </div>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      {/* ── Insights — a list with severity dots, not four stacked banners,
             which read as four errors rather than four notes. ─────────── */}
      <Panel title="Insights & recommendations">
        <div className="px-notes">
          {insights.map((insight) => (
            <div className="px-note" key={insight.id}>
              <span
                className={`px-dot px-dot--${NOTE_TONE[insight.type] || 'info'} px-note-dot`}
                aria-hidden="true"
              />
              <div>
                <p className="px-note-title">{insight.title}</p>
                <p className="px-note-body">{insight.description}</p>
              </div>
              {insight.status === 'completed' ? (
                <Tag tone="ok">Measured</Tag>
              ) : insight.status === 'error' ? (
                <Tag tone="bad">Error</Tag>
              ) : (
                <Tag tone={NOTE_TONE[insight.type] || 'info'}>{`${insight.impact} impact`}</Tag>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </Page>
  );
}
