/**
 * Weather Plugin (Demo)
 *
 * A demonstration plugin that returns fake weather data.
 * Used to test the plugin system.
 */

import type { PluginExport, PluginToolDefinition } from '../../src/types';
import manifest from './manifest.json';
import { createGetWeatherTool } from './tools/get-weather';

const tools: PluginToolDefinition[] = [
	{
		id: 'get_weather',
		createTool: (ctx) => createGetWeatherTool(ctx),
		// This plugin is always available (no required env vars)
		isAvailable: () => true
	}
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,

	async onLoad() {
		console.log('[weather] Demo weather plugin loaded');
	},

	validateConfig(config) {
		if (config.units && !['celsius', 'fahrenheit'].includes(config.units as string)) {
			return 'units doit etre "celsius" ou "fahrenheit"';
		}
		return true;
	}
};

export default plugin;
