import { jsonSchema, tool } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { readJson, runTool } from './api';
import { parsePage, toSafeAgent, type ApiAgent } from './shared';

interface ListAgentsParams {
	type?: 'INBOUND' | 'OUTBOUND';
	page?: number;
	size?: number;
}

export function createListAgentsTool(context: PluginContext): AnyTool {
	return tool({
		description: 'Liste les agents Volubile et leurs categories d appels configurees. Lecture seule.',
		inputSchema: jsonSchema<ListAgentsParams>({
			type: 'object',
			properties: {
				type: { type: 'string', enum: ['INBOUND', 'OUTBOUND'], description: 'Type d agent a filtrer.' },
				page: { type: 'integer', minimum: 1, description: 'Page a lire, a partir de 1.' },
				size: { type: 'integer', minimum: 1, maximum: 100, description: 'Nombre d agents, maximum 100.' }
			}
		}),
		execute: async (params) =>
			runTool(context, 'list_agents', async () => {
				const search = new URLSearchParams({
					fields: 'id,name,type,active,recordable,archived,created,configuration',
					page: String(params.page || 1),
					size: String(params.size || 50)
				});
				if (params.type) search.set('type', params.type);
				const page = parsePage<ApiAgent>(
					await readJson<unknown>(context, `/v1/agents?${search.toString()}`)
				);
				return { ...page, content: page.content.map(toSafeAgent) };
			})
	});
}
