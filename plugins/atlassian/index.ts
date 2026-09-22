/**
 * Atlassian MCP Plugin
 *
 * Bridges the official Atlassian MCP Server (https://mcp.atlassian.com/v2/mcp —
 * Jira, Confluence, Jira Service Management, Bitbucket, Compass, Loom, Teamwork
 * Graph, ...) into AI Playground. Upstream tools are discovered via `tools/list`
 * and each one is registered as an individual app tool grouped by product.
 *
 * Authentication:
 *  - `authMode: "oauth"` (default): per-user OAuth 2.1 with PKCE against the
 *    Atlassian authorization server. Discovery needs a token, so the manifest sets
 *    `skipRefreshOnRestart`: an admin connects and clicks "Refresh tools"; tools are
 *    then persisted as a snapshot and rebuilt on restart. At chat time each tool
 *    call uses the calling user's own token.
 *  - `authMode: "api_token"`: a single personal API token (Basic) or service-account
 *    key (Bearer) shared by all users. Required for Jira Service Management tools.
 *
 * Prompts exposed by the server (`prompts/list`) surface as external skills.
 */

import type {
	DiscoveredToolSnapshot,
	JsonValue,
	PluginExport,
	PluginPromptDeclaration,
	PluginTokensAPI,
	PluginToolDeclaration,
	PluginToolDefinition,
	ToolConfigValues
} from '../../src/types';
import manifest from './manifest.json';
import { resolveAuthMode, resolveMcpUrl, resolveConfiguredClient, resolveAuthorizeUrl, resolveTokenUrl, resolveRegistrationUrl } from './lib/config';
import { atlassianOAuthHandlers } from './lib/oauth';
import { resolveAuthHeader } from './lib/shared';
import {
	getPrompt,
	listPrompts,
	listTools,
	type McpToolDescriptor
} from './lib/mcp-client';
import { buildAtlassianProxyToolDef, createAtlassianProxyTool } from './tools/proxy';

/** Routing data stored in each snapshot entry's `meta` so a tool can be rebuilt on restore. */
interface AtlassianToolMeta {
	name: string;
}

interface AtlassianPromptMeta {
	promptName: string;
}

type Env = Record<string, string | undefined>;
type DiscoveryContext = { tokens?: PluginTokensAPI } | undefined;

