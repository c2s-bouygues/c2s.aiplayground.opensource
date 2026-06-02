import { tool, jsonSchema } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { listTools } from '../lib/mcp-client';
import { runTool } from '../lib/shared';

export function createListToolsTool(ctx: PluginContext): AnyTool {
	return tool({
		description:
			'List the tools exposed by the configured Snowflake MCP server. Returns each tool name, description, and JSON Schema input contract. Call this before snowflake_call_tool to know what is available.',
		inputSchema: jsonSchema<Record<string, never>>({
			type: 'object',
			properties: {},
			additionalProperties: false
		}),
		execute: async () =>
			runTool(ctx, async ({ token, config }) => {
				const tools = await listTools(config, token);
				return {
					success: true as const,
					count: tools.length,
					tools: tools.map((t) => ({
						name: t.name,
						description: t.description ?? '',
						inputSchema: t.inputSchema
					}))
				};
			})
	});
}
