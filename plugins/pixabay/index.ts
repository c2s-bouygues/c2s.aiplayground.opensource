/**
 * Pixabay Image Search Plugin
 *
 * Search for royalty-free images on Pixabay and store them locally in MinIO.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createSearchPixabayTool } from './tools/search-images';

const tools: PluginToolDefinition[] = [
	{
		id: 'search_images',
		createTool: (ctx) => createSearchPixabayTool(ctx),
		isAvailable: (env) => !!env.PIXABAY_API_KEY
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[pixabay] Pixabay image search plugin loaded');
	},

	validateConfig(config) {
		if (config.defaultPerPage !== undefined) {
			const perPage = config.defaultPerPage as number;
			if (perPage < 3 || perPage > 20) {
				return 'defaultPerPage doit etre entre 3 et 20';
			}
		}
		return true;
	}
};

export default plugin;
