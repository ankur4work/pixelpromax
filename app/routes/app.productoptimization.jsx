import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { optimizeBatch } from '../optimize.server';
import {
  Page,
  Button,
  Checkbox,
  Banner,
  Spinner,
} from '@shopify/polaris';
import {
  CommandBar,
  KpiStrip,
  Segmented,
  Panel,
  Meter,
  scoreTone,
  Tag,
  Table,
  Thead,
  Row,
  EmptyState,
  SkeletonRows,
  ActionBar,
  formatBytes,
  formatNumber,
} from '../components/ui';

/* -------------------------------------------------------------------------- */
/*  Loader — cheap data only                                                  */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  // Everything in here has to be fast, because the browser cannot finish the
  // navigation until this returns — which is why building the product catalog
  // here made clicking into the optimizer take 4-10+ seconds. The catalog lives
  // in /api/catalog (app/catalog.server.js) and is requested once this page has
  // already painted.
  //
  // The two remaining reads are independent, so they run concurrently instead of
  // one waiting on the other: billing is a cached Shopify read, usage and
  // settings are local DB.
  const [planResult, shopResult] = await Promise.allSettled([
    getBillingStateCached(admin, session.shop),
    Promise.all([
      getUsage(session.shop),
      db.shopSettings.findUnique({ where: { shop: session.shop } }),
    ]),
  ]);

  const plan = planResult.status === 'fulfilled' ? planResult.value.plan : null;
  // usage/settings tables not ready yet — default to zero/off.
  const [usage, settings] = shopResult.status === 'fulfilled'
    ? shopResult.value
    : [{ period: '', imagesUsed: 0 }, null];

  return {
    filter,
    sortBy,
    usage,
    autoOptimize: settings?.autoOptimize ?? false,
    plan: {
      tier: plan?.tier || 'free',
      name: plan?.name || 'Free',
      monthlyImages: plan?.monthlyImages ?? 100,
      autoOptimizeAllowed: entitled(plan, 'autoOptimize'),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Action — toggles auto-optimize, or processes ONE optimization batch       */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'setAutoOptimize') {
    const enabled = formData.get('enabled') === 'true';
    // Enabling is gated by plan entitlement; disabling is always allowed.
    if (enabled) {
      try {
        const { plan } = await getBillingStateCached(admin, session.shop);
        if (!entitled(plan, 'autoOptimize')) {
          return { success: false, settingUpdated: true, error: 'Upgrade to Growth to auto-optimize new products.' };
        }
      } catch { /* if billing check fails, fall through and block enabling */
        return { success: false, settingUpdated: true, error: 'Could not verify your plan. Try again.' };
      }
    }
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, autoOptimize: enabled },
      update: { autoOptimize: enabled },
    });
    return { success: true, settingUpdated: true, autoOptimize: enabled };
  }

  // The batch path is still exposed here. The browser drives the per-image API
  // instead, but the products/create webhook uses optimizeBatch and has no
  // browser to drive it — keeping both reachable means one code path can't rot.
  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      const { plan } = await getBillingStateCached(admin, session.shop);
      const remainingQuota = await getRemaining(session.shop, plan);
      return await optimizeBatch(admin, productId, {
        shop: session.shop,
        remainingQuota,
        genAlt: entitled(plan, 'altText'),
        seoNames: entitled(plan, 'filenameSeo'),
      });
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many images of the same product the browser optimizes at once.
 *
 * This MUST match what the batch path does server-side (BATCH_CONCURRENCY, 6).
 * Moving parallelism from the server to the browser and setting it to 3 halves
 * throughput: measured on a 16-image product, 119s of server time became ~40s
 * of wall clock instead of ~20s.
 *
 * Six is not a guess — it is the same number of concurrent images, against the
 * same shop's rate limit, that the batch path ran for months. The only addition
 * per image is one cheap context query; the expensive mutations are unchanged.
 */
