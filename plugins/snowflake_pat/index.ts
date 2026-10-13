/**
 * Snowflake MCP Plugin — Programmatic Access Token (PAT) authentication
 *
 * Dynamically discovers and exposes the tools of one or more Snowflake Cortex
 * Agents managed MCP servers. All MCP servers share a single Snowflake account;
 * the `servers[]` config array lists the individual MCP endpoints
 * (database/schema/mcp_server) to expose, each with its own `mcpServerPath`.
 *
 * Every server authenticates with a PAT — its own `servers[i].pat`, or the
 * account-wide `snowflakePat` — for both discovery and execution. There is no
 * OAuth flow: "Refresh tools" runs discovery directly, and every user shares the
 * PAT owner's Snowflake identity and role. Per-user OAuth servers belong in the
 * separate `snowflake` plugin, so an unconnected OAuth flow never blocks these.
 *
 * The manifest sets `skipRefreshOnRestart`: discovery is triggered by the admin
 * and the discovered tools are restored from the snapshot after a restart.
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
import { getEnabledServers, resolvePat } from './lib/config';
import { listTools, type McpToolDescriptor } from './lib/mcp-client';
import { createSnowflakeProxyTool, buildSnowflakeProxyToolDef } from './tools/proxy';

/** Routing data stored in each snapshot entry's `meta` so a tool can be rebuilt on restore. */
interface SnowflakeToolMeta {
	serverId: string;
	name: string;
}

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	// Tools are discovered dynamically (see discoverTools); no static tools.
	tools: [],

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

		if (config?.snowflakePat !== undefined && config.snowflakePat !== '') {
			if (typeof config.snowflakePat !== 'string' || !config.snowflakePat.trim()) {
				return 'snowflakePat must be a non-empty string';
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
			if (s.pat !== undefined && s.pat !== '') {
				if (typeof s.pat !== 'string' || !s.pat.trim()) {
					return `servers[${i}]: pat must be a non-empty string`;
				}
			}
		}

		const withoutPat = getEnabledServers(config).filter((s) => !resolvePat(config, s));
		if (withoutPat.length > 0) {
			return `No PAT for server(s) ${withoutPat.map((s) => `"${s.id}"`).join(', ')}: set servers[].pat or snowflakePat`;
		}

		return true;
	},

	async discoverTools(
		config: ToolConfigValues
	): Promise<{
		tools: PluginToolDefinition[];
		declarations: PluginToolDeclaration[];
		snapshot?: DiscoveredToolSnapshot[];
	}> {
		const servers = getEnabledServers(config);
		const tools: PluginToolDefinition[] = [];
		const declarations: PluginToolDeclaration[] = [];
		const snapshot: DiscoveredToolSnapshot[] = [];

		for (const server of servers) {
			const pat = resolvePat(config, server);
			if (!pat) {
				console.warn(`[snowflake_pat] Skipping discovery for "${server.id}": no PAT configured`);
				continue;
			}
			try {
				const descriptors = await listTools(config, server.id, pat);
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
					`[snowflake_pat] Discovered ${descriptors.length} tools from "${server.name}" (${server.id})`
				);
			} catch (err) {
				console.error(`[snowflake_pat] Tool discovery failed for server "${server.id}":`, err);
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
			'[snowflake_pat] Plugin loaded — dynamic multi-server discovery (manual refresh; PAT auth, no OAuth)'
		);
	}
};

export default plugin;
