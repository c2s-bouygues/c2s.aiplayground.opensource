/**
 * Runtime resolution + runTool wrapper for the Snowflake plugin.
 *
 * Mirrors the pattern used by the azure_devops plugin
 * (c2s.aiplayground/Chatbot.SvelteKit/internal-plugins/plugins/azure_devops/lib/shared.ts):
 * every tool's execute body is wrapped so any thrown error becomes a structured
 * { success: false, message } payload instead of bubbling up to the host.
 */

import type { PluginContext, ToolConfigValues } from '../../../src/types';
import { resolveMcpUrl } from './oauth';

export interface SnowflakeRuntime {
	token: string;
	mcpUrl: string;
	config: ToolConfigValues;
}

const NOT_CONNECTED_MSG_FR =
	'Snowflake non connecté. Clique sur « Connecter » dans la catégorie Snowflake du sélecteur d\'outils.';
const NOT_CONNECTED_MSG_EN =
	'Snowflake not connected. Click "Connect" in the Snowflake category of the tool selector.';

export class SnowflakeNotConnectedError extends Error {
	constructor(locale: string | undefined) {
		super(locale === 'en' ? NOT_CONNECTED_MSG_EN : NOT_CONNECTED_MSG_FR);
		this.name = 'SnowflakeNotConnectedError';
	}
}

export async function getSnowflakeRuntime(ctx: PluginContext): Promise<SnowflakeRuntime> {
	const token = await ctx.tokens.get();
	if (!token?.accessToken) {
		throw new SnowflakeNotConnectedError(ctx.locale);
	}
	return {
		token: token.accessToken,
		mcpUrl: resolveMcpUrl(ctx.pluginConfig),
		config: ctx.pluginConfig
	};
}

export async function runTool<T>(
	ctx: PluginContext,
	fn: (runtime: SnowflakeRuntime) => Promise<T>
): Promise<T | { success: false; message: string }> {
	try {
		const runtime = await getSnowflakeRuntime(ctx);
		return await fn(runtime);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.logger.error('Snowflake tool failed', { message });
		return { success: false, message };
	}
}
