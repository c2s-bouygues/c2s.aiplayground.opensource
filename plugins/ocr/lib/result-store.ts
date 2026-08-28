/**
 * OCR result store — persists each extraction to the plugin's conversation
 * storage so the LLM prompt stays small (bento pattern: `data` carries ids and
 * metadata, the heavy payload lives in storage and the MCP App fetches it
 * itself through the bridge).
 *
 * Two files per extraction, under the plugin prefix
 * (`mcp-plugins/{conversationId}/ocr/` — conversation-scoped by construction):
 * - `results/<docId>.md`   — the full markdown text (read by ocr_read_text /
 *   ocr_search_text, and downloadable by the user via its /api/files URL);
 * - `results/<docId>.json` — the full viewer payload (pages with text,
 *   dimensions, bounding boxes, crops, and the original document as a data
 *   URI), served to the panel by ocr_get_result.
 */

import type { PluginStorageAPI } from '../../../src/types';

/** An image/figure detected on a page, with its bounding box in page pixels. */
export interface OcrPageImage {
	id: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** data:image/... URI of the extracted crop (may be omitted over the size budget). */
	base64?: string;
}

/**
 * A layout block detected on a page (Mistral `blocks`, OCR 4+ models with
 * `include_blocks`): paragraph-level bounding box with a type label (text,
 * title, list, table, equation, caption, code, header, footer, signature…).
 * Coordinates in page pixels. `content` duplicates the page text block by
 * block — kept in the STORED payload only (never in the LLM prompt) so the
 * extraction panel can locate a provenance quote inside a block and highlight
 * it on scans/images, where the pdf.js text layer does not exist.
 */
export interface OcrPageBlock {
	type: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	content?: string;
}

export interface OcrPage {
	page: number;
	text: string;
	/** Page dimensions in pixels (Mistral `dimensions`) — enable the layout view. */
	width?: number;
	height?: number;
	dpi?: number;
	/** Detected images/figures with bounding boxes (Mistral `images`). */
	images?: OcrPageImage[];
	/** Paragraph-level layout blocks (Mistral `blocks`) — absent on older OCR models. */
	blocks?: OcrPageBlock[];
}

/** Full viewer payload persisted as `results/<docId>.json`. */
export interface StoredOcrResult {
	fileName: string;
	contentType: string;
	provider: string;
	pages: OcrPage[];
	/** Original document (PDF/image) as a data URI, size-capped by the caller. */
	document?: { mediaType: string; dataUri: string };
}

const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_URL_RE = /\/results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:md|json)$/i;

export function markdownFileName(docId: string): string {
	return `results/${docId}.md`;
}

export function payloadFileName(docId: string): string {
	return `results/${docId}.json`;
}

/**
 * Accepts a bare docId or the /api/files URL of one of the stored files
 * (`.../results/<docId>.md|.json`); null when neither shape matches.
 */
export function resolveDocId(ref: string): string | null {
	const trimmed = (ref ?? '').trim();
	if (DOC_ID_RE.test(trimmed)) return trimmed.toLowerCase();
	const match = trimmed.match(DOC_URL_RE);
	return match ? match[1].toLowerCase() : null;
}

/** Page texts joined into one markdown document (page separators when multi-page). */
export function buildMarkdown(pages: OcrPage[]): string {
	if (pages.length <= 1) return pages[0]?.text ?? '';
	return pages.map((p) => `--- Page ${p.page} ---\n\n${p.text}`).join('\n\n');
}

export async function saveOcrResult(
	storage: PluginStorageAPI,
	payload: StoredOcrResult
): Promise<{ docId: string; markdown: string; markdownUrl: string }> {
	const docId = crypto.randomUUID();
	const markdown = buildMarkdown(payload.pages);
	const markdownUrl = await storage.uploadFile(
		markdownFileName(docId),
		Buffer.from(markdown, 'utf-8'),
		'text/markdown; charset=utf-8'
	);
	await storage.uploadFile(
		payloadFileName(docId),
		Buffer.from(JSON.stringify(payload), 'utf-8'),
		'application/json'
	);
	return { docId, markdown, markdownUrl };
}

/** Throws when the reference is invalid or the file is gone (storage message). */
export async function loadMarkdown(
	storage: PluginStorageAPI,
	ref: string
): Promise<{ docId: string; text: string }> {
	const docId = resolveDocId(ref);
	if (!docId) throw new Error(`invalid OCR document reference: ${ref}`);
	const { buffer } = await storage.downloadFile(markdownFileName(docId));
	return { docId, text: buffer.toString('utf-8') };
}

export async function loadResult(
	storage: PluginStorageAPI,
	ref: string
): Promise<{ docId: string; payload: StoredOcrResult }> {
	const docId = resolveDocId(ref);
	if (!docId) throw new Error(`invalid OCR document reference: ${ref}`);
	const { buffer } = await storage.downloadFile(payloadFileName(docId));
	return { docId, payload: JSON.parse(buffer.toString('utf-8')) as StoredOcrResult };
}

/**
 * Length-preserving accent/case fold (é→e, Ç→c …): each char maps to exactly
 * one char, so indexes in the folded text are valid in the original text.
 */
export function foldText(text: string): string {
	let out = '';
	for (const ch of text) {
		const base = ch.normalize('NFD')[0] ?? ch;
		// Multi-code-unit chars (emoji, CJK): keep the original to preserve length.
		out += ch.length === 1 ? base.toLowerCase() : ch;
	}
	return out;
}
