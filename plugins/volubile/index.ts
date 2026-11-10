import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import {
	createGetCallDetailsTool,
	createGetCallKpisTool,
	createGetCallTranscriptTool,
	createGetCampaignDetailsTool,
	createListAgentsTool,
	createSearchCallsTool
} from './tools/read';

const tools: PluginToolDefinition[] = [
	{
		id: 'list_agents',
		createTool: (context) => createListAgentsTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	},
	{
		id: 'search_calls',
		createTool: (context) => createSearchCallsTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	},
	{
		id: 'get_call_details',
		createTool: (context) => createGetCallDetailsTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	},
	{
		id: 'get_call_transcript',
		createTool: (context) => createGetCallTranscriptTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	},
	{
		id: 'get_campaign_details',
		createTool: (context) => createGetCampaignDetailsTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	},
	{
		id: 'get_call_kpis',
		createTool: (context) => createGetCallKpisTool(context),
		isAvailable: (env) => !!env.VOLUBILE_API_KEY?.trim()
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[volubile] Read-only API plugin loaded');
	}
};

export default plugin;