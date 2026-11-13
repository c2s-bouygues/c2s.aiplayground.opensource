import { jsonSchema, tool } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { readJson, runTool } from './api';
import { requireUuid, toSafeCall, type ApiCall, type IdParams } from './shared';

export function createGetCallDetailsTool(context: PluginContext): AnyTool {
	return tool({
		description: 'Lit les informations principales, le resume et les categories d un appel Volubile. Lecture seule.',
		inputSchema: jsonSchema<IdParams>({
			type: 'object',
			properties: { id: { type: 'string', format: 'uuid', description: 'Identifiant de l appel.' } },
			required: ['id']
		}),
		execute: async (params) =>
			runTool(context, 'get_call_details', async () => {
				const call = await readJson<ApiCall>(context, `/v1/calls/${requireUuid(params.id)}`);
				return toSafeCall(call);
			})
	});
}
