/**
 * Snowflake MCP Plugin
 *
 * Dynamically discovers and exposes the tools of one or more Snowflake Cortex
 * Agents managed MCP servers. All MCP servers share a single Snowflake account
 * and OAuth security integration; the `servers[]` config array lists the
 * individual MCP endpoints (database/schema/mcp_server) to expose, each with its
 * own `mcpServerPath`.
 *
 * Discovery (tools/list) requires a per-user Snowflake OAuth token, which is not
 * available at app startup. The manifest therefore sets `skipRefreshOnRestart`:
 * an admin connects via OAuth and triggers "Refresh tools" in the plugin config
 * dialog, which runs discovery with the admin's token. Each discovered tool is
 * registered as an individual app tool and executes — at chat time — using the
 * calling user's own OAuth token.
 *
 * OAuth credentials live entirely in the plugin config (admin UI) — no env vars
 * are consulted. This keeps the plugin agnostic of any specific Snowflake
 * instance and lets multiple deployments coexist.
 */

import type {
	PluginExport,
	PluginToolDefinition,
	PluginToolDeclaration,
	ToolConfigValues,
	DiscoveredToolSnapshot,
	JsonValue
} from '../../src/types';
import manifest from './manifest.json';
import { snowflakeOAuthHandlers, getEnabledServers } from './lib/oauth';
import { SnowflakeNotConnectedError } from './lib/shared';
import { listTools, type McpToolDescriptor } from './lib/mcp-client';
import {
	createSnowflakeProxyTool,
	buildSnowflakeProxyToolDef
} from './tools/proxy';

/** Routing data stored in each snapshot entry's `meta` so a tool can be rebuilt on restore. */
interface SnowflakeToolMeta {
	serverId: string;
	name: string;
}

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	// Tools are discovered dynamically (see discoverTools); no static tools.
	tools: [],
	oauthHandlers: snowflakeOAuthHandlers,

	validateConfig(config: ToolConfigValues): boolean | string {
		const baseUrl = config?.snowflakeBaseUrl;
		if (!baseUrl || typeof baseUrl !== 'string') {
			return 'snowflakeBaseUrl is required (e.g. https://xy12345.snowflakecomputing.com)';
		}
		try {
			new URL(baseUrl);
		} catch {
			return `snowflakeBaseUrl is not a valid URL: "${baseUrl}"`;
		}

		if (!config?.oauthClientId || typeof config.oauthClientId !== 'string') {
			return 'oauthClientId is required';
		}
		if (!config?.oauthClientSecret || typeof config.oauthClientSecret !== 'string') {
			return 'oauthClientSecret is required';
		}

		if (config?.oauthAuthorizeUrl) {
			try {
				new URL(config.oauthAuthorizeUrl as string);
			} catch {
				return `oauthAuthorizeUrl is not a valid URL: "${config.oauthAuthorizeUrl}"`;
			}
		}
		if (config?.oauthTokenUrl) {
			try {
				new URL(config.oauthTokenUrl as string);
			} catch {
				return `oauthTokenUrl is not a valid URL: "${config.oauthTokenUrl}"`;
			}
		}

		const servers = config?.servers;
		if (!Array.isArray(servers) || servers.length === 0) {
			return 'servers is required and must contain at least one entry';
		}
		const ids = new Set<string>();
		for (let i = 0; i < servers.length; i++) {
			const s = servers[i] as Record<string, unknown>;
			if (!s.id || typeof s.id !== 'string') {
				return `servers[${i}]: id is required`;
			}
			if (!/^[a-z][a-z0-9_-]*$/.test(s.id)) {
				return `servers[${i}]: id "${s.id}" must be lowercase alphanumeric (underscores/hyphens allowed)`;
			}
			if (ids.has(s.id)) {
				return `servers[${i}]: duplicate id "${s.id}"`;
			}
			ids.add(s.id);
			if (!s.name || typeof s.name !== 'string') {
				return `servers[${i}]: name is required`;
			}
			if (!s.mcpServerPath || typeof s.mcpServerPath !== 'string') {
				return `servers[${i}]: mcpServerPath is required (e.g. /api/v2/databases/DB/schemas/SCHEMA/mcp-servers/NAME)`;
			}
		}

		return true;
	},

	async discoverTools(
		config: ToolConfigValues,
		_env: Record<string, string | undefined>,
		context?: { tokens?: import('../../src/types').PluginTokensAPI }
	): Promise<{
		tools: PluginToolDefinition[];
		declarations: PluginToolDeclaration[];
		snapshot?: DiscoveredToolSnapshot[];
	}> {
		const token = (await context?.tokens?.get())?.accessToken;
		if (!token) {
			// Surfaced to the admin as a "connect first" message by the refresh endpoint.
			throw new SnowflakeNotConnectedError(undefined);
		}

		const servers = getEnabledServers(config);
		const tools: PluginToolDefinition[] = [];
		const declarations: PluginToolDeclaration[] = [];
		const snapshot: DiscoveredToolSnapshot[] = [];

		for (const server of servers) {
			try {
				const descriptors = await listTools(config, server.id, token);
				for (const descriptor of descriptors) {
					const { toolDef, declaration } = createSnowflakeProxyTool(server, descriptor);
					tools.push(toolDef);
					declarations.push(declaration);
					snapshot.push({
						declaration,
						inputSchema: descriptor.inputSchema as JsonValue,
						meta: { serverId: server.id, name: descriptor.name }
					});
				}
				console.log(
					`[snowflake] Discovered ${descriptors.length} tools from "${server.name}" (${server.id})`
				);
			} catch (err) {
				console.error(`[snowflake] Tool discovery failed for server "${server.id}":`, err);
			}
		}

		return { tools, declarations, snapshot };
	},

	rehydrateTools(
		config: ToolConfigValues,
		_env: Record<string, string | undefined>,
		snapshot: DiscoveredToolSnapshot[]
	): { tools: PluginToolDefinition[]; declarations: PluginToolDeclaration[] } {
		// Only rebuild tools for servers still present and enabled in the current config.
		const serversById = new Map(getEnabledServers(config).map((s) => [s.id, s]));
		const tools: PluginToolDefinition[] = [];
		const declarations: PluginToolDeclaration[] = [];

		for (const entry of snapshot) {
			const meta = entry.meta as SnowflakeToolMeta | null;
			if (!meta?.serverId || !meta?.name) continue;
			const server = serversById.get(meta.serverId);
			if (!server) continue;
			const toolDef = buildSnowflakeProxyToolDef(
				server,
				meta.name,
				entry.inputSchema as McpToolDescriptor['inputSchema'],
				entry.declaration.description
			);
			tools.push(toolDef);
			declarations.push(entry.declaration);
		}

		return { tools, declarations };
	},

	async onLoad() {
		console.log(
			'[snowflake] Plugin loaded — dynamic multi-server discovery (manual refresh; per-user OAuth)'
		);
	}
};

export default plugin;
