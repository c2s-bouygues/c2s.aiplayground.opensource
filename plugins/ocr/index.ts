/**
 * OCR Plugin (demo)
 *
 * Two capabilities over files attached to the current conversation:
 *
 * 1. `extract` — raw text extraction (OCR) through an external OCR connector,
 *    displayed in the `ui://ocr/viewer` MCP App (SEP-1865). Connector:
 *    endpoint + API key from the plugin config, with OCR_ENDPOINT /
 *    OCR_API_KEY env vars as fallback; STUB mode when neither is set.
 *
 * 2. `extract_fields` — structured field extraction (port of
 *    IdeaStudio.MagicOcrV2): typed fields defined per call, per-field
 *    confidences, free-text coherence checks, optional double extraction with
 *    cross-validation, results in the `ui://ocr/extraction` MCP App with CSV
 *    export. LLM connector: llmApiKey/llmEndpoint/llmModel from the plugin
 *    config, with ANTHROPIC_API_KEY / AZURE_AI_* env vars as fallback; STUB
 *    mode when no key is available.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createExtractTool } from './tools/extract';
import { createExtractFieldsTool } from './tools/extract-fields';
import { createReadTextTool } from './tools/read-text';
import { createSearchTextTool } from './tools/search-text';
import { createGetResultTool } from './tools/get-result';
import { createSaveExportTool } from './tools/save-export';
import { OCR_VIEWER_RESOURCE_URI, renderOcrViewerTemplate } from './template';
import {
	EXTRACTION_VIEWER_RESOURCE_URI,
	renderExtractionViewerTemplate
} from './template-extraction';

const tools: PluginToolDefinition[] = [
	{
		id: 'extract',
		createTool: (ctx) => createExtractTool(ctx)
		// No isAvailable: the endpoint/key can come from the plugin config (admin
		// UI), which isAvailable(env) cannot see — and the stub mode must work
		// with no configuration at all.
	},
	{
		id: 'extract_fields',
		createTool: (ctx) => createExtractFieldsTool(ctx)
		// Same rationale: config-or-env connector, stub mode without any.
	},
	{
		// Long-document companions: extract stores the full markdown in the
		// plugin's conversation storage; these read it back in bounded slices.
		id: 'read_text',
		createTool: (ctx) => createReadTextTool(ctx)
	},
	{
		id: 'search_text',
		createTool: (ctx) => createSearchTextTool(ctx)
	},
	{
		// Panel data feed (bridge-only by convention): serves the full stored
		// payload (pages, boxes, document) to the ui://ocr/viewer iframe.
		id: 'get_result',
		createTool: (ctx) => createGetResultTool(ctx)
	},
	{
		// Panel export feed (bridge-only by convention): stores the extraction
		// panel's CSV so the host can download it via its /api/files URL (the
		// sandboxed iframe has no allow-downloads).
		id: 'save_export',
		createTool: (ctx) => createSaveExportTool(ctx)
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	appResources: [
		{
			uri: OCR_VIEWER_RESOURCE_URI,
			title: 'OCR result viewer',
			getHtml: renderOcrViewerTemplate,
			// The layout tab renders the real PDF pages with pdf.js loaded from
			// jsdelivr (script-src via resourceDomains); 'blob:' lets pdf.js spawn
			// its worker (worker-src falls back to script-src). Everything else
			// stays inline/host-origin.
			meta: {
				csp: {
					resourceDomains: ['https://cdn.jsdelivr.net', 'blob:']
				}
			}
		},
		{
			uri: EXTRACTION_VIEWER_RESOURCE_URI,
			title: 'Structured field extraction viewer',
			getHtml: renderExtractionViewerTemplate,
			// Same needs as the OCR viewer: the side-by-side document preview
			// renders PDF pages with pdf.js from jsdelivr ('blob:' for its worker).
			meta: {
				csp: {
					resourceDomains: ['https://cdn.jsdelivr.net', 'blob:']
				}
			}
		}
	],

	async onLoad() {
		console.log('[ocr] OCR plugin loaded');
	},

	validateConfig(config) {
		if (config.endpoint !== undefined && config.endpoint !== '') {
			const endpoint = String(config.endpoint);
			if (!/^https:\/\//i.test(endpoint)) {
				return "endpoint doit être une URL https://";
			}
		}
		if (config.llmEndpoint !== undefined && config.llmEndpoint !== '') {
			const llmEndpoint = String(config.llmEndpoint);
			if (!/^https:\/\//i.test(llmEndpoint)) {
				return "llmEndpoint doit être une URL https://";
			}
		}
		return true;
	}
};

export default plugin;
