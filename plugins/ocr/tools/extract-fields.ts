/**
 * Structured field extraction tool (MagicOCR-style).
 *
 * Downloads a file attached to the current conversation (image or PDF) and
 * extracts a caller-defined list of typed fields through a vision LLM (see
 * lib/extraction.ts — port of IdeaStudio.MagicOcrV2). Stateless equivalent of
 * MagicOCR's "templates": the field list, coherence checks and the
 * doubleExtraction switch are tool parameters built by the model from the
 * user's request.
 *
 * LLM connector: llmApiKey/llmEndpoint/llmModel from the plugin config, with
 * ANTHROPIC_API_KEY / AZURE_AI_API_KEY / AZURE_AI_ENDPOINT / AZURE_AI_DEPLOYMENT
 * environment variables as fallback (same resolution order as MagicOCR). When
 * no key is available the tool runs in STUB mode (placeholder values) so the
 * full chain works without a real backend.
 *
 * The result carries `_meta.ui` (SEP-1865) so the host opens the
 * `ui://ocr/extraction` MCP App and delivers `data` as `structuredContent`.
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale } from '../../../src/types';
import { EXTRACTION_VIEWER_RESOURCE_URI } from '../template-extraction';
import {
	buildDocumentBlock,
	compareExtractions,
	extractFromDocument,
	extractFromText,
	extractWithDoubleValidation,
	mergeBatchResults,
	stubExtraction,
	verifyFieldSources,
	type CoherenceCheck,
	type ExtractionResult,
	type FieldComparison,
	type LlmConfig,
	type TemplateField
} from '../lib/extraction';
import {
	batchedMistralOcr,
	mistralOcr,
	parseTooManyPages,
	resolveOcrConnector,
	DEFAULT_PAGE_LIMIT
} from '../lib/mistral-ocr';
import {
	buildMarkdown,
	saveOcrResult,
	type OcrPage,
	type StoredOcrResult
} from '../lib/result-store';

const EXTRACTION_ICON = 'hugeicons:document-validation';
const EXTRACTION_PREFERRED_WIDTH = 640;

/** The model needs the extracted values to answer, but keep the payload bounded. */
const MAX_CONTENT_JSON_CHARS = 6_000;

/** Anthropic inline limits are ~5MB/image and 32MB/request — guard well below. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Embed the original document in the stored panel payload up to this size, so
 * the extraction viewer's side-by-side preview can render the real PDF pages
 * (pdf.js) or the image. Beyond it the preview is simply unavailable. Aligned
 * with ocr_extract's cap (same storage/bridge path, never in the LLM prompt).
 */
const FILE_EMBED_MAX_BYTES = 20 * 1024 * 1024;

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

// --- Localized messages (external plugins are self-contained: no $lib imports) ---

const MSG_DONE: Record<Locale, string> = {
	fr: 'Extraction de {count} champ(s) depuis {fileName} terminée (confiance globale: {confidence}%, mode: {mode}, connecteur: {provider}). Le détail est affiché dans le panneau d’extraction.',
	en: 'Extracted {count} field(s) from {fileName} (overall confidence: {confidence}%, mode: {mode}, connector: {provider}). Details are shown in the extraction panel.',
	es: 'Extracción de {count} campo(s) de {fileName} completada (confianza global: {confidence}%, modo: {mode}, conector: {provider}). El detalle se muestra en el panel de extracción.',
	zh: '已从 {fileName} 提取 {count} 个字段（总体置信度：{confidence}%，模式：{mode}，连接器：{provider}）。详情显示在提取面板中。',
	de: '{count} Feld(er) aus {fileName} extrahiert (Gesamtkonfidenz: {confidence}%, Modus: {mode}, Konnektor: {provider}). Details werden im Extraktions-Panel angezeigt.'
};

