/**
 * Exa Search Plugin
 *
 * Neural/keyword web search via the Exa API (https://exa.ai/).
 *
 * Required environment variables:
 *   EXA_API_KEY - API key obtained from https://dashboard.exa.ai
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createSearchExaTool } from './tools/search-exa';

const tools: PluginToolDefinition[] = [
	{
		id: 'search_exa',
		createTool: (ctx) => createSearchExaTool(ctx),
		isAvailable: (env) => !!env.EXA_API_KEY
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[exa] Exa Search plugin loaded');
	}
};

export default plugin;
