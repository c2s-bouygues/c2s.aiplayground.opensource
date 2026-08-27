/**
 * Static SEP-1865 MCP App template for the structured field extraction tool
 * (MagicOCR-style results panel).
 *
 * Registered as `ui://ocr/extraction` (see the plugin's `appResources`) and
 * served by /api/mcp-apps/resource. Same contract as `ui://ocr/viewer`: the
 * template carries NO per-call data — the tool result's `data` arrives as
 * `structuredContent` through the ext-apps bridge, the theme via `hostContext`.
 *
 * Renders: field table with per-field confidence chips (green ≥80 / orange ≥60
 * / red <60, MagicOCR's Excel color rule), global confidence, coherence-check
 * results, errors/warnings, and a CSV export (copy + download; the CSV layout
 * mirrors MagicOCR's "Résultats" sheet: one row per document, `;` separator
 * and UTF-8 BOM for French Excel).
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
	--border: #e5e7eb; --accent: #2563eb;
	--ok: #047857; --ok-bg: #d1fae5;
	--warn: #b45309; --warn-bg: #fef3c7;
	--err: #b91c1c; --err-bg: #fee2e2;
}
html.theme-dark {
	--bg: #1b1d24; --panel: #23252e; --text: #e6e8ee; --muted: #9ca3af;
	--border: #363943; --accent: #60a5fa;
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
.body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.card h2 { font-size: 12px; margin: 0 0 8px; color: var(--muted); font-weight: 600;
	text-transform: uppercase; letter-spacing: 0.04em; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border);
	vertical-align: top; overflow-wrap: anywhere; }
th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: none; }
td.null { color: var(--muted); font-style: italic; }
.chip { display: inline-block; min-width: 42px; text-align: center; font-size: 11px;
	padding: 2px 6px; border-radius: 999px; font-weight: 600; }
.chip.ok { color: var(--ok); background: var(--ok-bg); }
.chip.warn { color: var(--warn); background: var(--warn-bg); }
.chip.err { color: var(--err); background: var(--err-bg); }
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
		<span class="badge warn" id="compare" hidden>VLM vs OCR</span>
		<span class="badge warn" id="provider" hidden>démo (stub)</span>
		<div class="toolbar">
			<button id="copycsv" hidden>Copier CSV</button>
			<button id="downloadcsv" hidden>Télécharger CSV</button>
		</div>
	</header>
	<div class="body" id="body"><div class="empty">En attente du résultat d’extraction…</div></div>
</div>
<script type="module">
import { App } from '/api/mcp-apps/vendor/app.js';

let csvText = '';
let csvFileName = 'extraction.csv';

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

/** MagicOCR "Résultats" sheet layout: one row per document. */
function buildCsv(data) {
	const result = data.result;
	const names = data.templateFields.map((f) => f.name);
	const header = ['Document']
		.concat(names)
		.concat(['Confiance (%)'])
		.concat(names.map((n) => 'Confiance ' + n + ' (%)'))
		.concat(['Erreurs', 'Avertissements']);
	const row = [data.fileName]
		.concat(names.map((n) => formatValue(result.fields ? result.fields[n] : null)))
		.concat([result.confidence])
		.concat(names.map((n) => (result.fieldConfidences ? result.fieldConfidences[n] : '') ?? ''))
		.concat([(result.errors || []).join(' | '), (result.warnings || []).join(' | ')]);
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

function render(data) {
	if (!isExtractionData(data)) return;
	const result = data.result;

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

	document.getElementById('mode').hidden = data.doubleExtraction !== true;
	document.getElementById('compare').hidden = !Array.isArray(data.comparison) || data.comparison.length === 0;
	document.getElementById('provider').hidden = data.provider !== 'stub';

	const body = document.getElementById('body');
	body.textContent = '';

	// --- Fields table ---
	const fieldsCard = makeCard('Champs extraits');
	const table = document.createElement('table');
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	for (const label of ['Champ', 'Valeur', 'Confiance']) {
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
		const tdValue = document.createElement('td');
		const value = formatValue(result.fields ? result.fields[field.name] : null);
		if (value === null) {
			tdValue.textContent = 'non trouvé';
			tdValue.className = 'null';
		} else {
			tdValue.textContent = value; // untrusted extracted value — textContent only
		}
		const tdConf = document.createElement('td');
		const fieldConf = result.fieldConfidences ? result.fieldConfidences[field.name] : undefined;
		if (typeof fieldConf === 'number') {
			const chip = document.createElement('span');
			chip.className = 'chip ' + confidenceClass(fieldConf);
			chip.textContent = Math.round(fieldConf) + '%';
			tdConf.appendChild(chip);
		} else {
			tdConf.textContent = '—';
			tdConf.className = 'null';
		}
		tr.appendChild(tdName);
		tr.appendChild(tdValue);
		tr.appendChild(tdConf);
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	fieldsCard.appendChild(table);
	body.appendChild(fieldsCard);

	// --- VLM vs OCR comparison (MagicOCR-style cross-validation, two modalities) ---
	const comparison = Array.isArray(data.comparison) ? data.comparison : [];
	if (comparison.length > 0) {
		const compCard = makeCard('Comparaison VLM vs OCR');
		const compTable = document.createElement('table');
		const compHead = document.createElement('thead');
		const compHeadRow = document.createElement('tr');
		for (const label of ['Champ', 'Vision (VLM)', 'Texte (OCR)', 'Statut']) {
			const th = document.createElement('th');
			th.textContent = label;
			compHeadRow.appendChild(th);
		}
		compHead.appendChild(compHeadRow);
		compTable.appendChild(compHead);
		const compBody = document.createElement('tbody');
		for (const entry of comparison) {
			const tr = document.createElement('tr');
			const tdName = document.createElement('td');
			tdName.textContent = String(entry.name || '');
			tr.appendChild(tdName);
			for (const side of ['vlm', 'ocr']) {
				const td = document.createElement('td');
				const value = formatValue(side === 'vlm' ? entry.vlmValue : entry.ocrValue);
				const conf = side === 'vlm' ? entry.vlmConfidence : entry.ocrConfidence;
				if (value === null) {
					td.textContent = 'non trouvé';
					td.className = 'null';
				} else {
					td.textContent = value; // untrusted extracted value — textContent only
					if (typeof conf === 'number') {
						const chip = document.createElement('span');
						chip.className = 'chip ' + confidenceClass(conf) ;
						chip.style.marginLeft = '6px';
						chip.textContent = Math.round(conf) + '%';
						td.appendChild(chip);
					}
				}
				tr.appendChild(td);
			}
			const tdStatus = document.createElement('td');
			const statusChip = document.createElement('span');
			const partial = entry.vlmValue == null || entry.ocrValue == null;
			statusChip.className = 'chip ' + (entry.agree ? 'ok' : partial ? 'warn' : 'err');
			statusChip.textContent = entry.agree ? 'concordant' : partial ? 'partiel' : 'divergent';
			tdStatus.appendChild(statusChip);
			tr.appendChild(tdStatus);
			compBody.appendChild(tr);
		}
		compTable.appendChild(compBody);
		compCard.appendChild(compTable);
		body.appendChild(compCard);
	}

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

	// --- CSV export ---
	csvText = buildCsv(data);
	csvFileName = 'extraction_' + data.fileName.replace(/\\.[^.]+$/, '') + '.csv';
	document.getElementById('copycsv').hidden = false;
	document.getElementById('downloadcsv').hidden = false;
}

document.getElementById('copycsv').addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(csvText);
		const btn = document.getElementById('copycsv');
		btn.textContent = 'Copié !';
		setTimeout(() => { btn.textContent = 'Copier CSV'; }, 1500);
	} catch {
		// clipboard unavailable in this sandbox — ignore
	}
});

document.getElementById('downloadcsv').addEventListener('click', () => {
	try {
		const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = csvFileName;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	} catch {
		// downloads blocked in this sandbox — the copy button remains available
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
