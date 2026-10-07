import { useState, useCallback, useEffect } from 'react';
import { useLoaderData, useSubmit, useActionData, useNavigation } from 'react-router';
import { authenticate } from '../shopify.server';
import { Page, Button, Banner } from '@shopify/polaris';
import {
  CommandBar,
  KpiStrip,
  Segmented,
  Panel,
  Meter,
  Tag,
  Table,
  Thead,
  Row,
  EmptyState,
  formatBytes,
  formatNumber,
} from '../components/ui';

/**
 * Helper function to calculate date ranges
 */
function getDateRange(timeRange) {
  const now = new Date();
  const date = new Date(now);

  switch (timeRange) {
    case '7days':
      date.setDate(date.getDate() - 7);
      break;
    case '30days':
      date.setDate(date.getDate() - 30);
      break;
    case '90days':
      date.setDate(date.getDate() - 90);
      break;
    case 'all':
      date.setFullYear(2020, 0, 1);
      break;
    default:
      date.setDate(date.getDate() - 30);
  }

  return date;
}

// NOTE: this asks for `media`, not `images`, and that distinction is the whole
// reason the dashboard works.
//
// The optimizer keys its per-image metafields off the MediaImage id
// (`image_<MediaImage id>` — see imageKey() in optimize.server.js, which reads
// from a media query). `product.images` returns the legacy ProductImage id
// instead, a completely different id space for the same photo. Requesting
// `images` here makes the lookup below build `image_<ProductImage id>`, which
// can never match a key written as `image_<MediaImage id>` — every record
// misses and the dashboard reports 0 optimized images on a store with hundreds
// genuinely optimized.
//
// metafields is also 250, not 20: the optimizer writes one metafield per image
// plus a summary, so 20 silently truncates the records for any product with
// more than nineteen images.
async function fetchAllProducts(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            media(first: 250) {
              edges {
                node {
                  ... on MediaImage {
                    id
                    image {
                      url
                      altText
                      width
                      height
                    }
                  }
                }
              }
            }
            metafields(first: 250, namespace: "image_optimization") {
              edges {
                node {
                  key
                  value
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { cursor }
  });

  return await response.json();
}

async function getAllProducts(admin) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await fetchAllProducts(admin, cursor);
    // push rather than rebuild: spreading the accumulator each page re-copies
    // every product already fetched, which is quadratic on a large catalog.
    for (const edge of data.data.products.edges) allProducts.push(edge.node);

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return allProducts;
}

/**
 * Get image format from URL
 */
function getImageFormat(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.webp')) return 'WebP';
  if (urlLower.includes('.png')) return 'PNG';
  if (urlLower.includes('.gif')) return 'GIF';
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'JPEG';
  return 'JPEG';
}

/**
 * Process products data into metrics. Only the sizes measured by the optimizer
 * (stored on per-image metafields) are counted — no estimated sizes, so every
 * number shown to the merchant reflects actual before/after file sizes.
 */
