/**
 * Keyword search inside a stored OCR result (`ocr_search_text`).
 *
 * Literal, case- and accent-insensitive search (length-preserving fold — see
 * `foldText` in lib/result-store.ts, so the returned `char_offset` values are
 * valid positions in the original markdown and can be fed straight into
 * ocr_read_text's `offset`).
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale } from '../../../src/types';
import { foldText, loadMarkdown } from '../lib/result-store';

const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 50;
const DEFAULT_CONTEXT_CHARS = 200;
const MAX_CONTEXT_CHARS = 500;
/** Counting stops here — enough to say "many more". */
const COUNT_CAP = 1_000;

const MSG_RESULTS: Record<Locale, string> = {
	fr: '{shown} occurrence(s) de « {query} » affichée(s) sur {total} dans le document {docId} ({totalChars} caractères). Utilise ocr_read_text avec offset=<char_offset> pour lire autour d’une occurrence.',
	en: '{shown} occurrence(s) of "{query}" shown out of {total} in document {docId} ({totalChars} characters). Use ocr_read_text with offset=<char_offset> to read around an occurrence.',
	es: '{shown} aparición(es) de «{query}» mostrada(s) de {total} en el documento {docId} ({totalChars} caracteres). Usa ocr_read_text con offset=<char_offset> para leer alrededor de una aparición.',
	zh: '在文档 {docId}（{totalChars} 个字符）中共找到 {total} 处“{query}”，显示 {shown} 处。使用 ocr_read_text 并设置 offset=<char_offset> 可阅读某处上下文。',
	de: '{shown} Vorkommen von „{query}“ angezeigt von {total} im Dokument {docId} ({totalChars} Zeichen). Nutze ocr_read_text mit offset=<char_offset>, um den Kontext eines Vorkommens zu lesen.'
};

const MSG_NO_MATCH: Record<Locale, string> = {
	fr: 'Aucune occurrence de « {query} » dans le document {docId} (recherche insensible à la casse et aux accents). Essaie un terme plus court ou une variante.',
	en: 'No occurrence of "{query}" in document {docId} (case- and accent-insensitive search). Try a shorter term or a variant.',
	es: 'Ninguna aparición de «{query}» en el documento {docId} (búsqueda insensible a mayúsculas y acentos). Prueba un término más corto o una variante.',
	zh: '文档 {docId} 中未找到“{query}”（搜索不区分大小写和重音）。请尝试更短的词或其变体。',
	de: 'Kein Vorkommen von „{query}“ im Dokument {docId} (Groß-/Kleinschreibung und Akzente werden ignoriert). Versuche einen kürzeren Begriff oder eine Variante.'
};

const MSG_NOT_FOUND: Record<Locale, string> = {
	fr: "Erreur: document OCR introuvable ({doc}). Utilise le docId retourné par un appel ocr_extract de CETTE conversation ; relance ocr_extract si besoin.",
	en: 'Error: OCR document not found ({doc}). Use the docId returned by an ocr_extract call of THIS conversation; re-run ocr_extract if needed.',
	es: 'Error: documento OCR no encontrado ({doc}). Usa el docId devuelto por una llamada ocr_extract de ESTA conversación; vuelve a ejecutar ocr_extract si es necesario.',
	zh: '错误：找不到 OCR 文档（{doc}）。请使用本会话中 ocr_extract 调用返回的 docId；如有需要请重新运行 ocr_extract。',
	de: 'Fehler: OCR-Dokument nicht gefunden ({doc}). Verwende die docId aus einem ocr_extract-Aufruf DIESER Konversation; führe ocr_extract bei Bedarf erneut aus.'
};

const MSG_EMPTY_QUERY: Record<Locale, string> = {
	fr: 'Erreur: le paramètre query est vide.',
	en: 'Error: the query parameter is empty.',
	es: 'Error: el parámetro query está vacío.',
	zh: '错误：query 参数为空。',
	de: 'Fehler: Der Parameter query ist leer.'
};

function msg(
	map: Record<Locale, string>,
	locale: Locale | undefined,
	params?: Record<string, string | number>
): string {
	let template = map[locale ?? 'fr'] ?? map['fr'];
	for (const [key, value] of Object.entries(params ?? {})) {
		template = template.replaceAll(`{${key}}`, String(value));
	}
	return template;
}

