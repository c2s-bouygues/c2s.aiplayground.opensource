/**
 * Bing Web Search Plugin
 *
 * Calls an Azure AI Foundry agent pre-configured with Bing grounding to search the web.
 *
 * Required environment variables:
 *   AZURE_FOUNDRY_BING_ENDPOINT    - Full Responses API URL for the application
 *                                    e.g. https://aif-xxx.services.ai.azure.com/api/projects/proj-xxx/applications/Agent-Bing-Search/protocols/openai/responses
 *   AZURE_FOUNDRY_BING_API_KEY     - API key for the Azure AI Foundry project
 * Optional:
 *   AZURE_FOUNDRY_BING_MODEL       - Model deployment name (include if required by the endpoint)
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createSearchBingTool } from './tools/search-bing';

const tools: PluginToolDefinition[] = [
	{
		id: 'search_bing',
		createTool: (ctx) => createSearchBingTool(ctx),
		isAvailable: (env) =>
			!!(env.AZURE_FOUNDRY_BING_ENDPOINT && env.AZURE_FOUNDRY_BING_API_KEY)
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[bing] Azure Foundry Bing Search plugin loaded');
	}
};

export default plugin;
