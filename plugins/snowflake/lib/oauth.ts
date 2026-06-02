/**
 * Snowflake OAuth 2.0 (authorization-code grant, confidential client).
 *
 * Snowflake's managed MCP server requires per-user OAuth tokens. The
 * authorize / token endpoints default to the account URL but stay
 * overridable via plugin config so non-account-level OAuth integrations
 * (e.g. external Snowflake OAuth) can also be wired in.
 *
 * Mirrors the shape of the azure_devops plugin's oauth.ts in
 * c2s.aiplayground/Chatbot.SvelteKit/internal-plugins/plugins/azure_devops/lib/oauth.ts.
 */

import type { ToolConfigValues, PluginOAuthHandlers } from '../../../src/types';

const DEFAULT_SCOPE = 'session:role-any refresh_token';

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

function resolveBaseUrl(config: ToolConfigValues): string {
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

function resolveCredentials(
	config: ToolConfigValues,
	env: Record<string, string | undefined>
): { clientId: string; clientSecret: string } {
	const clientId =
		(config?.oauthClientId as string | undefined)?.trim() || env.SNOWFLAKE_OAUTH_CLIENT_ID;
	const clientSecret =
		(config?.oauthClientSecret as string | undefined)?.trim() ||
		env.SNOWFLAKE_OAUTH_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error(
			'Snowflake OAuth not configured: provide oauthClientId/oauthClientSecret in config or SNOWFLAKE_OAUTH_CLIENT_ID/SNOWFLAKE_OAUTH_CLIENT_SECRET env vars'
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
	buildAuthUrl: ({ redirectUri, state, config, env }) => {
		const { clientId } = resolveCredentials(config, env);
		const params = new URLSearchParams({
			client_id: clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: resolveScope(config),
			state
		});
		return `${resolveAuthorizeUrl(config)}?${params.toString()}`;
	},

	exchangeCode: async ({ code, redirectUri, config, env }) => {
		const { clientId, clientSecret } = resolveCredentials(config, env);
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

	refresh: async ({ refreshToken, config, env }) => {
		const { clientId, clientSecret } = resolveCredentials(config, env);
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

export function resolveMcpServerPath(config: ToolConfigValues): string {
	const raw = (config?.mcpServerPath as string | undefined)?.trim();
	if (!raw) {
		throw new Error('Snowflake plugin: "mcpServerPath" config is required');
	}
	return raw.startsWith('/') ? raw : `/${raw}`;
}

export function resolveMcpUrl(config: ToolConfigValues): string {
	return `${resolveBaseUrl(config)}${resolveMcpServerPath(config)}`;
}

export function resolveTimeoutMs(config: ToolConfigValues): number {
	const seconds = Number(config?.timeoutSeconds);
	if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
	return Math.round(seconds * 1000);
}