const MSG_STUB_NOTICE: Record<Locale, string> = {
	fr: "NOTE: le connecteur LLM n'est pas configuré (clé API absente) — résultat de DÉMONSTRATION avec des valeurs factices. Configure le plugin OCR dans l'admin (llmApiKey) ou les variables ANTHROPIC_API_KEY / AZURE_AI_API_KEY.",
	en: 'NOTE: the LLM connector is not configured (missing API key) — DEMO result with placeholder values. Configure the OCR plugin in the admin UI (llmApiKey) or the ANTHROPIC_API_KEY / AZURE_AI_API_KEY environment variables.',
	es: 'NOTA: el conector LLM no está configurado (falta la clave API) — resultado de DEMOSTRACIÓN con valores ficticios. Configura el plugin OCR en el admin (llmApiKey) o las variables ANTHROPIC_API_KEY / AZURE_AI_API_KEY.',
	zh: '注意：LLM 连接器未配置（缺少 API 密钥）— 这是使用占位值的演示结果。请在管理界面配置 OCR 插件（llmApiKey）或设置 ANTHROPIC_API_KEY / AZURE_AI_API_KEY 环境变量。',
	de: 'HINWEIS: Der LLM-Konnektor ist nicht konfiguriert (API-Schlüssel fehlt) — DEMO-Ergebnis mit Platzhalterwerten. Konfiguriere das OCR-Plugin im Admin-Bereich (llmApiKey) oder die Variablen ANTHROPIC_API_KEY / AZURE_AI_API_KEY.'
};

const MSG_FILE_NOT_ACCESSIBLE: Record<Locale, string> = {
	fr: "Erreur: fichier inaccessible ({source}). Utilise exactement une des URLs de fichiers listées dans le contexte de la conversation — seuls les fichiers de la conversation courante sont lisibles.",
	en: 'Error: file not accessible ({source}). Use exactly one of the file URLs listed in the conversation context — only files of the current conversation are readable.',
	es: 'Error: archivo inaccesible ({source}). Usa exactamente una de las URLs de archivo listadas en el contexto — solo los archivos de la conversación actual son legibles.',
	zh: '错误：无法访问文件（{source}）。请使用会话上下文中列出的文件 URL——只能读取当前会话的文件。',
	de: 'Fehler: Datei nicht zugänglich ({source}). Verwende exakt eine der im Konversationskontext gelisteten Datei-URLs — nur Dateien der aktuellen Konversation sind lesbar.'
};

const MSG_UNSUPPORTED_TYPE: Record<Locale, string> = {
	fr: 'Erreur: type de fichier non supporté ({contentType}). Formats acceptés: PDF, JPEG, PNG, GIF, WEBP.',
	en: 'Error: unsupported file type ({contentType}). Accepted formats: PDF, JPEG, PNG, GIF, WEBP.',
	es: 'Error: tipo de archivo no soportado ({contentType}). Formatos aceptados: PDF, JPEG, PNG, GIF, WEBP.',
	zh: '错误：不支持的文件类型（{contentType}）。接受的格式：PDF、JPEG、PNG、GIF、WEBP。',
	de: 'Fehler: Dateityp nicht unterstützt ({contentType}). Akzeptierte Formate: PDF, JPEG, PNG, GIF, WEBP.'
};

const MSG_FILE_TOO_LARGE: Record<Locale, string> = {
	fr: 'Erreur: fichier trop volumineux ({size} Mo, maximum 25 Mo).',
	en: 'Error: file too large ({size} MB, maximum 25 MB).',
	es: 'Error: archivo demasiado grande ({size} MB, máximo 25 MB).',
	zh: '错误：文件过大（{size} MB，最大 25 MB）。',
	de: 'Fehler: Datei zu groß ({size} MB, maximal 25 MB).'
};

const MSG_COMPARE_DONE: Record<Locale, string> = {
	fr: 'Comparaison VLM vs OCR : {agree} champ(s) concordant(s), {disagree} divergent(s). Le détail est affiché dans le panneau.',
	en: 'VLM vs OCR comparison: {agree} field(s) agree, {disagree} diverge. Details are shown in the panel.',
	es: 'Comparación VLM vs OCR: {agree} campo(s) concordante(s), {disagree} divergente(s). El detalle se muestra en el panel.',
	zh: 'VLM 与 OCR 对比：{agree} 个字段一致，{disagree} 个存在分歧。详情显示在面板中。',
	de: 'VLM-vs-OCR-Vergleich: {agree} Feld(er) stimmen überein, {disagree} weichen ab. Details werden im Panel angezeigt.'
};

