/**
 * Static SEP-1865 MCP App template for the OCR plugin.
 *
 * Registered as `ui://ocr/viewer` (see the plugin's `appResources`) and served
 * by /api/mcp-apps/resource. The template carries NO per-call data: the host
 * delivers the tool result's `data` as `structuredContent` through the ext-apps
 * bridge (`ui/notifications/tool-result`). Theme arrives via `hostContext` and
 * `host-context-changed` notifications.
 *
 * Two tabs:
 * - "Texte": the extracted text, one card per page.
 * - "Mise en page": the REAL document pages with the detected figures'
 *   bounding boxes (Mistral `images`) overlaid in percent coordinates of the
 *   page `dimensions`. The original document travels in the tool payload
 *   (`data.document`, size-capped): PDFs are rasterized client-side with
 *   pdf.js loaded from jsdelivr (declared in the appResource CSP — embed/
 *   iframe PDF is denied by the sandbox), images are shown directly. When the
 *   document is absent (too big) or pdf.js can't load (no CDN access), the
 *   page falls back to a text-preview sheet at the true aspect ratio.
 *
 * OCR output is untrusted (it re-renders whatever the connector extracted from
 * a user file), so every string goes through `textContent` — never innerHTML —
 * and image sources are accepted only when they start with `data:image/`.
 *
 * The ext-apps SDK is loaded from the host origin (/api/mcp-apps/vendor/app.js)
 * and the widget is fully self-contained: the host's default CSP is enough, no
 * `meta.csp` declaration needed.
 */

export const OCR_VIEWER_RESOURCE_URI = 'ui://ocr/viewer';

export function renderOcrViewerTemplate(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OCR</title>
<style>
:root {
	--bg: #f8f9fb; --panel: #ffffff; --text: #1c1e26; --muted: #6b7280;
	--border: #e5e7eb; --accent: #2563eb; --badge-stub: #b45309; --badge-stub-bg: #fef3c7;
	--badge-real: #047857; --badge-real-bg: #d1fae5; --sheet: #ffffff; --box: rgba(37, 99, 235, 0.08);
}
html.theme-dark {
	--bg: #1b1d24; --panel: #23252e; --text: #e6e8ee; --muted: #9ca3af;
	--border: #363943; --accent: #60a5fa; --badge-stub: #fcd34d; --badge-stub-bg: #45350c;
	--badge-real: #6ee7b7; --badge-real-bg: #0c3d2e; --sheet: #2a2d38; --box: rgba(96, 165, 250, 0.12);
}
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text);
	font-family: system-ui, -apple-system, sans-serif; font-size: 14px; }
.wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 12px; gap: 10px; }
header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
header h1 { font-size: 15px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.badge.stub { color: var(--badge-stub); background: var(--badge-stub-bg); }
.badge.real { color: var(--badge-real); background: var(--badge-real-bg); }
.meta { font-size: 12px; color: var(--muted); }
.toolbar { display: flex; gap: 6px; margin-left: auto; }
button {
	font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
	border: 1px solid var(--border); background: var(--panel); color: var(--text);
}
button:hover { border-color: var(--accent); color: var(--accent); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
.tab {
	font: inherit; font-size: 13px; padding: 6px 12px; cursor: pointer; border: none;
	background: none; color: var(--muted); border-bottom: 2px solid transparent; border-radius: 0;
}
.tab:hover { color: var(--accent); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.view { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.view[hidden] { display: none; }
.page { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.page h2 { font-size: 12px; margin: 0 0 6px; color: var(--muted); font-weight: 600;
	text-transform: uppercase; letter-spacing: 0.04em; }
.page pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; line-height: 1.5; }
.sheet {
	position: relative; width: 100%; background: var(--sheet);
	border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.sheet .preview {
	position: absolute; inset: 0; padding: 4%; overflow: hidden;
	font-size: 9px; line-height: 1.35; color: var(--muted);
	white-space: pre-wrap; overflow-wrap: anywhere; user-select: none;
}
.sheet canvas, .sheet .pageimg {
	position: absolute; inset: 0; width: 100%; height: 100%; display: block;
}
.notice {
	font-size: 12px; color: var(--muted); background: var(--panel);
	border: 1px dashed var(--border); border-radius: 8px; padding: 8px 12px;
}
.bbox {
	position: absolute; box-sizing: border-box; border: 2px solid var(--accent);
	background: var(--box); border-radius: 2px;
}
.bbox img { width: 100%; height: 100%; object-fit: contain; display: block; }
.bbox .tag {
	position: absolute; top: -1px; left: -1px; font-size: 10px; line-height: 1;
	padding: 2px 4px; background: var(--accent); color: #fff; border-radius: 0 0 3px 0;
	max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.caption { font-size: 11px; color: var(--muted); margin-top: 6px; }
.empty { color: var(--muted); text-align: center; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
	<header>
		<h1 id="filename">OCR</h1>
		<span class="badge" id="provider" hidden></span>
		<span class="meta" id="pagecount"></span>
		<div class="toolbar"><button id="copy" hidden>Copier</button></div>
	</header>
	<div class="tabs" id="tabs" hidden>
		<button class="tab active" id="tab-text">Texte</button>
		<button class="tab" id="tab-layout">Mise en page</button>
	</div>
	<div class="view" id="view-text"><div class="empty">En attente du résultat OCR…</div></div>
	<div class="view" id="view-layout" hidden></div>
</div>
<script type="module">
import { App } from '/api/mcp-apps/vendor/app.js';

let fullText = '';

function isFullPayload(v) {
	return v && typeof v === 'object' && Array.isArray(v.pages);
}

function setBothViews(text) {
	for (const id of ['view-text', 'view-layout']) {
		const view = document.getElementById(id);
		view.textContent = '';
		const empty = document.createElement('div');
		empty.className = 'empty';
		empty.textContent = text;
		view.appendChild(empty);
	}
}

/**
 * Big results are not embedded in the tool message: ocr_extract returns a
 * small {docId, counts…} and the panel fetches the full payload itself
 * through the MCP Apps bridge (ocr_get_result — allowlisted, never persisted
 * in the chat, so the heavy data stays out of the LLM prompt).
 */
async function fetchPayload(docId) {
	const res = await app.callServerTool({
		name: 'ocr_get_result',
		arguments: { doc: docId, include_document: true }
	});
	const sc = res && res.structuredContent;
	if (isFullPayload(sc)) return sc;
	const text = res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
	throw new Error(text || 'payload indisponible');
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function renderText(pages) {
	const container = document.getElementById('view-text');
	container.textContent = '';
	for (const page of pages) {
		const card = document.createElement('div');
		card.className = 'page';
		const title = document.createElement('h2');
		title.textContent = 'Page ' + (typeof page.page === 'number' ? page.page : '?');
		const pre = document.createElement('pre');
		pre.textContent = page.text; // untrusted OCR output — textContent only
		card.appendChild(title);
		card.appendChild(pre);
		container.appendChild(card);
	}
	if (pages.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty';
		empty.textContent = 'Aucun texte extrait.';
		container.appendChild(empty);
	}
}

function dataUriToBytes(dataUri) {
	const comma = dataUri.indexOf(',');
	const raw = atob(dataUri.slice(comma + 1));
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build';

/** Load the original PDF with pdf.js (CDN); null when unavailable — fallback preview. */
async function loadPdf(doc) {
	if (!doc || doc.mediaType !== 'application/pdf') return null;
	if (typeof doc.dataUri !== 'string' || !doc.dataUri.startsWith('data:application/pdf')) return null;
	try {
		const pdfjs = await import(PDFJS_CDN + '/pdf.min.mjs');
		pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + '/pdf.worker.min.mjs';
		return await pdfjs.getDocument({ data: dataUriToBytes(doc.dataUri) }).promise;
	} catch (e) {
		console.warn('pdf.js unavailable, falling back to text preview', e);
		return null;
	}
}

/** Rasterize one PDF page into a canvas covering the sheet. */
async function renderPdfPage(pdfDoc, pageNo, sheet) {
	const page = await pdfDoc.getPage(pageNo);
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: Math.min(2, 1200 / base.width) });
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	sheet.style.aspectRatio = canvas.width + ' / ' + canvas.height;
	sheet.appendChild(canvas);
	await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

async function renderLayout(pages, doc) {
	const container = document.getElementById('view-layout');
	container.textContent = '';
	let drawn = 0;
	const totalBoxes = pages.reduce(
		(n, p) => n + (Array.isArray(p.images) ? p.images.length : 0),
		0
	);
	// Mistral basic OCR only boxes detected FIGURES — a text-only document
	// legitimately has zero boxes; say it instead of leaving it implicit.
	if (totalBoxes === 0 && pages.length > 0) {
		const notice = document.createElement('div');
		notice.className = 'notice';
		notice.textContent =
			'Aucune image/figure détectée dans ce document — les bounding boxes de Mistral OCR ne couvrent que les images, pas le texte.';
		container.appendChild(notice);
	}

	const pdfDoc = await loadPdf(doc);
	const imageUri =
		doc &&
		typeof doc.mediaType === 'string' &&
		doc.mediaType.startsWith('image/') &&
		typeof doc.dataUri === 'string' &&
		doc.dataUri.startsWith('data:image/')
			? doc.dataUri
			: null;

	for (const page of pages) {
		const width = num(page.width);
		const height = num(page.height);
		const pageNo = typeof page.page === 'number' ? page.page : null;
		if (!width || !height) {
			if (!pdfDoc && !imageUri) continue;
		}
		drawn++;

		const card = document.createElement('div');
		card.className = 'page';
		const title = document.createElement('h2');
		title.textContent = 'Page ' + (pageNo ?? '?');
		card.appendChild(title);

		const sheet = document.createElement('div');
		sheet.className = 'sheet';
		if (width && height) sheet.style.aspectRatio = width + ' / ' + height;

		// Page background, by fidelity: real PDF page (pdf.js) > original image
		// > thumbnail-style text preview (no CDN / file too big / not embedded).
		let background = 'preview';
		if (pdfDoc && pageNo !== null && pageNo >= 1 && pageNo <= pdfDoc.numPages) {
			try {
				await renderPdfPage(pdfDoc, pageNo, sheet);
				background = 'pdf';
			} catch (e) {
				console.warn('pdf.js page render failed', e);
			}
		} else if (imageUri) {
			const img = document.createElement('img');
			img.className = 'pageimg';
			img.src = imageUri;
			img.alt = 'page';
			sheet.appendChild(img);
			background = 'image';
		}
		if (background === 'preview' && typeof page.text === 'string' && page.text !== '') {
			const preview = document.createElement('div');
			preview.className = 'preview';
			preview.textContent = page.text; // untrusted OCR output — textContent only
			sheet.appendChild(preview);
		}

		// Boxes need the Mistral page dimensions to be positioned (percent coords).
		const images = Array.isArray(page.images) ? page.images : [];
		if (width && height) {
			for (const box of images) {
				const x0 = num(box.x0), y0 = num(box.y0), x1 = num(box.x1), y1 = num(box.y1);
				if (x0 === null || y0 === null || x1 === null || y1 === null || x1 <= x0 || y1 <= y0) continue;
				const div = document.createElement('div');
				div.className = 'bbox';
				div.style.left = (x0 / width) * 100 + '%';
				div.style.top = (y0 / height) * 100 + '%';
				div.style.width = ((x1 - x0) / width) * 100 + '%';
				div.style.height = ((y1 - y0) / height) * 100 + '%';
				div.title = String(box.id || '') + ' — [' + x0 + ', ' + y0 + '] → [' + x1 + ', ' + y1 + ']';
				// On a real page render the content is already under the box — outline
				// only. On the fallback preview, show the crop (inert image data URI).
				if (
					background === 'preview' &&
					typeof box.base64 === 'string' &&
					box.base64.startsWith('data:image/')
				) {
					const img = document.createElement('img');
					img.src = box.base64;
					img.alt = String(box.id || 'image');
					div.appendChild(img);
				} else {
					const tag = document.createElement('span');
					tag.className = 'tag';
					tag.textContent = String(box.id || 'image');
					div.appendChild(tag);
				}
				sheet.appendChild(div);
			}
		}
		card.appendChild(sheet);

		const caption = document.createElement('div');
		caption.className = 'caption';
		const dpi = num(page.dpi);
		const dims = width && height ? width + ' × ' + height + ' px' + (dpi ? ' (' + dpi + ' dpi)' : '') : 'dimensions inconnues';
		const source =
			background === 'pdf' ? 'rendu PDF' : background === 'image' ? 'image originale' : 'aperçu texte';
		caption.textContent = dims + ' — ' + images.length + ' zone(s) détectée(s) — ' + source;
		card.appendChild(caption);
		container.appendChild(card);
	}
	if (drawn === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty';
		empty.textContent = 'Pas de données de mise en page (le connecteur n’a pas fourni les dimensions des pages).';
		container.appendChild(empty);
	}
}

function selectTab(which) {
	document.getElementById('tab-text').classList.toggle('active', which === 'text');
	document.getElementById('tab-layout').classList.toggle('active', which === 'layout');
	document.getElementById('view-text').hidden = which !== 'text';
	document.getElementById('view-layout').hidden = which !== 'layout';
}
document.getElementById('tab-text').addEventListener('click', () => selectTab('text'));
document.getElementById('tab-layout').addEventListener('click', () => selectTab('layout'));

function renderHeader(data) {
	if (typeof data.fileName === 'string') {
		document.getElementById('filename').textContent = data.fileName;
	}
	const provider = document.getElementById('provider');
	provider.hidden = false;
	provider.textContent = data.provider === 'stub' ? 'démo (stub)' : String(data.provider || '');
	provider.className = 'badge ' + (data.provider === 'stub' ? 'stub' : 'real');

	const count = Array.isArray(data.pages) ? data.pages.length : data.pageCount;
	if (typeof count === 'number') {
		document.getElementById('pagecount').textContent = count + (count > 1 ? ' pages' : ' page');
	}
}

function renderAll(payload) {
	const pages = payload.pages.filter(
		(p) => p && typeof p === 'object' && typeof p.text === 'string'
	);
	fullText = pages.map((p) => p.text).join('\\n\\n');
	renderText(pages);
	// Async: rasterizes the embedded PDF with pdf.js when available.
	renderLayout(pages, payload.document).catch((e) => console.warn('layout render failed', e));

	document.getElementById('tabs').hidden = false;
	document.getElementById('copy').hidden = pages.length === 0;
}

function render(data) {
	if (!data || typeof data !== 'object') return;
	renderHeader(data);

	// Small docs / stub: the full payload rides inline in structuredContent.
	if (isFullPayload(data)) {
		renderAll(data);
		return;
	}

	// Big docs: only {docId, counts…} — fetch the payload through the bridge.
	if (typeof data.docId === 'string') {
		document.getElementById('tabs').hidden = false;
		setBothViews('Chargement du résultat OCR…');
		fetchPayload(data.docId)
			.then((payload) => {
				renderHeader({ ...data, ...payload });
				renderAll(payload);
			})
			.catch((e) => {
				console.warn('bridge fetch failed', e);
				setBothViews(
					'Impossible de charger le résultat complet (' +
						(e && e.message ? e.message : 'erreur') +
						'). Un aperçu du texte figure dans la réponse du chat.'
				);
			});
	}
}

document.getElementById('copy').addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(fullText);
		const btn = document.getElementById('copy');
		btn.textContent = 'Copié !';
		setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
	} catch {
		// clipboard unavailable in this sandbox — ignore
	}
});

function applyTheme(theme) {
	document.documentElement.classList.toggle('theme-dark', theme === 'dark');
}

const app = new App({ name: 'ocr-viewer', version: '1.0.0' });
app.ontoolresult = (result) => {
	const sc = result && result.structuredContent;
	if (sc) render(sc);
};
app.onhostcontextchanged = (ctx) => {
	if (ctx && (ctx.theme === 'dark' || ctx.theme === 'light')) applyTheme(ctx.theme);
};
await app.connect();
const ctx = app.getHostContext();
if (ctx && (ctx.theme === 'dark' || ctx.theme === 'light')) applyTheme(ctx.theme);
</script>
</body>
</html>`;
}
