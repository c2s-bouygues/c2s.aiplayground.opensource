/**
 * Shared Mistral Document AI (OCR) connector — used by ocr_extract (raw text)
 * and by ocr_extract_fields' VLM-vs-OCR comparison mode.
 *
 * Contract as served by Azure AI Foundry (`/providers/mistral/azure/ocr`) and
 * api.mistral.ai (`/v1/ocr`): the file travels as a base64 data-URL
 * (`document_url` for PDFs/documents, `image_url` for images); the response is
 * `{ pages: [{ index, markdown, images, dimensions }] }`.
 * `include_image_base64: true` asks for the crops of the detected figures so
 * the MCP App can render the page layout (bounding boxes) — kept within
 * IMAGE_BASE64_BUDGET_CHARS, boxes beyond keep coordinates only. Both
 * `Authorization: Bearer` and `api-key` headers are sent — Azure accepts
 * either depending on the resource configuration.
 */

import type { OcrPage, OcrPageBlock, OcrPageImage } from './result-store';
import { splitPdfIntoImageBatches } from './pdf-split';

export const DEFAULT_OCR_MODEL = 'mistral-ocr-2503';

/**
 * Hard cap for batched OCR of documents exceeding the service's per-request
 * page limit (Azure Mistral OCR: 30 pages/request): at most this many pages
 * are processed, front to back.
 */
export const MAX_TOTAL_PAGES = 500;

/** Fallback per-request page limit when the service error doesn't state one. */
export const DEFAULT_PAGE_LIMIT = 30;

const REQUEST_TIMEOUT_MS = 60_000;

/** Total data-URI budget across all page crops (structuredContent stays lean). */
export const IMAGE_BASE64_BUDGET_CHARS = 2_000_000;

export interface OcrConnector {
	endpoint: string;
	apiKey: string;
	model: string;
}

/**
 * Resolve the OCR connector from the plugin config (endpoint/apiKey/ocrModel)
 * with OCR_ENDPOINT / OCR_API_KEY / OCR_MODEL env fallbacks; null = not
 * configured (callers stub or degrade).
 */
export function resolveOcrConnector(
	config: { endpoint?: string; apiKey?: string; ocrModel?: string },
	env: Record<string, string | undefined>
): OcrConnector | null {
	const endpoint = config.endpoint?.trim() || env.OCR_ENDPOINT;
	const apiKey = config.apiKey?.trim() || env.OCR_API_KEY;
	if (!endpoint || !apiKey) return null;
	return {
		endpoint,
		apiKey,
		model: config.ocrModel?.trim() || env.OCR_MODEL || DEFAULT_OCR_MODEL
	};
}

/**
 * Resolve the OCR route from the configured endpoint:
 * - a URL already ending in /ocr is used as-is (full route configured);
 * - a bare Azure AI Foundry base URL (https://<resource>.services.ai.azure.com)
 *   gets the Mistral Document AI route `/providers/mistral/azure/ocr`;
 * - any other bare base URL gets the Mistral-native route `/v1/ocr`;
 * - a URL with another path is used as-is (custom proxy).
 */
export function buildOcrUrl(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, '');
	if (/\/ocr$/i.test(trimmed)) return trimmed;
	try {
		const url = new URL(trimmed);
		if (url.pathname === '' || url.pathname === '/') {
			return url.hostname.toLowerCase().endsWith('.services.ai.azure.com')
				? `${trimmed}/providers/mistral/azure/ocr`
				: `${trimmed}/v1/ocr`;
		}
	} catch {
		// not a parseable URL — let fetch surface the error
	}
	return trimmed;
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Mistral returns either a full data URI or raw base64 depending on the route. */
function normalizeImageDataUri(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') return undefined;
	if (value.startsWith('data:image/')) return value;
	if (value.startsWith('data:')) return undefined; // non-image data URI — drop
	return `data:image/jpeg;base64,${value}`;
}

/**
 * Detects the service's "too many pages" rejection (Azure Mistral OCR error
 * `document_parser_too_many_pages`, code 3730) and extracts the page counts
 * from its message ("This document has N pages, … maximum allowed of M").
 */
export function parseTooManyPages(
	errorText: string
): { totalPages: number; maxPages: number } | null {
	if (!/too_many_pages/i.test(errorText)) return null;
	const match = errorText.match(/has (\d+) pages.*?maximum allowed of (\d+)/i);
	if (!match) return { totalPages: 0, maxPages: DEFAULT_PAGE_LIMIT };
	return { totalPages: parseInt(match[1], 10), maxPages: parseInt(match[2], 10) };
}

/**
 * Batched OCR for documents exceeding the per-request page limit. The Azure
 * parser rejects an oversized document even when the request narrows the work
 * (`pages` parameter), so the PDF is REALLY split: pages are rasterized and
 * reassembled into image-only sub-PDFs of `batchSize` pages (lib/pdf-split.ts,
 * using the host's @hyzyla/pdfium + sharp), each OCR'd as its own document.
 * Sequential on purpose (rate-limit friendly); one shared crop budget so the
 * aggregate payload stays bounded. Page numbers are re-anchored to the
 * original document (chunk pages are 1-based within their sub-PDF).
 */
