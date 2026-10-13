/**
 * Runtime resolution + runTool wrapper for the Snowflake PAT plugin.
 *
 * Every tool's execute body is wrapped so any thrown error becomes a
 * structured { success: false, message } payload instead of bubbling up.
 */

import type { PluginContext, ToolConfigValues } from '../../../src/types';
import { resolvePat, type SnowflakeServerConfig } from './config';

export interface SnowflakeRuntime {
	pat: string;
	config: ToolConfigValues;
}

/** Resolve the PAT of a server; throws when none is configured. */
export function getSnowflakeRuntime(
	ctx: PluginContext,
	server: SnowflakeServerConfig
): SnowflakeRuntime {
	const config = ctx.pluginConfig;
	const pat = resolvePat(config, server);
	if (!pat) {
		throw new Error(
			`Snowflake PAT plugin: no PAT configured for server "${server.id}" (set servers[].pat or snowflakePat).`
		);
	}
	return { pat, config };
}

export async function runTool<T>(
	ctx: PluginContext,
	server: SnowflakeServerConfig,
	fn: (runtime: SnowflakeRuntime) => Promise<T>
): Promise<T | { success: false; message: string }> {
	try {
		return await fn(getSnowflakeRuntime(ctx, server));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.logger.error('Snowflake PAT tool failed', { message });
		return { success: false, message };
	}
}