const IMAGE_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `limit` in flight. Mirrors mapLimit. */
async function mapLimitClient(items, limit, fn, shouldStop) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      // Post-increment is safe: JavaScript runs one worker at a time between
      // awaits, so no two can claim the same item.
      let index = cursor++;
      while (index < items.length) {
        if (shouldStop()) return;
        await fn(items[index], index);
        index = cursor++;
      }
    }
  );
  await Promise.all(workers);
}

// Shown until /api/catalog answers. Declared here rather than imported from
// catalog.server.js so no server module is referenced from client code.
const EMPTY_STATS = {
  total: 0,
  needsOptimization: 0,
  optimized: 0,
  totalImages: 0,
  totalSizeMB: 0,
  potentialSavingsMB: 0,
};

const PRODUCT_COLUMNS = [
  { key: 'select', label: '' },
  { key: 'thumb', label: '', className: 'px-col-thumb' },
  { key: 'product', label: 'Product' },
  { key: 'images', label: 'Imgs', className: 'px-col-images', align: 'right' },
  { key: 'size', label: 'Original', className: 'px-col-size', align: 'right' },
  { key: 'saved', label: 'Saved', className: 'px-col-saved', align: 'right' },
  { key: 'progress', label: 'Optimized' },
  { key: 'action', label: '', className: 'px-col-action' },
];

const SORT_OPTIONS = [
  { label: 'Least done', value: 'score_asc' },
  { label: 'Most done', value: 'score_desc' },
  { label: 'Biggest', value: 'size_desc' },
  { label: 'Most images', value: 'images_desc' },
];

