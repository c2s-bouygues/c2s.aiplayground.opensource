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
import {
	buildMarkdown,
	saveOcrResult,
	type OcrPage,
	type StoredOcrResult
} from '../lib/result-store';
import {
	batchedMistralOcr,
	mistralOcr,
	parseTooManyPages,
	resolveOcrConnector,
	DEFAULT_PAGE_LIMIT,
	MAX_TOTAL_PAGES
} from '../lib/mistral-ocr';

const OCR_ICON = 'hugeicons:document-attachment';
const OCR_PREFERRED_WIDTH = 560;

/** The model needs the extracted text to answer questions, but keep it bounded. */
const MAX_CONTENT_TEXT_CHARS = 8_000;

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

/** Short user-facing line for the batch confirmation (the model-directed instructions go in `content`). */
const MSG_CONFIRM_BATCH_USER: Record<Locale, string> = {
	fr: 'Confirmation requise : {fileName} compte {totalPages} pages (limite : {maxPages} pages par requête OCR) — traitement possible en {batches} lot(s){cappedNote}.',
	en: 'Confirmation required: {fileName} has {totalPages} pages (limit: {maxPages} pages per OCR request) — can be processed in {batches} batch(es){cappedNote}.',
	es: 'Confirmación requerida: {fileName} tiene {totalPages} páginas (límite: {maxPages} páginas por petición OCR) — puede procesarse en {batches} lote(s){cappedNote}.',
	zh: '需要确认：{fileName} 共 {totalPages} 页（OCR 每次请求上限 {maxPages} 页）— 可分 {batches} 批处理{cappedNote}。',
	de: 'Bestätigung erforderlich: {fileName} hat {totalPages} Seiten (Limit: {maxPages} Seiten pro OCR-Anfrage) — Verarbeitung in {batches} Los(en) möglich{cappedNote}.'
};

const MSG_CONFIRM_BATCH: Record<Locale, string> = {
	fr: 'CONFIRMATION REQUISE — le document {fileName} compte {totalPages} pages, au-delà de la limite de {maxPages} pages par requête du service OCR. L’OCR peut être réalisé par lots ({batches} appel(s) de {maxPages} pages maximum, plafond global de 500 pages{cappedNote}). Demande EXPLICITEMENT à l’utilisateur s’il souhaite continuer. S’il confirme, rappelle ocr_extract avec les mêmes paramètres en ajoutant confirm_batch=true. Ne lance PAS le traitement par lots sans son accord.',
	en: 'CONFIRMATION REQUIRED — document {fileName} has {totalPages} pages, above the OCR service limit of {maxPages} pages per request. It can be processed in batches ({batches} call(s) of at most {maxPages} pages, global cap of 500 pages{cappedNote}). EXPLICITLY ask the user whether to continue. If they confirm, call ocr_extract again with the same parameters plus confirm_batch=true. Do NOT start batch processing without their approval.',
	es: 'CONFIRMACIÓN REQUERIDA — el documento {fileName} tiene {totalPages} páginas, por encima del límite de {maxPages} páginas por petición del servicio OCR. Puede procesarse por lotes ({batches} llamada(s) de máximo {maxPages} páginas, tope global de 500 páginas{cappedNote}). Pregunta EXPLÍCITAMENTE al usuario si desea continuar. Si confirma, vuelve a llamar a ocr_extract con los mismos parámetros añadiendo confirm_batch=true. NO inicies el procesamiento por lotes sin su acuerdo.',
	zh: '需要确认 — 文档 {fileName} 共 {totalPages} 页，超过 OCR 服务每次请求 {maxPages} 页的限制。可以分批处理（{batches} 次调用，每次最多 {maxPages} 页，总上限 500 页{cappedNote}）。请明确询问用户是否继续。如果用户确认，请使用相同参数并加上 confirm_batch=true 再次调用 ocr_extract。未经用户同意不要开始分批处理。',
	de: 'BESTÄTIGUNG ERFORDERLICH — das Dokument {fileName} hat {totalPages} Seiten und überschreitet das Limit von {maxPages} Seiten pro Anfrage des OCR-Dienstes. Es kann in Losen verarbeitet werden ({batches} Aufruf(e) mit höchstens {maxPages} Seiten, globale Obergrenze 500 Seiten{cappedNote}). Frage den Nutzer AUSDRÜCKLICH, ob fortgefahren werden soll. Bei Bestätigung rufe ocr_extract mit denselben Parametern plus confirm_batch=true erneut auf. Starte die Losverarbeitung NICHT ohne Zustimmung.'
};

