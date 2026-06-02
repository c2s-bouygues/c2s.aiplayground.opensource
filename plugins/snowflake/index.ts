/**
 * Snowflake MCP Plugin
 *
 * Pass-through to a Snowflake Cortex Agents managed MCP server.
 * The plugin is agnostic of the specific MCP server: callers configure the
 * Snowflake base URL plus the MCP server path, then authenticate per-user
 * via the standard plugin OAuth flow.
 *
 * Two tools are exposed:
 *  - list_tools : JSON-RPC tools/list against the configured MCP server
 *  - call_tool  : JSON-RPC tools/call against the configured MCP server
 *
 * Combined they let the LLM discover and invoke any tool the upstream
 * Snowflake MCP server advertises (CORTEX_AGENT_RUN, CORTEX_ANALYST_MESSAGE,
 * CORTEX_SEARCH_SERVICE_QUERY, SYSTEM_EXECUTE_SQL, GENERIC user procedures).
 */

import type { PluginExport, PluginToolDefinition, ToolConfigValues } from '../../src/types';
import manifest from './manifest.json';
import { snowflakeOAuthHandlers } from './lib/oauth';
import { createListToolsTool } from './tools/list-tools';
import { createCallToolTool } from './tools/call-tool';

const tools: PluginToolDefinition[] = [
	{ id: 'list_tools', createTool: (ctx) => createListToolsTool(ctx) },
	{ id: 'call_tool', createTool: (ctx) => createCallToolTool(ctx) }
];

const plugin: PluginExport = {
	manifest: manifest as PluginExport['manifest'],
	tools,
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
		const mcpPath = config?.mcpServerPath;
		if (!mcpPath || typeof mcpPath !== 'string') {
			return 'mcpServerPath is required (e.g. /api/v2/databases/MY_DB/schemas/MY_SCHEMA/mcp-servers/MY_MCP)';
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
		return true;
	},

	async onLoad() {
		console.log(
			'[snowflake] Plugin loaded — per-user OAuth + JSON-RPC pass-through to Snowflake Cortex MCP'
		);
	}
};

export default plugin;