const MSG_COMPARE_UNAVAILABLE: Record<Locale, string> = {
	fr: "Comparaison VLM/OCR indisponible : le connecteur OCR n'est pas configuré (endpoint/apiKey) — extraction vision seule.",
	en: 'VLM/OCR comparison unavailable: the OCR connector is not configured (endpoint/apiKey) — vision-only extraction.',
	es: 'Comparación VLM/OCR no disponible: el conector OCR no está configurado (endpoint/apiKey) — extracción solo por visión.',
	zh: 'VLM/OCR 对比不可用：OCR 连接器未配置（endpoint/apiKey）— 仅使用视觉提取。',
	de: 'VLM/OCR-Vergleich nicht verfügbar: Der OCR-Konnektor ist nicht konfiguriert (endpoint/apiKey) — nur Vision-Extraktion.'
};

const MSG_LLM_ERROR: Record<Locale, string> = {
	fr: "Erreur du connecteur LLM d'extraction : {error}. Vérifie la configuration du plugin OCR (llmEndpoint/llmApiKey/llmModel) — pour Azure AI Foundry, l'URL de base https://<ressource>.services.ai.azure.com suffit (la route /anthropic/v1/messages est ajoutée automatiquement).",
	en: 'Extraction LLM connector error: {error}. Check the OCR plugin configuration (llmEndpoint/llmApiKey/llmModel) — for Azure AI Foundry the base URL https://<resource>.services.ai.azure.com is enough (the /anthropic/v1/messages route is added automatically).',
	es: 'Error del conector LLM de extracción: {error}. Verifica la configuración del plugin OCR (llmEndpoint/llmApiKey/llmModel) — para Azure AI Foundry basta la URL base https://<recurso>.services.ai.azure.com (la ruta /anthropic/v1/messages se añade automáticamente).',
	zh: '提取 LLM 连接器错误：{error}。请检查 OCR 插件配置（llmEndpoint/llmApiKey/llmModel）— 对于 Azure AI Foundry，基础 URL https://<资源>.services.ai.azure.com 即可（/anthropic/v1/messages 路由会自动添加）。',
	de: 'Fehler des Extraktions-LLM-Konnektors: {error}. Prüfe die Konfiguration des OCR-Plugins (llmEndpoint/llmApiKey/llmModel) — für Azure AI Foundry genügt die Basis-URL https://<Ressource>.services.ai.azure.com (die Route /anthropic/v1/messages wird automatisch ergänzt).'
};

const MSG_COMPARE_FAILED: Record<Locale, string> = {
	fr: 'Comparaison VLM/OCR impossible ({error}) — extraction vision seule.',
	en: 'VLM/OCR comparison failed ({error}) — vision-only extraction.',
	es: 'Comparación VLM/OCR fallida ({error}) — extracción solo por visión.',
	zh: 'VLM/OCR 对比失败（{error}）— 仅使用视觉提取。',
	de: 'VLM/OCR-Vergleich fehlgeschlagen ({error}) — nur Vision-Extraktion.'
};

const MSG_NO_FIELDS: Record<Locale, string> = {
	fr: 'Erreur: aucun champ à extraire fourni. Renseigne le paramètre fields avec au moins un champ (name + type).',
	en: 'Error: no fields to extract were provided. Fill the fields parameter with at least one field (name + type).',
	es: 'Error: no se proporcionó ningún campo a extraer. Completa el parámetro fields con al menos un campo (name + type).',
	zh: '错误：未提供要提取的字段。请在 fields 参数中至少填写一个字段（name + type）。',
	de: 'Fehler: keine zu extrahierenden Felder angegeben. Fülle den Parameter fields mit mindestens einem Feld (name + type).'
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
	llmEndpoint?: string;
	llmApiKey?: string;
	llmModel?: string;
	/** OCR connector keys — used by the VLM-vs-OCR comparison mode. */
	endpoint?: string;
	apiKey?: string;
	ocrModel?: string;
}

interface ExtractFieldsParams {
	file_url: string;
	fields: Array<{
		name: string;
		type?: 'text' | 'number' | 'date' | 'email';
		required?: boolean;
		validationRule?: string;
	}>;
	coherenceChecks?: Array<{ name: string; rule: string }>;
	doubleExtraction?: boolean;
	compareWithOcr?: boolean;
}

