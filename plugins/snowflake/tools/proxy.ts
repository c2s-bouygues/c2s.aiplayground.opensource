/**
 * Snowflake proxy-tool factory.
 *
 * Each upstream tool discovered from a Snowflake managed MCP server (via
 * `tools/list`) is wrapped as an individual AI Playground tool. Unlike discovery
 * — which runs with the connecting admin's token — execution uses the *chat
 * user's* per-conversation OAuth token (`ctx.tokens` via `runTool`), so every
 * caller acts as themselves against Snowflake.
 */

import { tool, jsonSchema } from 'ai';
import type {
	AnyTool,
	PluginContext,
	PluginToolDefinition,
	PluginToolDeclaration
} from '../../../src/types';
import type { SnowflakeServerConfig } from '../lib/oauth';
import { callTool, type McpContentItem, type McpToolDescriptor } from '../lib/mcp-client';
import { runTool } from '../lib/shared';

/** Sanitize an upstream name into a valid tool id segment (lowercase, underscores). */
export function sanitizeToolId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 1) + '…';
}

function flattenContent(content: McpContentItem[]): string {
	return content
		.map((item) => {
			if (item.type === 'text' && typeof item.text === 'string') return item.text;
			if (item.type === 'image' && item.data) return `[image: ${item.mimeType ?? 'image'}]`;
			if (item.type === 'audio' && item.data) return `[audio: ${item.mimeType ?? 'audio'}]`;
			return JSON.stringify(item);
		})
		.filter((s) => s.length > 0)
		.join('\n');
}

/**
 * Build the executable proxy tool (no declaration) for a single upstream Snowflake tool.
 * Shared by live discovery and snapshot restore — the executor uses the *chat user's* token.
 */
export function buildSnowflakeProxyToolDef(
	server: SnowflakeServerConfig,
	toolName: string,
	inputSchema: McpToolDescriptor['inputSchema'],
	llmDescription: string
): PluginToolDefinition {
	const toolId = `${sanitizeToolId(server.id)}_${sanitizeToolId(toolName)}`;
	return {
		id: toolId,
		createTool: (ctx: PluginContext): AnyTool =>
			tool({
				description: llmDescription,
				inputSchema: jsonSchema<Record<string, unknown>>(inputSchema),
				execute: async (args) =>
					runTool(ctx, async ({ token, config }) => {
						const result = await callTool(
							config,
							server.id,
							token,
							toolName,
							(args as Record<string, unknown>) ?? {}
						);
						const text = flattenContent(result.content ?? []);
						if (result.isError) {
							return {
								success: false as const,
								serverId: server.id,
								name: toolName,
								message: text || `Snowflake MCP tool "${toolName}" returned an error`,
								content: result.content
							};
						}
						return {
							success: true as const,
							serverId: server.id,
							name: toolName,
							text,
							content: result.content
						};
					})
			}),
		isAvailable: () => server.enabled !== false
	};
}

/** Build the UI/LLM declaration for a discovered Snowflake tool. */
export function buildSnowflakeDeclaration(
	server: SnowflakeServerConfig,
	descriptor: McpToolDescriptor
): PluginToolDeclaration {
	const description = descriptor.description ?? '';
	const toolId = `${sanitizeToolId(server.id)}_${sanitizeToolId(descriptor.name)}`;
	return {
		id: toolId,
		name: descriptor.name,
		description: `[${server.name}] ${truncate(description, 120)}`,
		category: `snowflake_${sanitizeToolId(server.id)}`,
		categoryLabel: server.name,
		icon: 'simple-icons:snowflake',
		requiresPluginOAuth: 'snowflake',
		systemPromptInstructions: {
			fr: `- ${toolId}: ${description} (serveur Snowflake MCP « ${server.name} »)`,
			en: `- ${toolId}: ${description} (via Snowflake MCP server "${server.name}")`
		}
	};
}

/**
 * Build a proxy tool + declaration for one discovered Snowflake MCP tool on a server.
 */
export function createSnowflakeProxyTool(
	server: SnowflakeServerConfig,
	descriptor: McpToolDescriptor
): { toolDef: PluginToolDefinition; declaration: PluginToolDeclaration } {
	const declaration = buildSnowflakeDeclaration(server, descriptor);
	const toolDef = buildSnowflakeProxyToolDef(
		server,
		descriptor.name,
		descriptor.inputSchema,
		`[${server.name}] ${descriptor.description ?? ''}`
	);
	return { toolDef, declaration };
}
