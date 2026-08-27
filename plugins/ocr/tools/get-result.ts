/**
 * Panel data feed (`ocr_get_result`) — NOT meant for the LLM.
 *
 * The OCR viewer (ui://ocr/viewer) receives a SMALL structuredContent from
 * ocr_extract ({docId, counts…}) and fetches the full payload (pages, boxes,
 * crops, original document) itself by calling this tool through the MCP Apps
 * bridge (`/api/mcp-apps/bridge/{conversationId}/tools/call` — allowlisted to
 * `ocr_*` tools, response `data` → structuredContent). Bridge responses are
 * never persisted in the chat, so the heavy payload stays out of the prompt.
 *
 * The tool must be a regular registered tool for the bridge to build it, so
 * the LLM can technically call it: `toModelOutput` collapses the output to a
 * one-line text, and the system prompt instructions say to never call it.
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../src/types';
import { loadResult } from '../lib/result-store';

interface GetResultParams {
	doc: string;
	include_document?: boolean;
}

export function createGetResultTool(context: PluginContext): AnyTool {
	const { logger } = context;

	return tool({
		description:
			'Outil interne du panneau OCR (récupération du payload complet pour l’affichage). Ne pas appeler depuis la conversation — utiliser ocr_read_text / ocr_search_text à la place.',
		inputSchema: jsonSchema<GetResultParams>({
			type: 'object',
			properties: {
				doc: {
					type: 'string',
					description: 'docId retourné par ocr_extract'
				},
				include_document: {
					type: 'boolean',
					description: 'true pour inclure le document original (data URI) dans la réponse'
				}
			},
			required: ['doc']
		}),
		execute: async (
			params
		): Promise<{ message: string; data?: Record<string, unknown> }> => {
			try {
				const { docId, payload } = await loadResult(context.storage, params.doc);
				const { document, ...rest } = payload;
				return {
					message: `ocr_get_result: payload du document ${docId} servi au panneau (${payload.pages.length} page(s)). Cet outil est réservé au panneau — utilise ocr_read_text / ocr_search_text.`,
					data: {
						docId,
						...rest,
						...(params.include_document === true && document ? { document } : {})
					}
				};
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				logger.warn('ocr_get_result failed', { doc: params.doc, error: text });
				return { message: `ocr_get_result: document introuvable (${params.doc}): ${text}` };
			}
		},
		// Whatever happens, only the one-line message may reach the model — the
		// payload (with base64 crops/document) would blow up the prompt.
		toModelOutput: ({ output }) => ({
			type: 'text' as const,
			value: (output as { message: string }).message
		})
	});
}
