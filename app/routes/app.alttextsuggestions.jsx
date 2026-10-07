import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData, useFetcher, redirect } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { entitled } from '../plans.server';
import { visionUrl } from '../optimize.server';
import { setDefaultResultOrder } from 'node:dns';
import {
  Page,
  Button,
  Checkbox,
  Banner,
  Pagination,
} from '@shopify/polaris';
import {
  CommandBar,
  KpiStrip,
  Segmented,
  Panel,
  Meter,
  Tag,
  Table,
  Row,
  EmptyState,
  ActionBar,
  formatNumber,
} from '../components/ui';

// AI alt text is a Starter+ feature. Returns whether the shop's plan includes it;
// lets a re-auth Response propagate, treats other failures as not-entitled.
async function altTextAllowed(admin, shop) {
  try {
    const { plan } = await getBillingStateCached(admin, shop);
    return entitled(plan, 'altText');
  } catch (e) {
    if (e instanceof Response) throw e;
    return false;
  }
}

const PAGE_SIZE = 20;

// How many images the client asks the server to caption per request. Small
// batches keep every request short (a few seconds) so they never hit a proxy
// or browser timeout — the client drives the loop and shows live progress.
const GEN_BATCH_SIZE = 5;

// Prefer IPv4 + cap every upstream call so a slow OpenAI/CDN response can never
// stall a request indefinitely. A monolithic flow with no cap hangs for minutes
// and makes the feature look broken.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder('ipv4first'); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Verify the key with a real completion, not an auth check.
//
// An OpenAI account with no credit still authenticates — /v1/models returns
// 200 — but every completion comes back 429 insufficient_quota. Checking auth
// alone reports a dead key as healthy.
async function verifyOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, error: 'API key not configured' };

  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just: working' }]
      })
    }, 15000);

    if (response.ok) {
      return { success: true, workingModel: 'gpt-4o-mini', message: 'API key verified — using gpt-4o-mini.' };
    }
    const errorData = await response.json().catch(() => ({}));
    return { success: false, error: `API error: ${errorData.error?.message || response.status}` };
  } catch (error) {
    return { success: false, error: `Connection error: ${error.message}` };
  }
}

// Safety cap so a pathologically large catalog can't make the loader run
// forever. 200 pages x 50 products = up to 10,000 products.
const MAX_PRODUCT_PAGES = 200;