const MSG_CAPPED_NOTE: Record<Locale, string> = {
	fr: ' ; seules les 500 premières pages seront traitées',
	en: '; only the first 500 pages will be processed',
	es: '; solo se procesarán las primeras 500 páginas',
	zh: '；只会处理前 500 页',
	de: '; nur die ersten 500 Seiten werden verarbeitet'
};

const MSG_BATCH_DONE: Record<Locale, string> = {
	fr: 'OCR par lots : {processed} page(s) traitée(s) en {batches} lot(s) (document de {totalPages} pages{cappedNote}).',
	en: 'Batched OCR: {processed} page(s) processed in {batches} batch(es) (document of {totalPages} pages{cappedNote}).',
	es: 'OCR por lotes: {processed} página(s) procesada(s) en {batches} lote(s) (documento de {totalPages} páginas{cappedNote}).',
	zh: '分批 OCR：{processed} 页已处理，共 {batches} 批（文档共 {totalPages} 页{cappedNote}）。',
	de: 'OCR in Losen: {processed} Seite(n) in {batches} Los(en) verarbeitet (Dokument mit {totalPages} Seiten{cappedNote}).'
};

const MSG_CAPPED_DONE: Record<Locale, string> = {
	fr: ' — tronqué aux 500 premières pages',
	en: ' — truncated to the first 500 pages',
	es: ' — truncado a las primeras 500 páginas',
	zh: ' — 已截断为前 500 页',
	de: ' — auf die ersten 500 Seiten gekürzt'
};

const MSG_LONG_DOC: Record<Locale, string> = {
	fr: 'DOCUMENT LONG ({totalChars} caractères, {pages} page(s)) — seul un aperçu est inclus ci-dessus et il NE SUFFIT PAS pour répondre : il sert uniquement à identifier le document. Toute réponse, synthèse ou affirmation sur le contenu doit s’appuyer sur des appels ocr_search_text (recherche par mots-clés) et ocr_read_text (lecture paginée par offset) avec doc="{docId}", effectués AVANT de répondre — cite les passages effectivement lus. Le texte complet est enregistré dans {markdownUrl}. Ne tente pas de restituer tout le document d’un coup.',
	en: 'LONG DOCUMENT ({totalChars} characters, {pages} page(s)) — only a preview is included above and it is NOT sufficient to answer: it only identifies the document. Any answer, summary or claim about the content must rely on ocr_search_text (keyword search) and ocr_read_text (paginated reading by offset) calls with doc="{docId}", made BEFORE answering — quote the passages actually read. The full text is stored at {markdownUrl}. Do not try to reproduce the whole document at once.',
	es: 'DOCUMENTO LARGO ({totalChars} caracteres, {pages} página(s)) — arriba solo se incluye una vista previa y NO ES SUFICIENTE para responder: solo sirve para identificar el documento. Cualquier respuesta, síntesis o afirmación sobre el contenido debe apoyarse en llamadas a ocr_search_text (búsqueda por palabras clave) y ocr_read_text (lectura paginada por offset) con doc="{docId}", realizadas ANTES de responder — cita los pasajes realmente leídos. El texto completo está guardado en {markdownUrl}. No intentes reproducir todo el documento de una vez.',
	zh: '长文档（{totalChars} 个字符，{pages} 页）— 上面只包含预览，仅用于识别文档，不足以作为回答依据。对内容的任何回答、总结或论断都必须基于在回答之前调用 ocr_search_text（关键词搜索）和 ocr_read_text（按 offset 分页读取，参数 doc="{docId}"）的结果——请引用实际读取的段落。完整文本已保存到 {markdownUrl}。不要试图一次性输出整个文档。',
	de: 'LANGES DOKUMENT ({totalChars} Zeichen, {pages} Seite(n)) — oben ist nur eine Vorschau enthalten, und sie REICHT NICHT als Antwortgrundlage: sie dient nur der Identifikation des Dokuments. Jede Antwort, Zusammenfassung oder Aussage über den Inhalt muss sich auf ocr_search_text- (Stichwortsuche) und ocr_read_text-Aufrufe (seitenweises Lesen per Offset) mit doc="{docId}" stützen, die VOR der Antwort erfolgen — zitiere die tatsächlich gelesenen Passagen. Der vollständige Text ist unter {markdownUrl} gespeichert. Versuche nicht, das ganze Dokument auf einmal wiederzugeben.'
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

/**
 * Above this size the extracted text is not inlined in the tool `content`: the
 * model gets a preview + the markdown file reference, and works through
 * ocr_search_text / ocr_read_text. Everything in the returned object reaches
 * the LLM prompt (the host serializes the full output and replays it verbatim
 * on every later turn), so `content` and `data` must stay bounded.
 */
const LONG_DOC_PREVIEW_CHARS = 1_500;

/** Full pages/document ride inline in `data` only under this serialized size. */
const INLINE_DATA_MAX_CHARS = 8_000;

interface ExtractParams {
	file_url: string;
	language?: string;
	/** Set by the model only after the user explicitly approved batched OCR. */
	confirm_batch?: boolean;
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
			text: `[STUB OCR] ${fileName} (${contentType}, ${byteLength} octets)\n\nCeci est un texte factice généré par le connecteur OCR de démonstration. Configurez un endpoint et une clé API dans l'administration du plugin pour obtenir une vraie extraction.`,
			// Fake layout so the "Mise en page" tab is demonstrable without a backend.
			width: 1240,
			height: 1754,
			dpi: 150,
			images: [{ id: 'stub-figure-0', x0: 124, y0: 350, x1: 1116, y1: 877 }]
		},
		{
			page: 2,
			text: `[STUB OCR] Deuxième page factice pour illustrer le rendu multi-pages du panneau OCR.`,
			width: 1240,
			height: 1754,
			dpi: 150
		}
	];
}

