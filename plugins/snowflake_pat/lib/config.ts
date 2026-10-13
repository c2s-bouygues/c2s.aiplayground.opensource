/**
 * Config resolution for the Snowflake PAT plugin.
 *
 * A single Snowflake account (`snowflakeBaseUrl`) hosts every MCP server listed
 * in `config.servers[]`. Each server authenticates with a Programmatic Access
 * Token: its own `pat`, or the account-wide `snowflakePat`. There is no OAuth
 * and no env-var fallback — credentials are pure config.
 */

import type { ToolConfigValues } from '../../../src/types';

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

export function resolveBaseUrl(config: ToolConfigValues): string {
	const raw = (config?.snowflakeBaseUrl as string | undefined)?.trim();
	if (!raw) {
		throw new Error('Snowflake PAT plugin: "snowflakeBaseUrl" config is required');
	}
	if (!/^https?:\/\//i.test(raw)) {
		throw new Error('Snowflake PAT plugin: "snowflakeBaseUrl" must start with http:// or https://');
	}
	return trimTrailingSlash(raw);
}

export interface SnowflakeServerConfig {
	id: string;
	name: string;
	mcpServerPath: string;
	enabled?: boolean;
	timeoutSeconds?: number;
	/** Programmatic Access Token for this server. Overrides `snowflakePat`. */
	pat?: string;
}

export function getServers(config: ToolConfigValues): SnowflakeServerConfig[] {
	const raw = config?.servers;
	if (!Array.isArray(raw)) return [];
	return raw as SnowflakeServerConfig[];
}

export function getEnabledServers(config: ToolConfigValues): SnowflakeServerConfig[] {
	return getServers(config).filter((s) => s.enabled !== false);
}

/**
 * Resolve the Programmatic Access Token for a server: `servers[i].pat`, then the
 * account-wide `snowflakePat`. `undefined` means no PAT is configured.
 */
export function resolvePat(
	config: ToolConfigValues,
	server: SnowflakeServerConfig
): string | undefined {
	const own = typeof server.pat === 'string' ? server.pat.trim() : '';
	if (own) return own;
	const global = typeof config?.snowflakePat === 'string' ? config.snowflakePat.trim() : '';
	return global || undefined;
}

export function findServer(config: ToolConfigValues, serverId: string): SnowflakeServerConfig {
	const server = getServers(config).find((s) => s.id === serverId);
	if (!server) {
		const available = getServers(config)
			.map((s) => s.id)
			.join(', ');
		throw new Error(
			`Snowflake PAT plugin: server "${serverId}" not found. Available servers: ${available || '(none)'}`
		);
	}
	if (server.enabled === false) {
		throw new Error(`Snowflake PAT plugin: server "${serverId}" is disabled.`);
	}
	return server;
}

export function resolveMcpUrl(config: ToolConfigValues, serverId: string): string {
	const server = findServer(config, serverId);
	const path = server.mcpServerPath.startsWith('/')
		? server.mcpServerPath
		: `/${server.mcpServerPath}`;
	return `${resolveBaseUrl(config)}${path}`;
}

export function resolveTimeoutMs(config: ToolConfigValues, serverId: string): number {
	const server = findServer(config, serverId);
	const seconds = Number(server.timeoutSeconds);
	if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
	return Math.round(seconds * 1000);
}