export default function ProductOptimization() {
  const {
    filter: initialFilter, sortBy: initialSortBy,
    plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  // Optimization does not go through a fetcher — it drives /api/optimize
  // directly so several images can be in flight at once.
  const settingsFetcher = useFetcher();
  const revalidator = useRevalidator();

  // The product list is fetched AFTER this page renders. Building it takes
  // seconds (a Shopify request per 50 products, plus a HEAD per unmeasured
  // image), and in the loader the browser could not finish the navigation —
  // the click appeared to do nothing for 4-10+ seconds.
  const catalogFetcher = useFetcher();
  useEffect(() => {
    if (catalogFetcher.state === 'idle' && !catalogFetcher.data) {
      catalogFetcher.load('/api/catalog');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher.state, catalogFetcher.data]);

  // Memoized so the empty placeholder keeps a stable identity — several
  // callbacks and memos take `products` as a dependency.
  const products = useMemo(() => catalogFetcher.data?.products ?? [], [catalogFetcher.data]);
  const stats = catalogFetcher.data?.stats ?? EMPTY_STATS;
  const catalogLoading = !catalogFetcher.data;
  const refreshCatalog = useCallback(() => {
    catalogFetcher.load('/api/catalog');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher]);

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // Live per-product progress, keyed by product id, updated after every IMAGE.
  const [liveProgress, setLiveProgress] = useState({});

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);

  // sessionImages exists only to move the meter while a run is in progress,
  // before the loader has caught up. The moment fresh loader data arrives it
  // ALREADY includes those images, so the session delta has to be dropped —
  // otherwise both are added and the meter reads exactly double (16 optimized
  // images showing as 32/100).
  useEffect(() => {
    setSessionImages(0);
  }, [usage]);

  // buildCatalog reports failure as data, not a rejection, so surface it here.
  useEffect(() => {
    if (catalogFetcher.data?.error) setError(catalogFetcher.data.error);
  }, [catalogFetcher.data]);

  /**
   * A run, driven one IMAGE per request from the browser.
   *
   * One request per BATCH of up to BATCH_SIZE (10) images means a product with
   * fewer images than that is a single request: the row would jump from 0/8 to
   * 8/8 with nothing in between. Asking for one image at a time makes every
   * response a progress event, and the pool below keeps the parallelism that
   * made batching fast in the first place.
   *
   * Counters live in a ref and are published into state — several concurrent
   * workers updating the same tallies through setState callbacks is much easier
   * to get wrong.
   */
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  // Set by the Stop button and by a quota refusal; every worker checks it.
  const stopRef = useRef(false);

  const publish = useCallback(() => {
    const s = runRef.current;
    setRun(s ? { ...s, images: s.images.map(i => ({ ...i })) } : null);
  }, []);

  /** One call to the per-image API. */
  const callApi = useCallback(async (fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);

    // App Bridge already adds the session token to relative fetches, but asking
    // for it explicitly means auth doesn't depend on that patch being in place.
    const headers = {};
    try {
      const token = await window.shopify?.idToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* App Bridge's own fetch patch is the backstop */ }

    const response = await fetch('/api/optimize', { method: 'POST', body, headers });

    let data = null;
    try { data = await response.json(); } catch { /* fall through */ }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your session expired. Reload the page and try again.');
      }
      throw new Error(data?.error || `The server returned an error (${response.status}).`);
    }
    if (!data) throw new Error('The server sent back an empty response.');
    return data;
  }, []);

  const executeRun = useCallback(async (productIds) => {
    const byId = new Map(products.map(p => [p.id, p]));

    runRef.current = {
      productIds,
      productIndex: 0,
      productTitle: byId.get(productIds[0])?.title || '',
      // Seeded from the counts already on screen so the bar is honest from the
      // first frame, then corrected with the real count per product.
      totalImages: productIds.reduce((sum, id) => sum + (byId.get(id)?.imageCount || 0), 0),
      imagesDone: 0,
      imagesOptimized: 0,
      imagesSkipped: 0,
      imagesFailed: 0,
      savedMB: 0,
      images: [],
      recent: [],
      stopping: false,
    };
    publish();

    let quotaError = null;
    let lastError = null;

    for (let i = 0; i < productIds.length; i++) {
      if (stopRef.current) break;

      const productId = productIds[i];
      const state = runRef.current;
      state.productIndex = i;
      state.productTitle = byId.get(productId)?.title || '';
      state.images = [];
      publish();

      let listing;
      try {
        listing = await callApi({ intent: 'listImages', productId });
      } catch (err) {
        lastError = err.message;
        // Drop the estimate, or its images sit in the total forever and the bar
        // can never reach 100%.
        state.totalImages -= byId.get(productId)?.imageCount || 0;
        publish();
        continue;
      }

      state.totalImages += listing.images.length - (byId.get(productId)?.imageCount || 0);
      state.productTitle = listing.title;
      state.images = listing.images.map(img => ({
        id: img.id,
        url: img.url,
        // Images already recorded are shown as done immediately rather than
        // re-sent — that resumability is what the batch path gave us for free.
        status: img.done ? 'skipped' : 'pending',
        detail: img.done ? 'Done earlier' : null,
      }));
      publish();

      // The id each slot ends up holding, so the merchant's order can be put
      // back: replacing an image appends the copy at the end, and with several
      // in flight they no longer finish in the order they started.
      const finalIds = listing.images.map(img => img.id);
      const todo = listing.images
        .map((img, index) => ({ ...img, index }))
        .filter(img => !img.done);

      // Per-product accumulators, so each row's numbers move image by image.
      let productOptimized = listing.images.length - todo.length;
      let productSaved = 0;
      const productTotal = listing.images.length;
      const pushProductProgress = () => {
        const base = byId.get(productId);
        setLiveProgress(prev => ({
          ...prev,
          [productId]: {
            ...prev[productId],
            optimized: productOptimized,
            score: productTotal > 0 ? Math.round((productOptimized / productTotal) * 100) : 0,
            sizeSavedMB: (base?.sizeSavedMB || 0) + productSaved,
            // view() reads these straight into the row, so they must always be
            // numbers. The authoritative values arrive from finalize; until then
            // the loader's own figures stand in.
            originalSizeMB: base?.totalOriginalSizeMB || 0,
            compressionRate: base?.compressionRate || 0,
          },
        }));
      };
      pushProductProgress();

      await mapLimitClient(
        todo,
        IMAGE_CONCURRENCY,
        async (image) => {
          const entry = runRef.current.images[image.index];
          entry.status = 'working';
          publish();

          let result;
          try {
            result = await callApi({ intent: 'optimizeImage', productId, imageId: image.id });
          } catch (err) {
            result = { success: false, error: err.message };
          }

          const live = runRef.current;

          // Every remaining image would return the same refusal, so stop.
          if (result.quotaExceeded) {
            quotaError = 'Monthly image quota reached. Upgrade your plan to optimize more images this month.';
            stopRef.current = true;
            entry.status = 'pending';
            publish();
            return;
          }

          if (result.success) {
            finalIds[image.index] = result.newImageId || image.id;
            live.imagesDone += 1;
            productOptimized += 1;

            if (result.skipped) {
              live.imagesSkipped += 1;
              entry.status = 'skipped';
              entry.detail = 'Already optimal';
            } else {
              live.imagesOptimized += 1;
              live.savedMB += result.savedMB || 0;
              productSaved += result.savedMB || 0;
              entry.status = 'done';
              entry.detail = `−${result.compressionRate}%`;
              live.recent = [{
                key: result.newImageId,
                text: `${listing.title} — ${formatBytes(result.originalSizeMB)} → ${formatBytes(result.optimizedSizeMB)} (−${result.compressionRate}%)`,
              }, ...live.recent].slice(0, 4);
              // Only re-encoded images are metered, so only they move the meter.
              setSessionImages(s => s + 1);
            }
          } else {
            live.imagesFailed += 1;
            lastError = result.error;
            entry.status = 'failed';
            entry.detail = result.error;
          }

          pushProductProgress();
          publish();
        },
        () => stopRef.current
      );

      // Rewrite the summary and restore the order, even for a partial product —
      // the stored numbers should describe what is on the store now.
      try {
        const { summary } = await callApi({
          intent: 'finalize',
          productId,
          order: JSON.stringify(finalIds),
        });
        if (summary) {
          setLiveProgress(prev => ({
            ...prev,
            [productId]: {
              optimized: summary.processed,
              score: summary.totalImages > 0
                ? Math.round((summary.processed / summary.totalImages) * 100)
                : 0,
              originalSizeMB: summary.totalOriginalSizeMB,
              sizeSavedMB: summary.totalSizeSavedMB,
              compressionRate: summary.avgCompressionRate,
              needsOptimization: summary.processed < summary.totalImages,
            },
          }));
        }
      } catch (err) {
        console.error('Could not finalize', productId, err);
      }
    }

    const final = runRef.current;
    const stoppedByUser = final.stopping;

    runRef.current = null;
    stopRef.current = false;
    setRun(null);

    if (final.imagesDone === 0 && final.imagesFailed === 0) {
      if (stoppedByUser && !quotaError) {
        setSuccessMessage('Stopped — nothing was changed.');
        setTimeout(() => setSuccessMessage(null), 6000);
      } else {
        setError(quotaError || lastError || 'Nothing was optimized.');
      }
    } else if (final.imagesDone === 0) {
      setError(lastError || 'None of the images could be optimized.');
    } else {
      const parts = [];
      if (final.imagesOptimized > 0) {
        parts.push(`Optimized ${final.imagesOptimized} image${final.imagesOptimized > 1 ? 's' : ''} — saved ${formatBytes(final.savedMB)}.`);
      }
      if (final.imagesSkipped > 0) {
        parts.push(`${final.imagesSkipped} image${final.imagesSkipped > 1 ? 's were' : ' was'} already as small as possible.`);
      }
      if (final.imagesFailed > 0) parts.push(`${final.imagesFailed} could not be processed — ${lastError}`);
      if (quotaError) parts.push(quotaError);
      else if (stoppedByUser) parts.push('You stopped the run; the rest were left alone.');

      setSuccessMessage(parts.join(' '));
      setTimeout(() => setSuccessMessage(null), 12000);
    }

    // Quietly refresh in place: the loader for the usage meter, /api/catalog for
    // the new scores and sizes. liveProgress stays authoritative for display, so
    // read-after-write metafield lag can't flip a finished product back to
    // "needs optimization". Splitting these is why the meter updates
    // immediately instead of waiting on a full catalog rebuild.
    revalidator.revalidate();
    refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, callApi, publish, revalidator, refreshCatalog]);

  // Reflect the saved auto-optimize setting (or surface a gating error).
  useEffect(() => {
    if (settingsFetcher.state !== 'idle' || !settingsFetcher.data) return;
    const d = settingsFetcher.data;
    if (!d.settingUpdated) return;
    if (d.success) {
      setAutoOptimize(d.autoOptimize);
    } else {
      setError(d.error || 'Could not update setting.');
      setAutoOptimize(false); // revert optimistic flip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFetcher.state, settingsFetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || runRef.current) return;
    setError(null);
    setSuccessMessage(null);
    stopRef.current = false;
    executeRun(ids).catch((err) => {
      // A throw here would leave the page showing progress forever.
      console.error('Optimization run crashed:', err);
      runRef.current = null;
      stopRef.current = false;
      setRun(null);
      setError(err.message || 'The optimization run stopped unexpectedly.');
      revalidator.revalidate();
    });
  }, [executeRun, revalidator]);

  const handleStopRun = useCallback(() => {
    stopRef.current = true;
    if (runRef.current) {
      runRef.current.stopping = true;
      publish();
    }
  }, [publish]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleToggleAutoOptimize = useCallback((checked) => {
    setAutoOptimize(checked); // optimistic
    setError(null);
    settingsFetcher.submit(
      { actionType: 'setAutoOptimize', enabled: String(checked) },
      { method: 'post' }
    );
  }, [settingsFetcher]);

  // Live counts for the segmented filter, so the merchant can see how many
  // products are in each bucket without switching to it.
  const filterCounts = useMemo(() => ({
    all: products.length,
    needs_optimization: products.filter(p => p.needsOptimization).length,
    optimized: products.filter(p => !p.needsOptimization).length,
    no_alt_text: products.filter(p => p.imagesWithAlt === 0).length,
  }), [products]);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  // Queue everything in the current view that still needs work. This only
  // SELECTS — the run itself still has to be started from the action bar, so a
  // single click can never spend a merchant's whole monthly quota.
  const handleSelectNeedsWork = useCallback(() => {
    setSelectedProducts(displayedProducts.filter(p => p.needsOptimization).map(p => p.id));
  }, [displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isRunning = run !== null;
  const isBusy = isRunning || revalidator.state !== 'idle';
  const activeId = run ? run.productIds[run.productIndex] : null;

  const imagesSettled = run ? run.imagesDone + run.imagesFailed : 0;
  const progress = run && run.totalImages > 0
    ? Math.min(100, Math.round((imagesSettled / run.totalImages) * 100))
    : 0;
  const productImagesSettled = run
    ? run.images.filter(i => i.status !== 'pending' && i.status !== 'working').length
    : 0;

  // Usage meter: loader baseline + images optimized live this session.
  const quota = plan?.monthlyImages ?? 100;
  const usedImages = (usage?.imagesUsed ?? 0) + sessionImages;
  const usagePct = quota > 0 ? Math.min(100, Math.round((usedImages / quota) * 100)) : 0;
  const quotaReached = usedImages >= quota;

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  const allDisplayedSelected =
    selectedProducts.length === displayedProducts.length && displayedProducts.length > 0;

  return (
    <Page>
      <CommandBar
        title="Optimizer"
        subtitle="WebP conversion and smart compression — originals are replaced in place and your image order is restored after every run."
      >
        <Button
          onClick={refreshCatalog}
          loading={catalogFetcher.state === 'loading'}
          disabled={isRunning}
        >
          Refresh
        </Button>
        <Button
          variant="primary"
          onClick={handleSelectNeedsWork}
          disabled={isBusy || quotaReached || filterCounts.needs_optimization === 0}
        >
          Select all needing work
        </Button>
      </CommandBar>

      {/* ── Live run rail ─────────────────────────────────────────────── */}
      {isRunning && (
        <div className="px-run">
          <div className="px-run-head">
            <p className="px-run-title">
              {run.stopping
                ? 'Finishing the images already started…'
                : run.images.length > 0
                  ? `Optimizing image ${Math.min(productImagesSettled + 1, run.images.length)} of ${run.images.length}`
                  : 'Reading the product’s images…'}
            </p>
            <div className="px-bar-aside">
              <span className="px-run-pct">{`${progress}%`}</span>
              {!run.stopping && (
                <Button variant="tertiary" onClick={handleStopRun}>Stop</Button>
              )}
            </div>
          </div>
          <div className="px-run-body">
            <Meter value={progress} showValue={false} label="Run progress" />

            <p className="px-run-line">
              {run.productTitle ? <strong>{run.productTitle}</strong> : 'Starting…'}
              {run.productIds.length > 1 &&
                ` · product ${run.productIndex + 1} of ${run.productIds.length}`}
            </p>

            {/* One chip per image, so "how many are done" is something the
                merchant can see rather than infer from a spinner. */}
            {run.images.length > 0 && (
              <div className="px-chips">
                {run.images.map((image, index) => (
                  <div
                    key={image.id}
                    className={`px-chip px-chip--${image.status}`}
                    title={
                      image.detail
                        ? `Image ${index + 1}: ${image.detail}`
                        : `Image ${index + 1}: ${image.status}`
                    }
                  >
                    <img src={image.url} alt="" />
                  </div>
                ))}
              </div>
            )}

            <p className="px-run-line">
              {`${imagesSettled} of ${run.totalImages} image${run.totalImages === 1 ? '' : 's'} done`}
              {run.imagesOptimized > 0 && ` · ${formatBytes(run.savedMB)} saved`}
              {run.imagesSkipped > 0 && ` · ${run.imagesSkipped} already optimal`}
              {run.imagesFailed > 0 && ` · ${run.imagesFailed} failed`}
            </p>

            {run.recent.length > 0 && (
              <div className="px-run-log">
                {run.recent.map((entry) => (
                  <p className="px-run-log-item" key={entry.key}>{entry.text}</p>
                ))}
              </div>
            )}

            <p className="px-run-line">
              {`Up to ${IMAGE_CONCURRENCY} images are processed at a time. Each one is downloaded, re-compressed and uploaded back to Shopify, so please keep this page open.`}
            </p>
          </div>
        </div>
      )}

      {/* Errors and successes stay as Polaris Banners on purpose: a merchant
          already recognises that treatment from the rest of the admin, and a
          bespoke flat variant of an error message is a bad place to be
          original. */}
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
        </div>
      )}
      {successMessage && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Done" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
        </div>
      )}

      <KpiStrip
        items={[
          { label: 'Products', value: formatNumber(stats.total) },
          {
            label: 'Needs work',
            value: formatNumber(stats.needsOptimization),
            tone: stats.needsOptimization > 0 ? 'bad' : 'ok',
          },
          { label: 'Images', value: formatNumber(stats.totalImages) },
          { label: 'Saved so far', value: formatBytes(liveSavings), tone: 'ok' },
        ]}
      />

      {/* ── Quota + automation, side by side in one settings panel ────── */}
      <Panel
        title={`Monthly quota · ${plan?.name || 'Free'} plan`}
        note={quotaReached ? 'Quota reached — upgrade to optimize more this month.' : undefined}
        padded
      >
        <div className="px-quota" style={{ marginBottom: 16 }}>
          <Meter
            value={usagePct}
            tone={quotaReached ? 'bad' : usagePct >= 80 ? 'warn' : undefined}
            label="Monthly image quota used"
          />
          <span className="px-kpi-note">
            {`${formatNumber(usedImages)} of ${formatNumber(quota)} images this month`}
          </span>
        </div>

        {plan?.autoOptimizeAllowed ? (
          <Checkbox
            label="Auto-optimize images on newly created products"
            helpText="Set and forget — new products are optimized in the background as they are created."
            checked={autoOptimize}
            onChange={handleToggleAutoOptimize}
            disabled={settingsFetcher.state !== 'idle'}
          />
        ) : (
          <p className="px-launch-desc">
            <Tag tone="warn">Growth &amp; up</Tag>{' '}
            Background auto-optimization of newly created products is available on the Growth plan and above.
          </p>
        )}
      </Panel>

      {/* ── Product table ─────────────────────────────────────────────── */}
      <Panel
        title="Products"
        actions={
          <div className="px-bar-aside" style={{ flexWrap: 'wrap' }}>
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              disabled={isBusy}
              options={[
                { label: 'All', value: 'all', count: filterCounts.all },
                { label: 'Needs work', value: 'needs_optimization', count: filterCounts.needs_optimization },
                { label: 'Done', value: 'optimized', count: filterCounts.optimized },
                { label: 'No alt', value: 'no_alt_text', count: filterCounts.no_alt_text },
              ]}
            />
            <Segmented
              label="Sort"
              value={sortBy}
              onChange={setSortBy}
              disabled={isBusy}
              options={SORT_OPTIONS}
            />
          </div>
        }
      >
        {catalogLoading ? (
          <>
            <Table variant="products">
              <Thead columns={PRODUCT_COLUMNS} />
            </Table>
            <SkeletonRows variant="products" columns={PRODUCT_COLUMNS.length} rows={6} />
            <div className="px-panel-foot">
              <Spinner accessibilityLabel="Loading your products" size="small" />{' '}
              Loading your products and measuring image sizes…
            </div>
          </>
        ) : displayedProducts.length === 0 ? (
          <EmptyState title="No products in this view">
            {products.length === 0
              ? 'Add products with images to your store, then come back here to optimize them.'
              : 'Try a different filter to see products.'}
          </EmptyState>
        ) : (
          <Table variant="products">
            <div className="px-tr px-thead">
              <div className="px-th">
                <Checkbox
                  label={`Select all ${displayedProducts.length} products in view`}
                  labelHidden
                  checked={allDisplayedSelected}
                  onChange={handleSelectAll}
                  disabled={isBusy}
                />
              </div>
              {PRODUCT_COLUMNS.slice(1).map((col) => (
                <div
                  key={col.key}
                  className={['px-th', col.className, col.align === 'right' ? 'px-td--num' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  {col.label}
                </div>
              ))}
            </div>

            {displayedProducts.map((raw) => {
              const product = view(raw);
              const isActive = activeId === product.id;
              // The product being worked on expands itself, so the image chips
              // are visible without the merchant having to find the row.
              const isExpanded = expandedId === product.id || isActive;
              const selected = selectedProducts.includes(product.id);

              return (
                <div key={product.id}>
                  <Row selected={selected} active={isActive}>
                    <div className="px-td">
                      <Checkbox
                        label={`Select ${product.title}`}
                        labelHidden
                        checked={selected}
                        onChange={() => handleSelectProduct(product.id)}
                        disabled={isBusy}
                      />
                    </div>
                    <div className="px-td px-col-thumb">
                      {product.featuredImageUrl ? (
                        <img className="px-thumb" src={product.featuredImageUrl} alt="" />
                      ) : (
                        <span className="px-thumb" aria-hidden="true" />
                      )}
                    </div>
                    <div className="px-td">
                      <p className="px-td-strong" title={product.title}>{product.title}</p>
                      <p className="px-td-meta">
                        {product.status}
                        {` · ${product.imagesWithAlt}/${product.imageCount} with alt`}
                        {isActive && ' · optimizing…'}
                        {' · '}
                        <button
                          type="button"
                          className="px-disclose"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedId(expandedId === product.id ? null : product.id)
                          }
                        >
                          <span className="px-disclose-caret">{isExpanded ? '▾' : '▸'}</span>
                          details
                        </button>
                      </p>
                    </div>
                    <div className="px-td px-td--num px-col-images">{product.imageCount}</div>
                    <div className="px-td px-td--num px-col-size">
                      {formatBytes(product.totalOriginalSizeMB)}
                    </div>
                    <div className="px-td px-td--num px-col-saved px-td-ok">
                      {formatBytes(product.sizeSavedMB)}
                    </div>
                    <div className="px-td">
                      <Meter
                        value={product.score}
                        tone={scoreTone(product.score)}
                        label={`${product.title} optimization progress`}
                      />
                    </div>
                    <div className="px-td px-td--right px-col-action">
                      {product.needsOptimization ? (
                        <Button
                          variant="primary"
                          size="slim"
                          onClick={() => handleOptimizeProduct(product.id)}
                          loading={isActive}
                          disabled={isBusy || quotaReached}
                        >
                          {isActive ? 'Running' : 'Optimize'}
                        </Button>
                      ) : (
                        <Tag tone="ok" dot>Done</Tag>
                      )}
                    </div>
                  </Row>

                  {isExpanded && (
                    <div className="px-expand">
                      <div className="px-expand-grid">
                        <div>
                          <p className="px-expand-k">Images with alt</p>
                          <p className="px-expand-v">{`${product.imagesWithAlt} / ${product.imageCount}`}</p>
                        </div>
                        <div>
                          <p className="px-expand-k">Optimized</p>
                          <p className="px-expand-v">{`${product.optimizedImages} / ${product.imageCount}`}</p>
                        </div>
                        <div>
                          <p className="px-expand-k">Original size</p>
                          <p className="px-expand-v">{formatBytes(product.totalOriginalSizeMB)}</p>
                        </div>
                        <div>
                          <p className="px-expand-k">Saved</p>
                          <p className="px-expand-v px-td-ok">
                            {`${formatBytes(product.sizeSavedMB)} (${product.compressionRate}%)`}
                          </p>
                        </div>
                        <div>
                          <p className="px-expand-k">Status</p>
                          <p className="px-expand-v">{product.status}</p>
                        </div>
                      </div>

                      {isActive && run.images.length > 0 && (
                        <div className="px-chips">
                          {run.images.map((image, index) => (
                            <div
                              key={image.id}
                              className={`px-chip px-chip--${image.status}`}
                              title={
                                image.detail
                                  ? `Image ${index + 1}: ${image.detail}`
                                  : `Image ${index + 1}: ${image.status}`
                              }
                            >
                              <img src={image.url} alt="" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Table>
        )}
      </Panel>

      {/* ── Sticky bulk action bar ────────────────────────────────────── */}
      {selectedProducts.length > 0 && (
        <ActionBar
          text={`${selectedProducts.length} product${selectedProducts.length === 1 ? '' : 's'} selected`}
          note={
            quotaReached
              ? 'Monthly quota reached — upgrade to run this.'
              : 'Images already optimized are skipped, so re-running is free.'
          }
        >
          <button
            type="button"
            className="px-btn-ghost"
            onClick={() => setSelectedProducts([])}
          >
            Clear
          </button>
          <Button
            variant="primary"
            onClick={handleOptimizeSelected}
            loading={isBusy}
            disabled={isBusy || quotaReached}
          >
            Optimize selected
          </Button>
        </ActionBar>
      )}
    </Page>
  );
}
