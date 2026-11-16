import { jsonSchema, tool } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { readJson, runTool } from './api';
import { requireUuid, type IdParams } from './shared';

export function createGetCampaignDetailsTool(context: PluginContext): AnyTool {
	return tool({
		description: 'Lit le nom, le statut et les parametres d une campagne Volubile connue. Ne change pas son statut.',
		inputSchema: jsonSchema<IdParams>({
			type: 'object',
			properties: { id: { type: 'string', format: 'uuid', description: 'Identifiant de la campagne.' } },
			required: ['id']
		}),
		execute: async (params) =>
			runTool(context, 'get_campaign_details', async () => {
				const campaign = await readJson<Record<string, unknown>>(
					context,
					`/v1/campaigns/${requireUuid(params.id)}`
				);
				return {
					id: campaign.id,
					name: campaign.name,
					agentId: campaign.agentId,
					startDate: campaign.startDate,
					days: campaign.days,
					timeSlots: campaign.timeSlots,
					batchSize: campaign.batchSize,
					status: campaign.status,
					timezone: campaign.timezone
				};
			})
	});
}
