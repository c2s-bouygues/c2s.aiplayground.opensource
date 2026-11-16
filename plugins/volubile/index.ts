import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createGetCallDetailsTool } from './tools/get-call-details';
import { createGetCallKpisTool } from './tools/get-call-kpis';
import { createGetCallTranscriptTool } from './tools/get-call-transcript';
import { createGetCampaignDetailsTool } from './tools/get-campaign-details';
import { createListAgentsTool } from './tools/list-agents';
import { createSearchCallsTool } from './tools/search-calls';

// Pas de isAvailable: il ne voit que les variables d'environnement, pas la configuration admin
// ou se trouve la cle API. Si elle manque, l'outil le signale a l'appel.
const tools: PluginToolDefinition[] = [
	{
		id: 'list_agents',
		createTool: (context) => createListAgentsTool(context)
	},
	{
		id: 'search_calls',
		createTool: (context) => createSearchCallsTool(context)
	},
	{
		id: 'get_call_details',
		createTool: (context) => createGetCallDetailsTool(context)
	},
	{
		id: 'get_call_transcript',
		createTool: (context) => createGetCallTranscriptTool(context)
	},
	{
		id: 'get_campaign_details',
		createTool: (context) => createGetCampaignDetailsTool(context)
	},
	{
		id: 'get_call_kpis',
		createTool: (context) => createGetCallKpisTool(context)
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[volubile] Read-only API plugin loaded');
	},

	validateConfig(config) {
		const baseUrl = config?.apiBaseUrl;
		if (baseUrl !== undefined && baseUrl !== '') {
			if (typeof baseUrl !== 'string') return "apiBaseUrl doit etre une URL";
			try {
				if (new URL(baseUrl).protocol !== 'https:') return "apiBaseUrl doit commencer par https://";
			} catch {
				return `apiBaseUrl n'est pas une URL valide: "${baseUrl}"`;
			}
		}
		if (config?.apiKey !== undefined && typeof config.apiKey !== 'string') {
			return 'apiKey doit etre du texte';
		}
		return true;
	}
};

export default plugin;
