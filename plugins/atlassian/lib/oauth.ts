/**
 * OAuth 2.1 for the Atlassian MCP Server (authorization-code + PKCE S256).
 *
 * Authorization server metadata (https://mcp.atlassian.com/.well-known/oauth-authorization-server):
 *   authorize  : /v1/authorize
 *   token      : /v1/token   (client_secret_basic | client_secret_post | none)
 *   register   : /v1/register (RFC 7591 dynamic client registration)
 *   grants     : authorization_code, refresh_token
 *   PKCE       : S256
 *
 * Client identity:
 *  - Preferred: the admin sets `oauthClientId` (+ optional `oauthClientSecret`).
 *  - Fallback : dynamic registration on first use, cached in memory per redirect URI.
 *    The registration is lost on restart (refresh tokens bound to that client_id then
 *    fail and users simply reconnect); the plugin logs the client_id so the admin can
 *    persist it in the config.
 */

import type { PluginOAuthHandlers, ToolConfigValues } from '../../../src/types';
import {
	resolveAuthorizeUrl,
	resolveConfiguredClient,
	resolveRegistrationUrl,
	resolveScope,
	resolveTokenUrl,
	resolveResource
} from './config';

interface OAuthClient {
	clientId: string;
	clientSecret?: string;
}

const dynamicClients = new Map<string, Promise<OAuthClient>>();

interface RegistrationResponse {
	client_id: string;
	client_secret?: string;
	[key: string]: unknown;
}

async function registerClient(config: ToolConfigValues, redirectUri: string): Promise<OAuthClient> {
	const res = await fetch(resolveRegistrationUrl(config), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({
			client_name: 'AI Playground - Atlassian plugin',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: resolveScope(config)
		})
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Atlassian dynamic client registration failed (${res.status}): ${text}`);
	}
	const json = (await res.json()) as RegistrationResponse;
	if (!json.client_id) {
		throw new Error('Atlassian dynamic client registration returned no client_id');
	}
	console.warn(
		`[atlassian] Registered OAuth client dynamically (client_id=${json.client_id}). ` +
			'Persist it in the plugin config ("oauthClientId") so it survives restarts.'
	);
	// Registered with token_endpoint_auth_method "none" (public PKCE client): ignore any
	// client_secret the server echoes back, otherwise postToken would switch to client_secret_basic.
	return { clientId: json.client_id };
}

async function resolveClient(config: ToolConfigValues, redirectUri: string): Promise<OAuthClient> {
	const configured = resolveConfiguredClient(config);
	if (configured.clientId) {
		return { clientId: configured.clientId, clientSecret: configured.clientSecret };
	}
	let pending = dynamicClients.get(redirectUri);
	if (!pending) {
		pending = registerClient(config, redirectUri).catch((err) => {
			dynamicClients.delete(redirectUri);
			throw err;
		});
		dynamicClients.set(redirectUri, pending);
	}
	return pending;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
}

async function postToken(
	config: ToolConfigValues,
	client: OAuthClient,
	body: URLSearchParams
): Promise<TokenResponse> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'application/json'
	};
	if (client.clientSecret) {
		// client_secret_basic
		headers.Authorization = `Basic ${Buffer.from(
			`${client.clientId}:${client.clientSecret}`,
			'utf8'
		).toString('base64')}`;
	} else {
		body.set('client_id', client.clientId);
	}
	const res = await fetch(resolveTokenUrl(config), { method: 'POST', headers, body });
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Atlassian token endpoint error (${res.status}): ${text}`);
	}
	return (await res.json()) as TokenResponse;
}

/**
 * Best-effort identity lookup for the connection metadata (`read:me` scope).
 * Failure is non-fatal: the token is still valid for MCP calls.
 */
async function fetchIdentity(accessToken: string): Promise<Record<string, unknown>> {
	try {
		const res = await fetch('https://api.atlassian.com/me', {
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
		});
		if (!res.ok) return {};
		const me = (await res.json()) as Record<string, unknown>;
		return {
			accountId: me.account_id ?? null,
			email: me.email ?? null,
			name: me.name ?? null
		};
	} catch {
		return {};
	}
}

export const atlassianOAuthHandlers: PluginOAuthHandlers = {
	buildAuthUrl: async ({ redirectUri, state, config, codeChallenge, codeChallengeMethod }) => {
		const client = await resolveClient(config, redirectUri);
		const params = new URLSearchParams({
			client_id: client.clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: resolveScope(config),
			state,
			resource: resolveResource(config)
		});
		if (codeChallenge) {
			params.set('code_challenge', codeChallenge);
			params.set('code_challenge_method', codeChallengeMethod ?? 'S256');
		}
		return `${resolveAuthorizeUrl(config)}?${params.toString()}`;
	},

	exchangeCode: async ({ code, redirectUri, config, codeVerifier }) => {
		const client = await resolveClient(config, redirectUri);
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			resource: resolveResource(config)
		});
		if (codeVerifier) body.set('code_verifier', codeVerifier);
		const tokens = await postToken(config, client, body);
		const identity = await fetchIdentity(tokens.access_token);
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresIn: tokens.expires_in,
			scope: tokens.scope,
			metadata: { ...identity, clientId: client.clientId }
		};
	},

	refresh: async ({ refreshToken, config }) => {
		// The redirect URI is unknown here; only a configured or already-registered client can refresh.
		const configured = resolveConfiguredClient(config);
		let client: OAuthClient | undefined = configured.clientId
			? { clientId: configured.clientId, clientSecret: configured.clientSecret }
			: undefined;
		if (!client) {
			const first = dynamicClients.values().next();
			if (!first.done) client = await first.value;
		}
		if (!client) {
			throw new Error(
				'Atlassian OAuth refresh failed: no OAuth client available (set oauthClientId in the plugin config or reconnect).'
			);
		}
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			resource: resolveResource(config)
		});
		const tokens = await postToken(config, client, body);
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresIn: tokens.expires_in,
			scope: tokens.scope
		};
	}
};
