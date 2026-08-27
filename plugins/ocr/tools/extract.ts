/**
 * OCR extract tool.
 *
 * Downloads a file attached to the current conversation (via
 * `storage.downloadConversationFile`, access-controlled by the core) and runs
 * it through an external OCR connector. When no endpoint/apiKey is configured
 * (plugin config or OCR_ENDPOINT / OCR_API_KEY env vars), the tool runs in
 * STUB mode and returns placeholder text. The real branch implements the
 * Mistral Document AI (OCR) contract — Azure AI Foundry
 * (`/providers/mistral/azure/ocr`) or api.mistral.ai (`/v1/ocr`); a bare base
 * URL like https://<resource>.services.ai.azure.com is completed automatically.
 *
 * The result carries `_meta.ui` (SEP-1865) so the host opens the `ui://ocr/viewer`
 * MCP App and delivers `data` as `structuredContent` to the iframe.
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale } from '../../../src/types';
import { OCR_VIEWER_RESOURCE_URI } from '../template';

const OCR_ICON = 'hugeicons:document-attachment';
const OCR_PREFERRED_WIDTH = 560;

/** The model needs the extracted text to answer questions, but keep it bounded. */
const MAX_MESSAGE_TEXT_CHARS = 8_000;

const REQUEST_TIMEOUT_MS = 60_000;

// --- Localized messages (external plugins are self-contained: no $lib imports) ---

const MSG_DONE: Record<Locale, string> = {
	fr: 'Texte extrait de {fileName} ({pages} page(s), connecteur: {provider}). Le résultat est affiché dans le panneau OCR.',
	en: 'Text extracted from {fileName} ({pages} page(s), connector: {provider}). The result is shown in the OCR panel.',
	es: 'Texto extraído de {fileName} ({pages} página(s), conector: {provider}). El resultado se muestra en el panel OCR.',
	zh: '已从 {fileName} 提取文本（{pages} 页，连接器：{provider}）。结果显示在 OCR 面板中。',
	de: 'Text aus {fileName} extrahiert ({pages} Seite(n), Konnektor: {provider}). Das Ergebnis wird im OCR-Panel angezeigt.'
};

const MSG_STUB_NOTICE: Record<Locale, string> = {
	fr: "NOTE: le connecteur OCR n'est pas configuré (endpoint/clé API absents) — résultat de DÉMONSTRATION avec du texte factice. Configure le plugin OCR dans l'admin pour brancher un vrai service.",
	en: 'NOTE: the OCR connector is not configured (missing endpoint/API key) — DEMO result with placeholder text. Configure the OCR plugin in the admin UI to attach a real service.',
	es: 'NOTA: el conector OCR no está configurado (faltan endpoint/clave API) — resultado de DEMOSTRACIÓN con texto ficticio. Configura el plugin OCR en el admin para conectar un servicio real.',
	zh: '注意：OCR 连接器未配置（缺少 endpoint/API 密钥）— 这是使用占位文本的演示结果。请在管理界面配置 OCR 插件以接入真实服务。',
	de: 'HINWEIS: Der OCR-Konnektor ist nicht konfiguriert (Endpoint/API-Schlüssel fehlen) — DEMO-Ergebnis mit Platzhaltertext. Konfiguriere das OCR-Plugin im Admin-Bereich, um einen echten Dienst anzubinden.'
};

const MSG_FILE_NOT_ACCESSIBLE: Record<Locale, string> = {
	fr: "Erreur: fichier inaccessible ({source}). Utilise exactement une des URLs de fichiers listées dans le contexte de la conversation — seuls les fichiers de la conversation courante sont lisibles.",
	en: 'Error: file not accessible ({source}). Use exactly one of the file URLs listed in the conversation context — only files of the current conversation are readable.',
	es: 'Error: archivo inaccesible ({source}). Usa exactamente una de las URLs de archivo listadas en el contexto — solo los archivos de la conversación actual son legibles.',
	zh: '错误：无法访问文件（{source}）。请使用会话上下文中列出的文件 URL——只能读取当前会话的文件。',
	de: 'Fehler: Datei nicht zugänglich ({source}). Verwende exakt eine der im Konversationskontext gelisteten Datei-URLs — nur Dateien der aktuellen Konversation sind lesbar.'
};

const MSG_OCR_ERROR: Record<Locale, string> = {
	fr: "Erreur du service OCR : {error}",
	en: 'OCR service error: {error}',
	es: 'Error del servicio OCR: {error}',
	zh: 'OCR 服务错误：{error}',
	de: 'Fehler des OCR-Dienstes: {error}'
};

function msg(
	map: Record<Locale, string>,
	locale: Locale | undefined,
	params?: Record<string, string | number>
): string {
	let template = map[locale ?? 'fr'] ?? map['fr'];
	for (const [key, value] of Object.entries(params ?? {})) {
		template = template.replace(`{${key}}`, String(value));
	}
	return template;
}

interface OcrPluginConfig {
	endpoint?: string;
	apiKey?: string;
	ocrModel?: string;
}

interface OcrPage {
	page: number;
	text: string;
}

interface ExtractParams {
	file_url: string;
	language?: string;
}

/**
 * STUB connector: no external call, deterministic placeholder pages so the
 * whole chain (download → result shape → MCP App viewer) can be demonstrated
 * without a real OCR backend.
 */
function stubOcr(fileName: string, contentType: string, byteLength: number): OcrPage[] {
	return [
		{
			page: 1,
			text: `[STUB OCR] ${fileName} (${contentType}, ${byteLength} octets)\n\nCeci est un texte factice généré par le connecteur OCR de démonstration. Configurez un endpoint et une clé API dans l'administration du plugin pour obtenir une vraie extraction.`
		},
		{
			page: 2,
			text: `[STUB OCR] Deuxième page factice pour illustrer le rendu multi-pages du panneau OCR.`
		}
	];
}

