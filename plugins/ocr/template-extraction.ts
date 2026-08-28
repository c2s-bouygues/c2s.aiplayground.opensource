/**
 * Static SEP-1865 MCP App template for the structured field extraction tool
 * (MagicOCR-style results panel).
 *
 * Registered as `ui://ocr/extraction` (see the plugin's `appResources`) and
 * served by /api/mcp-apps/resource. Same contract as `ui://ocr/viewer`: the
 * template carries NO per-call data — the tool result's `data` arrives as
 * `structuredContent` through the ext-apps bridge, the theme via `hostContext`.
 *
 * Renders: a summary strip (extracted / missing / low-confidence / divergent /
 * corrected counts), a single field table with per-field confidence chips
 * (green ≥80 / orange ≥60 / red <60, MagicOCR's Excel color rule), per-value
 * copy buttons, manual correction of values (extract → verify → fix → export
 * workflow: corrected values are marked, revertible, and flow into the CSV),
 * a "needs review" filter, the VLM vs OCR comparison merged as a status column
 * (divergent rows expand to show both values with the differing segment
 * highlighted), coherence-check results, errors/warnings, a consumption card
 * when the comparison ran (Anthropic input/output tokens of the VLM and
 * OCR-text sides from `data.tokenUsage`, plus per-approach USD cost estimates
 * from `data.costEstimate` — OpenRouter token prices + page-billed Mistral
 * OCR — when the server could resolve them), and a CSV export
 * (copy + download; the CSV layout mirrors MagicOCR's "Résultats" sheet: one
 * row per document, `;` separator and UTF-8 BOM for French Excel, plus a
 * trailing "Champs corrigés" column listing manually corrected fields), and a
 * side-by-side preview of the original document ("Aperçu document" toggle):
 * the tool stores the file in the plugin's result store and the panel fetches
 * it lazily via ocr_get_result through the MCP Apps bridge (never persisted in
 * the chat), rendering PDFs with pdf.js from jsdelivr and images directly.
 * Per-field provenance (result.fieldSources, model-reported) renders as a
 * "p. N" chip whose tooltip carries the exact quote; clicking it opens the
 * preview, highlights the quote on the page — via the pdf.js text layer on
 * native-text PDFs, else via the Mistral layout blocks stored with the OCR
 * pages (paragraph granularity, works on scans/images) — and scrolls to it;
 * plain page scroll when neither source matches.
 *
 * Extracted values are untrusted (they come from a user document through an
 * LLM), so every string goes through `textContent` — never innerHTML.
 */

export const EXTRACTION_VIEWER_RESOURCE_URI = 'ui://ocr/extraction';

export function renderExtractionViewerTemplate(): string {
	return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Extraction de champs</title>
<style>
:root {
	--bg: #f8f9fb; --panel: #ffffff; --text: #1c1e26; --muted: #6b7280;
	--border: #e5e7eb; --accent: #2563eb; --accent-bg: #dbeafe;
	--ok: #047857; --ok-bg: #d1fae5;
	--warn: #b45309; --warn-bg: #fef3c7;
	--err: #b91c1c; --err-bg: #fee2e2;
}
html.theme-dark {
	--bg: #1b1d24; --panel: #23252e; --text: #e6e8ee; --muted: #9ca3af;
	--border: #363943; --accent: #60a5fa; --accent-bg: #1e3a5f;
	--ok: #6ee7b7; --ok-bg: #0c3d2e;
	--warn: #fcd34d; --warn-bg: #45350c;
	--err: #fca5a5; --err-bg: #4c1414;
}
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text);
	font-family: system-ui, -apple-system, sans-serif; font-size: 14px; }
.wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 12px; gap: 10px; }
header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
header h1 { font-size: 15px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.err { color: var(--err); background: var(--err-bg); }
.toolbar { display: flex; gap: 6px; margin-left: auto; }
button {
	font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
	border: 1px solid var(--border); background: var(--panel); color: var(--text);
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.active { border-color: var(--accent); color: var(--accent); background: var(--bg); font-weight: 600; }
.summary { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.stat { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600;
	border: 1px solid var(--border); color: var(--muted); background: var(--panel); }
.stat.ok { color: var(--ok); background: var(--ok-bg); border-color: transparent; }
.stat.warn { color: var(--warn); background: var(--warn-bg); border-color: transparent; }
.stat.err { color: var(--err); background: var(--err-bg); border-color: transparent; }
.stat.edited { color: var(--accent); background: var(--accent-bg); border-color: transparent; }
.main { flex: 1; display: flex; gap: 10px; min-height: 0; }
.body { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.docpane { flex: 0 0 45%; min-width: 0; overflow-y: auto; box-sizing: border-box;
	background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.docpane canvas, .docpane img { width: 100%; height: auto; display: block; margin: 0 auto;
	border: 1px solid var(--border); border-radius: 4px; background: #fff; }
.docpane .sheet { position: relative; }
.docpane .hl { position: absolute; background: rgba(96, 165, 250, 0.32);
	outline: 1.5px solid var(--accent); border-radius: 2px; pointer-events: none; }
.docpane .pagelabel { font-size: 11px; color: var(--muted); margin: 8px 0 3px; }
.docpane .notice { color: var(--muted); font-size: 12px; text-align: center; margin-top: 24px; }
@media (max-width: 700px) { .main { flex-direction: column; } .docpane { flex: 0 0 40%; } }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.card h2 { font-size: 12px; margin: 0 0 8px; color: var(--muted); font-weight: 600;
	text-transform: uppercase; letter-spacing: 0.04em; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border);
	vertical-align: top; overflow-wrap: anywhere; }
th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em;
	position: sticky; top: 0; background: var(--panel); z-index: 1; }
tr:last-child td { border-bottom: none; }
td.null, .val.null { color: var(--muted); font-style: italic; }
.val.null.required-missing { color: var(--err); font-weight: 600; }
.chip { display: inline-block; min-width: 42px; text-align: center; font-size: 11px;
	padding: 2px 6px; border-radius: 999px; font-weight: 600; }
.chip.ok { color: var(--ok); background: var(--ok-bg); }
.chip.warn { color: var(--warn); background: var(--warn-bg); }
.chip.err { color: var(--err); background: var(--err-bg); }
.chip.edited { color: var(--accent); background: var(--accent-bg); }
.chip.source { color: var(--muted); background: var(--bg); border: 1px solid var(--border);
	min-width: 0; font-weight: 500; }
.chip.source.unverified { color: var(--warn); background: var(--warn-bg); border-color: transparent; }
.chip.toggle { cursor: pointer; user-select: none; }
.valwrap { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.valwrap .val { flex: 1; min-width: 0; }
.copy, .edit, .revert { border: none; background: none; padding: 0 2px; font-size: 12px;
	color: var(--muted); cursor: pointer; opacity: 0; transition: opacity 0.1s; }
tr:hover .copy, tr:hover .edit, tr:hover .revert, .detailrow .copy { opacity: 1; }
.copy:hover, .edit:hover, .revert:hover { color: var(--accent); border: none; }
.more { border: none; background: none; padding: 0; font-size: 12px; color: var(--accent); cursor: pointer; }
.more:hover { border: none; }
.editbox { display: flex; flex-direction: column; gap: 4px; }
.editbox textarea { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid var(--accent);
	border-radius: 6px; background: var(--bg); color: var(--text); resize: vertical; min-height: 30px;
	box-sizing: border-box; width: 100%; }
.editactions { display: flex; gap: 6px; }
.editactions .hint { font-size: 11px; color: var(--muted); align-self: center; }
tr.detail > td { background: var(--bg); padding: 8px 12px; }
.detailrow { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.detailrow .side { font-size: 11px; color: var(--muted); text-transform: uppercase;
	letter-spacing: 0.04em; min-width: 90px; }
.diff { background: var(--warn-bg); color: var(--warn); border-radius: 3px; padding: 0 1px; }
ul { margin: 0; padding-left: 18px; }
li { margin: 2px 0; overflow-wrap: anywhere; }
li.error { color: var(--err); }
li.warning { color: var(--warn); }
.check { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; }
.check .mark { font-weight: 700; }
.check.pass .mark { color: var(--ok); }
.check.fail .mark { color: var(--err); }
.check .msg { color: var(--muted); }
.empty { color: var(--muted); text-align: center; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
	<header>
		<h1 id="filename">Extraction de champs</h1>
		<span class="badge" id="status" hidden></span>
		<span class="badge" id="confidence" hidden></span>
		<span class="badge warn" id="mode" hidden>double extraction</span>
		<span class="badge warn" id="provider" hidden>démo (stub)</span>
		<div class="toolbar">
			<button id="toggledoc" hidden>Aperçu document</button>
			<button id="filterreview" hidden>À vérifier</button>
			<button id="copycsv" hidden>Copier CSV</button>
			<button id="downloadcsv" hidden>Télécharger CSV</button>
		</div>
	</header>
	<div class="summary" id="summary" hidden></div>
	<div class="main">
		<div class="body" id="body"><div class="empty">En attente du résultat d’extraction…</div></div>
		<div class="docpane" id="docpane" hidden></div>
	</div>
</div>
<script type="module">
import { App } from '/api/mcp-apps/vendor/app.js';

let csvFileName = 'extraction.csv';
let reviewFilterActive = false;
/** Last structuredContent received — CSV is rebuilt from it (+ corrections) on export. */
let lastData = null;
/** Manual corrections: field name → corrected string value. Reset at each render. */
let corrections = new Map();
/** [{row, detailRow|null, field, original, baseNeedsReview, needsReview, expanded, tdValue}] */
let fieldRows = [];
/** docId of the stored panel payload (document preview); null when unavailable. */
let currentDocId = null;
/** Document preview pane: 'idle' (not fetched) | 'loading' | 'loaded' | 'failed'. */
let docPaneState = 'idle';
let docPaneOpen = false;
/** Pending renderDocPane() call — awaited by jumpToPage before scrolling. */
let docPaneLoadPromise = null;
/** pdf.js document of the rendered preview (native-text PDFs) — quote highlighting. */
let pdfDocRef = null;
/** page number → { sheet, scale } of the rendered pages (scale null for images). */
let sheetInfo = new Map();
/** OCR pages of the fetched payload (with Mistral blocks) — quote-highlight fallback. */
let payloadPages = [];

const CONF_TOOLTIP = 'Seuils de confiance — ≥ 80 % : fiable · 60–79 % : à vérifier · < 60 % : douteux';
/** Above this length a value is collapsed behind a « voir plus » toggle. */
const VALUE_PREVIEW_CHARS = 300;

function isExtractionData(v) {
	return v && typeof v === 'object' && typeof v.fileName === 'string'
		&& v.result && typeof v.result === 'object' && Array.isArray(v.templateFields);
}

function confidenceClass(value) {
	if (value >= 80) return 'ok';
	if (value >= 60) return 'warn';
	return 'err';
}

function formatValue(value) {
	if (value === null || value === undefined) return null;
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function csvCell(value) {
	const text = value === null || value === undefined ? '' : String(value);
	return '"' + text.replaceAll('"', '""') + '"';
}

/** Corrected value if the user fixed the field, else the extracted one. */
function effectiveValue(name, original) {
	return corrections.has(name) ? corrections.get(name) : original;
}

/**
 * MagicOCR "Résultats" sheet layout: one row per document. Manual corrections
 * replace the extracted values; the trailing "Champs corrigés" column lists them.
 */
function buildCsv(data) {
	const result = data.result;
	const names = data.templateFields.map((f) => f.name);
	const header = ['Document']
		.concat(names)
		.concat(['Confiance (%)'])
		.concat(names.map((n) => 'Confiance ' + n + ' (%)'))
		.concat(['Erreurs', 'Avertissements', 'Champs corrigés']);
	const row = [data.fileName]
		.concat(names.map((n) => effectiveValue(n, formatValue(result.fields ? result.fields[n] : null))))
		.concat([result.confidence])
		.concat(names.map((n) => (result.fieldConfidences ? result.fieldConfidences[n] : '') ?? ''))
		.concat([
			(result.errors || []).join(' | '),
			(result.warnings || []).join(' | '),
			names.filter((n) => corrections.has(n)).join(' | ')
		]);
	// \\uFEFF BOM + ';' separator: opens correctly in French Excel.
	return '\\uFEFF' + header.map(csvCell).join(';') + '\\r\\n' + row.map(csvCell).join(';');
}

function makeCard(title) {
	const card = document.createElement('div');
	card.className = 'card';
	const h = document.createElement('h2');
	h.textContent = title;
	card.appendChild(h);
	return card;
}

function makeConfChip(value) {
	const chip = document.createElement('span');
	chip.className = 'chip ' + confidenceClass(value);
	chip.textContent = Math.round(value) + '%';
	chip.title = CONF_TOOLTIP;
	return chip;
}

function makeCopyButton(text) {
	const btn = document.createElement('button');
	btn.className = 'copy';
	btn.type = 'button';
	btn.textContent = 'copier';
	btn.title = 'Copier la valeur';
	btn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(text);
			btn.textContent = '✓';
			setTimeout(() => { btn.textContent = 'copier'; }, 1200);
		} catch {
			// clipboard unavailable in this sandbox — ignore
		}
	});
	return btn;
}

/** Fill \`container\` with \`text\`, collapsed behind « voir plus » when long. */
function appendCollapsibleText(container, text) {
	if (text.length <= VALUE_PREVIEW_CHARS) {
		container.textContent = text; // untrusted extracted value — textContent only
		return;
	}
	const span = document.createElement('span');
	const toggle = document.createElement('button');
	toggle.className = 'more';
	toggle.type = 'button';
	let expanded = false;
	const apply = () => {
		span.textContent = expanded ? text : text.slice(0, VALUE_PREVIEW_CHARS) + '… ';
		toggle.textContent = expanded ? ' voir moins' : 'voir plus';
	};
	toggle.addEventListener('click', () => { expanded = !expanded; apply(); });
	apply();
	container.appendChild(span);
	container.appendChild(toggle);
}

/**
 * Fill \`container\` with \`text\`, highlighting the segment that differs from
 * \`other\` (common prefix/suffix stay plain). textContent only — no innerHTML.
 */
function appendDiffText(container, text, other) {
	let p = 0;
	while (p < text.length && p < other.length && text[p] === other[p]) p++;
	let s = 0;
	while (s < text.length - p && s < other.length - p
		&& text[text.length - 1 - s] === other[other.length - 1 - s]) s++;
	const mid = text.slice(p, text.length - s);
	if (mid === '') {
		container.textContent = text;
		return;
	}
	container.appendChild(document.createTextNode(text.slice(0, p)));
	const mark = document.createElement('span');
	mark.className = 'diff';
	mark.textContent = mid;
	container.appendChild(mark);
	container.appendChild(document.createTextNode(text.slice(text.length - s)));
}

/** One "Vision (VLM)" / "Texte (OCR)" line inside an expanded divergence row. */
function makeDetailLine(label, value, conf, otherValue) {
	const line = document.createElement('div');
	line.className = 'detailrow';
	const side = document.createElement('span');
	side.className = 'side';
	side.textContent = label;
	line.appendChild(side);
	const val = document.createElement('span');
	val.className = 'val';
	if (value === null) {
		val.textContent = 'non trouvé';
		val.style.fontStyle = 'italic';
		val.style.color = 'var(--muted)';
	} else if (otherValue !== null) {
		appendDiffText(val, value, otherValue);
	} else {
		val.textContent = value; // untrusted extracted value — textContent only
	}
	line.appendChild(val);
	if (typeof conf === 'number') line.appendChild(makeConfChip(conf));
	if (value !== null) line.appendChild(makeCopyButton(value));
	return line;
}

function applyReviewFilter() {
	for (const entry of fieldRows) {
		const hide = reviewFilterActive && !entry.needsReview;
		entry.row.hidden = hide;
		if (entry.detailRow) entry.detailRow.hidden = hide || !entry.expanded;
	}
}

/** Refresh the review-filter button and the "corrigé(s)" stat after an edit. */
function updateReviewUi() {
	const reviewCount = fieldRows.filter((e) => e.needsReview).length;
	const filterBtn = document.getElementById('filterreview');
	filterBtn.hidden = reviewCount === 0;
	filterBtn.textContent = 'À vérifier (' + reviewCount + ')';
	if (reviewCount === 0) reviewFilterActive = false;
	filterBtn.classList.toggle('active', reviewFilterActive);
	applyReviewFilter();

	const stat = document.getElementById('correctedstat');
	if (stat) {
		stat.hidden = corrections.size === 0;
		stat.textContent = corrections.size + ' corrigé(s)';
	}
}

/** Display mode of a value cell: value (or "non trouvé") + copy/edit/revert controls. */
function renderValueCell(entry) {
	const td = entry.tdValue;
	const field = entry.field;
	td.textContent = '';
	const corrected = corrections.has(field.name);
	const value = corrected ? corrections.get(field.name) : entry.original;

	const wrap = document.createElement('div');
	wrap.className = 'valwrap';
	const val = document.createElement('span');
	if (value === null) {
		val.className = 'val null' + (field.required ? ' required-missing' : '');
		val.textContent = field.required ? 'non trouvé (requis)' : 'non trouvé';
	} else {
		val.className = 'val';
		appendCollapsibleText(val, value); // untrusted extracted value — textContent only
	}
	wrap.appendChild(val);

	if (corrected) {
		const chip = document.createElement('span');
		chip.className = 'chip edited';
		chip.textContent = 'corrigé';
		chip.title = 'Valeur originale : ' + (entry.original === null ? 'non trouvé' : entry.original);
		wrap.appendChild(chip);
		const revert = document.createElement('button');
		revert.className = 'revert';
		revert.type = 'button';
		revert.textContent = 'rétablir';
		revert.title = 'Revenir à la valeur extraite';
		revert.addEventListener('click', () => {
			corrections.delete(field.name);
			entry.needsReview = entry.baseNeedsReview;
			renderValueCell(entry);
			updateReviewUi();
		});
		wrap.appendChild(revert);
	}

	// Provenance chip ("p. N", model-reported): tooltip carries the exact quote,
	// click jumps to the page in the document preview when it is available.
	// verified === true: the quote was found in the OCR text (audited);
	// verified === false: it was not — shown as a doubt, not an error.
	const source = entry.source;
	if (source && (source.page !== null || source.quote)) {
		const src = document.createElement('span');
		src.className = 'chip source' + (source.verified === false ? ' unverified' : '');
		const mark = source.verified === true ? ' ✓' : source.verified === false ? ' ?' : '';
		src.textContent = (source.page !== null ? 'p. ' + source.page : 'source') + mark;
		const verifiedNote = source.verified === true
			? ' — citation vérifiée dans le texte OCR'
			: source.verified === false
				? ' — citation non retrouvée dans le texte OCR (à vérifier)'
				: '';
		src.title = (source.quote ? '« ' + source.quote + ' »' : 'Localisation dans le document')
			+ verifiedNote
			+ (currentDocId !== null && source.page !== null ? ' — cliquer pour afficher la page' : '');
		if (currentDocId !== null && source.page !== null) {
			src.classList.add('toggle');
			src.addEventListener('click', () => jumpToPage(source.page, source.quote));
		}
		wrap.appendChild(src);
	}

	if (value !== null) wrap.appendChild(makeCopyButton(value));

	const edit = document.createElement('button');
	edit.className = 'edit';
	edit.type = 'button';
	edit.textContent = 'modifier';
	edit.title = 'Corriger la valeur manuellement (reprise dans l’export CSV)';
	edit.addEventListener('click', () => renderEditCell(entry));
	wrap.appendChild(edit);

	td.appendChild(wrap);
}

/** Edit mode of a value cell: textarea + OK / Annuler (Échap annule). */
function renderEditCell(entry) {
	const td = entry.tdValue;
	const field = entry.field;
	td.textContent = '';
	const box = document.createElement('div');
	box.className = 'editbox';
	const area = document.createElement('textarea');
	const current = effectiveValue(field.name, entry.original);
	area.value = current === null ? '' : current;
	box.appendChild(area);
	const actions = document.createElement('div');
	actions.className = 'editactions';
	const ok = document.createElement('button');
	ok.type = 'button';
	ok.textContent = 'OK';
	const cancel = document.createElement('button');
	cancel.type = 'button';
	cancel.textContent = 'Annuler';
	const hint = document.createElement('span');
	hint.className = 'hint';
	hint.textContent = 'vide = valeur extraite';
	actions.appendChild(ok);
	actions.appendChild(cancel);
	actions.appendChild(hint);
	box.appendChild(actions);
	td.appendChild(box);
	area.focus();

	const commit = () => {
		const raw = area.value;
		// Empty input or identical to the extracted value: drop the correction.
		if (raw.trim() === '' || raw === entry.original) {
			corrections.delete(field.name);
			entry.needsReview = entry.baseNeedsReview;
		} else {
			corrections.set(field.name, raw);
			// A manual fix counts as human-reviewed.
			entry.needsReview = false;
		}
		renderValueCell(entry);
		updateReviewUi();
	};
	ok.addEventListener('click', commit);
	cancel.addEventListener('click', () => renderValueCell(entry));
	area.addEventListener('keydown', (ev) => {
		if (ev.key === 'Escape') renderValueCell(entry);
		else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) commit();
	});
}

// --- Side-by-side document preview -----------------------------------------

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build';

function dataUriToBytes(dataUri) {
	const comma = dataUri.indexOf(',');
	const raw = atob(dataUri.slice(comma + 1));
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** Load the original PDF with pdf.js (CDN); null when unavailable. */
async function loadPdf(doc) {
	if (!doc || doc.mediaType !== 'application/pdf') return null;
	if (typeof doc.dataUri !== 'string' || !doc.dataUri.startsWith('data:application/pdf')) return null;
	try {
		const pdfjs = await import(PDFJS_CDN + '/pdf.min.mjs');
		pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + '/pdf.worker.min.mjs';
		return await pdfjs.getDocument({ data: dataUriToBytes(doc.dataUri) }).promise;
	} catch (e) {
		console.warn('pdf.js unavailable — no document preview', e);
		return null;
	}
}

function docPaneNotice(pane, text) {
	pane.textContent = '';
	const notice = document.createElement('div');
	notice.className = 'notice';
	notice.textContent = text;
	pane.appendChild(notice);
}

/**
 * Fetch the stored payload through the MCP Apps bridge (ocr_get_result — never
 * persisted in the chat) and render the original document in the pane.
 */
async function renderDocPane() {
	const pane = document.getElementById('docpane');
	docPaneNotice(pane, 'Chargement du document…');
	try {
		const res = await app.callServerTool({
			name: 'ocr_get_result',
			arguments: { doc: currentDocId, include_document: true }
		});
		const sc = res && res.structuredContent;
		payloadPages = sc && Array.isArray(sc.pages) ? sc.pages : [];
		const doc = sc && sc.document;
		if (!doc || typeof doc.dataUri !== 'string') {
			docPaneNotice(pane, 'Aperçu indisponible (document trop volumineux ou non conservé).');
			docPaneState = 'failed';
			return;
		}
		if (typeof doc.mediaType === 'string' && doc.mediaType.startsWith('image/')) {
			pane.textContent = '';
			// Positioned wrapper so quote highlights can overlay the image too.
			const sheet = document.createElement('div');
			sheet.className = 'sheet';
			sheet.dataset.page = '1';
			const img = document.createElement('img');
			img.src = doc.dataUri; // data: URI rebuilt by the plugin from the stored file
			img.alt = 'Document original';
			sheet.appendChild(img);
			pane.appendChild(sheet);
			sheetInfo.set(1, { sheet, scale: null });
			docPaneState = 'loaded';
			return;
		}
		const pdfDoc = await loadPdf(doc);
		if (!pdfDoc) {
			docPaneNotice(pane, 'Aperçu PDF indisponible (pdf.js inaccessible).');
			docPaneState = 'failed';
			return;
		}
		pdfDocRef = pdfDoc;
		pane.textContent = '';
		for (let p = 1; p <= pdfDoc.numPages; p++) {
			if (pdfDoc.numPages > 1) {
				const label = document.createElement('div');
				label.className = 'pagelabel';
				label.textContent = 'Page ' + p + ' / ' + pdfDoc.numPages;
				pane.appendChild(label);
			}
			const page = await pdfDoc.getPage(p);
			const base = page.getViewport({ scale: 1 });
			const scale = Math.min(2, 1000 / base.width);
			const viewport = page.getViewport({ scale });
			// Positioned wrapper: quote-highlight overlays are placed above the canvas.
			const sheet = document.createElement('div');
			sheet.className = 'sheet';
			sheet.dataset.page = String(p); // jumpToPage anchor
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(viewport.width);
			canvas.height = Math.round(viewport.height);
			sheet.appendChild(canvas);
			pane.appendChild(sheet);
			sheetInfo.set(p, { sheet, scale });
			await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
		}
		docPaneState = 'loaded';
	} catch (e) {
		console.warn('document preview failed', e);
		docPaneNotice(pane, 'Aperçu indisponible (erreur de chargement).');
		docPaneState = 'failed';
	}
}

function setDocPaneOpen(open) {
	docPaneOpen = open;
	document.getElementById('docpane').hidden = !open;
	document.getElementById('toggledoc').classList.toggle('active', open);
	// Lazy fetch: the (heavy) payload is only pulled the first time the pane opens.
	if (open && docPaneState === 'idle') {
		docPaneState = 'loading';
		docPaneLoadPromise = renderDocPane();
	}
}

/** Accent/case-insensitive, whitespace-collapsed form used for quote matching. */
function normalizeMatchText(s) {
	return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ');
}

/**
 * Locate a quote in a pdf.js text-content item list: returns the indexes of
 * the items overlapping the first match, or null. Same matching spirit as the
 * server-side provenance audit (fold + collapsed whitespace).
 */
function findQuoteItems(items, quote) {
	const needle = normalizeMatchText(quote).trim();
	if (needle.length < 3) return null;
	let joined = '';
	const spans = [];
	for (let i = 0; i < items.length; i++) {
		const norm = normalizeMatchText(String(items[i].str || ''));
		const start = joined.length;
		joined += norm;
		spans.push({ start, end: joined.length, index: i });
		joined += ' ';
	}
	const at = joined.indexOf(needle);
	if (at === -1) return null;
	const to = at + needle.length;
	return spans.filter((s) => s.end > at && s.start < to).map((s) => s.index);
}

/** pdf.js text-layer highlight (line/fragment granularity, native-text PDFs). */
async function highlightViaPdfTextLayer(page, quote) {
	const info = sheetInfo.get(page);
	if (!pdfDocRef || !info || info.scale === null) return null;
	try {
		const pdfPage = await pdfDocRef.getPage(page);
		const textContent = await pdfPage.getTextContent();
		const items = textContent.items.filter(
			(it) => typeof it.str === 'string' && it.str.trim() !== ''
		);
		const matched = findQuoteItems(items, quote);
		if (!matched || matched.length === 0) return null;
		const viewport = pdfPage.getViewport({ scale: info.scale });
		const canvas = info.sheet.querySelector('canvas');
		let first = null;
		for (const i of matched) {
			const item = items[i];
			const t = item.transform;
			const rect = viewport.convertToViewportRectangle([
				t[4], t[5], t[4] + (item.width || 0), t[5] + (item.height || 0)
			]);
			const hl = document.createElement('div');
			hl.className = 'hl';
			hl.style.left = (Math.min(rect[0], rect[2]) / canvas.width) * 100 + '%';
			hl.style.top = (Math.min(rect[1], rect[3]) / canvas.height) * 100 + '%';
			hl.style.width = Math.max((Math.abs(rect[2] - rect[0]) / canvas.width) * 100, 0.5) + '%';
			hl.style.height = Math.max((Math.abs(rect[3] - rect[1]) / canvas.height) * 100, 0.8) + '%';
			info.sheet.appendChild(hl);
			if (!first) first = hl;
		}
		return first;
	} catch (e) {
		console.warn('pdf.js quote highlight failed', e);
		return null;
	}
}

/**
 * Mistral layout-blocks highlight (paragraph granularity — works on scans and
 * images, where there is no pdf.js text layer). Looks for the quote in the
 * block contents of the given page first, then of the other pages (the model's
 * page claim can be off); highlights the whole matching block.
 */
function highlightViaBlocks(page, quote) {
	const needle = normalizeMatchText(quote).trim();
	if (needle.length < 3) return null;
	const claimed = payloadPages.filter((p) => p && p.page === page);
	const others = payloadPages.filter((p) => p && p.page !== page);
	for (const p of claimed.concat(others)) {
		const width = typeof p.width === 'number' ? p.width : 0;
		const height = typeof p.height === 'number' ? p.height : 0;
		if (!width || !height || !Array.isArray(p.blocks)) continue;
		const info = sheetInfo.get(p.page);
		if (!info) continue;
		for (const block of p.blocks) {
			if (!block || typeof block.content !== 'string') continue;
			if (!normalizeMatchText(block.content).includes(needle)) continue;
			const x0 = block.x0, y0 = block.y0, x1 = block.x1, y1 = block.y1;
			if (typeof x0 !== 'number' || typeof y0 !== 'number'
				|| typeof x1 !== 'number' || typeof y1 !== 'number' || x1 <= x0 || y1 <= y0) continue;
			const hl = document.createElement('div');
			hl.className = 'hl';
			hl.style.left = (x0 / width) * 100 + '%';
			hl.style.top = (y0 / height) * 100 + '%';
			hl.style.width = ((x1 - x0) / width) * 100 + '%';
			hl.style.height = ((y1 - y0) / height) * 100 + '%';
			info.sheet.appendChild(hl);
			return hl;
		}
	}
	return null;
}

/**
 * Highlight the provenance quote in the preview — by fidelity: pdf.js text
 * layer (finest), then Mistral layout blocks (paragraph-level, scans/images
 * included). Overlays are positioned in % so responsive scaling keeps them
 * aligned. Returns the first highlight element, or null when nothing matched.
 */
async function highlightQuoteOnPage(page, quote) {
	for (const el of document.querySelectorAll('#docpane .hl')) el.remove();
	if (typeof quote !== 'string' || quote === '') return null;
	const viaPdf = await highlightViaPdfTextLayer(page, quote);
	if (viaPdf) return viaPdf;
	return highlightViaBlocks(page, quote);
}

/**
 * Open the preview (loading it if needed), highlight the quote on the given
 * 1-based page when the PDF text layer allows it, and scroll to the highlight
 * (or to the page as a fallback).
 */
async function jumpToPage(page, quote) {
	if (currentDocId === null) return;
	setDocPaneOpen(true);
	if (docPaneLoadPromise) {
		try { await docPaneLoadPromise; } catch { /* renderDocPane never throws, belt-and-braces */ }
	}
	if (typeof page !== 'number') return;
	const hl = quote ? await highlightQuoteOnPage(page, quote) : null;
	const target = hl || document.querySelector('#docpane [data-page="' + page + '"]');
	if (target && typeof target.scrollIntoView === 'function') {
		target.scrollIntoView({ block: hl ? 'center' : 'start', behavior: 'smooth' });
	}
}

function addStat(summary, text, kind, id) {
	const stat = document.createElement('span');
	stat.className = 'stat' + (kind ? ' ' + kind : '');
	stat.textContent = text;
	if (id) stat.id = id;
	summary.appendChild(stat);
	return stat;
}

function render(data) {
	if (!isExtractionData(data)) return;
	const result = data.result;
	lastData = data;
	corrections = new Map();

	document.getElementById('filename').textContent = data.fileName;

	const status = document.getElementById('status');
	status.hidden = false;
	status.textContent = data.status === 'success' ? 'succès' : 'anomalies';
	status.className = 'badge ' + (data.status === 'success' ? 'ok' : 'err');

	const confidence = document.getElementById('confidence');
	const confValue = typeof result.confidence === 'number' ? result.confidence : 0;
	confidence.hidden = false;
	confidence.textContent = 'confiance ' + Math.round(confValue) + '%';
	confidence.className = 'badge ' + confidenceClass(confValue);
	confidence.title = CONF_TOOLTIP;

	document.getElementById('mode').hidden = data.doubleExtraction !== true;
	document.getElementById('provider').hidden = data.provider !== 'stub';

	// Document preview: reset the pane, show the toggle only when a payload was stored.
	currentDocId = typeof data.docId === 'string' ? data.docId : null;
	docPaneState = 'idle';
	docPaneOpen = false;
	docPaneLoadPromise = null;
	pdfDocRef = null;
	sheetInfo = new Map();
	payloadPages = [];
	const docPane = document.getElementById('docpane');
	docPane.hidden = true;
	docPane.textContent = '';
	const toggleDoc = document.getElementById('toggledoc');
	toggleDoc.hidden = currentDocId === null;
	toggleDoc.classList.remove('active');

	const comparison = Array.isArray(data.comparison) ? data.comparison : [];
	const compByName = new Map();
	for (const entry of comparison) compByName.set(String(entry.name || ''), entry);
	const hasComparison = comparison.length > 0;

	const body = document.getElementById('body');
	body.textContent = '';
	fieldRows = [];

	// --- Per-field flags (drive the summary strip and the review filter) ---
	let extracted = 0, missing = 0, missingRequired = 0, lowConf = 0, divergent = 0;

	// --- Fields table (comparison merged as a status column) ---
	const fieldsCard = makeCard('Champs extraits');
	const table = document.createElement('table');
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	const headers = hasComparison
		? ['Champ', 'Valeur', 'Confiance', 'VLM vs OCR']
		: ['Champ', 'Valeur', 'Confiance'];
	for (const label of headers) {
		const th = document.createElement('th');
		th.textContent = label;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	table.appendChild(thead);
	const tbody = document.createElement('tbody');
	for (const field of data.templateFields) {
		const tr = document.createElement('tr');
		const tdName = document.createElement('td');
		tdName.textContent = field.name + (field.required ? ' *' : '');
		if (field.required) tdName.title = 'Champ requis';
		const tdValue = document.createElement('td');
		const value = formatValue(result.fields ? result.fields[field.name] : null);
		if (value === null) {
			missing++;
			if (field.required) missingRequired++;
		} else {
			extracted++;
		}
		const tdConf = document.createElement('td');
		const fieldConf = result.fieldConfidences ? result.fieldConfidences[field.name] : undefined;
		if (typeof fieldConf === 'number') {
			tdConf.appendChild(makeConfChip(fieldConf));
			if (value !== null && fieldConf < 80) lowConf++;
		} else {
			tdConf.textContent = '—';
			tdConf.className = 'null';
		}
		tr.appendChild(tdName);
		tr.appendChild(tdValue);
		tr.appendChild(tdConf);

		// Status column + expandable detail row when the VLM/OCR sides diverge.
		let comp = null;
		let detailRow = null;
		const rawSource = result.fieldSources ? result.fieldSources[field.name] : undefined;
		const entry = {
			row: tr, detailRow: null, field, original: value, tdValue,
			source: rawSource && typeof rawSource === 'object'
				? {
						page: typeof rawSource.page === 'number' ? rawSource.page : null,
						quote: typeof rawSource.quote === 'string' ? rawSource.quote : null,
						verified: typeof rawSource.verified === 'boolean' ? rawSource.verified : null
					}
				: null,
			baseNeedsReview: false, needsReview: false, expanded: false
		};
		if (hasComparison) {
			comp = compByName.get(field.name) || null;
			const tdStatus = document.createElement('td');
			if (comp) {
				const vlmValue = formatValue(comp.vlmValue);
				const ocrValue = formatValue(comp.ocrValue);
				const partial = vlmValue === null || ocrValue === null;
				const chip = document.createElement('span');
				chip.className = 'chip ' + (comp.agree ? 'ok' : partial ? 'warn' : 'err');
				chip.textContent = comp.agree ? 'concordant' : partial ? '▸ partiel' : '▸ divergent';
				if (!comp.agree) {
					divergent++;
					// Detail row: both modalities side by side, differing segment highlighted.
					detailRow = document.createElement('tr');
					detailRow.className = 'detail';
					detailRow.hidden = true;
					const td = document.createElement('td');
					td.colSpan = headers.length;
					td.appendChild(makeDetailLine('Vision (VLM)', vlmValue, comp.vlmConfidence, ocrValue));
					td.appendChild(makeDetailLine('Texte (OCR)', ocrValue, comp.ocrConfidence, vlmValue));
					detailRow.appendChild(td);
					chip.classList.add('toggle');
					chip.title = 'Afficher les deux valeurs';
					chip.addEventListener('click', () => {
						entry.expanded = !entry.expanded;
						detailRow.hidden = !entry.expanded;
						chip.textContent = (entry.expanded ? '▾ ' : '▸ ') + (partial ? 'partiel' : 'divergent');
					});
				}
				tdStatus.appendChild(chip);
			} else {
				tdStatus.textContent = '—';
				tdStatus.className = 'null';
			}
			tr.appendChild(tdStatus);
		}

		entry.detailRow = detailRow;
		entry.baseNeedsReview =
			value === null
			|| (typeof fieldConf === 'number' && fieldConf < 80)
			|| (comp !== null && comp.agree !== true);
		entry.needsReview = entry.baseNeedsReview;
		renderValueCell(entry);
		tbody.appendChild(tr);
		if (detailRow) tbody.appendChild(detailRow);
		fieldRows.push(entry);
	}
	table.appendChild(tbody);
	fieldsCard.appendChild(table);
	body.appendChild(fieldsCard);

	// --- Summary strip ---
	const summary = document.getElementById('summary');
	summary.textContent = '';
	summary.hidden = false;
	const total = data.templateFields.length;
	addStat(summary, extracted + '/' + total + ' champ(s) extrait(s)', extracted === total ? 'ok' : 'warn');
	if (missing > 0) {
		const text = missing + ' non trouvé(s)' + (missingRequired > 0 ? ' dont ' + missingRequired + ' requis' : '');
		addStat(summary, text, missingRequired > 0 ? 'err' : 'warn');
	}
	if (lowConf > 0) addStat(summary, lowConf + ' confiance < 80 %', 'warn');
	if (hasComparison) {
		addStat(summary, divergent === 0
			? 'VLM/OCR : tout concordant'
			: divergent + ' divergence(s) VLM/OCR', divergent === 0 ? 'ok' : 'err');
	}
	const correctedStat = addStat(summary, '0 corrigé(s)', 'edited', 'correctedstat');
	correctedStat.hidden = true;

	// --- "Needs review" filter + corrected stat ---
	updateReviewUi();

	// --- Coherence checks ---
	const checks = Array.isArray(result.coherenceCheckResults) ? result.coherenceCheckResults : [];
	if (checks.length > 0) {
		const checksCard = makeCard('Contrôles de cohérence');
		for (const check of checks) {
			const line = document.createElement('div');
			line.className = 'check ' + (check.passed ? 'pass' : 'fail');
			const mark = document.createElement('span');
			mark.className = 'mark';
			mark.textContent = check.passed ? '✓' : '✗';
			const name = document.createElement('span');
			name.textContent = String(check.name || '');
			const message = document.createElement('span');
			message.className = 'msg';
			message.textContent = String(check.message || '');
			line.appendChild(mark);
			line.appendChild(name);
			line.appendChild(message);
			checksCard.appendChild(line);
		}
		body.appendChild(checksCard);
	}

	// --- Errors / warnings ---
	const errors = Array.isArray(result.errors) ? result.errors : [];
	const warnings = Array.isArray(result.warnings) ? result.warnings : [];
	if (errors.length > 0 || warnings.length > 0) {
		const issuesCard = makeCard('Erreurs et avertissements');
		const list = document.createElement('ul');
		for (const error of errors) {
			const li = document.createElement('li');
			li.className = 'error';
			li.textContent = String(error);
			list.appendChild(li);
		}
		for (const warning of warnings) {
			const li = document.createElement('li');
			li.className = 'warning';
			li.textContent = String(warning);
			list.appendChild(li);
		}
		issuesCard.appendChild(list);
		body.appendChild(issuesCard);
	}

	// --- Consumption & estimated cost (compareWithOcr runs) ---
	// Token counts come from the extraction LLM (Anthropic usage); the cost
	// estimate (data.costEstimate, server-side via the OpenRouter catalog) adds
	// the page-billed Mistral OCR pass so both APPROACHES compare fairly:
	// vision = VLM tokens; text = Mistral OCR pages + LLM-over-text tokens.
	const usage = data.tokenUsage;
	const cost = data.costEstimate && typeof data.costEstimate === 'object' ? data.costEstimate : null;
	if (usage && typeof usage === 'object' && (usage.vlm || usage.ocr)) {
		const ocrPageCount = typeof usage.ocrPageCount === 'number' ? usage.ocrPageCount : 0;
		const usageCard = makeCard(cost
			? 'Consommation et coût estimé (VLM vs OCR)'
			: 'Consommation de tokens (VLM vs OCR)');
		const utable = document.createElement('table');
		const uhead = document.createElement('thead');
		const uheadRow = document.createElement('tr');
		const uheaders = ['Poste', 'Tokens entrée', 'Tokens sortie', 'Appels LLM'];
		if (cost) uheaders.push('Coût estimé (USD)');
		for (const label of uheaders) {
			const th = document.createElement('th');
			th.textContent = label;
			uheadRow.appendChild(th);
		}
		uhead.appendChild(uheadRow);
		utable.appendChild(uhead);
		const ubody = document.createElement('tbody');
		const fmtTokens = (n) => (typeof n === 'number' ? n.toLocaleString('fr-FR') : '—');
		const fmtUsd = (n) => (typeof n === 'number' ? '$' + n.toFixed(4) : '—');
		const addUsageRow = (label, cells, isTotal) => {
			const tr = document.createElement('tr');
			for (const text of [label].concat(cells)) {
				const td = document.createElement('td');
				td.textContent = text;
				if (isTotal) td.style.fontWeight = '600';
				tr.appendChild(td);
			}
			ubody.appendChild(tr);
		};
		const tokenCells = (u) => [fmtTokens(u && u.inputTokens), fmtTokens(u && u.outputTokens), fmtTokens(u && u.calls)];
		if (usage.vlm) {
			addUsageRow('Vision (VLM) — appels LLM',
				tokenCells(usage.vlm).concat(cost ? [fmtUsd(cost.vlmLlmUsd)] : []), false);
		}
		if (usage.ocr) {
			addUsageRow('Texte (OCR) — appels LLM',
				tokenCells(usage.ocr).concat(cost ? [fmtUsd(cost.ocrLlmUsd)] : []), false);
		}
		if (ocrPageCount > 0) {
			addUsageRow('Texte (OCR) — passage Mistral OCR',
				[ocrPageCount + ' page(s)', '—', '—'].concat(cost ? [fmtUsd(cost.ocrPagesUsd)] : []), false);
		}
		if (cost && usage.vlm && usage.ocr) {
			addUsageRow('Total approche vision (VLM)',
				tokenCells(usage.vlm).concat([fmtUsd(cost.vlmTotalUsd)]), true);
			addUsageRow('Total approche texte (OCR + LLM)',
				tokenCells(usage.ocr).concat([fmtUsd(cost.ocrTotalUsd)]), true);
		}
		utable.appendChild(ubody);
		usageCard.appendChild(utable);
		const usageNote = document.createElement('div');
		usageNote.style.fontSize = '11px';
		usageNote.style.color = 'var(--muted)';
		usageNote.style.marginTop = '6px';
		usageNote.textContent = cost
			? 'Montants indicatifs en USD — tarifs tokens via openrouter.ai (' + String(cost.pricingModel)
				+ ' : ' + Number(cost.inputPerMTok).toFixed(2) + ' $ entrée / '
				+ Number(cost.outputPerMTok).toFixed(2) + ' $ sortie par million de tokens), Mistral OCR à '
				+ Number(cost.ocrPricePerPage).toFixed(4) + ' $/page (configurable : ocrPricePerPage).'
			: 'Tokens du connecteur LLM d’extraction uniquement — le passage Mistral OCR (facturé à la page) n’est pas compté ici (tarifs openrouter.ai indisponibles).';
		usageCard.appendChild(usageNote);
		body.appendChild(usageCard);
	}

	// --- CSV export (rebuilt on click so manual corrections are included) ---
	csvFileName = 'extraction_' + data.fileName.replace(/\\.[^.]+$/, '') + '.csv';
	document.getElementById('copycsv').hidden = false;
	document.getElementById('downloadcsv').hidden = false;
}

document.getElementById('toggledoc').addEventListener('click', () => {
	setDocPaneOpen(!docPaneOpen);
});

document.getElementById('filterreview').addEventListener('click', () => {
	reviewFilterActive = !reviewFilterActive;
	document.getElementById('filterreview').classList.toggle('active', reviewFilterActive);
	applyReviewFilter();
});

document.getElementById('copycsv').addEventListener('click', async () => {
	if (!lastData) return;
	try {
		await navigator.clipboard.writeText(buildCsv(lastData));
		const btn = document.getElementById('copycsv');
		btn.textContent = 'Copié !';
		setTimeout(() => { btn.textContent = 'Copier CSV'; }, 1500);
	} catch {
		// clipboard unavailable in this sandbox — ignore
	}
});

document.getElementById('downloadcsv').addEventListener('click', async () => {
	if (!lastData) return;
	const btn = document.getElementById('downloadcsv');
	if (btn.disabled) return;
	btn.disabled = true;
	btn.textContent = 'Préparation…';
	try {
		// The sandboxed iframe has no allow-downloads: a blob/anchor download is
		// silently ignored. Same workaround as the host's bento download: store
		// the CSV server-side (ocr_save_export, bridge-only) and let the HOST
		// open its /api/files URL outside the sandbox.
		const res = await app.callServerTool({
			name: 'ocr_save_export',
			arguments: {
				csv: buildCsv(lastData),
				file_name: csvFileName,
				...(currentDocId !== null ? { doc: currentDocId } : {})
			}
		});
		const sc = res && res.structuredContent;
		const fileUrl = sc && typeof sc.url === 'string' ? sc.url : null;
		if (!fileUrl) throw new Error('export sans URL');
		await app.openLink({ url: new URL(fileUrl, location.origin).href });
		btn.textContent = 'Téléchargé ✓';
	} catch (e) {
		console.warn('CSV download failed', e);
		btn.textContent = 'Échec — utilise Copier CSV';
	} finally {
		setTimeout(() => {
			btn.textContent = 'Télécharger CSV';
			btn.disabled = false;
		}, 2000);
	}
});

function applyTheme(theme) {
	document.documentElement.classList.toggle('theme-dark', theme === 'dark');
}

const app = new App({ name: 'ocr-extraction-viewer', version: '1.0.0' });
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
