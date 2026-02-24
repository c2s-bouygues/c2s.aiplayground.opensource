/**
 * Fetch Plugin
 *
 * Fetches URL content and converts HTML to readable markdown.
 * Inspired by the official MCP fetch server.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createFetchUrlTool } from './tools/fetch-url';

const tools: PluginToolDefinition[] = [
	{
		id: 'fetch_url',
		createTool: (ctx) => createFetchUrlTool(ctx),
		isAvailable: () => true
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[fetch] Fetch URL plugin loaded');
	},

	validateConfig(config) {
		if (config.maxLength !== undefined) {
			const maxLength = config.maxLength as number;
			if (maxLength < 100 || maxLength > 100000) {
				return 'maxLength doit etre entre 100 et 100000';
			}
		}
		return true;
	}
};

export default plugin;
