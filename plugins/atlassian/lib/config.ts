/**
 * Config resolution for the Atlassian MCP plugin.
 *
 * Everything lives in the plugin config (admin UI). The only env fallbacks are
 * ATLASSIAN_API_TOKEN / ATLASSIAN_API_TOKEN_EMAIL for the headless mode, so the
 * playground can be exercised without the admin UI.
 */

import type { ToolConfigValues } from '../../../src/types';

export const DEFAULT_MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
// Authorization server advertised by https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp
// (issuer https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3). Tokens from the legacy
// mcp.atlassian.com "v1" server are NOT accepted by the v2 resource (401 invalid_token).
export const DEFAULT_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
export const DEFAULT_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const DEFAULT_REGISTRATION_URL = 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register';
export const DEFAULT_SCOPE =
	'offline_access read:me read:jira:agent-interface write:jira:agent-interface search:jira:agent-interface read:confluence:agent-interface write:confluence:agent-interface search:confluence:agent-interface search:rovo:agent-interface';

export type AuthMode = 'oauth' | 'api_token';

type Env = Record<string, string | undefined>;

function str(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveAuthMode(config: ToolConfigValues): AuthMode {
	return str(config?.authMode) === 'api_token' ? 'api_token' : 'oauth';
}

/** Final MCP URL, honouring the `?tools=all` override. */
export function resolveMcpUrl(config: ToolConfigValues): string {
	const raw = str(config?.mcpUrl) ?? DEFAULT_MCP_URL;
	const url = new URL(raw);
	const exposeAll = config?.exposeAllTools !== false;
	if (exposeAll) {
		url.searchParams.set('tools', 'all');
	} else {
		url.searchParams.delete('tools');
	}
	return url.toString();
}

/**
 * RFC 8707 resource indicator: the canonical MCP resource URL (no query string).
 * Sent on authorize + token requests so the issued token is bound to the MCP server.
 */
export function resolveResource(config: ToolConfigValues): string {
	const url = new URL(str(config?.mcpUrl) ?? DEFAULT_MCP_URL);
	url.search = '';
	url.hash = '';
	return url.toString();
}

export function resolveAuthorizeUrl(config: ToolConfigValues): string {
	return str(config?.oauthAuthorizeUrl) ?? DEFAULT_AUTHORIZE_URL;
}

export function resolveTokenUrl(config: ToolConfigValues): string {
	return str(config?.oauthTokenUrl) ?? DEFAULT_TOKEN_URL;
}

export function resolveRegistrationUrl(config: ToolConfigValues): string {
	return str(config?.oauthRegistrationUrl) ?? DEFAULT_REGISTRATION_URL;
}

export function resolveScope(config: ToolConfigValues): string {
	return str(config?.oauthScope) ?? DEFAULT_SCOPE;
}

export function resolveConfiguredClient(config: ToolConfigValues): {
	clientId?: string;
	clientSecret?: string;
} {
	return {
		clientId: str(config?.oauthClientId),
		clientSecret: str(config?.oauthClientSecret)
	};
}

export function resolveDefaultCloudId(config: ToolConfigValues): string | undefined {
	return str(config?.defaultCloudId);
}

export function resolveTimeoutMs(config: ToolConfigValues): number {
	const seconds = Number(config?.timeoutSeconds);
	if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
	return Math.round(seconds * 1000);
}

/**
 * Build the Authorization header for the headless API-token mode.
 * Personal token + e-mail -> Basic; service-account key alone -> Bearer.
 */
export function resolveApiTokenAuthHeader(config: ToolConfigValues, env: Env): string {
	const token = str(config?.apiToken) ?? str(env?.ATLASSIAN_API_TOKEN);
	const email = str(config?.apiTokenEmail) ?? str(env?.ATLASSIAN_API_TOKEN_EMAIL);
	if (!token) {
		throw new Error(
			'Atlassian plugin: authMode is "api_token" but no apiToken is configured (config or env ATLASSIAN_API_TOKEN).'
		);
	}
	if (email) {
		return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
	}
	return `Bearer ${token}`;
}
