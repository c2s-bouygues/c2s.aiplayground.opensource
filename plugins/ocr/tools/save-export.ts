/**
 * Panel export feed (`ocr_save_export`) — NOT meant for the LLM.
 *
 * The extraction viewer builds its CSV client-side (extracted values + manual
 * corrections), but the sandboxed app iframe has no `allow-downloads`: a
 * blob/anchor download is silently ignored. Same workaround as the host's
 * bento deck download: the panel calls this tool through the MCP Apps bridge,
 * the CSV is persisted in the plugin's conversation storage, and the panel
 * hands the returned /api/files URL to `app.openLink` so the HOST opens it
 * outside the sandbox (session-gated download, like the stored markdown).
 *
 * The tool must be a regular registered tool for the bridge to build it, so
 * the LLM can technically call it: `toModelOutput` collapses the output to a
 * one-line text, and the system prompt instructions say to never call it.
 */

import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../src/types';
import { resolveDocId } from '../lib/result-store';

/** Exports are small tabular text — anything bigger than this is not a CSV of ours. */
const MAX_CSV_BYTES = 2 * 1024 * 1024;

/** Strip anything path-like or exotic; always end up with a safe `<base>.csv`. */
export function sanitizeExportFileName(name: unknown): string {
	const raw = typeof name === 'string' ? name : '';
	const base = raw
		.split(/[\\/]/)
		.pop()!
		.replace(/\.csv$/i, '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._-]+|[._-]+$/g, '')
		.slice(0, 80);
	return (base || 'extraction') + '.csv';
}

interface SaveExportParams {
	csv: string;
	file_name?: string;
	/** docId of the extraction the export belongs to — keys the stored file. */
	doc?: string;
}

export function createSaveExportTool(context: PluginContext): AnyTool {
	const { logger } = context;

	return tool({
		description:
			'Outil interne du panneau d’extraction (enregistrement de l’export CSV pour téléchargement). Ne pas appeler depuis la conversation.',
		inputSchema: jsonSchema<SaveExportParams>({
			type: 'object',
			properties: {
				csv: {
					type: 'string',
					description: 'Contenu CSV à enregistrer'
				},
				file_name: {
					type: 'string',
					description: 'Nom de fichier souhaité (assaini côté serveur, extension .csv imposée)'
				},
				doc: {
					type: 'string',
					description: 'docId de l’extraction concernée (optionnel)'
				}
			},
			required: ['csv']
		}),
		execute: async (
			params
		): Promise<{ message: string; data?: Record<string, unknown> }> => {
			const csv = typeof params.csv === 'string' ? params.csv : '';
			if (csv.trim() === '') {
				return { message: 'ocr_save_export: contenu CSV vide — rien à enregistrer.' };
			}
			const buffer = Buffer.from(csv, 'utf-8');
			if (buffer.length > MAX_CSV_BYTES) {
				return {
					message: `ocr_save_export: export trop volumineux (${buffer.length} octets, max ${MAX_CSV_BYTES}).`
				};
			}

			const fileName = sanitizeExportFileName(params.file_name);
			// Keyed by the extraction's docId when provided (stable re-export slot),
			// by a fresh id otherwise (extraction without a stored panel payload).
			const docId = (params.doc ? resolveDocId(params.doc) : null) ?? crypto.randomUUID();

			try {
				const url = await context.storage.uploadFile(
					`exports/${docId}.csv`,
					buffer,
					'text/csv; charset=utf-8'
				);
				logger.info('ocr_save_export: CSV stored', { docId, fileName, bytes: buffer.length });
				return {
					message: `ocr_save_export: export CSV enregistré (${buffer.length} octets) et servi au panneau. Cet outil est réservé au panneau.`,
					data: { url, fileName }
				};
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				logger.warn('ocr_save_export failed', { error: text });
				return { message: `ocr_save_export: échec de l'enregistrement: ${text}` };
			}
		},
		// Whatever happens, only the one-line message may reach the model.
		toModelOutput: ({ output }) => ({
			type: 'text' as const,
			value: (output as { message: string }).message
		})
	});
}
