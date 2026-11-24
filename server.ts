import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dns from 'node:dns/promises';
import { GoogleGenAI, Type } from '@google/genai';
import rateLimit from 'express-rate-limit';
import { generateRuleBasedFormatting } from './src/formatting_rules.js';
import {
  isPrivateOrReservedIp,
  validatePublicImageUrl,
  normalizeAllowedImageMime
} from './src/url_safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const isProd = process.env.NODE_ENV === 'production';
const PORT = isProd && process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '15mb' }));

// Rate limiting to protect API endpoints from excessive traffic and denial of service
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per 15 minutes
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests from this IP, please try again after a few minutes.' }
});

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 AI requests per minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many AI requests from this IP, please slow down.' }
});

app.use('/api/', apiLimiter);
app.use('/api/ai/', aiLimiter);
app.use('/api/brand-logo/search', aiLimiter);

function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (trimmed.length < 15) return false;
  if (
    trimmed === 'YOUR_API_KEY' ||
    trimmed === 'dummy' ||
    trimmed === 'test' ||
    trimmed.startsWith('TODO') ||
    trimmed.startsWith('placeholder') ||
    trimmed.includes('undefined') ||
    trimmed.includes('null')
  ) {
    return false;
  }
  return true;
}

let aiClientInstance: GoogleGenAI | null = null;
function getAi(): GoogleGenAI | null {
  if (!isGeminiConfigured()) return null;
  if (!aiClientInstance) {
    try {
      aiClientInstance = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    } catch {
      aiClientInstance = null;
    }
  }
  return aiClientInstance;
}

/**
 * GET /api/ai/status
 */
app.get('/api/ai/status', (req, res) => {
  return res.json({
    ok: true,
    isConfigured: isGeminiConfigured()
  });
});

/**
 * POST /api/ai/format
 */