const DEFAULT_OCR_MODEL = 'mistral-ocr-2503';

/**
 * Resolve the OCR route from the configured endpoint:
 * - a URL already ending in /ocr is used as-is (full route configured);
 * - a bare Azure AI Foundry base URL (https://<resource>.services.ai.azure.com)
 *   gets the Mistral Document AI route `/providers/mistral/azure/ocr`;
 * - any other bare base URL gets the Mistral-native route `/v1/ocr`;
 * - a URL with another path is used as-is (custom proxy).
 */
function buildOcrUrl(endpoint: string): string {
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

/**
 * Real connector: Mistral Document AI (OCR) contract, as served by Azure AI
 * Foundry (`/providers/mistral/azure/ocr`) and by api.mistral.ai (`/v1/ocr`).
 * The file travels as a base64 data-URL (`document_url` for PDFs/documents,
 * `image_url` for images); the response is `{ pages: [{ index, markdown }] }`.
 * Both `Authorization: Bearer` and `api-key` headers are sent — Azure accepts
 * either depending on the resource configuration. Note: this API has no
 * language parameter (the tool's `language` input is accepted but unused).
 */
async function remoteOcr(
	endpoint: string,
	apiKey: string,
	model: string,
	buffer: Buffer,
	contentType: string,
	fileName: string
): Promise<OcrPage[]> {
	const mediaType =
		(contentType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
	const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;
	const document = mediaType.startsWith('image/')
		? { type: 'image_url', image_url: dataUrl }
		: { type: 'document_url', document_url: dataUrl, document_name: fileName };

	const response = await fetch(buildOcrUrl(endpoint), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'api-key': apiKey
		},
		body: JSON.stringify({ model, document, include_image_base64: false }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});

	const raw = await response.text().catch(() => '');
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
	return data.pages
		.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
		.map((p, i) => ({
			// Mistral pages are 0-based `index` with `markdown` content; tolerate
			// the { page, text } shape for custom proxies.
			page:
				typeof p.index === 'number' ? p.index + 1 : typeof p.page === 'number' ? p.page : i + 1,
			text: typeof p.markdown === 'string' ? p.markdown : typeof p.text === 'string' ? p.text : ''
		}));
}

export function createExtractTool(context: PluginContext): AnyTool {
	const { locale, logger, env } = context;
	const config = (context.pluginConfig ?? {}) as OcrPluginConfig;

	return tool({
		description:
			"Extrait le texte (OCR) d'un fichier attaché à la conversation (PDF scanné, image de document). Le paramètre file_url doit être exactement une des URLs de fichiers fournies dans le contexte.",
		inputSchema: jsonSchema<ExtractParams>({
			type: 'object',
			properties: {
				file_url: {
					type: 'string',
					description:
						"URL /api/files/... du fichier à traiter, copiée EXACTEMENT depuis la liste des fichiers disponibles pour l'OCR dans le contexte de la conversation"
				},
				language: {
					type: 'string',
					description: "Langue attendue du document (code ISO, ex: 'fr', 'en') — optionnel"
				}
			},
			required: ['file_url']
		}),
		execute: async (params): Promise<{
			message: string;
			data?: Record<string, unknown>;
			_meta?: Record<string, unknown>;
		}> => {
			let file: { buffer: Buffer; contentType: string; fileName: string };
			try {
				file = await context.storage.downloadConversationFile(params.file_url);
			} catch (error) {
				logger.warn('OCR file download failed', {
					source: params.file_url,
					error: error instanceof Error ? error.message : String(error)
				});
				return { message: msg(MSG_FILE_NOT_ACCESSIBLE, locale, { source: params.file_url }) };
			}

			const endpoint = config.endpoint?.trim() || env.OCR_ENDPOINT;
			const apiKey = config.apiKey?.trim() || env.OCR_API_KEY;
			const isStub = !endpoint || !apiKey;

			let pages: OcrPage[];
			const provider = isStub ? 'stub' : 'mistral-azure';
			if (isStub) {
				pages = stubOcr(file.fileName, file.contentType, file.buffer.length);
			} else {
				const model = config.ocrModel?.trim() || env.OCR_MODEL || DEFAULT_OCR_MODEL;
				try {
					pages = await remoteOcr(
						endpoint,
						apiKey,
						model,
						file.buffer,
						file.contentType,
						file.fileName
					);
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					logger.error('OCR connector call failed', { endpoint, error: text });
					return { message: msg(MSG_OCR_ERROR, locale, { error: text }) };
				}
			}

			const fullText = pages.map((p) => p.text).join('\n\n');
			const truncated =
				fullText.length > MAX_MESSAGE_TEXT_CHARS
					? `${fullText.slice(0, MAX_MESSAGE_TEXT_CHARS)}\n[…texte tronqué]`
					: fullText;

			const summary = msg(MSG_DONE, locale, {
				fileName: file.fileName,
				pages: pages.length,
				provider
			});
			const stubNotice = isStub ? `\n\n${msg(MSG_STUB_NOTICE, locale)}` : '';

			logger.info('OCR extraction done', {
				fileName: file.fileName,
				pages: pages.length,
				provider
			});

			return {
				message: `${summary}${stubNotice}\n\n---\n${truncated}`,
				data: {
					fileName: file.fileName,
					contentType: file.contentType,
					provider,
					pages
				},
				_meta: {
					ui: {
						resourceUri: OCR_VIEWER_RESOURCE_URI,
						title: `OCR — ${file.fileName}`,
						icon: OCR_ICON,
						preferredWidth: OCR_PREFERRED_WIDTH
					}
				}
			};
		}
	});
}
