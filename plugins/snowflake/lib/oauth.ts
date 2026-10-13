/**
 * Snowflake OAuth 2.0 (authorization-code grant, confidential client).
 *
 * Per-account OAuth: a single Snowflake security integration's credentials
 * sit at the top level of the plugin config and apply to every MCP server
 * listed in `config.servers[]`. There is no env-var fallback — credentials
 * are pure config so multiple plugin instances (different Snowflake accounts)
 * could in principle coexist on the same host.
 *
 * Per RFC 6749 §2.3.1 we send client_id/client_secret in the form body.
 * Snowflake's token endpoint accepts that for CUSTOM CONFIDENTIAL clients
 * (verified empirically — body-credentials work).
 */

import type { ToolConfigValues, PluginOAuthHandlers } from '../../../src/types';

const DEFAULT_SCOPE = 'session:role-any refresh_token';

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

export function resolveBaseUrl(config: ToolConfigValues): string {
	const raw = (config?.snowflakeBaseUrl as string | undefined)?.trim();
	if (!raw) {
		throw new Error('Snowflake plugin: "snowflakeBaseUrl" config is required');
	}
	if (!/^https?:\/\//i.test(raw)) {
		throw new Error('Snowflake plugin: "snowflakeBaseUrl" must start with http:// or https://');
	}
	return trimTrailingSlash(raw);
}

function resolveAuthorizeUrl(config: ToolConfigValues): string {
	const override = (config?.oauthAuthorizeUrl as string | undefined)?.trim();
	if (override) return override;
	return `${resolveBaseUrl(config)}/oauth/authorize`;
}

function resolveTokenUrl(config: ToolConfigValues): string {
	const override = (config?.oauthTokenUrl as string | undefined)?.trim();
	if (override) return override;
	return `${resolveBaseUrl(config)}/oauth/token-request`;
}

function resolveScope(config: ToolConfigValues): string {
	const raw = (config?.oauthScope as string | undefined)?.trim();
	return raw && raw.length > 0 ? raw : DEFAULT_SCOPE;
}

function resolveCredentials(config: ToolConfigValues): {
	clientId: string;
	clientSecret: string;
} {
	const clientId = (config?.oauthClientId as string | undefined)?.trim();
	const clientSecret = (config?.oauthClientSecret as string | undefined)?.trim();
	if (!clientId || !clientSecret) {
		throw new Error(
			'Snowflake OAuth not configured: provide oauthClientId and oauthClientSecret in the plugin config (admin UI).'
		);
	}
	return { clientId, clientSecret };
}

interface SnowflakeTokenClaims {
	sub?: string;
	username?: string;
	role?: string;
	account?: string;
}

function decodeJwtClaims(token: string | undefined): SnowflakeTokenClaims {
	if (!token) return {};
	const parts = token.split('.');
	if (parts.length < 2) return {};
	try {
		const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
		const json = Buffer.from(padded, 'base64').toString('utf8');
		return JSON.parse(json) as SnowflakeTokenClaims;
	} catch {
		return {};
	}
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	username?: string;
	token_type?: string;
}

async function postTokenForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Snowflake token endpoint error (${res.status}): ${text}`);
	}
	return (await res.json()) as TokenResponse;
}

export const snowflakeOAuthHandlers: PluginOAuthHandlers = {
	buildAuthUrl: ({ redirectUri, state, config }) => {
		const { clientId } = resolveCredentials(config);
		const params = new URLSearchParams({
			client_id: clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: resolveScope(config),
			state
		});
		return `${resolveAuthorizeUrl(config)}?${params.toString()}`;
	},

	exchangeCode: async ({ code, redirectUri, config }) => {
		const { clientId, clientSecret } = resolveCredentials(config);
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			client_secret: clientSecret
		});
		const tokens = await postTokenForm(resolveTokenUrl(config), body);
		const claims = decodeJwtClaims(tokens.access_token);
		const username = tokens.username || claims.username || claims.sub || null;
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresIn: tokens.expires_in,
			scope: tokens.scope,
			metadata: {
				username,
				role: claims.role ?? null,
				account: claims.account ?? null,
				snowflakeBaseUrl: resolveBaseUrl(config)
			}
		};
	},

	refresh: async ({ refreshToken, config }) => {
		const { clientId, clientSecret } = resolveCredentials(config);
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret
		});
		const tokens = await postTokenForm(resolveTokenUrl(config), body);
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresIn: tokens.expires_in,
			scope: tokens.scope
		};
	}
};

export interface SnowflakeServerConfig {
	id: string;
	name: string;
	mcpServerPath: string;
	enabled?: boolean;
	timeoutSeconds?: number;
}

export function getServers(config: ToolConfigValues): SnowflakeServerConfig[] {
	const raw = config?.servers;
	if (!Array.isArray(raw)) return [];
	return raw as SnowflakeServerConfig[];
}

export function getEnabledServers(config: ToolConfigValues): SnowflakeServerConfig[] {
	return getServers(config).filter((s) => s.enabled !== false);
}

export function findServer(config: ToolConfigValues, serverId: string): SnowflakeServerConfig {
	const server = getServers(config).find((s) => s.id === serverId);
	if (!server) {
		const available = getServers(config)
			.map((s) => s.id)
			.join(', ');
		throw new Error(
			`Snowflake plugin: server "${serverId}" not found. Available servers: ${available || '(none)'}`
		);
	}
	if (server.enabled === false) {
		throw new Error(`Snowflake plugin: server "${serverId}" is disabled.`);
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