/**
 * Embed the original document in the app payload up to this size, so the
 * viewer's "Document original" tab can render the real PDF pages (pdf.js) or
 * the image under the bounding boxes. Beyond it the tab falls back to the
 * text preview. The document never reaches the LLM prompt (stored payload,
 * fetched by the panel through the bridge), so the cost is storage + one
 * bridge transfer (~+33% base64).
 */
const FILE_EMBED_MAX_BYTES = 20 * 1024 * 1024;

export function createExtractTool(context: PluginContext): AnyTool {
	const { locale, logger, env } = context;
	const config = (context.pluginConfig ?? {}) as OcrPluginConfig;

	return tool({
		description:
			"Extrait le texte (OCR) d'un fichier attaché à la conversation (PDF natif ou scanné, image de document). Outil À PRIVILÉGIER sur les autres méthodes pour l'acquisition du contenu des PDF : extraction fidèle à la mise en page, documents longs traités par lots, puis recherche/lecture paginée via ocr_search_text et ocr_read_text. Le paramètre file_url doit être exactement une des URLs de fichiers fournies dans le contexte.",
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
				},
				confirm_batch: {
					type: 'boolean',
					description:
						"true UNIQUEMENT après accord explicite de l'utilisateur, pour lancer l'OCR par lots d'un document dépassant la limite de pages par requête du service (plafond global: 500 pages)"
				}
			},
			required: ['file_url']
		}),
		execute: async (params): Promise<{
			message: string;
			content?: string;
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

			const connector = resolveOcrConnector(config, env);
			const isStub = connector === null;

			let pages: OcrPage[];
			let batchInfo: { batches: number; totalPages: number; capped: boolean } | null = null;
			const provider = isStub ? 'stub' : 'mistral-azure';
			if (connector === null) {
				pages = stubOcr(file.fileName, file.contentType, file.buffer.length);
			} else {
				try {
					pages = await mistralOcr(connector, file.buffer, file.contentType, file.fileName);
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					const tooMany = parseTooManyPages(text);
					if (!tooMany) {
						logger.error('OCR connector call failed', { endpoint: connector.endpoint, error: text });
						return { message: msg(MSG_OCR_ERROR, locale, { error: text }) };
					}

					// Document over the per-request page limit: batched OCR, but only
					// after the user explicitly approved it (draft/confirm pattern).
					const totalPages = tooMany.totalPages || MAX_TOTAL_PAGES;
					const batchSize = Math.max(1, tooMany.maxPages || DEFAULT_PAGE_LIMIT);
					const plannedBatches = Math.ceil(Math.min(totalPages, MAX_TOTAL_PAGES) / batchSize);
					if (params.confirm_batch !== true) {
						logger.info('OCR batch confirmation requested', {
							fileName: file.fileName,
							totalPages,
							batchSize
						});
						const confirmParams = {
							fileName: file.fileName,
							totalPages,
							maxPages: batchSize,
							batches: plannedBatches,
							cappedNote: totalPages > MAX_TOTAL_PAGES ? msg(MSG_CAPPED_NOTE, locale) : ''
						};
						return {
							message: msg(MSG_CONFIRM_BATCH_USER, locale, confirmParams),
							content: msg(MSG_CONFIRM_BATCH, locale, confirmParams)
						};
					}
					try {
						const result = await batchedMistralOcr(
							connector,
							file.buffer,
							file.fileName,
							batchSize
						);
						pages = result.pages;
						batchInfo = {
							batches: result.batches,
							totalPages: result.totalPages,
							capped: result.capped
						};
					} catch (batchError) {
						const batchText =
							batchError instanceof Error ? batchError.message : String(batchError);
						logger.error('Batched OCR failed', { endpoint: connector.endpoint, error: batchText });
						return { message: msg(MSG_OCR_ERROR, locale, { error: batchText }) };
					}
				}
			}

			// Original document kept for the viewer's layout tab (real PDF pages
			// under the bounding boxes) — stored in the result payload, NEVER in
			// `data` (everything in the tool output lands in the LLM prompt).
			const embedMediaType = (file.contentType || '').split(';')[0].trim().toLowerCase();
			const embeddable =
				file.buffer.length <= FILE_EMBED_MAX_BYTES &&
				(embedMediaType === 'application/pdf' || embedMediaType.startsWith('image/'));

			const payload: StoredOcrResult = {
				fileName: file.fileName,
				contentType: file.contentType,
				provider,
				pages,
				...(embeddable
					? {
							document: {
								mediaType: embedMediaType,
								dataUri: `data:${embedMediaType};base64,${file.buffer.toString('base64')}`
							}
						}
					: {})
			};

			let stored: { docId: string; markdown: string; markdownUrl: string } | null = null;
			try {
				stored = await saveOcrResult(context.storage, payload);
			} catch (error) {
				logger.warn('OCR result store failed — falling back to inline text', {
					error: error instanceof Error ? error.message : String(error)
				});
			}

			const fullText = stored?.markdown ?? buildMarkdown(pages);
			const boxCount = pages.reduce((n, p) => n + (p.images?.length ?? 0), 0);

			const summary = msg(MSG_DONE, locale, {
				fileName: file.fileName,
				pages: pages.length,
				provider
			});
			const batchNote = batchInfo
				? `\n${msg(MSG_BATCH_DONE, locale, {
						processed: pages.length,
						batches: batchInfo.batches,
						totalPages: batchInfo.totalPages,
						cappedNote: batchInfo.capped ? msg(MSG_CAPPED_DONE, locale) : ''
					})}`
				: '';
			const stubNotice = isStub ? `\n\n${msg(MSG_STUB_NOTICE, locale)}` : '';

			let body: string;
			if (fullText.length <= MAX_CONTENT_TEXT_CHARS) {
				body = fullText;
			} else if (stored) {
				body = `${fullText.slice(0, LONG_DOC_PREVIEW_CHARS)}\n[…]\n\n${msg(MSG_LONG_DOC, locale, {
					totalChars: fullText.length,
					pages: pages.length,
					markdownUrl: stored.markdownUrl,
					docId: stored.docId
				})}`;
			} else {
				body = `${fullText.slice(0, MAX_CONTENT_TEXT_CHARS)}\n[…texte tronqué]`;
			}

			logger.info('OCR extraction done', {
				fileName: file.fileName,
				pages: pages.length,
				provider,
				docId: stored?.docId,
				totalChars: fullText.length
			});

			// `data` reaches BOTH the panel (structuredContent) and the LLM prompt
			// (serialized on the current turn and replayed verbatim on every later
			// one) — keep it small. Full pages/document ride inline only when tiny
			// (stub, small docs: the panel then renders without a bridge call);
			// otherwise the panel fetches the payload via ocr_get_result.
			const inlinePayload = JSON.stringify(payload).length <= INLINE_DATA_MAX_CHARS;

			// `message` is the ONLY field the host UI renders in the tool step — keep it
			// to the short summary. The extracted text goes in `content`, which reaches
			// the model via toModelOutput (and via the serialized replay on later turns).
			return {
				message: `${summary}${batchNote}${stubNotice}`,
				content: body,
				data: {
					...(stored ? { docId: stored.docId, markdownUrl: stored.markdownUrl } : {}),
					fileName: file.fileName,
					contentType: file.contentType,
					provider,
					pageCount: pages.length,
					totalChars: fullText.length,
					boxCount,
					...(inlinePayload
						? { pages, ...(payload.document ? { document: payload.document } : {}) }
						: {})
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
		},
		// The host serializes the FULL output to the model by default — expose
		// `message` + `content` only, `data`/`_meta` are panel plumbing.
		// (Later-turn replays bypass this hook, hence `data` staying small above.)
		toModelOutput: ({ output }) => {
			const o = output as { message: string; content?: string };
			return {
				type: 'text' as const,
				value: o.content ? `${o.message}\n\n---\n${o.content}` : o.message
			};
		}
	});
}
