/**
 * Runtime resolution + runTool wrapper for the Snowflake plugin.
 *
 * Every tool's execute body is wrapped so any thrown error becomes a
 * structured { success: false, message } payload instead of bubbling up.
 */

import type { PluginContext, ToolConfigValues } from '../../../src/types';
import { resolvePat, type SnowflakeServerConfig } from './oauth';

export type SnowflakeAuthType = 'oauth' | 'pat';

export interface SnowflakeAuth {
	token: string;
	authType: SnowflakeAuthType;
}

export interface SnowflakeRuntime extends SnowflakeAuth {
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

/**
 * Resolve the credentials for a server: its PAT when one is configured,
 * otherwise the calling user's OAuth token.
 */
export async function getSnowflakeRuntime(
	ctx: PluginContext,
	server: SnowflakeServerConfig
): Promise<SnowflakeRuntime> {
	const config = ctx.pluginConfig;
	const pat = resolvePat(config, server);
	if (pat) {
		return { token: pat, authType: 'pat', config };
	}
	const token = await ctx.tokens.get();
	if (!token?.accessToken) {
		throw new SnowflakeNotConnectedError(ctx.locale);
	}
	return {
		token: token.accessToken,
		authType: 'oauth',
		config
	};
}

export async function runTool<T>(
	ctx: PluginContext,
	server: SnowflakeServerConfig,
	fn: (runtime: SnowflakeRuntime) => Promise<T>
): Promise<T | { success: false; message: string }> {
	try {
		const runtime = await getSnowflakeRuntime(ctx, server);
		return await fn(runtime);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.logger.error('Snowflake tool failed', { message });
		return { success: false, message };
	}
}
