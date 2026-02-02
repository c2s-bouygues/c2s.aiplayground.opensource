import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { executeTool } from '$lib/server/plugin-loader';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { pluginId, toolId, params, env, config } = body;

		if (!pluginId || !toolId) {
			return json({ error: 'pluginId and toolId are required' }, { status: 400 });
		}

		const result = await executeTool({
			pluginId,
			toolId,
			params: params || {},
			env: env || {},
			config: config || {}
		});

		return json({ success: true, result });
	} catch (error) {
		console.error('Error executing tool:', error);
		return json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