const PRODUCTS_QUERY = `#graphql
  query GetProductsWithImages($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          featuredImage { url altText }
          media(first: 250) {
            edges {
              node {
                mediaContentType
                ... on MediaImage {
                  id
                  alt
                  image { url }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: AI alt text is Starter+. Free users go back to the app home.
  if (!(await altTextAllowed(admin, session.shop))) throw redirect('/app');

  try {
    // Page through the whole catalog (metadata only, so this stays fast).
    // Alt text is generated ONCE per product (from its main image) and applied
    // to ALL of that product's images, so each row here is a PRODUCT, carrying
    // every image id so a single caption can be written to all of them.
    const rows = [];
    let cursor = null;
    let hasNextPage = true;
    let pages = 0;
    let truncated = false;

    while (hasNextPage) {
      if (pages >= MAX_PRODUCT_PAGES) { truncated = true; break; }
      const response = await admin.graphql(PRODUCTS_QUERY, { variables: { cursor } });
      const data = await response.json();
      const conn = data.data.products;

      conn.edges.forEach(({ node: product }) => {
        const productImages = product.media.edges
          .map(e => e.node)
          .filter(n => n && n.mediaContentType === 'IMAGE' && n.image?.url)
          .map(n => ({ id: n.id, url: n.image.url, alt: n.alt || '' }));
        if (productImages.length === 0) return; // nothing to caption

        // Use the merchandising "main" image for the thumbnail + AI input,
        // falling back to the first media image.
        const main = productImages.find(i => i.url === product.featuredImage?.url) || productImages[0];
        const currentAlt = product.featuredImage?.altText || main.alt || '';

        rows.push({
          id: product.id,                       // row id = product id
          productId: product.id,
          productTitle: product.title,
          url: main.url,                        // main image (thumbnail + AI)
          imageIds: productImages.map(i => i.id), // apply caption to ALL of these
          imageCount: productImages.length,
          currentAlt,
          suggestedAlt: '',
          seoScore: calculateSeoScore(currentAlt),
          status: 'pending'
        });
      });

      hasNextPage = conn.pageInfo.hasNextPage;
      cursor = conn.pageInfo.endCursor;
      pages += 1;
    }

    return { images: rows, truncated };
  } catch (error) {
    console.error('Error loading products for alt text:', error);
    return { images: [], loadError: 'Could not load product images. Please refresh to try again.' };
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: block alt-text generation for non-entitled (Free) plans.
  if (!(await altTextAllowed(admin, session.shop))) {
    return { error: 'AI alt text is available on the Starter plan and above.' };
  }
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'verifyApiKey') {
    return await verifyOpenAIKey();
  }

  // Apply one product's caption to ALL of its images (chunked under Shopify's
  // 250-file limit). Returns the first userError message, or null on success.
  async function writeAltToFiles(files) {
    const FILE_UPDATE_LIMIT = 250;
    for (let i = 0; i < files.length; i += FILE_UPDATE_LIMIT) {
      const chunk = files.slice(i, i + FILE_UPDATE_LIMIT);
      const response = await admin.graphql(
        `#graphql
          mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
              files { id alt }
              userErrors { field message }
            }
          }
        `,
        { variables: { files: chunk } }
      );
      const result = await response.json();
      // Top-level GraphQL errors (throttling, auth, bad field) leave `data` null.
      // Without this check those failures fall through as a false success.
      if (result.errors?.length) {
        return result.errors[0].message || 'Shopify rejected the alt text update.';
      }
      const err = result.data?.fileUpdate?.userErrors?.[0];
      if (err) return err.message;
    }
    return null;
  }

  // Apply a single product's caption to every image of that product.
  if (actionType === 'applyAltText') {
    const imageIds = JSON.parse(formData.get('imageIds') || '[]');
    const altText = formData.get('altText');

    try {
      const files = imageIds.map(id => ({ id, alt: altText }));
      const errMsg = await writeAltToFiles(files);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true, message: 'Alt text applied to every image on the product.' };
    } catch (error) {
      console.error('Error updating image:', error);
      return { success: false, error: 'Failed to update image alt text: ' + error.message };
    }
  }

  // Bulk apply: each update is a product's caption + all of its image ids.
  // Flatten to a flat files list (one entry per image) and write chunked.
  if (actionType === 'applyBulk') {
    const updates = JSON.parse(formData.get('updates')); // [{ imageIds, altText }]

    try {
      const files = updates.flatMap(({ imageIds, altText }) =>
        (imageIds || []).map(id => ({ id, alt: altText }))
      );
      const errMsg = await writeAltToFiles(files);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true, message: `Applied captions to ${updates.length} products (${files.length} images).` };
    } catch (error) {
      console.error('Error in bulk update:', error);
      return { success: false, error: 'Failed to update some images: ' + error.message };
    }
  }

  // Caption ONE small batch per request. The client splits pending products into
  // GEN_BATCH_SIZE chunks and calls this repeatedly, so every request stays
  // short (a few seconds) and can never time out — no matter how big the store.
  if (actionType === 'generateSuggestions') {
    try {
      const imagesData = JSON.parse(formData.get('images'));
      const aiProvider = formData.get('aiProvider') || 'openai';

      const suggestions = await Promise.all(
        imagesData.map(async (image) => {
          // The merchant explicitly chose the no-API path, so don't spend a
          // call to discover that.
          if (aiProvider === 'fallback') {
            const altText = generateSmartFallback(image.productTitle, image.url);
            return { id: image.id, suggestedAlt: altText, seoScore: calculateSeoScore(altText), usedFallback: true };
          }
          try {
            const suggestion = await generateAIAltText(image.url, image.productTitle);
            return { id: image.id, suggestedAlt: suggestion.altText, seoScore: suggestion.seoScore };
          } catch (error) {
            // The AI call failed (bad/expired key, no quota, image unreachable…).
            // Log it AND tag the row so the UI can warn the merchant instead of
            // silently passing off the truncated product title as an "AI" result.
            console.error(`AI alt text failed for image ${image.id}: ${error.message}`);
            return {
              id: image.id,
              suggestedAlt: generateSmartFallback(image.productTitle, image.url),
              seoScore: 70,
              usedFallback: true,
              aiError: error.message
            };
          }
        })
      );

      // If every image fell back, the provider is down/misconfigured — surface
      // the real reason so the merchant knows to fix their API key, not retry.
      const aiError = suggestions.find(s => s.aiError)?.aiError || null;
      const fallbackCount = suggestions.filter(s => s.usedFallback).length;
      return { success: true, kind: 'suggestions', suggestions, aiError, fallbackCount };
    } catch (error) {
      return { success: false, kind: 'suggestions', error: 'Failed to generate AI suggestions: ' + error.message };
    }
  }

  return { success: false, error: 'Invalid action' };
}

function calculateSeoScore(altText) {
  if (!altText) return 0;
  let score = 50;
  const wordCount = altText.split(' ').length;
  if (wordCount >= 5 && wordCount <= 15) score += 30;
  else if (wordCount >= 3 && wordCount <= 20) score += 15;
  if (altText.match(/\b(color|size|style|material|pattern|texture|design|quality)\b/i)) score += 10;
  if (altText.length > 20 && altText.length < 125) score += 10;
  return Math.min(score, 100);
}

// OpenAI (gpt-4o-mini vision) is the only alt-text provider. One vision API is
// one thing to fund, hold a key for, and disclose in the App Store listing.
//
// Note the failure mode this leaves. An OpenAI account with no credit still
// authenticates, but every completion comes back 429 insufficient_quota, so the
// key looks correctly configured while every image silently falls back to its
// product title. generateWithOpenAI includes the response body in the thrown
// error for exactly this reason, and the UI surfaces it when images fall back.
async function generateAIAltText(imageUrl, productTitle) {
  return await generateWithOpenAI(imageUrl, productTitle);
}

async function generateWithOpenAI(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under 125 characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`
          },
          // Narrowed CDN variant — see visionUrl() for why. The bulk generator
          // never downloads the image itself, so there is nothing else here
          // that needs the full-resolution url.
          { type: 'image_url', image_url: { url: visionUrl(imageUrl) } }
        ]
      }]
    })
  }, 25000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  let altText = result.choices[0]?.message?.content?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';

  return { altText, seoScore: calculateSeoScore(altText) };
}