function isValidUrl(value: unknown): boolean {
	if (typeof value !== 'string' || value.trim().length === 0) return false;
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	// Tools are discovered dynamically (see discoverTools); no static tools.
	tools: [],
	oauthHandlers: atlassianOAuthHandlers,

	validateConfig(config: ToolConfigValues): boolean | string {
		if (config?.mcpUrl && !isValidUrl(config.mcpUrl)) {
			return `mcpUrl is not a valid URL: "${config.mcpUrl}"`;
		}
		for (const key of ['oauthAuthorizeUrl', 'oauthTokenUrl', 'oauthRegistrationUrl'] as const) {
			if (config?.[key] && !isValidUrl(config[key])) {
				return `${key} is not a valid URL: "${config[key]}"`;
			}
		}
		const mode = config?.authMode;
		if (mode !== undefined && mode !== '' && mode !== 'oauth' && mode !== 'api_token') {
			return 'authMode must be "oauth" or "api_token"';
		}
		if (mode === 'api_token') {
			const hasToken =
				(typeof config?.apiToken === 'string' && config.apiToken.trim().length > 0) ||
				(typeof process !== 'undefined' && !!process.env?.ATLASSIAN_API_TOKEN);
			if (!hasToken) {
				return 'authMode "api_token" requires apiToken (config) or the ATLASSIAN_API_TOKEN env var';
			}
		}
		const { clientId, clientSecret } = resolveConfiguredClient(config ?? {});
		if (clientSecret && !clientId) {
			return 'oauthClientSecret is set but oauthClientId is empty';
		}
		if (config?.timeoutSeconds !== undefined && config.timeoutSeconds !== '') {
			const t = Number(config.timeoutSeconds);
			if (!Number.isFinite(t) || t < 5 || t > 600) {
				return 'timeoutSeconds must be between 5 and 600';
			}
		}
		return true;
	},

	async discoverTools(
		config: ToolConfigValues,
		env: Env,
		context?: DiscoveryContext
	): Promise<{
		tools: PluginToolDefinition[];
		declarations: PluginToolDeclaration[];
		snapshot?: DiscoveredToolSnapshot[];
	}> {
		// Throws AtlassianNotConnectedError in OAuth mode when no admin token is present —
		// surfaced to the admin as a "connect first" message by the refresh endpoint.
		const authHeader = await resolveAuthHeader(config, env, context?.tokens);

		const descriptors = await listTools(config, authHeader);
		const tools: PluginToolDefinition[] = [];
		const declarations: PluginToolDeclaration[] = [];
		const snapshot: DiscoveredToolSnapshot[] = [];
		const seen = new Set<string>();

		for (const descriptor of descriptors) {
			const { toolDef, declaration } = createAtlassianProxyTool(descriptor);
			if (seen.has(toolDef.id)) {
				console.warn(`[atlassian] Duplicate tool id "${toolDef.id}" (upstream "${descriptor.name}") — skipped`);
				continue;
			}
			seen.add(toolDef.id);
			tools.push(toolDef);
			declarations.push(declaration);
			snapshot.push({
				declaration,
				inputSchema: descriptor.inputSchema as JsonValue,
				meta: { name: descriptor.name } satisfies AtlassianToolMeta as unknown as JsonValue
			});
		}

		console.log(`[atlassian] Discovered ${tools.length} tools from ${resolveMcpUrl(config)}`);
		return { tools, declarations, snapshot };
	},

	rehydrateTools(
		_config: ToolConfigValues,
		_env: Env,
		snapshot: DiscoveredToolSnapshot[]
	): { tools: PluginToolDefinition[]; declarations: PluginToolDeclaration[] } {
		const tools: PluginToolDefinition[] = [];
		const declarations: PluginToolDeclaration[] = [];
		for (const entry of snapshot) {
			const meta = entry.meta as AtlassianToolMeta | null;
			if (!meta?.name) continue;
			tools.push(
				buildAtlassianProxyToolDef(
					meta.name,
					entry.inputSchema as McpToolDescriptor['inputSchema'],
					entry.declaration.description
				)
			);
			declarations.push(entry.declaration);
		}
		return { tools, declarations };
	},

	async discoverPrompts(
		config: ToolConfigValues,
		env: Env,
		context?: DiscoveryContext
	): Promise<{ prompts: PluginPromptDeclaration[] }> {
		try {
			const authHeader = await resolveAuthHeader(config, env, context?.tokens);
			const descriptors = await listPrompts(config, authHeader);
			return {
				prompts: descriptors.map((p) => ({
					id: `atlassian:${p.name}`,
					name: p.title ?? p.name,
					description: p.description,
					meta: { promptName: p.name } satisfies AtlassianPromptMeta as unknown as JsonValue
				}))
			};
		} catch (err) {
			// Prompts are optional (many MCP servers do not implement prompts/list).
			console.warn('[atlassian] Prompt discovery skipped:', err instanceof Error ? err.message : err);
			return { prompts: [] };
		}
	},

	async getPromptContent(
		config: ToolConfigValues,
		env: Env,
		meta: JsonValue,
		context?: DiscoveryContext
	): Promise<string> {
		const { promptName } = meta as unknown as AtlassianPromptMeta;
		if (!promptName) throw new Error('Atlassian plugin: prompt meta is missing "promptName"');
		const authHeader = await resolveAuthHeader(config, env, context?.tokens);
		return getPrompt(config, authHeader, promptName);
	},

	async onLoad() {
		console.log(
			'[atlassian] Plugin loaded — dynamic tool discovery from the Atlassian MCP Server (per-user OAuth 2.1 or headless API token)'
		);
	}
};

// Re-exported for tests / diagnostics (e.g. verifying resolved endpoints).
export const atlassianEndpoints = (config: ToolConfigValues) => ({
	authMode: resolveAuthMode(config),
	mcpUrl: resolveMcpUrl(config),
	authorizeUrl: resolveAuthorizeUrl(config),
	tokenUrl: resolveTokenUrl(config),
	registrationUrl: resolveRegistrationUrl(config)
});

export default plugin;
