import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale, Source } from '../../../src/types';
import type {
	SearchExaParams,
	ExaSearchResponse,
	ExaSearchResult,
	ExaErrorResponse,
	SearchExaResult
} from './models';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';

function stripHtml(text: string): string {
	return text.replace(/<[^>]*>/g, '');
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const arr = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
		return arr.length > 0 ? arr : undefined;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const arr = value
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		return arr.length > 0 ? arr : undefined;
	}
	return undefined;
}

function asSearchType(value: unknown): 'auto' | 'neural' | 'keyword' {
	if (value === 'neural' || value === 'keyword' || value === 'auto') return value;
	return 'auto';
}

function buildContent(result: ExaSearchResult): string {
	const parts: string[] = [];
	if (result.highlights && result.highlights.length > 0) {
		parts.push(result.highlights.join(' ... '));
	}
	if (result.text) {
		parts.push(result.text);
	}
	return stripHtml(parts.join('\n\n').trim());
}

function convertToSources(results: ExaSearchResult[]): Source[] {
	return results.map((r, index) => ({
		id: `exa-${r.id ?? index}`,
		content: buildContent(r),
		metadata: {
			source: stripHtml(r.title ?? r.url),
			type: 'web',
			url: r.url,
			domain: extractDomain(r.url),
			age: r.publishedDate ?? undefined
		},
		similarity:
			typeof r.score === 'number'
				? Math.max(0, Math.min(1, r.score))
				: 1 - index * (0.5 / Math.max(results.length - 1, 1))
	}));
}

const SEARCH_RESULTS_FOUND: Record<Locale, string> = {
	fr: '{count} résultats trouvés via Exa.',
	en: '{count} results found via Exa.',
	es: '{count} resultados encontrados en Exa.',
	zh: '通过 Exa 找到 {count} 个结果。',
	de: '{count} Ergebnisse über Exa gefunden.'
};

function searchResultsFoundMsg(locale: Locale | undefined, count: number): string {
	const template = SEARCH_RESULTS_FOUND[locale ?? 'fr'] ?? SEARCH_RESULTS_FOUND['fr'];
	return template.replace('{count}', String(count));
}

export function createSearchExaTool(context: PluginContext): AnyTool {
	return tool({
		description:
			'Searches the web via Exa (neural + keyword search). Returns ranked sources with full page text and highlights. Use this for current web information when you need detailed sources to cite.',
		inputSchema: jsonSchema<SearchExaParams>({
			type: 'object',
			properties: {
				q: {
					type: 'string',
					description: 'Search query. Use natural language for best results with neural search.'
				},
				numResults: {
					type: 'number',
					description: 'Optional override for number of results (1-25).',
					minimum: 1,
					maximum: 25
				}
			},
			required: ['q']
		}),
		execute: async (params): Promise<SearchExaResult> => {
			const apiKey = context.env.EXA_API_KEY;
			if (!apiKey) {
				return { message: 'Exa Search is not configured. Please set EXA_API_KEY.' };
			}

			const cfg = context.pluginConfig ?? {};
			const configuredMax = clampNumber(cfg.maxResults, 1, 25, 10);
			const numResults = params.numResults
				? clampNumber(params.numResults, 1, 25, configuredMax)
				: configuredMax;
			const searchType = asSearchType(cfg.searchType);
			const includeDomains = asStringArray(cfg.includeDomains);
			const excludeDomains = asStringArray(cfg.excludeDomains);

			const body: Record<string, unknown> = {
				query: params.q,
				numResults,
				type: searchType,
				contents: {
					text: { maxCharacters: 2000 },
					highlights: { numSentences: 3, highlightsPerUrl: 1 }
				}
			};
			if (includeDomains) body.includeDomains = includeDomains;
			if (excludeDomains) body.excludeDomains = excludeDomains;

			context.logger.info('search_exa called', {
				query: params.q,
				numResults,
				type: searchType
			});

			try {
				const response = await fetch(EXA_SEARCH_URL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-api-key': apiKey
					},
					body: JSON.stringify(body)
				});

				if (!response.ok) {
					const errText = await response.text();
					context.logger.error('Exa search API error', {
						status: response.status,
						body: errText
					});
					let detail = errText;
					try {
						const parsed: ExaErrorResponse = JSON.parse(errText);
						const msg =
							typeof parsed.error === 'string'
								? parsed.error
								: parsed.error?.message ?? parsed.message;
						if (msg) detail = msg;
					} catch {
						/* keep raw text */
					}
					return {
						message: `Exa Search error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`
					};
				}

				const data: ExaSearchResponse = await response.json();
				const results = data.results ?? [];
				const sources = results.length > 0 ? convertToSources(results) : undefined;
				const message = searchResultsFoundMsg(context.locale, results.length);

				context.logger.info('search_exa completed', {
					query: params.q,
					sourceCount: results.length,
					autoprompt: data.autopromptString
				});

				return { message, sources };
			} catch (error) {
				context.logger.error('Unexpected error calling Exa search', { err: error });
				return {
					message: `Exa Search error: ${error instanceof Error ? error.message : 'Unknown error'}`
				};
			}
		}
	});
}