function processProductsData(products, timeRange) {
  const startDate = getDateRange(timeRange);

  let totalImages = 0;
  let optimizedImages = 0;
  let totalOriginalSizeMB = 0;
  let totalOptimizedSizeMB = 0;
  let formatStats = {};
  let recentActivityMap = {};
  let pageStats = [];

  products.forEach(product => {
    // Flatten MediaImage nodes to the shape the loop below expects. `id` stays
    // the MediaImage gid so it matches the metafield keys the optimizer writes.
    // Non-image media (video, 3D models) come back as empty objects from the
    // inline fragment and are dropped.
    const images = (product.media?.edges || [])
      .map(edge => edge.node)
      .filter(node => node && node.id && node.image?.url)
      .map(node => ({
        id: node.id,
        url: node.image.url,
        altText: node.image.altText,
        width: node.image.width,
        height: node.image.height,
      }));
    const productUrl = `/products/${product.handle}`;

    let pageImageCount = 0;
    let pageSizeSaved = 0;
    let pageOriginalSize = 0;

    images.forEach(image => {
      totalImages++;

      const format = getImageFormat(image.url);
      if (!formatStats[format]) {
        formatStats[format] = {
          format,
          count: 0,
          originalSizeMB: 0,
          optimizedSizeMB: 0
        };
      }
      formatStats[format].count++;

      const imageKey = `image_${image.id.split('/').pop()}`;
      const optimizationData = product.metafields.edges.find(
        edge => edge.node.key === imageKey
      );

      if (!optimizationData) return;

      try {
        const optData = JSON.parse(optimizationData.node.value);
        if (typeof optData.originalSizeMB !== 'number' || typeof optData.optimizedSizeMB !== 'number') {
          return;
        }

        const originalSizeMB = optData.originalSizeMB;
        const optimizedSizeMB = optData.optimizedSizeMB;
        const updatedAt = new Date(optData.optimizedAt || optimizationData.node.updatedAt);

        if (updatedAt < startDate) return;

        optimizedImages++;
        totalOriginalSizeMB += originalSizeMB;
        totalOptimizedSizeMB += optimizedSizeMB;
        formatStats[format].originalSizeMB += originalSizeMB;
        formatStats[format].optimizedSizeMB += optimizedSizeMB;

        pageImageCount++;
        pageSizeSaved += (originalSizeMB - optimizedSizeMB);
        pageOriginalSize += originalSizeMB;

        const dateKey = updatedAt.toISOString().split('T')[0];
        if (!recentActivityMap[dateKey]) {
          recentActivityMap[dateKey] = {
            date: dateKey,
            imagesOptimized: 0,
            sizeSavedMB: 0,
            totalOriginalMB: 0,
            totalOptimizedMB: 0
          };
        }

        recentActivityMap[dateKey].imagesOptimized++;
        recentActivityMap[dateKey].sizeSavedMB += (originalSizeMB - optimizedSizeMB);
        recentActivityMap[dateKey].totalOriginalMB += originalSizeMB;
        recentActivityMap[dateKey].totalOptimizedMB += optimizedSizeMB;
      } catch (e) {
        // Unreadable optimization record — leave the image out of the totals.
      }
    });

    if (pageImageCount > 0) {
      const sizeReductionPercent = pageOriginalSize > 0
        ? Math.min(Math.round((pageSizeSaved / pageOriginalSize) * 100), 100)
        : 0;

      let impact = 'low';
      if (pageSizeSaved > 2.5) impact = 'high';
      else if (pageSizeSaved > 1) impact = 'medium';

      pageStats.push({
        url: productUrl,
        productTitle: product.title,
        imagesCount: pageImageCount,
        sizeSavedMB: pageSizeSaved,
        sizeReductionPercent,
        impact
      });
    }
  });

  const totalSavingsMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const avgCompressionRate = totalOriginalSizeMB > 0
    ? Math.round((totalSavingsMB / totalOriginalSizeMB) * 100)
    : 0;

  const recentActivity = Object.values(recentActivityMap)
    .map(day => ({
      ...day,
      compressionRate: day.totalOriginalMB > 0
        ? Math.round(((day.totalOriginalMB - day.totalOptimizedMB) / day.totalOriginalMB) * 100)
        : 0
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  const topPages = pageStats
    .sort((a, b) => b.sizeSavedMB - a.sizeSavedMB)
    .slice(0, 10);

  return {
    metrics: {
      totalImages,
      optimizedImages,
      totalSavingsMB,
      totalOriginalSizeMB,
      totalOptimizedSizeMB,
      avgCompressionRate
    },
    byFormat: Object.values(formatStats).sort((a, b) => b.count - a.count),
    recentActivity,
    topPages
  };
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const timeRange = url.searchParams.get('timeRange') || '30days';

  try {
    const products = await getAllProducts(admin);
    const { metrics, byFormat, recentActivity, topPages } = processProductsData(products, timeRange);

    return {
      metrics,
      byFormat,
      recentActivity,
      topPages,
      timeRange,
      error: null
    };
  } catch (error) {
    console.error('Error loading dashboard data:', error);
    return {
      metrics: {
        totalImages: 0,
        optimizedImages: 0,
        totalSavingsMB: 0,
        totalOriginalSizeMB: 0,
        totalOptimizedSizeMB: 0,
        avgCompressionRate: 0
      },
      byFormat: [],
      recentActivity: [],
      topPages: [],
      timeRange,
      error: 'Failed to load dashboard data'
    };
  }
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'exportReport') {
    const timeRange = formData.get('timeRange');

    try {
      const products = await getAllProducts(admin);
      const { metrics, byFormat, recentActivity, topPages } = processProductsData(products, timeRange);

      const csvRows = [
        ['PixelPro Max — Image Optimization Report'],
        ['Generated:', new Date().toLocaleString()],
        ['Time Range:', timeRange],
        [''],
        ['Overview Metrics'],
        ['Metric', 'Value'],
        ['Total Images', metrics.totalImages],
        ['Optimized Images', metrics.optimizedImages],
        ['Optimization Rate', `${Math.round((metrics.optimizedImages / Math.max(metrics.totalImages, 1)) * 100)}%`],
        ['Measured Original Size (MB)', metrics.totalOriginalSizeMB.toFixed(2)],
        ['Measured Optimized Size (MB)', metrics.totalOptimizedSizeMB.toFixed(2)],
        ['Total Savings (MB)', metrics.totalSavingsMB.toFixed(2)],
        ['Average Compression Rate', `${metrics.avgCompressionRate}%`],
        [''],
        ['Format Breakdown'],
        ['Format', 'Count', 'Original Size (MB)', 'Optimized Size (MB)', 'Savings (MB)', 'Compression Rate'],
        ...byFormat.map(f => [
          f.format,
          f.count,
          f.originalSizeMB.toFixed(2),
          f.optimizedSizeMB.toFixed(2),
          (f.originalSizeMB - f.optimizedSizeMB).toFixed(2),
          // Guard the divide: a format with images but no optimization records
          // has originalSizeMB === 0, which rendered as "NaN%" in the CSV.
          f.originalSizeMB > 0
            ? `${Math.round(((f.originalSizeMB - f.optimizedSizeMB) / f.originalSizeMB) * 100)}%`
            : '0%'
        ]),
        [''],
        ['Recent Activity'],
        ['Date', 'Images Optimized', 'Size Saved (MB)', 'Compression Rate'],
        ...recentActivity.map(a => [
          new Date(a.date).toLocaleDateString(),
          a.imagesOptimized,
          a.sizeSavedMB.toFixed(2),
          `${a.compressionRate}%`
        ]),
        [''],
        ['Top Optimized Pages'],
        ['Product', 'URL', 'Images', 'Size Saved (MB)', 'Size Reduction', 'Impact'],
        ...topPages.map(p => [
          p.productTitle || 'Unknown',
          p.url,
          p.imagesCount,
          p.sizeSavedMB.toFixed(2),
          `${p.sizeReductionPercent}%`,
          p.impact.toUpperCase()
        ])
      ];

      const csv = csvRows.map(row =>
        row.map(cell =>
          typeof cell === 'string' && cell.includes(',') ? `"${cell}"` : cell
        ).join(',')
      ).join('\n');

      return {
        success: true,
        csv,
        filename: `pixelpro-max-report-${timeRange}-${Date.now()}.csv`
      };
    } catch (error) {
      console.error('Error generating report:', error);
      return { success: false, error: 'Failed to generate report' };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

const TIME_RANGE_OPTIONS = [
  { label: '7 days', value: '7days' },
  { label: '30 days', value: '30days' },
  { label: '90 days', value: '90days' },
  { label: 'All time', value: 'all' },
];

const FORMAT_COLUMNS = [
  { key: 'format', label: 'Format' },
  { key: 'count', label: 'Images', align: 'right' },
  { key: 'reduction', label: 'Reduction' },
  { key: 'saved', label: 'Saved', align: 'right' },
  { key: 'rate', label: 'Rate', align: 'right' },
];

const PAGE_COLUMNS = [
  { key: 'page', label: 'Product page' },
  { key: 'images', label: 'Imgs', align: 'right' },
  { key: 'before', label: 'Before', className: 'px-col-before', align: 'right' },
  { key: 'after', label: 'After', className: 'px-col-after', align: 'right' },
  { key: 'saved', label: 'Saved', align: 'right' },
  { key: 'impact', label: 'Impact', align: 'right' },
];

const IMPACT_TONE = { high: 'ok', medium: 'warn', low: 'info' };

export default function ImageOptimizationDashboard() {
  const {
    metrics,
    byFormat,
    recentActivity,
    topPages,
    timeRange: initialTimeRange,
    error: loadError
  } = useLoaderData();

  const submit = useSubmit();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [timeRange, setTimeRange] = useState(initialTimeRange);

  // The CSV is turned into a blob URL offered as a real link rather than a
  // synthetic anchor click: this page runs inside Shopify's admin iframe, where
  // a programmatic download is at the mercy of the frame's sandbox, while a
  // genuine user click on an <a download> is not.
  //
  // Reading useActionData here is also what makes the button work at all — an
  // action that builds the CSV and returns it does nothing visible if no
  // component reads the result.
  const [reportUrl, setReportUrl] = useState(null);
  useEffect(() => {
    if (!actionData?.success || !actionData.csv) {
      setReportUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(
      new Blob([actionData.csv], { type: 'text/csv;charset=utf-8;' })
    );
    setReportUrl(url);
    // Revoked on replacement/unmount so repeated exports don't leak blobs.
    return () => URL.revokeObjectURL(url);
  }, [actionData]);

  // Building the report walks the full product catalog, which is slow on a
  // large store. Without this the button gives no sign it is working.
  const isExporting =
    navigation.state === 'submitting' &&
    navigation.formData?.get('actionType') === 'exportReport';

  const handleTimeRangeChange = useCallback((value) => {
    setTimeRange(value);
    submit({ timeRange: value }, { method: 'get' });
  }, [submit]);

  const handleExportReport = useCallback(() => {
    const formData = new FormData();
    formData.append('actionType', 'exportReport');
    formData.append('timeRange', timeRange);
    submit(formData, { method: 'post' });
  }, [timeRange, submit]);

  const optimizationRate = metrics.totalImages > 0
    ? Math.round((metrics.optimizedImages / metrics.totalImages) * 100)
    : 0;

  const isReloading = navigation.state === 'loading';

  return (
    <Page>
      <CommandBar
        title="Analytics"
        subtitle="Measured results from your optimization runs. Every figure here comes from the actual file sizes recorded before and after compression — nothing is estimated."
      >
        <Button url="/app/productoptimization">Open optimizer</Button>
        <Button variant="primary" onClick={handleExportReport} loading={isExporting}>
          Export CSV
        </Button>
      </CommandBar>

      {loadError && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Error" tone="critical">{loadError}</Banner>
        </div>
      )}
      {actionData?.success === false && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Couldn't build the report" tone="critical">{actionData.error}</Banner>
        </div>
      )}
      {reportUrl && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="success" title="Your report is ready">
            <a href={reportUrl} download={actionData?.filename || 'report.csv'}>
              Download CSV
            </a>
          </Banner>
        </div>
      )}

      <Panel
        title="Reporting window"
        note={isReloading ? 'Recalculating…' : undefined}
        actions={
          <Segmented
            label=""
            value={timeRange}
            onChange={handleTimeRangeChange}
            disabled={isReloading}
            options={TIME_RANGE_OPTIONS}
          />
        }
      >
        <KpiStrip
          items={[
            {
              label: 'Images',
              value: formatNumber(metrics.totalImages),
              note: `${formatNumber(metrics.optimizedImages)} optimized · ${optimizationRate}%`,
            },
            { label: 'Total saved', value: formatBytes(metrics.totalSavingsMB), tone: 'ok' },
            {
              label: 'Avg compression',
              value: `${metrics.avgCompressionRate}%`,
              tone: 'ok',
            },
            {
              label: 'Payload',
              value: `${formatBytes(metrics.totalOriginalSizeMB)} → ${formatBytes(metrics.totalOptimizedSizeMB)}`,
              note: 'measured before → after',
            },
          ]}
        />
      </Panel>

      {metrics.totalImages === 0 && (
        <div style={{ marginBottom: 16 }}>
          <Banner title="Nothing measured yet" tone="info">
            Run the optimizer on a product and its measured before/after sizes will appear here.
          </Banner>
        </div>
      )}

      <Panel title="By format" note="Only images with a recorded optimization are counted.">
        {byFormat.length === 0 ? (
          <EmptyState title="No format data yet">
            Formats appear once at least one image has been optimized in this window.
          </EmptyState>
        ) : (
          <Table variant="formats">
            <Thead columns={FORMAT_COLUMNS} />
            {byFormat.map((format) => {
              const savings = format.originalSizeMB - format.optimizedSizeMB;
              const compressionPercent = format.originalSizeMB > 0
                ? Math.round((savings / format.originalSizeMB) * 100)
                : 0;
              return (
                <Row key={format.format}>
                  <div className="px-td px-td-strong">{format.format}</div>
                  <div className="px-td px-td--num">{formatNumber(format.count)}</div>
                  <div className="px-td">
                    <Meter value={compressionPercent} tone="ok" showValue={false} label={`${format.format} reduction`} />
                  </div>
                  <div className="px-td px-td--num px-td-ok">{formatBytes(savings)}</div>
                  <div className="px-td px-td--num">{`${compressionPercent}%`}</div>
                </Row>
              );
            })}
          </Table>
        )}
      </Panel>

      <Panel title="Recent activity" note="Last five days with recorded optimizations.">
        {recentActivity.length === 0 ? (
          <EmptyState title="No activity in this window">
            Widen the reporting window, or run the optimizer to record some.
          </EmptyState>
        ) : (
          <div className="px-notes">
            {recentActivity.map((day) => (
              <div className="px-note" key={day.date}>
                <span className="px-dot px-dot--brand px-note-dot" aria-hidden="true" />
                <div>
                  <p className="px-note-title">
                    {`${formatNumber(day.imagesOptimized)} image${day.imagesOptimized === 1 ? '' : 's'} optimized`}
                  </p>
                  <p className="px-note-body">
                    {new Date(day.date).toLocaleDateString()}
                    {` · ${day.compressionRate}% average compression`}
                  </p>
                </div>
                <Tag tone="ok">{formatBytes(day.sizeSavedMB)}</Tag>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Top optimized pages" note="Ranked by measured bytes saved.">
        {topPages.length === 0 ? (
          <EmptyState title="No pages to rank yet">
            Optimize a product and its page will appear here with its measured saving.
          </EmptyState>
        ) : (
          <Table variant="pages">
            <Thead columns={PAGE_COLUMNS} />
            {topPages.map((page) => {
              // The loader records saved + reduction%, not the raw before/after
              // pair, so the two are reconstructed from them. reduction is
              // capped at 100 upstream, which keeps this divide safe.
              const before = page.sizeReductionPercent > 0
                ? page.sizeSavedMB / (page.sizeReductionPercent / 100)
                : 0;
              const after = Math.max(0, before - page.sizeSavedMB);
              return (
                <Row key={page.url}>
                  <div className="px-td">
                    <p className="px-td-strong" title={page.productTitle}>{page.productTitle}</p>
                    <p className="px-td-meta">{page.url}</p>
                  </div>
                  <div className="px-td px-td--num">{page.imagesCount}</div>
                  <div className="px-td px-td--num px-col-before">{formatBytes(before)}</div>
                  <div className="px-td px-td--num px-col-after">{formatBytes(after)}</div>
                  <div className="px-td px-td--num px-td-ok">
                    {`${formatBytes(page.sizeSavedMB)} (${page.sizeReductionPercent}%)`}
                  </div>
                  <div className="px-td px-td--right">
                    <Tag tone={IMPACT_TONE[page.impact] || 'info'} dot>
                      {page.impact}
                    </Tag>
                  </div>
                </Row>
              );
            })}
          </Table>
        )}
      </Panel>
    </Page>
  );
}
