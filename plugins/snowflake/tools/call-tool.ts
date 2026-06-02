import { tool, jsonSchema } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { callTool, type McpContentItem } from '../lib/mcp-client';
import { runTool } from '../lib/shared';

interface CallToolParams {
	name: string;
	arguments?: Record<string, unknown>;
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

export function createCallToolTool(ctx: PluginContext): AnyTool {
	return tool({
		description:
			'Invoke a tool on the configured Snowflake MCP server. Pass the tool name (as returned by snowflake_list_tools) and an arguments object matching that tool\'s inputSchema.',
		inputSchema: jsonSchema<CallToolParams>({
			type: 'object',
			required: ['name'],
			properties: {
				name: {
					type: 'string',
					description:
						'Name of the upstream Snowflake MCP tool to invoke (e.g. CORTEX_AGENT_RUN, CORTEX_ANALYST_MESSAGE, SYSTEM_EXECUTE_SQL).'
				},
				arguments: {
					type: 'object',
					description:
						"Arguments object matching the target tool's inputSchema. Use {} if the tool takes no arguments.",
					additionalProperties: true
				}
			},
			additionalProperties: false
		}),
		execute: async ({ name, arguments: args }) =>
			runTool(ctx, async ({ token, config }) => {
				const result = await callTool(config, token, name, args ?? {});
				const text = flattenContent(result.content ?? []);
				if (result.isError) {
					return {
						success: false as const,
						message: text || `Snowflake MCP tool "${name}" returned an error`,
						content: result.content
					};
				}
				return {
					success: true as const,
					name,
					text,
					content: result.content
				};
			})
	});
}
