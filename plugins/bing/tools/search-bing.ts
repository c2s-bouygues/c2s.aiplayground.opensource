import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale, Source } from '../../../src/types';
import type {
	SearchBingParams,
	ResponsesApiResponse,
	AgentSource,
	AgentStructuredResponse,
	SearchBingResult
} from './models';

// Azure AI Foundry Responses API version
const API_VERSION = '2025-11-15-preview';

/**
 * Strip HTML tags from a string (the agent may use <strong> etc.)
 */
function stripHtml(text: string): string {
	return text.replace(/<[^>]*>/g, '');
}

/**
 * Extract the hostname from a URL, removing the www. prefix.
 */
function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

/**
 * Convert the agent's raw source list to Source[] for UI source-citation display.
 */
function convertToSources(agentSources: AgentSource[]): Source[] {
	return agentSources.map((src, index) => ({
		id: `bing-${src.id}${src.url ? '-' + encodeURIComponent(src.url) : ''}`,
		content: stripHtml(src.content),
		metadata: {
			source: stripHtml(src.title),
			type: 'web',
			url: src.url ?? undefined,
			domain: src.domain ?? (src.url ? extractDomain(src.url) : undefined),
			age: src.date ?? undefined
		},
		similarity: 1 - index * (0.5 / Math.max(agentSources.length - 1, 1))
	}));
}

const SEARCH_RESULTS_FOUND: Record<Locale, string> = {
	fr: '{count} résultats trouvés via Bing.',
	en: '{count} results found via Bing.',
	es: '{count} resultados encontrados en Bing.',
	zh: '通过 Bing 找到 {count} 个结果。'
};

function searchResultsFoundMsg(locale: Locale | undefined, count: number): string {
	const template = SEARCH_RESULTS_FOUND[locale ?? 'fr'] ?? SEARCH_RESULTS_FOUND['fr'];
	return template.replace('{count}', String(count));
}

export function createSearchBingTool(context: PluginContext): AnyTool {
	return tool({
		description:
			'Searches the internet via an Azure AI Foundry agent with Bing grounding. Use this tool to find current, real-time information on the web. Returns structured results with sources.',
		inputSchema: jsonSchema<SearchBingParams>({
			type: 'object',
			properties: {
				q: {
					type: 'string',
					description:
						'Search query. Be specific and use natural language for best results.'
				}
			},
			required: ['q']
		}),
		execute: async (params): Promise<SearchBingResult> => {
			const endpoint = context.env.AZURE_FOUNDRY_BING_ENDPOINT?.replace(/\/$/, '');
			const apiKey = context.env.AZURE_FOUNDRY_BING_API_KEY;

			if (!endpoint || !apiKey) {
				return {
					message:
						'Bing Search is not configured. Please set AZURE_FOUNDRY_BING_ENDPOINT and AZURE_FOUNDRY_BING_API_KEY.'
				};
			}

			const url = `${endpoint}?api-version=${API_VERSION}`;
			context.logger.info('search_bing called', { query: params.q });

			const input = params.q;

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'api-key': apiKey
					},
					body: JSON.stringify({ input })
				});

				if (!response.ok) {
					const errText = await response.text();
					context.logger.error('Responses API error', {
						status: response.status,
						body: errText
					});
					return { message: `Bing Search error: ${response.status} ${response.statusText}` };
				}

				const data: ResponsesApiResponse = await response.json();

				if (data.error) {
					context.logger.error('Responses API returned error', { error: data.error });
					return { message: `Bing Search error: ${data.error.message}` };
				}

				const outputMsg = data.output?.find(
					(o) => o.type === 'message' && o.role === 'assistant'
				);
				const textContent = outputMsg?.content?.find((c) => c.type === 'output_text');
				const responseText = textContent?.text;

				if (!responseText) {
					context.logger.warn('No text content in agent response', {
						outputCount: data.output?.length
					});
					return { message: 'Bing Search returned no content.' };
				}

				// Try to parse as structured JSON (sources + synthesized answer)
				// The agent may prefix the JSON with plain-text prose, so extract the
				// JSON object substring before parsing.
				try {
					const jsonStart = responseText.indexOf('{');
					const jsonEnd = responseText.lastIndexOf('}');
					const jsonStr =
						jsonStart !== -1 && jsonEnd > jsonStart
							? responseText.slice(jsonStart, jsonEnd + 1)
							: responseText;
					const parsed: AgentStructuredResponse = JSON.parse(jsonStr);

					if (parsed.errors?.length) {
						context.logger.warn('search_bing agent errors', { errors: parsed.errors });
					}

					const sources = parsed.sources?.length ? convertToSources(parsed.sources) : undefined;
					const content = parsed.summary ? stripHtml(parsed.summary) : undefined;

					const count = sources?.length ?? 0;
					const message = searchResultsFoundMsg(context.locale, count);

					context.logger.info('search_bing completed', {
						query: parsed.query ?? params.q,
						status: parsed.message,
						sourceCount: count
					});

					return { message, sources, content };
				} catch {
					// Plain-text response (agent did not return JSON)
					context.logger.info('search_bing completed (plain text)', {
						query: params.q,
						length: responseText.length
					});
					return {
						message: searchResultsFoundMsg(context.locale, 0),
						content: responseText
					};
				}
			} catch (error) {
				context.logger.error('Unexpected error calling Responses API', { err: error });
				return {
					message: `Bing Search error: ${error instanceof Error ? error.message : 'Unknown error'}`
				};
			}
		}
	});
}