function generateSmartFallback(productTitle, imageUrl) {
  const titleWords = productTitle.toLowerCase();
  const urlLower = imageUrl.toLowerCase();
  const colors = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'purple', 'pink', 'orange', 'brown', 'gray', 'grey', 'navy', 'beige', 'tan'];
  let detectedColor = colors.find(color => titleWords.includes(color) || urlLower.includes(color));
  let description = '';

  if (titleWords.match(/\b(shirt|tee|t-shirt|blouse|top)\b/)) {
    description = `casual ${detectedColor || ''} cotton fabric`.trim();
  } else if (titleWords.match(/\b(shoe|shoes|sneaker|sneakers|boot|boots)\b/)) {
    description = `comfortable ${detectedColor || 'quality'} footwear with durable construction`.trim();
  } else if (titleWords.match(/\b(watch|watches)\b/)) {
    description = `elegant ${detectedColor || 'premium'} timepiece with precision design`.trim();
  } else if (titleWords.match(/\b(bag|bags|backpack|purse|handbag)\b/)) {
    description = `durable ${detectedColor || 'quality'} bag with spacious storage`.trim();
  } else {
    description = `${detectedColor || 'quality'} product with professional design`.trim();
  }

  let altText = `${productTitle} - ${description}`;
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';
  return altText;
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

const PROVIDER_OPTIONS = [
  { label: 'OpenAI vision', value: 'openai' },
  { label: 'No API (fallback)', value: 'fallback' },
];

function scoreTag(score) {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'warn';
  return 'bad';
}

