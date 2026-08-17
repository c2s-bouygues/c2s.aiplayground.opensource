/**
 * Staan Web Search Tool
 *
 * AI-optimized web search via the Staan "Web for AI" API (https://docs.staan.ai/docs/web-for-ai).
 * Runs on Qwant's infrastructure (European data residency). Returns ranked web results
 * enriched with semantically scored content chunks, and optionally the full page body
 * as Markdown for RAG use cases.
 */

import { tool, jsonSchema, type JSONValue } from 'ai';
import type { PluginContext, AnyTool, Locale, Source } from '../../../src/types';
import type {
	StaanPluginConfig,
	StaanSearchParams,
	StaanSearchResponse,
	StaanSearchResult,
	StaanWebResult
} from './models';

const STAAN_API_URL = 'https://api.staan.ai/v2/search/web';

/** Staan recommends an 8-10s client timeout when chunk/full-content enrichment is enabled. */
const REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_MAX_SNIPPETS = 5;
/** Staan's recommended baseline threshold for chunk relevance. */
const DEFAULT_MIN_SCORE = 0.2;
const DEFAULT_MAX_FULL_CONTENT_CHARS = 20_000;

// --- Localized messages (external plugins are self-contained: no $lib imports) ---

const MSG_RESULTS_FOUND: Record<Locale, string> = {
	fr: '{count} résultats trouvés via Staan.',
	en: '{count} results found via Staan.',
	es: '{count} resultados encontrados en Staan.',
	zh: '通过 Staan 找到 {count} 个结果。',
	de: '{count} Ergebnisse über Staan gefunden.'
};

const MSG_NO_RESULTS: Record<Locale, string> = {
	fr: 'Aucun résultat trouvé pour cette recherche.',
	en: 'No results found for this search.',
	es: 'No se encontraron resultados para esta búsqueda.',
	zh: '未找到与此搜索相关的结果。',
	de: 'Keine Ergebnisse für diese Suche gefunden.'
};

const MSG_NOT_CONFIGURED: Record<Locale, string> = {
	fr: "Staan Web Search n'est pas configuré. Renseigne la clé API dans la configuration du plugin ou la variable d'environnement STAAN_API_KEY.",
	en: 'Staan Web Search is not configured. Set the API key in the plugin configuration or the STAAN_API_KEY environment variable.',
	es: 'Staan Web Search no está configurado. Define la clave API en la configuración del plugin o en la variable de entorno STAAN_API_KEY.',
	zh: 'Staan 网页搜索未配置。请在插件配置中设置 API 密钥，或设置 STAAN_API_KEY 环境变量。',
	de: 'Staan Web Search ist nicht konfiguriert. Hinterlege den API-Schlüssel in der Plugin-Konfiguration oder in der Umgebungsvariable STAAN_API_KEY.'
};

const MSG_API_ERROR: Record<Locale, string> = {
	fr: 'Erreur API Staan : {status} {statusText}',
	en: 'Staan API error: {status} {statusText}',
	es: 'Error de la API de Staan: {status} {statusText}',
	zh: 'Staan API 错误：{status} {statusText}',
	de: 'Staan-API-Fehler: {status} {statusText}'
};

const MSG_SEARCH_ERROR: Record<Locale, string> = {
	fr: 'Erreur lors de la recherche web : {error}',
	en: 'Error during web search: {error}',
	es: 'Error durante la búsqueda web: {error}',
	zh: '网页搜索时出错：{error}',
	de: 'Fehler bei der Websuche: {error}'
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

// --- Helpers ---

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

/**
 * Convert Staan results to Source[] for UI source-citation display.
 * Similarity uses the best chunk score when enrichment is available,
 * falling back to a rank-based estimate.
 */
function convertToSources(results: StaanWebResult[]): Source[] {
	return results.map((result, index) => {
		const chunks = result.extra_snippets ?? [];
		const bestChunkScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.score)) : undefined;
		const rankSimilarity = 1 - index * (0.5 / Math.max(results.length - 1, 1));

		return {
			id: `staan-${index}-${encodeURIComponent(result.url)}`,
			content: [result.snippet, ...chunks.map((c) => c.chunk)].filter(Boolean).join('\n'),
			metadata: {
				source: result.title,
				type: 'web',
				url: result.url,
				domain: result.hostname ?? extractDomain(result.url),
				age: result.published_date
			},
			similarity: bestChunkScore ?? rankSimilarity
		};
	});
}

function formatSearchResults(
	response: StaanSearchResponse,
	maxFullContentChars: number,
	locale?: Locale
): StaanSearchResult {
	const webResults = response.web?.results;

	if (!webResults || webResults.length === 0) {
		return { message: msg(MSG_NO_RESULTS, locale) };
	}

	const results = webResults.map((result) => ({
		title: result.title,
		url: result.url,
		snippet: result.snippet,
		hostname: result.hostname,
		publishedDate: result.published_date,
		chunks:
			result.extra_snippets && result.extra_snippets.length > 0 ? result.extra_snippets : undefined,
		fullContent:
			result.full_content && result.full_content.length > 0
				? result.full_content.text.substring(0, maxFullContentChars)
				: undefined
	}));

	return {
		message: msg(MSG_RESULTS_FOUND, locale, { count: results.length }),
		sources: convertToSources(webResults),
		results
	};
}

/**
 * Creates the staan_search tool for AI-optimized web search via the Staan API.
 */