interface SearchTextParams {
	doc: string;
	query: string;
	max_results?: number;
	context_chars?: number;
}

interface SearchMatch {
	char_offset: number;
	before: string;
	match: string;
	after: string;
}

export function createSearchTextTool(context: PluginContext): AnyTool {
	const { locale, logger } = context;

	return tool({
		description:
			"Recherche un terme dans le texte d'un document OCR déjà extrait (insensible à la casse et aux accents). Retourne les occurrences avec leur contexte et un char_offset utilisable par ocr_read_text. Paramètre doc: le docId retourné par ocr_extract.",
		inputSchema: jsonSchema<SearchTextParams>({
			type: 'object',
			properties: {
				doc: {
					type: 'string',
					description: "docId retourné par ocr_extract (ou URL /api/files/... du fichier .md)"
				},
				query: {
					type: 'string',
					description: 'Terme à rechercher (recherche littérale, pas une regex)'
				},
				max_results: {
					type: 'number',
					description: `Nombre maximal d'occurrences retournées (défaut: ${DEFAULT_MAX_RESULTS}, max: ${MAX_MAX_RESULTS})`
				},
				context_chars: {
					type: 'number',
					description: `Caractères de contexte avant/après chaque occurrence (défaut: ${DEFAULT_CONTEXT_CHARS}, max: ${MAX_CONTEXT_CHARS})`
				}
			},
			required: ['doc', 'query']
		}),
		execute: async (
			params
		): Promise<{ message: string; content?: string; data?: Record<string, unknown> }> => {
			const query = (params.query ?? '').trim();
			if (query === '') {
				return { message: msg(MSG_EMPTY_QUERY, locale) };
			}

			let text: string;
			let docId: string;
			try {
				({ docId, text } = await loadMarkdown(context.storage, params.doc));
			} catch (error) {
				logger.warn('ocr_search_text: document not found', {
					doc: params.doc,
					error: error instanceof Error ? error.message : String(error)
				});
				return { message: msg(MSG_NOT_FOUND, locale, { doc: params.doc }) };
			}

			const maxResults = Math.min(
				Math.max(Math.floor(params.max_results ?? DEFAULT_MAX_RESULTS), 1),
				MAX_MAX_RESULTS
			);
			const contextChars = Math.min(
				Math.max(Math.floor(params.context_chars ?? DEFAULT_CONTEXT_CHARS), 20),
				MAX_CONTEXT_CHARS
			);

			const haystack = foldText(text);
			const needle = foldText(query);

			const matches: SearchMatch[] = [];
			let total = 0;
			let from = 0;
			while (total < COUNT_CAP) {
				const idx = haystack.indexOf(needle, from);
				if (idx === -1) break;
				total++;
				if (matches.length < maxResults) {
					matches.push({
						char_offset: idx,
						before: text.slice(Math.max(0, idx - contextChars), idx),
						match: text.slice(idx, idx + needle.length),
						after: text.slice(idx + needle.length, idx + needle.length + contextChars)
					});
				}
				from = idx + needle.length;
			}

			if (total === 0) {
				return {
					message: msg(MSG_NO_MATCH, locale, { query, docId }),
					data: { docId, total_matches: 0, matches: [] }
				};
			}

			const totalLabel = total >= COUNT_CAP ? `${COUNT_CAP}+` : String(total);
			const lines = matches.map(
				(m) =>
					`- offset ${m.char_offset}: …${m.before.replace(/\s+/g, ' ')}【${m.match}】${m.after.replace(/\s+/g, ' ')}…`
			);

			// `message` is the ONLY field the host UI renders in the tool step — keep it
			// to the summary line. The occurrence list goes in `content` (model-only via
			// toModelOutput; replayed with the serialized output on later turns).
			return {
				message: msg(MSG_RESULTS, locale, {
					shown: matches.length,
					total: totalLabel,
					query,
					docId,
					totalChars: text.length
				}),
				content: lines.join('\n'),
				data: { docId, total_matches: total, matches }
			};
		},
		toModelOutput: ({ output }) => {
			const o = output as { message: string; content?: string };
			return {
				type: 'text' as const,
				value: o.content ? `${o.message}\n\n${o.content}` : o.message
			};
		}
	});
}