export default function AltTextSuggestions() {
  const { images: initialImages, loadError, truncated } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  // Generation runs through its own fetcher so it doesn't block (or get blocked
  // by) navigation/apply submits, and so each batch is an independent request.
  const genFetcher = useFetcher();

  const [images, setImages] = useState(initialImages);
  const [selectedImages, setSelectedImages] = useState([]);
  const [error, setError] = useState(loadError || null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [aiProvider, setAiProvider] = useState('openai');
  const [filter, setFilter] = useState('pending');
  const [page, setPage] = useState(0);

  // Live progress for the batched generation loop: queue of remaining batches
  // plus a {done,total} counter so the user sees movement instead of a frozen
  // spinner during a long single request.
  const genQueueRef = useRef([]);
  const genProviderRef = useRef('openai');
  const [genProgress, setGenProgress] = useState(null); // { done, total } | null

  const isGenerating = genProgress !== null;
  const isSubmitting = navigation.state === 'submitting';

  // Submit the next queued batch, or finish if the queue is empty.
  const submitNextBatch = useCallback(() => {
    const batch = genQueueRef.current.shift();
    if (!batch) {
      setGenProgress(null);
      setSuccessMessage('AI suggestions generated. Review them, then apply.');
      setTimeout(() => setSuccessMessage(null), 5000);
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'generateSuggestions');
    formData.append('aiProvider', genProviderRef.current);
    formData.append('images', JSON.stringify(batch.map(img => ({
      id: img.id, url: img.url, productTitle: img.productTitle
    }))));
    genFetcher.submit(formData, { method: 'post' });
  }, [genFetcher]);

  // Merge each completed batch's suggestions, advance progress, fire the next.
  useEffect(() => {
    if (genFetcher.state !== 'idle' || !genFetcher.data) return;
    const data = genFetcher.data;
    if (data.kind !== 'suggestions') return;

    if (data.success && data.suggestions) {
      setImages(prev =>
        prev.map(img => {
          const suggestion = data.suggestions.find(s => s.id === img.id);
          return suggestion
            ? { ...img, suggestedAlt: suggestion.suggestedAlt, seoScore: suggestion.seoScore, usedFallback: !!suggestion.usedFallback }
            : img;
        })
      );
      // Warn the merchant when the AI provider failed — otherwise the fallback
      // (a sentence built from the product title) looks like a real AI
      // description and the failure is invisible.
      if (data.aiError) {
        setError(`AI generation failed — showing fallback text built from your product title, not a real AI description. Reason: ${data.aiError}. Check the OpenAI API key and that the account has credit.`);
      }
      setGenProgress(prev => prev ? { ...prev, done: Math.min(prev.total, prev.done + data.suggestions.length) } : prev);
    } else if (data.error) {
      setError(data.error);
    }
    submitNextBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genFetcher.state, genFetcher.data]);

  const handleVerifyApiKey = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
    const formData = new FormData();
    formData.append('actionType', 'verifyApiKey');
    submit(formData, { method: 'post' });
  }, [submit]);

  useEffect(() => {
    if (actionData?.workingModel) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 6000);
    } else if (actionData?.error) {
      setError(actionData.error);
    } else if (actionData?.message) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 4000);
    }
  }, [actionData]);

  const generateSuggestions = useCallback(() => {
    if (isGenerating) return;
    setError(null);
    // If the user checked specific products, only generate for those; otherwise
    // generate one caption for every pending product. One API call per product.
    const needsSuggestion = (img) => img.status === 'pending' && !img.suggestedAlt;
    const pendingImages = selectedImages.length > 0
      ? images.filter(img => selectedImages.includes(img.id) && needsSuggestion(img))
      : images.filter(needsSuggestion);
    if (pendingImages.length === 0) {
      setError(selectedImages.length > 0
        ? 'The selected products already have suggestions (or are already applied).'
        : 'Every product already has a suggestion. Edit one directly, or apply what is there.');
      return;
    }
    // Split into small batches the client feeds to the server one at a time, so
    // a 200-product store never lives or dies on one multi-minute request.
    const batches = [];
    for (let i = 0; i < pendingImages.length; i += GEN_BATCH_SIZE) {
      batches.push(pendingImages.slice(i, i + GEN_BATCH_SIZE));
    }
    genQueueRef.current = batches;
    genProviderRef.current = aiProvider;
    setGenProgress({ done: 0, total: pendingImages.length });
    submitNextBatch();
  }, [images, aiProvider, isGenerating, selectedImages, submitNextBatch]);

  const handleSelectImage = useCallback((id) => {
    setSelectedImages(prev => prev.includes(id) ? prev.filter(imgId => imgId !== id) : [...prev, id]);
  }, []);

  const handleApply = useCallback((productId) => {
    const product = images.find(img => img.id === productId);
    if (!product?.suggestedAlt) {
      setError('Generate or type a caption first.');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyAltText');
    formData.append('imageIds', JSON.stringify(product.imageIds));
    formData.append('altText', product.suggestedAlt);
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      img.id === productId ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages(prev => prev.filter(id => id !== productId));
  }, [images, submit]);

  const handleApplySelected = useCallback(() => {
    const updates = selectedImages
      .map(id => {
        const product = images.find(img => img.id === id);
        if (!product?.suggestedAlt) return null;
        return { imageIds: product.imageIds, altText: product.suggestedAlt };
      })
      .filter(Boolean);

    if (updates.length === 0) {
      setError('None of the selected products have a caption yet. Generate suggestions first.');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyBulk');
    formData.append('updates', JSON.stringify(updates));
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      selectedImages.includes(img.id) && img.suggestedAlt
        ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages([]);
  }, [selectedImages, images, submit]);

  const handleEditSuggestion = useCallback((id, newText) => {
    setImages(prev => prev.map(img =>
      img.id === id ? { ...img, suggestedAlt: newText, seoScore: calculateSeoScore(newText) } : img
    ));
  }, []);

  // Each row is a PRODUCT (one caption per product, applied to all its images).
  const pendingCount = images.filter(img => img.status === 'pending').length;
  const appliedCount = images.filter(img => img.status === 'applied').length;
  const readyCount = images.filter(img => img.status === 'pending' && img.suggestedAlt).length;
  const productCount = images.length;
  const totalImages = images.reduce((sum, img) => sum + (img.imageCount || 0), 0);

  const filtered = useMemo(() => {
    if (filter === 'pending') return images.filter(img => img.status === 'pending');
    if (filter === 'ready') return images.filter(img => img.status === 'pending' && img.suggestedAlt);
    if (filter === 'applied') return images.filter(img => img.status === 'applied');
    if (filter === 'no_alt') return images.filter(img => !img.currentAlt);
    return images;
  }, [images, filter]);

  // Keep the current page valid as the filter changes the row count.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);
  const pageStart = safePage * PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : pageStart + 1;
  const rangeEnd = Math.min(pageStart + PAGE_SIZE, filtered.length);

  // Select-all operates on what is VISIBLE. Selecting rows the merchant cannot
  // see and then applying to them is the kind of surprise that gets an app
  // uninstalled.
  const selectableOnPage = paged.filter(img => img.status !== 'applied').map(img => img.id);
  const allPageSelected =
    selectableOnPage.length > 0 && selectableOnPage.every(id => selectedImages.includes(id));
  const handleSelectAll = useCallback(() => {
    setSelectedImages(prev =>
      allPageSelected
        ? prev.filter(id => !selectableOnPage.includes(id))
        : [...new Set([...prev, ...selectableOnPage])]
    );
  }, [allPageSelected, selectableOnPage]);

  return (
    <Page>
      <CommandBar
        title="Alt text"
        subtitle="One AI caption per product, generated from its main image and written to every image on that product — one API call instead of one per photo."
      >
        <Button onClick={handleVerifyApiKey} disabled={isGenerating || isSubmitting}>
          Test API key
        </Button>
        <Button
          variant="primary"
          onClick={generateSuggestions}
          loading={isGenerating}
          disabled={isGenerating}
        >
          {isGenerating
            ? `Analyzing ${genProgress.done}/${genProgress.total}…`
            : selectedImages.length > 0
              ? `Generate for ${selectedImages.length} selected`
              : 'Generate all pending'}
        </Button>
      </CommandBar>

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
      {truncated && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="info">
            {`Showing the first ${images.length} products. This store has a very large catalog, so caption these and reload to continue with the rest.`}
          </Banner>
        </div>
      )}

      <KpiStrip
        items={[
          { label: 'Products', value: formatNumber(productCount) },
          { label: 'Images covered', value: formatNumber(totalImages) },
          { label: 'Pending', value: formatNumber(pendingCount) },
          { label: 'Applied', value: formatNumber(appliedCount), tone: 'ok' },
        ]}
      />

      {isGenerating && (
        <Panel title="Generating captions" padded>
          <div className="px-quota">
            <Meter
              value={genProgress.total > 0 ? (genProgress.done / genProgress.total) * 100 : 0}
              label="Caption generation progress"
            />
            <span className="px-kpi-note">
              {`${genProgress.done} of ${genProgress.total} products · ${GEN_BATCH_SIZE} per request`}
            </span>
          </div>
        </Panel>
      )}

      <Panel
        title="Captions"
        actions={
          <div className="px-bar-aside" style={{ flexWrap: 'wrap' }}>
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { label: 'Pending', value: 'pending', count: pendingCount },
                { label: 'Ready', value: 'ready', count: readyCount },
                { label: 'Applied', value: 'applied', count: appliedCount },
                { label: 'All', value: 'all', count: productCount },
              ]}
            />
            <Segmented
              label="Source"
              value={aiProvider}
              onChange={setAiProvider}
              disabled={isGenerating}
              options={PROVIDER_OPTIONS}
            />
          </div>
        }
        footer={
          filtered.length > PAGE_SIZE ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Pagination
                hasPrevious={safePage > 0}
                onPrevious={() => setPage(p => Math.max(0, p - 1))}
                hasNext={safePage < pageCount - 1}
                onNext={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                label={`${rangeStart}–${rangeEnd} of ${filtered.length} products`}
              />
            </div>
          ) : undefined
        }
      >
        {filtered.length === 0 ? (
          <EmptyState title="Nothing in this view">
            {images.length === 0
              ? 'Add products with images to your store, then come back here to caption them.'
              : 'Try a different filter — or generate suggestions for the pending products.'}
          </EmptyState>
        ) : (
          <Table variant="alt">
            <div className="px-tr px-thead">
              <div className="px-th">
                <Checkbox
                  label="Select every product on this page"
                  labelHidden
                  checked={allPageSelected}
                  onChange={handleSelectAll}
                  disabled={selectableOnPage.length === 0}
                />
              </div>
              <div className="px-th px-col-thumb" />
              <div className="px-th">Product &amp; current alt</div>
              <div className="px-th">Suggested caption</div>
              <div className="px-th px-col-score px-td--num">SEO</div>
              <div className="px-th px-td--num">Apply</div>
            </div>

            {paged.map((image) => {
              const selected = selectedImages.includes(image.id);
              const applied = image.status === 'applied';
              return (
                <Row key={image.id} selected={selected}>
                  <div className="px-td">
                    <Checkbox
                      label={`Select ${image.productTitle}`}
                      labelHidden
                      checked={selected}
                      onChange={() => handleSelectImage(image.id)}
                      disabled={applied}
                    />
                  </div>
                  <div className="px-td px-col-thumb">
                    <img
                      className="px-thumb px-thumb--lg"
                      src={image.url}
                      alt={image.currentAlt || ''}
                    />
                  </div>
                  <div className="px-td">
                    <p className="px-td-strong" title={image.productTitle}>
                      {image.productTitle}
                    </p>
                    <p className="px-td-meta" title={image.currentAlt || 'No alt text'}>
                      {image.currentAlt || 'No alt text'}
                    </p>
                    <p className="px-td-meta">
                      {`${image.imageCount} image${image.imageCount === 1 ? '' : 's'}`}
                      {applied && ' · applied'}
                      {image.usedFallback && ' · fallback text'}
                    </p>
                  </div>
                  <div className="px-td">
                    <textarea
                      className="px-input"
                      rows={2}
                      value={image.suggestedAlt}
                      disabled={applied}
                      aria-label={`Suggested alt text for ${image.productTitle}`}
                      placeholder="Generate a suggestion, or type a caption here…"
                      onChange={(e) => handleEditSuggestion(image.id, e.target.value)}
                    />
                  </div>
                  <div className="px-td px-col-score px-td--right">
                    <Tag tone={scoreTag(image.seoScore)}>{`${image.seoScore}%`}</Tag>
                  </div>
                  <div className="px-td px-td--right">
                    {applied ? (
                      <Tag tone="ok" dot>Applied</Tag>
                    ) : (
                      <Button
                        size="slim"
                        variant="primary"
                        onClick={() => handleApply(image.id)}
                        loading={isSubmitting && !isGenerating}
                        disabled={isSubmitting || !image.suggestedAlt}
                      >
                        Apply
                      </Button>
                    )}
                  </div>
                </Row>
              );
            })}
          </Table>
        )}
      </Panel>

      {selectedImages.length > 0 && (
        <ActionBar
          text={`${selectedImages.length} product${selectedImages.length === 1 ? '' : 's'} selected`}
          note="The caption is written to every image on each selected product."
        >
          <button type="button" className="px-btn-ghost" onClick={() => setSelectedImages([])}>
            Clear
          </button>
          <Button
            variant="primary"
            onClick={handleApplySelected}
            loading={isSubmitting && !isGenerating}
            disabled={isSubmitting}
          >
            Apply selected
          </Button>
        </ActionBar>
      )}
    </Page>
  );
}