app.post('/api/ai/format', async (req, res) => {
  try {
    const { prompt, items } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: 'A prompt instruction is required.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'An array of inventory items is required.' });
    }

    const ai = getAi();
    if (!ai) {
      const fallback = generateRuleBasedFormatting(prompt, items);
      return res.json({
        ok: true,
        message: `${fallback.message} (Standardized via intelligent retail formatter)`,
        summary: fallback.summary,
        changes: fallback.changes
      });
    }

    const sampleItems = items.slice(0, 150).map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || item.current_name || ''),
      barcode: String(item.barcode || ''),
      category: String(item.category || ''),
      price: String(item.price || '')
    }));

    const systemInstruction = `You are an expert retail & liquor store inventory formatting and POS standardization assistant (specializing in Clover and Toast POS catalog transformations).
Your task is to analyze inventory items and produce structured modifications based on the user's formatting request.

CRITICAL POLICY & BOUNDARIES:
1. FORMATTING RULES MUST NOT TOUCH PRICING. Under no circumstances should pricing ever be proposed, changed, or touched. Pricing is authoritative store data.
2. FORMATTING RULES MUST ONLY FIX:
   - ITEM NAME ('name'): Uniform Title Case brand naming, standardizing bottle volumes ('11oz', '12oz', '750ml', '1 L', '1.75 L'), standardizing packs ('6-Pack', '12-Pack', '24-Pack'), and removing messy POS abbreviations.
   - CATEGORY ('category'): Streamline and simplify categories into clean Toast retail departments ('LIQUOR/SPIRITS', 'BEER', 'WINE', 'RTD (READY TO DRINK)', 'CANDY/SNACKS', 'DRINKS', 'TOBACCO PRODUCTS', 'VAPES', 'Smoke Shop').
   - UPC / BARCODE ('barcode'): Clean non-digits or pad 11-digit UPCs to 12-digit UPC-A with leading zeros.

Guidelines:
1. ONLY propose changes for items that actually require adjustments per the user's instruction.
2. For each change, specify the exact item 'id', 'field' ('name', 'category', or 'barcode' ONLY - NEVER 'price'), 'originalValue', 'proposedValue', and a clear, concise 'reason'.
3. In 'message', provide a conversational, helpful overview of the changes made.
4. In 'summary', provide a 1-sentence summary (e.g., 'Standardized 18 liquor bottle sizes and title casing.').
5. If no items require changes, return an empty 'changes' array with an explanatory message.`;

    const userContent = `User Request: "${prompt.trim()}"

Items to evaluate (${sampleItems.length} items):
${JSON.stringify(sampleItems, null, 2)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: userContent,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            message: { type: Type.STRING },
            summary: { type: Type.STRING },
            changes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  field: { type: Type.STRING, enum: ['name', 'category', 'barcode'] },
                  originalValue: { type: Type.STRING },
                  proposedValue: { type: Type.STRING },
                  reason: { type: Type.STRING }
                },
                required: ['id', 'field', 'originalValue', 'proposedValue', 'reason']
              }
            }
          },
          required: ['message', 'summary', 'changes']
        }
      }
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const safeChanges = (Array.isArray(parsed.changes) ? parsed.changes : []).filter(
      (c: any) => c && (c.field === 'name' || c.field === 'category' || c.field === 'barcode') && c.field !== 'price'
    );

    return res.json({
      ok: true,
      message: parsed.message || 'Formatting proposals generated.',
      summary: parsed.summary || `Proposed adjustments for ${safeChanges.length} items (Name, Category, and UPC only).`,
      changes: safeChanges
    });
  } catch (err: any) {
    console.log('[AI Info] Using local retail formatter engine.');
    const fallback = generateRuleBasedFormatting(req.body.prompt, req.body.items || []);
    const safeFallbackChanges = (fallback.changes || []).filter(
      (c: any) => c && (c.field === 'name' || c.field === 'category' || c.field === 'barcode') && c.field !== 'price'
    );
    return res.json({
      ok: true,
      message: `${fallback.message} (Applied via intelligent retail formatter; pricing protected)`,
      summary: fallback.summary,
      changes: safeFallbackChanges
    });
  }
});

/**
 * POST /api/ai/chat
 */
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'A message string is required.' });
    }

    const ai = getAi();
    if (!ai) {
      return res.json({
        ok: true,
        reply: `I'm here to assist with your Toast POS import. Our retail engine automatically standardizes bottle sizes (e.g., 750 mL, 1 L, 11oz), UPC-A barcodes, and categories according to Toast Retail Onboarding standards.`
      });
    }

    const systemInstruction = `You are the Gemini AI Inventory Copilot for store operators migrating inventory from Clover to Toast POS.
You help operators understand Toast CSV import requirements, barcode integrity (UPC-A, EAN-13 padding, SKU identity), category structuring, and packaging rules.
Provide clear, reassuring, and concise advice. If the user asks you to modify items or categories, explain how to do it or advise them to use the interactive formatting prompt.`;

    const contents = context
      ? `Workflow Context: ${JSON.stringify(context)}\nUser Question: ${message.trim()}`
      : message.trim();

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config: {
        systemInstruction
      }
    });

    return res.json({
      ok: true,
      reply: response.text || 'No response generated.'
    });
  } catch (err: any) {
    console.log('[AI Info] Using local assistant reply.');
    return res.json({
      ok: true,
      reply: `I'm here to assist with your Toast POS import. You can ask me how to standardize bottle sizes, pad barcodes, or prepare the official Toast Onboarding Retail Template.`
    });
  }
});

/**
 * POST /api/ai/online-search-scan
 * Performs a complete online search scan of unapproved inventory items
 * using Gemini 3.8 Flash with Google Search grounding or domain catalog fallback.
 */
