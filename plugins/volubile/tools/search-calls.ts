import { jsonSchema, tool } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { readJson, runTool } from './api';
import { parsePage, requireUuid, toSafeCall, validateDateRange, type ApiCall } from './shared';

const SEARCH_DEFAULT_SIZE = 20;

interface SearchCallsParams {
	from: string;
	to: string;
	agentId?: string;
	phone?: string;
	campaignName?: string;
	page?: number;
	size?: number;
}

export function createSearchCallsTool(context: PluginContext): AnyTool {
	return tool({
		description: 'Recherche des exemples d appels Volubile entre deux dates. Les numeros et variables de contexte ne sont pas renvoyes. Pour compter, totaliser des durees ou calculer un taux, utiliser get_call_kpis.',
		inputSchema: jsonSchema<SearchCallsParams>({
			type: 'object',
			properties: {
				from: { type: 'string', format: 'date', description: 'Date de debut incluse, au format AAAA-MM-JJ.' },
				to: { type: 'string', format: 'date', description: 'Date de fin incluse, au format AAAA-MM-JJ.' },
				agentId: { type: 'string', format: 'uuid', description: 'Identifiant d un agent, si un filtre est souhaite.' },
				phone: { type: 'string', description: 'Filtre par numero E.164. Le numero ne sera pas renvoye dans les resultats.' },
				campaignName: { type: 'string', description: 'Filtre par nom de campagne.' },
				page: { type: 'integer', minimum: 1, description: 'Page a lire, a partir de 1.' },
				size: { type: 'integer', minimum: 1, maximum: 100, description: 'Nombre d appels, par defaut 20, maximum 100.' }
			},
			required: ['from', 'to']
		}),
		execute: async (params) =>
			runTool(context, 'search_calls', async () => {
				validateDateRange(params.from, params.to);
				const search = new URLSearchParams({
					from: params.from,
					to: params.to,
					page: String(params.page || 1),
					size: String(params.size || SEARCH_DEFAULT_SIZE)
				});
				if (params.agentId) search.set('agentId', requireUuid(params.agentId));
				if (params.phone) search.set('phone', params.phone);
				if (params.campaignName) search.set('campaignName', params.campaignName);
				const page = parsePage<ApiCall>(
					await readJson<unknown>(context, `/v1/calls?${search.toString()}`)
				);
				return { ...page, content: page.content.map(toSafeCall) };
			})
	});
}
