/**
 * Paginated reading of a stored OCR result (`ocr_read_text`).
 *
 * Long documents are not inlined in the ocr_extract message: the full markdown
 * lives in the plugin's conversation storage (`results/<docId>.md`, see
 * lib/result-store.ts). This tool serves it back to the model in bounded
 * chunks addressed by character offset — the offsets returned by
 * ocr_search_text are directly usable here.
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool, Locale } from '../../../src/types';
import { loadMarkdown } from '../lib/result-store';

const DEFAULT_MAX_CHARS = 8_000;
const MAX_MAX_CHARS = 20_000;

const MSG_CHUNK: Record<Locale, string> = {
	fr: 'Extrait du document {docId} — caractères {start} à {end} sur {total}.',
	en: 'Excerpt of document {docId} — characters {start} to {end} of {total}.',
	es: 'Extracto del documento {docId} — caracteres {start} a {end} de {total}.',
	zh: '文档 {docId} 的摘录 — 第 {start} 至 {end} 个字符（共 {total} 个）。',
	de: 'Auszug aus Dokument {docId} — Zeichen {start} bis {end} von {total}.'
};

const MSG_NEXT: Record<Locale, string> = {
	fr: 'Suite disponible : rappelle ocr_read_text avec offset={next}.',
	en: 'More available: call ocr_read_text again with offset={next}.',
	es: 'Hay más: vuelve a llamar a ocr_read_text con offset={next}.',
	zh: '还有后续内容：请以 offset={next} 再次调用 ocr_read_text。',
	de: 'Weiterer Inhalt verfügbar: rufe ocr_read_text erneut mit offset={next} auf.'
};

const MSG_END: Record<Locale, string> = {
	fr: 'Fin du document.',
	en: 'End of document.',
	es: 'Fin del documento.',
	zh: '文档结束。',
	de: 'Ende des Dokuments.'
};

const MSG_NOT_FOUND: Record<Locale, string> = {
	fr: "Erreur: document OCR introuvable ({doc}). Utilise le docId (ou l'URL du fichier .md) retourné par un appel ocr_extract de CETTE conversation ; relance ocr_extract si besoin.",
	en: 'Error: OCR document not found ({doc}). Use the docId (or the .md file URL) returned by an ocr_extract call of THIS conversation; re-run ocr_extract if needed.',
	es: 'Error: documento OCR no encontrado ({doc}). Usa el docId (o la URL del archivo .md) devuelto por una llamada ocr_extract de ESTA conversación; vuelve a ejecutar ocr_extract si es necesario.',
	zh: '错误：找不到 OCR 文档（{doc}）。请使用本会话中 ocr_extract 调用返回的 docId（或 .md 文件 URL）；如有需要请重新运行 ocr_extract。',
	de: 'Fehler: OCR-Dokument nicht gefunden ({doc}). Verwende die docId (oder die .md-Datei-URL) aus einem ocr_extract-Aufruf DIESER Konversation; führe ocr_extract bei Bedarf erneut aus.'
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

interface ReadTextParams {
	doc: string;
	offset?: number;
	max_chars?: number;
}

export function createReadTextTool(context: PluginContext): AnyTool {
	const { locale, logger } = context;

	return tool({
		description:
			"Lit une tranche du texte d'un document OCR déjà extrait (lecture paginée). Paramètre doc: le docId retourné par ocr_extract. Les char_offset retournés par ocr_search_text sont utilisables comme offset.",
		inputSchema: jsonSchema<ReadTextParams>({
			type: 'object',
			properties: {
				doc: {
					type: 'string',
					description: "docId retourné par ocr_extract (ou URL /api/files/... du fichier .md)"
				},
				offset: {
					type: 'number',
					description: 'Position de départ en caractères (défaut: 0)'
				},
				max_chars: {
					type: 'number',
					description: `Taille maximale de la tranche (défaut: ${DEFAULT_MAX_CHARS}, max: ${MAX_MAX_CHARS})`
				}
			},
			required: ['doc']
		}),
		execute: async (
			params
		): Promise<{ message: string; data?: Record<string, unknown> }> => {
			let text: string;
			let docId: string;
			try {
				({ docId, text } = await loadMarkdown(context.storage, params.doc));
			} catch (error) {
				logger.warn('ocr_read_text: document not found', {
					doc: params.doc,
					error: error instanceof Error ? error.message : String(error)
				});
				return { message: msg(MSG_NOT_FOUND, locale, { doc: params.doc }) };
			}

			const total = text.length;
			const offset = Math.min(Math.max(Math.floor(params.offset ?? 0), 0), total);
			const maxChars = Math.min(
				Math.max(Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS), 200),
				MAX_MAX_CHARS
			);
			const end = Math.min(offset + maxChars, total);
			const nextOffset = end < total ? end : null;

			const header = msg(MSG_CHUNK, locale, { docId, start: offset, end, total });
			const footer = nextOffset !== null ? msg(MSG_NEXT, locale, { next: nextOffset }) : msg(MSG_END, locale);

			return {
				message: `${header}\n\n---\n${text.slice(offset, end)}\n---\n${footer}`,
				data: { docId, offset, next_offset: nextOffset, total_chars: total }
			};
		}
	});
}