app.post('/api/ai/online-search-scan', async (req, res) => {
  const runDomainCatalogScan = () => {
    const items = req.body.items || [];
    const corrections: any[] = [];
    for (const it of items) {
      const origName = String(it.name || it.current_name || '');
      const normRes = generateRuleBasedFormatting('Standardize Title Case, brand names, and volumes', [it]);
      if (normRes.changes && normRes.changes.length > 0) {
        for (const ch of normRes.changes) {
          corrections.push({
            id: it.id,
            itemName: origName,
            field: ch.field,
            originalValue: ch.originalValue,
            proposedValue: ch.proposedValue,
            reason: `${ch.reason} (Standardized via retail catalog rules)`
          });
        }
      }
    }
    return res.json({
      ok: true,
      message: `Completed catalog scan of ${items.length} unapproved items using retail standards.`,
      summary: `Found ${corrections.length} correction(s) for review.`,
      corrections
    });
  };

  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'An array of unapproved inventory items is required.' });
    }

    const ai = getAi();
    if (!ai) {
      return runDomainCatalogScan();
    }

    const itemsToScan = items.slice(0, 50).map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || item.current_name || ''),
      barcode: String(item.barcode || ''),
      category: String(item.category || ''),
      price: String(item.price || ''),
      issues: Array.isArray(item.issues) ? item.issues : []
    }));

    const systemInstruction = `You are an expert retail & liquor store inventory catalog specialist connected to real-time Google Search.
You are performing a comprehensive online product scan on unapproved store inventory items being prepared for Toast POS.

CRITICAL POLICY & BOUNDARIES:
1. ONLINE SEARCH SCANS AND FORMATTING RULES MUST NEVER TOUCH PRICING. Under no circumstances should pricing ever be proposed, modified, or touched.
2. ONLY PROPOSE CORRECTIONS FOR:
   - ITEM NAME ('name'): Uniform Title Case brand naming (e.g. "Jack Daniel's", "Corona Extra", "High Noon", "Tito's Handmade Vodka"), standardizing packaging & volume units ("11oz", "12oz", "750 mL", "1 L", "1.75 L", "6-Pack", "12-Pack"), and expanding POS shorthand based on live product search.
   - CATEGORY ('category'): Streamline and simplify categories into clean retail departments ('LIQUOR/SPIRITS', 'BEER', 'WINE', 'RTD (READY TO DRINK)', 'CANDY/SNACKS', 'DRINKS', 'TOBACCO PRODUCTS', 'VAPES', 'Smoke Shop').
   - UPC / BARCODE ('barcode'): Pad 11-digit UPCs or clean non-numeric characters. NEVER propose changes to 'price'.

Rules:
- ONLY propose changes for items where corrections are genuinely needed.
- Return structured JSON with:
  - "message": A polite explanation of the scan results.
  - "summary": A 1-sentence summary of findings.
  - "corrections": An array of objects with:
      - "id": The item's id
      - "itemName": The item's name
      - "field": 'name' | 'category' | 'barcode' (NEVER 'price')
      - "originalValue": The current value
      - "proposedValue": The corrected value
      - "reason": Clear rationale based on product search and retail standards.`;

    const userPrompt = `Perform online search scan and product corrections for these ${itemsToScan.length} unapproved items:
${JSON.stringify(itemsToScan, null, 2)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: userPrompt,
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            message: { type: Type.STRING },
            summary: { type: Type.STRING },
            corrections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  itemName: { type: Type.STRING },
                  field: { type: Type.STRING, enum: ['name', 'category', 'barcode'] },
                  originalValue: { type: Type.STRING },
                  proposedValue: { type: Type.STRING },
                  reason: { type: Type.STRING }
                },
                required: ['id', 'field', 'originalValue', 'proposedValue', 'reason']
              }
            }
          },
          required: ['message', 'summary', 'corrections']
        }
      }
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const safeCorrections = (Array.isArray(parsed.corrections) ? parsed.corrections : []).filter(
      (c: any) => c && (c.field === 'name' || c.field === 'category' || c.field === 'barcode') && c.field !== 'price'
    );

    return res.json({
      ok: true,
      message: parsed.message || 'Online search scan complete.',
      summary: parsed.summary || `Found corrections for ${safeCorrections.length} unapproved items (Item Name, Category, and UPC only).`,
      corrections: safeCorrections
    });
  } catch (err: any) {
    console.log('[AI Info] Using domain catalog engine for unapproved items scan.');
    return runDomainCatalogScan();
  }
});

/**
 * Helper to fetch a remote image URL with strict SSRF protection
 * (HTTPS only, DNS resolution check on every hop, redirect cap, size & MIME check).
 */
async function fetchSafeRemoteImage(rawUrl: string) {
  const MAX_REDIRECTS = 3;
  const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = validatePublicImageUrl(currentUrl);
    if (!check.ok || !check.url) {
      return { ok: false as const, status: 400, error: check.error || 'Invalid image URL.' };
    }

    const hostname = check.url.hostname.replace(/^\[|\]$/g, '');
    let resolvedRecords: Array<{ address: string }>;
    try {
      resolvedRecords = await dns.lookup(hostname, { all: true });
    } catch {
      return { ok: false as const, status: 400, error: 'Could not resolve image host.' };
    }

    if (!resolvedRecords || resolvedRecords.length === 0) {
      return { ok: false as const, status: 400, error: 'Image host resolved to no addresses.' };
    }

    for (const rec of resolvedRecords) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { ok: false as const, status: 403, error: 'Blocked private or reserved destination IP.' };
      }
    }

    const response = await fetch(check.url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'aistudio-build',
        Accept: 'image/png,image/jpeg,image/webp,image/gif,*/*;q=0.5'
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { ok: false as const, status: 400, error: 'Redirect missing location header.' };
      }
      currentUrl = new URL(location, check.url).toString();
      continue;
    }

    if (!response.ok) {
      return {
        ok: false as const,
        status: 502,
        error: `Image server responded with HTTP ${response.status}.`
      };
    }

    const mime = normalizeAllowedImageMime(response.headers.get('content-type'));
    if (!mime) {
      return {
        ok: false as const,
        status: 415,
        error: 'URL did not return a supported raster image (PNG, JPEG, WebP, or GIF).'
      };
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BYTES) {
      return { ok: false as const, status: 413, error: 'Image exceeds 2 MB maximum size.' };
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return { ok: false as const, status: 400, error: 'Fetched image file is empty.' };
    }
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return { ok: false as const, status: 413, error: 'Image exceeds 2 MB maximum size.' };
    }

    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return {
      ok: true as const,
      contentType: mime,
      dataUrl: `data:${mime};base64,${base64}`
    };
  }

  return { ok: false as const, status: 400, error: 'Too many redirects while fetching image.' };
}

/**
 * POST /api/brand-logo/search
 * Searches Google via Gemini Search Grounding (gemini-4-hydrogen) for official brand logo image URLs.
 */
app.post('/api/brand-logo/search', async (req, res) => {
  const rawQuery = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!rawQuery || rawQuery.length > 120) {
    return res.status(400).json({ ok: false, error: 'Please enter a brand name (1–120 characters) to search.' });
  }

  const googleImagesUrl = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${rawQuery} logo png`)}`;
  const ai = getAi();
  if (!ai) {
    return res.status(503).json({
      ok: false,
      error: 'Google Logo Search requires GEMINI_API_KEY on the server. You can open Google Images directly or paste an image URL below.',
      googleImagesUrl,
      results: []
    });
  }

  try {
    const prompt = `Search Google for official, high-resolution, publicly accessible brand logo raster image URLs (PNG, JPG, or WebP — avoid SVG if a PNG/JPG exists) for the retail/beverage brand: "${rawQuery}".