export function createSearchStaanTool(context: PluginContext): AnyTool {
	const { locale, logger, env } = context;
	const config = (context.pluginConfig ?? {}) as StaanPluginConfig;

	const defaultMarket = config.defaultMarket || 'fr-fr';
	const defaultMaxSnippets = clamp(config.maxSnippets ?? DEFAULT_MAX_SNIPPETS, 1, 10);
	const defaultMinScore = clamp(config.minScore ?? DEFAULT_MIN_SCORE, 0, 1);
	// Default true — an unsaved plugin config has no values, so "unset" must
	// behave like the manifest default.
	const allowFullContent = config.allowFullContent !== false;
	const maxFullContentChars = clamp(
		config.maxFullContentChars ?? DEFAULT_MAX_FULL_CONTENT_CHARS,
		1000,
		100_000
	);

	const fullContentNote = allowFullContent
		? `\n- full_content: récupère le corps complet des pages en Markdown (plus lent, plus de tokens). À réserver aux cas où les extraits ne suffisent pas.`
		: '';

	return tool<StaanSearchParams, StaanSearchResult, Record<string, unknown>>({
		description: `Recherche web optimisée pour l'IA via l'API Staan (infrastructure Qwant, données européennes / RGPD). Retourne des résultats classés enrichis de chunks de contenu sémantiquement scorés par rapport à la requête — idéal pour du RAG et la citation de sources. Les résultats sont réordonnés par pertinence sémantique, pas par ranking SERP brut.${fullContentNote}`,
		// Strip UI-only `sources` from the tool result sent back to the LLM.
		// `sources` duplicate `results[]` content for citation display and would
		// needlessly bloat the tool message.
		toModelOutput: ({ output }) => {
			const { sources: _omit, ...modelView } = output;
			void _omit;
			return { type: 'json', value: modelView as unknown as JSONValue };
		},
		inputSchema: jsonSchema<StaanSearchParams>({
			type: 'object',
			properties: {
				q: {
					type: 'string',
					description:
						'Requête de recherche (mots-clés ou question en langage naturel, 400 caractères max). Supporte les filtres site:'
				},
				offset: {
					type: 'number',
					enum: [0, 10, 20, 30],
					description:
						"Position de départ pour la pagination (l'API retourne 10 résultats par page). Valeurs autorisées: 0, 10, 20, 30. Par défaut: 0"
				},
				market: {
					type: 'string',
					enum: ['fr-fr', 'en-us', 'de-de'],
					description: `Marché/locale de la recherche. Par défaut: ${defaultMarket}`
				},
				extra_snippets: {
					type: 'boolean',
					description:
						'Récupérer les pages et retourner des chunks de contenu sémantiquement scorés (recommandé pour le RAG). Par défaut: true'
				},
				...(allowFullContent && {
					full_content: {
						type: 'boolean',
						description:
							'Retourner le corps complet des pages en Markdown (plus lent, beaucoup de tokens). Par défaut: false'
					}
				}),
				max_snippets: {
					type: 'number',
					description: `Nombre maximum de chunks scorés par URL (1-10). Par défaut: ${defaultMaxSnippets}`
				},
				min_score: {
					type: 'number',
					description: `Score de pertinence minimum des chunks (0-1). Par défaut: ${defaultMinScore}`
				}
			},
			required: ['q']
		}),
		execute: async (params): Promise<StaanSearchResult> => {
			logger.info('staan_search called', { query: params.q });

			const apiKey = config.apiKey?.trim() || env.STAAN_API_KEY;

			if (!apiKey) {
				logger.error('Staan API key is not configured (config.apiKey or STAAN_API_KEY)');
				return { message: msg(MSG_NOT_CONFIGURED, locale) };
			}

			// The API accepts q up to 400 chars, count fixed at 10 (must not be sent),
			// offset only 0/10/20/30, market only fr-fr/en-us/de-de.
			const offset = clamp(Math.floor((params.offset ?? 0) / 10) * 10, 0, 30);
			const searchParams = new URLSearchParams({
				q: params.q.substring(0, 400),
				market: params.market || defaultMarket,
				offset: String(offset)
			});

			if (params.extra_snippets !== false) {
				searchParams.set('extra_snippets', 'true');
				searchParams.set(
					'max_snippets',
					String(clamp(params.max_snippets ?? defaultMaxSnippets, 1, 10))
				);
				searchParams.set('min_score', String(clamp(params.min_score ?? defaultMinScore, 0, 1)));
			}
			if (allowFullContent && params.full_content === true) {
				searchParams.set('full_content', 'markdown');
			}

			try {
				const response = await fetch(`${STAAN_API_URL}?${searchParams.toString()}`, {
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${apiKey}`
					},
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				});

				if (!response.ok) {
					const errorText = await response.text();
					logger.error('Staan API error', {
						status: response.status,
						statusText: response.statusText,
						error: errorText
					});
					return {
						message: msg(MSG_API_ERROR, locale, {
							status: response.status,
							statusText: response.statusText
						})
					};
				}

				const data: StaanSearchResponse = await response.json();
				logger.info('Staan response received', {
					searchId: data.search_id,
					resultsCount: data.web?.results?.length ?? 0
				});

				return formatSearchResults(data, maxFullContentChars, locale);
			} catch (error) {
				logger.error('Error searching web via Staan', { err: error });
				return {
					message: msg(MSG_SEARCH_ERROR, locale, {
						error: error instanceof Error ? error.message : 'Unknown error'
					})
				};
			}
		}
	});
}
