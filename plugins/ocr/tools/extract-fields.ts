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
	extractFromDocument,
	extractWithDoubleValidation,
	stubExtraction,
	type CoherenceCheck,
	type ExtractionResult,
	type LlmConfig,
	type TemplateField
} from '../lib/extraction';

const EXTRACTION_ICON = 'hugeicons:document-validation';
const EXTRACTION_PREFERRED_WIDTH = 640;

/** The model needs the extracted values to answer, but keep the payload bounded. */
const MAX_MESSAGE_JSON_CHARS = 6_000;

/** Anthropic inline limits are ~5MB/image and 32MB/request — guard well below. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
			"Extrait des champs structurés (valeurs typées) d'un document attaché à la conversation (PDF ou image : facture, formulaire, reçu, bon de livraison…). Définis les champs à extraire d'après la demande de l'utilisateur ; le résultat inclut valeurs, confiances 0-100, erreurs et contrôles de cohérence.",
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
						"Champs à extraire, construits d'après la demande de l'utilisateur (équivalent d'un template MagicOCR)",
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
						'true pour lancer deux extractions indépendantes et les croiser champ par champ (plus fiable, plus lent) — optionnel'
				}
			},
			required: ['file_url', 'fields']
		}),
		execute: async (
			params
		): Promise<{
			message: string;
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

			let result: ExtractionResult;
			if (isStub) {
				result = stubExtraction(fields, coherenceChecks);
			} else if (doubleExtraction) {
				result = await extractWithDoubleValidation(llm, block, fields, coherenceChecks);
			} else {
				result = await extractFromDocument(llm, block, fields, coherenceChecks);
			}

			// MagicOCR status rule: error as soon as one error or one failed check.
			const status =
				result.errors.length > 0 || result.coherenceCheckResults.some((c) => !c.passed)
					? 'error'
					: 'success';

			const summary = msg(MSG_DONE, locale, {
				count: fields.length,
				fileName: file.fileName,
				confidence: result.confidence,
				mode: doubleExtraction ? 'double extraction' : 'simple',
				provider
			});
			const stubNotice = isStub ? `\n\n${msg(MSG_STUB_NOTICE, locale)}` : '';

			const resultJson = JSON.stringify(
				{
					status,
					fields: result.fields,
					confidence: result.confidence,
					fieldConfidences: result.fieldConfidences,
					errors: result.errors,
					warnings: result.warnings,
					coherenceCheckResults: result.coherenceCheckResults
				},
				null,
				2
			);
			const truncated =
				resultJson.length > MAX_MESSAGE_JSON_CHARS
					? `${resultJson.slice(0, MAX_MESSAGE_JSON_CHARS)}\n[…résultat tronqué]`
					: resultJson;

			logger.info('Field extraction done', {
				fileName: file.fileName,
				fieldCount: fields.length,
				confidence: result.confidence,
				status,
				doubleExtraction,
				provider
			});

			return {
				message: `${summary}${stubNotice}\n\n---\n${truncated}`,
				data: {
					fileName: file.fileName,
					contentType: file.contentType,
					provider,
					doubleExtraction,
					status,
					templateFields: fields,
					result
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
		}
	});
}
