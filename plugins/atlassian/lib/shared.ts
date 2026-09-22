/**
 * Runtime resolution + runTool wrapper for the Atlassian plugin.
 *
 * Resolves the Authorization header to use for MCP calls depending on the
 * configured auth mode (per-user OAuth token vs shared API token), and wraps
 * every tool body so thrown errors become a structured { success: false } payload.
 */

import type { PluginContext, PluginTokensAPI, ToolConfigValues } from '../../../src/types';
import { resolveApiTokenAuthHeader, resolveAuthMode } from './config';

export interface AtlassianRuntime {
	authHeader: string;
	config: ToolConfigValues;
}

const NOT_CONNECTED_MSG_FR =
	"Atlassian non connecté. Clique sur « Connecter » dans la catégorie Atlassian du sélecteur d'outils.";
const NOT_CONNECTED_MSG_EN =
	'Atlassian not connected. Click "Connect" in the Atlassian category of the tool selector.';

export class AtlassianNotConnectedError extends Error {
	constructor(locale: string | undefined) {
		super(locale === 'en' ? NOT_CONNECTED_MSG_EN : NOT_CONNECTED_MSG_FR);
		this.name = 'AtlassianNotConnectedError';
	}
}

/**
 * Resolve the Authorization header for a given config/env and (optional) token store.
 * Shared by discovery (admin token) and execution (chat user's token).
 */
export async function resolveAuthHeader(
	config: ToolConfigValues,
	env: Record<string, string | undefined>,
	tokens: PluginTokensAPI | undefined,
	locale?: string
): Promise<string> {
	if (resolveAuthMode(config) === 'api_token') {
		return resolveApiTokenAuthHeader(config, env);
	}
	const token = await tokens?.get();
	if (!token?.accessToken) {
		throw new AtlassianNotConnectedError(locale);
	}
	return `Bearer ${token.accessToken}`;
}

export async function getAtlassianRuntime(ctx: PluginContext): Promise<AtlassianRuntime> {
	const authHeader = await resolveAuthHeader(ctx.pluginConfig, ctx.env, ctx.tokens, ctx.locale);
	return { authHeader, config: ctx.pluginConfig };
}

export async function runTool<T>(
	ctx: PluginContext,
	fn: (runtime: AtlassianRuntime) => Promise<T>
): Promise<T | { success: false; message: string }> {
	try {
		const runtime = await getAtlassianRuntime(ctx);
		return await fn(runtime);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.logger.error('Atlassian tool failed', { message });
		return { success: false, message };
	}
}
