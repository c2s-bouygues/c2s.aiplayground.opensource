import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../src/types';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

interface FetchUrlParams {
	url: string;
	max_length?: number;
	start_index?: number;
	raw?: boolean;
}

interface FetchUrlResult {
	url: string;
	content: string;
	contentType: string;
	contentLength: number;
	startIndex: number;
	truncated: boolean;
	message: string;
}

function isHtmlContent(contentType: string, body: string): boolean {
	if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
		return true;
	}
	const trimmed = body.trimStart().toLowerCase();
	return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

function htmlToReadableMarkdown(html: string, url: string): string {
	const { document } = parseHTML(html);

	// Use Readability to extract the main content
	const reader = new Readability(document, { charThreshold: 0 });
	const article = reader.parse();

	const contentHtml = article?.content || html;

	const turndown = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
		bulletListMarker: '-'
	});

	let markdown = turndown.turndown(contentHtml);

	// Prepend title if available
	if (article?.title) {
		markdown = `# ${article.title}\n\n${markdown}`;
	}

	return markdown;
}

function applyPagination(
	content: string,
	startIndex: number,
	maxLength: number
): { text: string; truncated: boolean } {
	if (startIndex >= content.length) {
		return {
			text: `<error>start_index (${startIndex}) depasse la longueur du contenu (${content.length})</error>`,
			truncated: false
		};
	}

	const slice = content.slice(startIndex, startIndex + maxLength);
	const truncated = startIndex + maxLength < content.length;

	let text = slice;
	if (truncated) {
		const remaining = content.length - (startIndex + maxLength);
		text += `\n\n---\n*Contenu tronque. ${remaining} caracteres restants. Utilisez start_index=${startIndex + maxLength} pour la suite.*`;
	}

	return { text, truncated };
}

export function createFetchUrlTool(context: PluginContext): AnyTool {
	const defaultMaxLength = (context.pluginConfig.maxLength as number) || 5000;
	const userAgent =
		(context.pluginConfig.userAgent as string) || 'Mozilla/5.0 (compatible; PluginFetch/1.0)';

	return tool({
		description:
			"Recupere le contenu d'une URL et le convertit en markdown lisible. Supporte la pagination pour les contenus longs.",
		inputSchema: jsonSchema<FetchUrlParams>({
			type: 'object',
			properties: {
				url: {
					type: 'string',
					description: "L'URL a recuperer (ex: https://example.com)"
				},
				max_length: {
					type: 'number',
					description: `Nombre maximum de caracteres a retourner (defaut: ${defaultMaxLength})`
				},
				start_index: {
					type: 'number',
					description: 'Index de depart dans le contenu pour la pagination (defaut: 0)'
				},
				raw: {
					type: 'boolean',
					description: 'Si true, retourne le HTML brut sans conversion en markdown (defaut: false)'
				}
			},
			required: ['url']
		}),
		execute: async (params): Promise<FetchUrlResult> => {
			const { url, raw = false } = params;
			const maxLength = params.max_length ?? defaultMaxLength;
			const startIndex = params.start_index ?? 0;

			context.logger.info('Fetching URL', { url, maxLength, startIndex, raw });

			const response = await fetch(url, {
				headers: {
					'User-Agent': userAgent,
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
				},
				redirect: 'follow'
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
			}

			const contentType = response.headers.get('content-type') || 'text/plain';
			const body = await response.text();

			let content: string;
			if (isHtmlContent(contentType, body) && !raw) {
				content = htmlToReadableMarkdown(body, url);
			} else {
				content = body;
			}

			const fullLength = content.length;
			const { text, truncated } = applyPagination(content, startIndex, maxLength);

			return {
				url,
				content: text,
				contentType,
				contentLength: fullLength,
				startIndex,
				truncated,
				message: truncated
					? `Contenu recupere (${fullLength} caracteres, affichage ${startIndex}-${startIndex + maxLength})`
					: `Contenu recupere (${fullLength} caracteres)`
			};
		}
	});
}
