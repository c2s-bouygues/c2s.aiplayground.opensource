/**
 * Staan Web Search Plugin
 *
 * AI-optimized web search via the Staan API (https://staan.ai), built on Qwant's
 * European search infrastructure. Returns ranked web results with semantically
 * scored content chunks and optional full page content for RAG pipelines.
 *
 * The API key is a plugin config parameter (admin UI), with the STAAN_API_KEY
 * environment variable as a fallback.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createSearchStaanTool } from './tools/search-staan';

const ALLOWED_MARKETS = ['fr-fr', 'en-us', 'de-de'];

const tools: PluginToolDefinition[] = [
	{
		id: 'search',
		createTool: (ctx) => createSearchStaanTool(ctx)
		// No isAvailable: the API key can come from the plugin config (admin UI),
		// which isAvailable(env) cannot see; the tool reports a clear
		// not-configured message at runtime instead.
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[staan] Staan Web Search plugin loaded');
	},

	validateConfig(config) {
		if (config.minScore !== undefined) {
			const minScore = config.minScore as number;
			if (minScore < 0 || minScore > 1) {
				return 'minScore doit etre entre 0 et 1';
			}
		}
		if (config.maxSnippets !== undefined) {
			const maxSnippets = config.maxSnippets as number;
			if (maxSnippets < 1 || maxSnippets > 10) {
				return 'maxSnippets doit etre entre 1 et 10';
			}
		}
		if (config.defaultMarket !== undefined && config.defaultMarket !== '') {
			if (!ALLOWED_MARKETS.includes(config.defaultMarket as string)) {
				return `defaultMarket doit etre l'un de: ${ALLOWED_MARKETS.join(', ')}`;
			}
		}
		return true;
	}
};

export default plugin;
