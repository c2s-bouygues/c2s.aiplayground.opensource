import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale, Source } from '../../../src/types';

interface SearchBingParams {
	q: string;
}

// Azure AI Foundry Responses API version
const API_VERSION = '2025-11-15-preview';

interface ResponsesApiOutput {
	type: string;
	role?: string;
	content?: Array<{ type: string; text?: string }>;
}

interface ResponsesApiResponse {
	output?: ResponsesApiOutput[];
	status?: string;
	error?: { message: string };
}

/** Structured response format returned by the Foundry agent */
interface AgentSource {
	id: string;
	title: string;
	url: string;
	content: string;
	date?: string;
}

interface AgentStructuredResponse {
	message: string;
	sources?: AgentSource[];
	summary?: string;
}

/** Structured result returned to the application */
interface SearchBingResult {
	message: string;
	sources?: Source[];
	content?: string;
}

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
		id: `bing-${src.id}-${encodeURIComponent(src.url)}`,
		content: stripHtml(src.content),
		metadata: {
			source: stripHtml(src.title),
			type: 'web',
			url: src.url,
			domain: extractDomain(src.url),
			age: src.date
		},
		similarity: 1 - index * (0.5 / Math.max(agentSources.length - 1, 1))
	}));
}

const SEARCH_RESULTS_FOUND: Record<Locale, string> = {
	fr: '{count} résultats trouvés.',
	en: '{count} results found.',
	es: '{count} resultados encontrados.',
	zh: '找到 {count} 个结果。'
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
			const model = context.env.AZURE_FOUNDRY_BING_MODEL;

			if (!endpoint || !apiKey) {
				return {
					message:
						'Bing Search is not configured. Please set AZURE_FOUNDRY_BING_ENDPOINT and AZURE_FOUNDRY_BING_API_KEY.'
				};
			}

			const url = `${endpoint}?api-version=${API_VERSION}`;
			context.logger.info('search_bing called', { query: params.q });

			const input = params.q;

			const requestBody: Record<string, unknown> = { input };
			if (model) requestBody.model = model;

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'api-key': apiKey
					},
					body: JSON.stringify(requestBody)
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
					const sources = parsed.sources?.length ? convertToSources(parsed.sources) : undefined;

					const contentParts: string[] = [];
					if (parsed.message) contentParts.push(stripHtml(parsed.message));
					if (parsed.summary) contentParts.push(stripHtml(parsed.summary));
					const content = contentParts.join('\n\n') || undefined;

					const count = sources?.length ?? 0;
					const message = searchResultsFoundMsg(context.locale, count);

					context.logger.info('search_bing completed', {
						query: params.q,
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