export async function batchedMistralOcr(
	connector: OcrConnector,
	buffer: Buffer,
	fileName: string,
	batchSize: number,
	options?: { cropBudget?: { remaining: number } }
): Promise<{ pages: OcrPage[]; batches: number; totalPages: number; capped: boolean }> {
	const split = await splitPdfIntoImageBatches(buffer, batchSize, MAX_TOTAL_PAGES);
	const cropBudget = options?.cropBudget ?? { remaining: IMAGE_BASE64_BUDGET_CHARS };
	const all: OcrPage[] = [];
	for (const [j, batchPdf] of split.batches.entries()) {
		const startPage = j * batchSize;
		const chunk = await mistralOcr(connector, batchPdf, 'application/pdf', fileName, {
			cropBudget
		});
		all.push(...chunk.map((p) => ({ ...p, page: startPage + p.page })));
	}
	return {
		pages: all,
		batches: split.batches.length,
		totalPages: split.totalPages,
		capped: split.capped
	};
}

export async function mistralOcr(
	connector: OcrConnector,
	buffer: Buffer,
	contentType: string,
	fileName: string,
	options?: {
		/** Crop data-URI budget shared across the batches of one extraction. */
		cropBudget?: { remaining: number };
	}
): Promise<OcrPage[]> {
	const mediaType =
		(contentType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
	const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;
	const document = mediaType.startsWith('image/')
		? { type: 'image_url', image_url: dataUrl }
		: { type: 'document_url', document_url: dataUrl, document_name: fileName };

	const callOcr = async (includeBlocks: boolean) =>
		fetch(buildOcrUrl(connector.endpoint), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${connector.apiKey}`,
				'api-key': connector.apiKey
			},
			body: JSON.stringify({
				model: connector.model,
				document,
				include_image_base64: true,
				// Paragraph-level layout blocks (OCR 4+ models) — rendered as the
				// viewer's "Zones texte" overlay. Retried without when rejected.
				...(includeBlocks ? { include_blocks: true } : {})
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});

	let response = await callOcr(true);
	let raw = await response.text().catch(() => '');
	// Older models/routes may reject the unknown `include_blocks` parameter —
	// degrade to a blocks-less request instead of failing the extraction.
	if (
		!response.ok &&
		response.status >= 400 &&
		response.status < 500 &&
		/include_blocks|extra_forbidden|unknown (field|parameter)|unexpected keyword/i.test(raw)
	) {
		response = await callOcr(false);
		raw = await response.text().catch(() => '');
	}
	if (!response.ok) {
		throw new Error(
			`${response.status} ${response.statusText}${raw ? ` — ${raw.slice(0, 300)}` : ''}`
		);
	}
	let data: { pages?: unknown };
	try {
		data = JSON.parse(raw) as { pages?: unknown };
	} catch {
		throw new Error(
			`réponse non-JSON du service OCR (HTTP ${response.status}): ${raw.slice(0, 200) || '(corps vide)'}`
		);
	}
	if (!Array.isArray(data.pages)) {
		throw new Error('unexpected response shape (missing pages[])');
	}
	const budget = options?.cropBudget ?? { remaining: IMAGE_BASE64_BUDGET_CHARS };
	return data.pages
		.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
		.map((p, i) => {
			const dims = (typeof p.dimensions === 'object' && p.dimensions !== null
				? p.dimensions
				: {}) as Record<string, unknown>;
			const images: OcrPageImage[] = (Array.isArray(p.images) ? p.images : [])
				.filter((img): img is Record<string, unknown> => typeof img === 'object' && img !== null)
				.map((img, j) => {
					const box: OcrPageImage = {
						id: typeof img.id === 'string' ? img.id : `img-${i}-${j}`,
						x0: toFiniteNumber(img.top_left_x) ?? 0,
						y0: toFiniteNumber(img.top_left_y) ?? 0,
						x1: toFiniteNumber(img.bottom_right_x) ?? 0,
						y1: toFiniteNumber(img.bottom_right_y) ?? 0
					};
					const dataUri = normalizeImageDataUri(img.image_base64);
					if (dataUri && dataUri.length <= budget.remaining) {
						budget.remaining -= dataUri.length;
						box.base64 = dataUri;
					}
					return box;
				});
			// Paragraph-level blocks (OCR 4+). `content` rides in the stored payload
			// (never the LLM prompt): it lets the extraction panel match a provenance
			// quote to a block and highlight it on scans/images.
			const blocks: OcrPageBlock[] = (Array.isArray(p.blocks) ? p.blocks : [])
				.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
				.map((b) => ({
					type: typeof b.type === 'string' && b.type !== '' ? b.type : 'text',
					x0: toFiniteNumber(b.top_left_x) ?? 0,
					y0: toFiniteNumber(b.top_left_y) ?? 0,
					x1: toFiniteNumber(b.bottom_right_x) ?? 0,
					y1: toFiniteNumber(b.bottom_right_y) ?? 0,
					...(typeof b.content === 'string' && b.content !== '' ? { content: b.content } : {})
				}))
				.filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
			return {
				// Mistral pages are 0-based `index` with `markdown` content; tolerate
				// the { page, text } shape for custom proxies.
				page:
					typeof p.index === 'number' ? p.index + 1 : typeof p.page === 'number' ? p.page : i + 1,
				text:
					typeof p.markdown === 'string' ? p.markdown : typeof p.text === 'string' ? p.text : '',
				width: toFiniteNumber(dims.width),
				height: toFiniteNumber(dims.height),
				dpi: toFiniteNumber(dims.dpi),
				...(images.length > 0 ? { images } : {}),
				...(blocks.length > 0 ? { blocks } : {})
			};
		});
}
