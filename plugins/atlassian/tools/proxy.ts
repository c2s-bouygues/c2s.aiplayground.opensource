/**
 * Atlassian proxy-tool factory.
 *
 * Each upstream tool discovered from the Atlassian MCP Server (via `tools/list`)
 * is wrapped as an individual AI Playground tool. Discovery runs with the
 * connecting admin's credentials; execution uses the chat user's own OAuth
 * token (or the shared API token in headless mode) through `runTool`.
 *
 * Tools are grouped into UI categories per Atlassian product (Jira, Confluence,
 * Bitbucket, ...) inferred from the upstream tool name.
 */

import { tool, jsonSchema } from 'ai';
import type {
	AnyTool,
	PluginContext,
	PluginToolDeclaration,
	PluginToolDefinition
} from '../../../src/types';
import { resolveDefaultCloudId } from '../lib/config';
import { callTool, type McpContentItem, type McpToolDescriptor } from '../lib/mcp-client';
import { runTool } from '../lib/shared';

export const ATLASSIAN_ICON = 'simple-icons:atlassian';

interface ProductInfo {
	key: string;
	label: string;
	icon: string;
}

const PRODUCTS: Array<{ match: RegExp; info: ProductInfo }> = [
	{ match: /jsm|servicedesk|service_?management/i, info: { key: 'jsm', label: 'Jira Service Management', icon: 'simple-icons:jira' } },
	{ match: /jira|issue|worklog|sprint|board/i, info: { key: 'jira', label: 'Jira', icon: 'simple-icons:jira' } },
	{ match: /confluence|page|space|comment/i, info: { key: 'confluence', label: 'Confluence', icon: 'simple-icons:confluence' } },
	{ match: /bitbucket|pull_?request|repositor|commit/i, info: { key: 'bitbucket', label: 'Bitbucket', icon: 'simple-icons:bitbucket' } },
	{ match: /compass/i, info: { key: 'compass', label: 'Compass', icon: ATLASSIAN_ICON } },
	{ match: /loom/i, info: { key: 'loom', label: 'Loom', icon: 'simple-icons:loom' } },
	{ match: /goal/i, info: { key: 'goals', label: 'Atlassian Goals', icon: ATLASSIAN_ICON } },
	{ match: /project/i, info: { key: 'projects', label: 'Atlassian Projects', icon: ATLASSIAN_ICON } },
	{ match: /team/i, info: { key: 'teams', label: 'Atlassian Teams', icon: ATLASSIAN_ICON } },
	{ match: /focus/i, info: { key: 'focus', label: 'Atlassian Focus', icon: ATLASSIAN_ICON } },
	{ match: /talent/i, info: { key: 'talent', label: 'Atlassian Talent', icon: ATLASSIAN_ICON } },
	{ match: /teamwork|graph|rovo|search|fetch|discover|execute/i, info: { key: 'platform', label: 'Atlassian Platform', icon: ATLASSIAN_ICON } }
];

const DEFAULT_PRODUCT: ProductInfo = { key: 'general', label: 'Atlassian', icon: ATLASSIAN_ICON };

export function productOf(toolName: string): ProductInfo {
	for (const { match, info } of PRODUCTS) {
		if (match.test(toolName)) return info;
	}
	return DEFAULT_PRODUCT;
}

/** Sanitize an upstream name into a valid tool id segment (lowercase, underscores). */
export function sanitizeToolId(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
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
			if (item.type === 'resource_link' && typeof item.uri === 'string') {
				return `[resource: ${item.uri}]`;
			}
			return JSON.stringify(item);
		})
		.filter((s) => s.length > 0)
		.join('\n');
}

/** Inject the configured default cloudId when the tool accepts one and the LLM omitted it. */
function withDefaultCloudId(
	args: Record<string, unknown>,
	inputSchema: McpToolDescriptor['inputSchema'],
	defaultCloudId: string | undefined
): Record<string, unknown> {
	if (!defaultCloudId) return args;
	const props = inputSchema?.properties ?? {};
	if (!('cloudId' in props)) return args;
	const current = args.cloudId;
	if (typeof current === 'string' && current.trim().length > 0) return args;
	return { ...args, cloudId: defaultCloudId };
}

/**
 * Build the executable proxy tool (no declaration) for a single upstream Atlassian tool.
 * Shared by live discovery and snapshot restore.
 */
export function buildAtlassianProxyToolDef(
	toolName: string,
	inputSchema: McpToolDescriptor['inputSchema'],
	llmDescription: string
): PluginToolDefinition {
	const toolId = sanitizeToolId(toolName);
	const schema: McpToolDescriptor['inputSchema'] =
		inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object', properties: {} };
	return {
		id: toolId,
		createTool: (ctx: PluginContext): AnyTool =>
			tool({
				description: llmDescription,
				inputSchema: jsonSchema<Record<string, unknown>>(schema),
				execute: async (args) =>
					runTool(ctx, async ({ authHeader, config }) => {
						const finalArgs = withDefaultCloudId(
							(args as Record<string, unknown>) ?? {},
							schema,
							resolveDefaultCloudId(config)
						);
						const result = await callTool(config, authHeader, toolName, finalArgs);
						const text = flattenContent(result.content ?? []);
						if (result.isError) {
							return {
								success: false as const,
								name: toolName,
								message: text || `Atlassian MCP tool "${toolName}" returned an error`,
								content: result.content
							};
						}
						return {
							success: true as const,
							name: toolName,
							text,
							structuredContent: result.structuredContent,
							content: result.content
						};
					})
			}),
		isAvailable: () => true
	};
}

/** Build the UI/LLM declaration for a discovered Atlassian tool. */
export function buildAtlassianDeclaration(descriptor: McpToolDescriptor): PluginToolDeclaration {
	const description = descriptor.description ?? '';
	const toolId = sanitizeToolId(descriptor.name);
	const product = productOf(descriptor.name);
	const readOnly = descriptor.annotations?.readOnlyHint === true;
	return {
		id: toolId,
		name: descriptor.title ?? descriptor.name,
		description: `[${product.label}] ${truncate(description, 120)}`,
		category: `atlassian_${product.key}`,
		categoryLabel: product.label,
		icon: product.icon,
		requiresPluginOAuth: 'atlassian',
		systemPromptInstructions: {
			fr: `- atlassian_${toolId}: ${description}${readOnly ? ' (lecture seule)' : ''} (via le serveur MCP Atlassian, produit ${product.label})`,
			en: `- atlassian_${toolId}: ${description}${readOnly ? ' (read-only)' : ''} (via the Atlassian MCP server, ${product.label})`
		}
	};
}

/** Build a proxy tool + declaration for one discovered Atlassian MCP tool. */
export function createAtlassianProxyTool(descriptor: McpToolDescriptor): {
	toolDef: PluginToolDefinition;
	declaration: PluginToolDeclaration;
} {
	const declaration = buildAtlassianDeclaration(descriptor);
	const toolDef = buildAtlassianProxyToolDef(
		descriptor.name,
		descriptor.inputSchema,
		`[${productOf(descriptor.name).label}] ${descriptor.description ?? ''}`
	);
	return { toolDef, declaration };
}