/**
 * LLM connector resolution, same order as MagicOCR's `getAnthropicClient`:
 * plugin config → ANTHROPIC_API_KEY → AZURE_AI_* env vars → stub mode (null).
 */
function resolveLlmConfig(
	config: OcrPluginConfig,
	env: Record<string, string | undefined>
): LlmConfig | null {
	const cfgEndpoint = config.llmEndpoint?.trim();
	const cfgModel = config.llmModel?.trim();
	const cfgKey = config.llmApiKey?.trim();
	if (cfgKey) {
		return {
			apiKey: cfgKey,
			baseUrl: cfgEndpoint || DEFAULT_BASE_URL,
			model: cfgModel || DEFAULT_MODEL
		};
	}
	if (env.ANTHROPIC_API_KEY) {
		return {
			apiKey: env.ANTHROPIC_API_KEY,
			baseUrl: cfgEndpoint || DEFAULT_BASE_URL,
			model: cfgModel || DEFAULT_MODEL
		};
	}
	if (env.AZURE_AI_API_KEY) {
		return {
			apiKey: env.AZURE_AI_API_KEY,
			baseUrl: cfgEndpoint || env.AZURE_AI_ENDPOINT || DEFAULT_BASE_URL,
			model: cfgModel || env.AZURE_AI_DEPLOYMENT || DEFAULT_MODEL
		};
	}
	return null;
}

function sanitizeFields(raw: ExtractFieldsParams['fields']): TemplateField[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((f) => f && typeof f.name === 'string' && f.name.trim() !== '')
		.map((f) => ({
			name: f.name.trim(),
			type: f.type === 'number' || f.type === 'date' || f.type === 'email' ? f.type : 'text',
			required: f.required === true,
			...(typeof f.validationRule === 'string' && f.validationRule.trim() !== ''
				? { validationRule: f.validationRule.trim() }
				: {})
		}));
}

/**
 * Above this many fields the extraction is split into internal batches (one
 * LLM call each) and merged: a single oversized call gets its JSON answer cut
 * by max_tokens (observed around ~100 fields). Coherence checks ride with the
 * first batch only — the model sees the WHOLE document on every call, so they
 * stay meaningful there without being paid on each batch.
 */
const FIELDS_PER_CALL = 25;

function chunkFields(fields: TemplateField[]): TemplateField[][] {
	const out: TemplateField[][] = [];
	for (let i = 0; i < fields.length; i += FIELDS_PER_CALL) {
		out.push(fields.slice(i, i + FIELDS_PER_CALL));
	}
	return out;
}

/** Vision extraction, batched over the field list (sequential — full document each call). */
async function runVisionExtraction(
	llm: LlmConfig,
	block: NonNullable<ReturnType<typeof buildDocumentBlock>>,
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[],
	doubleExtraction: boolean
): Promise<ExtractionResult> {
	const run = (f: TemplateField[], c: CoherenceCheck[]) =>
		doubleExtraction
			? extractWithDoubleValidation(llm, block, f, c)
			: extractFromDocument(llm, block, f, c);
	const batches = chunkFields(fields);
	if (batches.length === 1) return run(fields, coherenceChecks);
	const results: ExtractionResult[] = [];
	for (const [i, batch] of batches.entries()) {
		results.push(await run(batch, i === 0 ? coherenceChecks : []));
	}
	return mergeBatchResults(results);
}

/** Text-side extraction (compareWithOcr), batched the same way. */
async function runTextExtraction(
	llm: LlmConfig,
	documentText: string,
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): Promise<ExtractionResult> {
	const batches = chunkFields(fields);
	if (batches.length === 1) return extractFromText(llm, documentText, fields, coherenceChecks);
	const results: ExtractionResult[] = [];
	for (const [i, batch] of batches.entries()) {
		results.push(await extractFromText(llm, documentText, batch, i === 0 ? coherenceChecks : []));
	}
	return mergeBatchResults(results);
}

function sanitizeChecks(raw: ExtractFieldsParams['coherenceChecks']): CoherenceCheck[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(c) =>
				c &&
				typeof c.name === 'string' &&
				c.name.trim() !== '' &&
				typeof c.rule === 'string' &&
				c.rule.trim() !== ''
		)
		.map((c) => ({ name: c.name.trim(), rule: c.rule.trim() }));
}

