import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlugins, getToolInputSchema } from '$lib/server/plugin-loader';

export const GET: RequestHandler = async ({ url }) => {
	const pluginId = url.searchParams.get('pluginId');
	const toolId = url.searchParams.get('toolId');

	// If requesting schema for a specific tool
	if (pluginId && toolId) {
		const schema = getToolInputSchema(pluginId, toolId);
		return json({ schema });
	}

	// Return all plugins
	const plugins = getPlugins();
	return json({ plugins });
};
