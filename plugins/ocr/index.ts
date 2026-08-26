/**
 * OCR Plugin (demo)
 *
 * Extracts text from files attached to the current conversation (scanned PDFs,
 * document images) through an external OCR connector, and displays the result
 * in a SEP-1865 MCP App panel (`ui://ocr/viewer`) — this plugin doubles as the
 * MCP Apps demo for the external plugin repo.
 *
 * Connector: endpoint + API key from the plugin config (admin UI), with
 * OCR_ENDPOINT / OCR_API_KEY environment variables as fallback. When neither is
 * set the tool runs in STUB mode (placeholder text) so the full chain —
 * conversation-file download, tool result shape, MCP App viewer — works
 * without a real backend. The real branch is a thin wrapper meant to be
 * swapped for the actual Mistral-OCR-on-Azure contract.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createExtractTool } from './tools/extract';
import { OCR_VIEWER_RESOURCE_URI, renderOcrViewerTemplate } from './template';

const tools: PluginToolDefinition[] = [
	{
		id: 'extract',
		createTool: (ctx) => createExtractTool(ctx)
		// No isAvailable: the endpoint/key can come from the plugin config (admin
		// UI), which isAvailable(env) cannot see — and the stub mode must work
		// with no configuration at all.
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	appResources: [
		{
			uri: OCR_VIEWER_RESOURCE_URI,
			title: 'OCR result viewer',
			getHtml: renderOcrViewerTemplate
			// Self-contained widget: the host's default CSP is enough (inline
			// script/style + host-origin SDK), no meta.csp declaration needed.
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
		return true;
	}
};

export default plugin;