export function createExtractFieldsTool(context: PluginContext): AnyTool {
	const { locale, logger, env } = context;
	const config = (context.pluginConfig ?? {}) as OcrPluginConfig;

	return tool({
		description:
			"Extrait des champs structurés (valeurs typées) d'un document attaché à la conversation (PDF ou image : facture, formulaire, reçu, bon de livraison…). Définis les champs à extraire d'après la demande de l'utilisateur ; le résultat inclut valeurs, confiances 0-100, erreurs et contrôles de cohérence. Options de fiabilisation : doubleExtraction (deux passes vision croisées) et compareWithOcr (validation croisée vision vs texte Mistral OCR, comparée champ par champ dans le panneau).",
		inputSchema: jsonSchema<ExtractFieldsParams>({
			type: 'object',
			properties: {
				file_url: {
					type: 'string',
					description:
						"URL /api/files/... du fichier à traiter, copiée EXACTEMENT depuis la liste des fichiers disponibles dans le contexte de la conversation"
				},
				fields: {
					type: 'array',
					description:
						"Champs à extraire, construits d'après la demande de l'utilisateur (équivalent d'un template MagicOCR). Pour des éléments répétés (liste d'exigences, lignes de facture…), fournir UN champ par élément nommé par son identifiant réel — jamais un unique champ agrégé. Les grandes listes sont acceptées en UN SEUL appel : l'outil découpe lui-même en lots internes",
					items: {
						type: 'object',
						properties: {
							name: { type: 'string', description: 'Libellé exact du champ (ex: "Numéro de facture")' },
							type: {
								type: 'string',
								enum: ['text', 'number', 'date', 'email'],
								description: "Type du champ (défaut: 'text'). date → YYYY-MM-DD, number → valeur numérique seule"
							},
							required: { type: 'boolean', description: 'true si le champ est obligatoire (erreur s’il est introuvable)' },
							validationRule: {
								type: 'string',
								description: 'Règle de validation en texte libre transmise au modèle (optionnel)'
							}
						},
						required: ['name']
					}
				},
				coherenceChecks: {
					type: 'array',
					description:
						'Contrôles de cohérence en texte libre, vérifiés par le modèle (ex: "le total TTC doit être égal au total HT + TVA") — optionnel',
					items: {
						type: 'object',
						properties: {
							name: { type: 'string', description: 'Nom court du contrôle' },
							rule: { type: 'string', description: 'Règle à vérifier, en texte libre' }
						},
						required: ['name', 'rule']
					}
				},
				doubleExtraction: {
					type: 'boolean',
					description:
						'true pour lancer deux extractions vision indépendantes et les croiser champ par champ (plus fiable, plus lent) — optionnel'
				},
				compareWithOcr: {
					type: 'boolean',
					description:
						"true pour valider l'extraction en croisant deux approches différentes : extraction vision (VLM sur l'image) contre extraction depuis le texte Mistral OCR — comparaison champ par champ affichée dans le panneau (nécessite le connecteur OCR configuré) — optionnel"
				}
			},
			required: ['file_url', 'fields']
		}),
		execute: async (
			params
		): Promise<{
			message: string;
			content?: string;
			data?: Record<string, unknown>;
			_meta?: Record<string, unknown>;
		}> => {
			const fields = sanitizeFields(params.fields);
			if (fields.length === 0) {
				return { message: msg(MSG_NO_FIELDS, locale) };
			}
			const coherenceChecks = sanitizeChecks(params.coherenceChecks);
			const doubleExtraction = params.doubleExtraction === true;

			let file: { buffer: Buffer; contentType: string; fileName: string };
			try {
				file = await context.storage.downloadConversationFile(params.file_url);
			} catch (error) {
				logger.warn('Field extraction file download failed', {
					source: params.file_url,
					error: error instanceof Error ? error.message : String(error)
				});
				return { message: msg(MSG_FILE_NOT_ACCESSIBLE, locale, { source: params.file_url }) };
			}

			if (file.buffer.length > MAX_FILE_BYTES) {
				return {
					message: msg(MSG_FILE_TOO_LARGE, locale, {
						size: (file.buffer.length / (1024 * 1024)).toFixed(1)
					})
				};
			}

			const block = buildDocumentBlock(file.buffer, file.contentType);
			if (!block) {
				return { message: msg(MSG_UNSUPPORTED_TYPE, locale, { contentType: file.contentType }) };
			}

			const llm = resolveLlmConfig(config, env);
			const isStub = llm === null;
			const provider = isStub ? 'stub' : llm.model;
			const compareWithOcr = params.compareWithOcr === true;

			let result: ExtractionResult;
			let comparison: FieldComparison[] | null = null;
			let compareNotice = '';
			/** OCR pages from the compareWithOcr pass, reused for the stored panel payload. */
			let ocrPagesForStore: OcrPage[] | null = null;
			if (llm === null) {
				result = stubExtraction(fields, coherenceChecks);
			} else {
				const vlmPromise = runVisionExtraction(llm, block, fields, coherenceChecks, doubleExtraction);
				if (!compareWithOcr) {
					result = await vlmPromise;
				} else {
					// Cross-modality validation: vision extraction vs text extraction
					// over the Mistral OCR markdown (crops skipped — text only).
					const connector = resolveOcrConnector(config, env);
					if (!connector) {
						compareNotice = `\n${msg(MSG_COMPARE_UNAVAILABLE, locale)}`;
						result = await vlmPromise;
					} else {
						try {
							let ocrPages: OcrPage[];
							try {
								ocrPages = await mistralOcr(
									connector,
									file.buffer,
									file.contentType,
									file.fileName,
									{ cropBudget: { remaining: 0 } }
								);
							} catch (ocrError) {
								// Same batching principle as ocr_extract: documents over the
								// per-request page limit are split into image sub-PDFs. No
								// extra user confirmation here — asking for compareWithOcr IS
								// the consent for the heavier OCR pass.
								const ocrErrorText =
									ocrError instanceof Error ? ocrError.message : String(ocrError);
								const tooMany = parseTooManyPages(ocrErrorText);
								if (!tooMany) throw ocrError;
								const batchSize = Math.max(1, tooMany.maxPages || DEFAULT_PAGE_LIMIT);
								logger.info('compareWithOcr: batched OCR fallback', {
									fileName: file.fileName,
									totalPages: tooMany.totalPages,
									batchSize
								});
								const batched = await batchedMistralOcr(
									connector,
									file.buffer,
									file.fileName,
									batchSize,
									{ cropBudget: { remaining: 0 } }
								);
								ocrPages = batched.pages;
							}
							ocrPagesForStore = ocrPages;
							const ocrText = buildMarkdown(ocrPages);
							const [vlmResult, ocrResult] = await Promise.all([
								vlmPromise,
								runTextExtraction(llm, ocrText, fields, coherenceChecks)
							]);
							// A technically failed extraction has no data: comparing it would
							// fabricate "agreements" between empty results — degrade instead.
							if (vlmResult.failed || ocrResult.failed) {
								const failedSide = vlmResult.failed ? vlmResult : ocrResult;
								compareNotice = `\n${msg(MSG_COMPARE_FAILED, locale, {
									error: failedSide.errors[0] ?? 'échec du connecteur'
								})}`;
								result = vlmResult.failed ? ocrResult : vlmResult;
							} else {
								const compared = compareExtractions(vlmResult, ocrResult, fields);
								result = compared.result;
								comparison = compared.comparison;
							}
						} catch (error) {
							compareNotice = `\n${msg(MSG_COMPARE_FAILED, locale, {
								error: error instanceof Error ? error.message : String(error)
							})}`;
							result = await vlmPromise;
						}
					}
				}
			}

			// Provenance audit: when the compareWithOcr pass produced OCR text, check
			// the model-reported quotes against it (verified/unverified flag on each
			// source — soft signal for the panel, confidences untouched).
			if (ocrPagesForStore) verifyFieldSources(result, ocrPagesForStore);

			// LLM connector down (transport/parse failure on every attempt): no data
			// at all — report the error plainly instead of a 0%-confidence table.
			if (result.failed) {
				logger.error('Field extraction LLM connector failed', {
					error: result.errors.join(' | ')
				});
				return {
					message: msg(MSG_LLM_ERROR, locale, {
						error: result.errors[0] ?? 'erreur inconnue'
					})
				};
			}

			// MagicOCR status rule: error as soon as one error or one failed check.
			const status =
				result.errors.length > 0 || result.coherenceCheckResults.some((c) => !c.passed)
					? 'error'
					: 'success';

			const fieldBatches = Math.ceil(fields.length / FIELDS_PER_CALL);
			const modeParts = [
				doubleExtraction ? 'double extraction' : 'simple',
				...(comparison ? ['comparaison VLM/OCR'] : []),
				...(fieldBatches > 1 ? [`${fieldBatches} lots de champs`] : [])
			];
			const summary = msg(MSG_DONE, locale, {
				count: fields.length,
				fileName: file.fileName,
				confidence: result.confidence,
				mode: modeParts.join(' + '),
				provider
			});
			const compareSummary = comparison
				? `\n${msg(MSG_COMPARE_DONE, locale, {
						agree: comparison.filter((c) => c.agree).length,
						disagree: comparison.filter((c) => !c.agree).length
					})}`
				: '';
			const stubNotice = isStub ? `\n\n${msg(MSG_STUB_NOTICE, locale)}` : '';

			const resultJson = JSON.stringify(
				{
					status,
					fields: result.fields,
					confidence: result.confidence,
					fieldConfidences: result.fieldConfidences,
					...(result.fieldSources ? { fieldSources: result.fieldSources } : {}),
					errors: result.errors,
					warnings: result.warnings,
					coherenceCheckResults: result.coherenceCheckResults
				},
				null,
				2
			);
			const truncated =
				resultJson.length > MAX_CONTENT_JSON_CHARS
					? `${resultJson.slice(0, MAX_CONTENT_JSON_CHARS)}\n[…résultat tronqué]`
					: resultJson;

			// Side-by-side document preview: persist the original file (and the OCR
			// pages when compareWithOcr ran) in the plugin's result store; the panel
			// fetches it via ocr_get_result through the MCP Apps bridge (never
			// persisted in the chat), so only the small `docId` rides in `data`.
			const embedMediaType = (file.contentType || '').split(';')[0].trim().toLowerCase();
			const embeddable =
				file.buffer.length <= FILE_EMBED_MAX_BYTES &&
				(embedMediaType === 'application/pdf' || embedMediaType.startsWith('image/'));
			let docId: string | null = null;
			if (embeddable || ocrPagesForStore) {
				const storePayload: StoredOcrResult = {
					fileName: file.fileName,
					contentType: file.contentType,
					provider,
					pages: ocrPagesForStore ?? [],
					...(embeddable
						? {
								document: {
									mediaType: embedMediaType,
									dataUri: `data:${embedMediaType};base64,${file.buffer.toString('base64')}`
								}
							}
						: {})
				};
				try {
					docId = (await saveOcrResult(context.storage, storePayload)).docId;
				} catch (error) {
					logger.warn('extract_fields: result store failed — no document preview', {
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}

			logger.info('Field extraction done', {
				fileName: file.fileName,
				fieldCount: fields.length,
				confidence: result.confidence,
				status,
				doubleExtraction,
				provider,
				docId
			});

			// `message` is the ONLY field the host UI renders in the tool step — keep it
			// to the short summary. The result JSON goes in `content`, which reaches
			// the model via toModelOutput (and via the serialized replay on later turns).
			return {
				message: `${summary}${compareSummary}${compareNotice}${stubNotice}`,
				content: truncated,
				data: {
					...(docId ? { docId } : {}),
					fileName: file.fileName,
					contentType: file.contentType,
					provider,
					doubleExtraction,
					status,
					templateFields: fields,
					result,
					...(comparison ? { comparison } : {})
				},
				_meta: {
					ui: {
						resourceUri: EXTRACTION_VIEWER_RESOURCE_URI,
						title: `Extraction — ${file.fileName}`,
						icon: EXTRACTION_ICON,
						preferredWidth: EXTRACTION_PREFERRED_WIDTH
					}
				}
			};
		},
		// The host serializes the FULL output to the model by default — expose
		// `message` + `content` (the bounded result JSON) only.
		toModelOutput: ({ output }) => {
			const o = output as { message: string; content?: string };
			return {
				type: 'text' as const,
				value: o.content ? `${o.message}\n\n---\n${o.content}` : o.message
			};
		}
	});
}
