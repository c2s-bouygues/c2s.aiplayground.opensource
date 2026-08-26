/**
 * Static SEP-1865 MCP App template for the OCR plugin.
 *
 * Registered as `ui://ocr/viewer` (see the plugin's `appResources`) and served
 * by /api/mcp-apps/resource. The template carries NO per-call data: the host
 * delivers the tool result's `data` as `structuredContent` through the ext-apps
 * bridge (`ui/notifications/tool-result`). Theme arrives via `hostContext` and
 * `host-context-changed` notifications.
 *
 * OCR output is untrusted (it re-renders whatever the connector extracted from
 * a user file), so every string goes through `textContent` — never innerHTML.
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
	--badge-real: #047857; --badge-real-bg: #d1fae5;
}
html.theme-dark {
	--bg: #1b1d24; --panel: #23252e; --text: #e6e8ee; --muted: #9ca3af;
	--border: #363943; --accent: #60a5fa; --badge-stub: #fcd34d; --badge-stub-bg: #45350c;
	--badge-real: #6ee7b7; --badge-real-bg: #0c3d2e;
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
.pages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.page { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.page h2 { font-size: 12px; margin: 0 0 6px; color: var(--muted); font-weight: 600;
	text-transform: uppercase; letter-spacing: 0.04em; }
.page pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; line-height: 1.5; }
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
	<div class="pages" id="pages"><div class="empty" id="empty">En attente du résultat OCR…</div></div>
</div>
<script type="module">
import { App } from '/api/mcp-apps/vendor/app.js';

let fullText = '';

function isOcrData(v) {
	return v && typeof v === 'object' && typeof v.fileName === 'string' && Array.isArray(v.pages);
}

function render(data) {
	if (!isOcrData(data)) return;
	document.getElementById('filename').textContent = data.fileName;

	const provider = document.getElementById('provider');
	provider.hidden = false;
	provider.textContent = data.provider === 'stub' ? 'démo (stub)' : String(data.provider || '');
	provider.className = 'badge ' + (data.provider === 'stub' ? 'stub' : 'real');

	const pages = data.pages.filter((p) => p && typeof p === 'object' && typeof p.text === 'string');
	document.getElementById('pagecount').textContent =
		pages.length + (pages.length > 1 ? ' pages' : ' page');

	const container = document.getElementById('pages');
	container.textContent = '';
	fullText = pages.map((p) => p.text).join('\\n\\n');
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

	const copy = document.getElementById('copy');
	copy.hidden = pages.length === 0;
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