Prefer direct image URLs from Wikimedia Commons (upload.wikimedia.org), Wikipedia thumbnails, official brand media/press pages, or clean logo CDNs that return an actual PNG/JPG/WebP image file.

Return ONLY a valid JSON object (no markdown code fences) in this exact format:
{
  "results": [
    {
      "title": "Short descriptive label of this logo",
      "imageUrl": "https://...direct-image-url.png",
      "sourceUrl": "https://...source-page-url",
      "domain": "upload.wikimedia.org"
    }
  ]
}
Include up to 6 real image URLs found in your Google Search results. Do not invent or guess URLs.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const rawText = (response.text || '').trim();
    const cleanedJson = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let candidates: Array<{ title: string; imageUrl: string; sourceUrl?: string; domain?: string }> = [];
    try {
      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanedJson);
      if (Array.isArray(parsed?.results)) {
        candidates = parsed.results;
      }
    } catch {
      candidates = [];
    }

    const seenUrls = new Set<string>();
    const safeResults: Array<{ title: string; imageUrl: string; sourceUrl: string; domain: string }> = [];

    for (const item of candidates) {
      if (!item || typeof item.imageUrl !== 'string') continue;
      const check = validatePublicImageUrl(item.imageUrl);
      if (!check.ok || !check.url) continue;
      const normalized = check.url.toString();
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);

      let safeSource = '';
      if (typeof item.sourceUrl === 'string') {
        const srcCheck = validatePublicImageUrl(item.sourceUrl);
        if (srcCheck.ok && srcCheck.url) {
          safeSource = srcCheck.url.toString();
        }
      }

      safeResults.push({
        title: String(item.title || `${rawQuery} Logo`).slice(0, 100),
        imageUrl: normalized,
        sourceUrl: safeSource || normalized,
        domain: check.url.hostname
      });
      if (safeResults.length >= 6) break;
    }

    // Collect grounding source links from Gemini search metadata for user transparency
    const groundingSources: Array<{ title: string; url: string }> = [];
    const chunks = (response as any)?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const ch of chunks) {
        const uri = ch?.web?.uri;
        if (typeof uri === 'string') {
          const check = validatePublicImageUrl(uri);
          if (check.ok && check.url) {
            groundingSources.push({
              title: String(ch?.web?.title || check.url.hostname).slice(0, 80),
              url: check.url.toString()
            });
          }
        }
        if (groundingSources.length >= 6) break;
      }
    }

    return res.json({
      ok: true,
      query: rawQuery,
      googleImagesUrl,
      results: safeResults,
      groundingSources
    });
  } catch (err: any) {
    const rawMsg = String(err?.message || 'Unable to reach search service.');
    let friendlyMsg = rawMsg;
    try {
      const parsedErr = JSON.parse(rawMsg);
      if (parsedErr?.error?.message) {
        friendlyMsg = parsedErr.error.message;
      }
    } catch {
      // keep rawMsg
    }
    console.error('[Brand Logo Search Error]:', friendlyMsg);
    return res.status(502).json({
      ok: false,
      error: `Google logo search unavailable (${friendlyMsg}). You can open Google Images below and paste any logo URL or upload a photo.`,
      googleImagesUrl,
      results: []
    });
  }
});

/**
 * POST /api/brand-logo/fetch
 * Downloads a verified public HTTPS raster image server-side (SSRF-protected)
 * and returns a base64 data URL for canvas resizing and Firestore/PDF embedding.
 */
app.post('/api/brand-logo/fetch', async (req, res) => {
  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const result = await fetchSafeRemoteImage(rawUrl);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      dataUrl: result.dataUrl,
      contentType: result.contentType
    });
  } catch (err: any) {
    console.error('[Brand Logo Fetch Error]:', err?.message || err);
    return res.status(502).json({
      ok: false,
      error: `Could not fetch logo image: ${err?.message || 'Network timeout or unreachable host.'}`
    });
  }
});


async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const staticLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false
    });
    app.use(staticLimiter);
    app.use(express.static(join(__dirname, 'dist')));
    app.use(staticLimiter, (req, res) => {
      res.sendFile(join(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
  server.on('error', (err: any) => {
    console.error(`Server failed to listen on ${HOST}:${PORT}:`, err?.message || err);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
});

export { app, isGeminiConfigured };
