/**
 * Plugin Loader for the test playground
 *
 * Dynamically loads plugins from the plugins/ directory
 */

import type { PluginExport, PluginContext, PluginLogger, PluginStorageAPI, ToolConfigValues } from '../../types';

// Import plugins statically (Vite doesn't support dynamic imports from fs in dev)
import weatherPlugin from '../../../plugins/weather';
import pixabayPlugin from '../../../plugins/pixabay';

// Registry of loaded plugins
const loadedPlugins: PluginExport[] = [weatherPlugin, pixabayPlugin];

export interface PluginInfo {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	icon?: string;
	category?: string;
	requiredEnvVars: string[];
	optionalEnvVars: string[];
	configSchema?: object;
	tools: {
		id: string;
		name: string;
		description: string;
	}[];
}

export function getPlugins(): PluginInfo[] {
	return loadedPlugins.map((plugin) => ({
		id: plugin.manifest.id,
		name: plugin.manifest.name,
		version: plugin.manifest.version,
		description: plugin.manifest.description,
		author: plugin.manifest.author,
		icon: plugin.manifest.icon,
		category: plugin.manifest.category,
		requiredEnvVars: plugin.manifest.requiredEnvVars || [],
		optionalEnvVars: plugin.manifest.optionalEnvVars || [],
		configSchema: plugin.manifest.configSchema,
		tools: plugin.manifest.tools.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description
		}))
	}));
}

export function getPlugin(pluginId: string): PluginExport | undefined {
	return loadedPlugins.find((p) => p.manifest.id === pluginId);
}

function createMockLogger(pluginId: string): PluginLogger {
	return {
		debug: (message: string, data?: Record<string, unknown>) => {
			console.log(`[${pluginId}] DEBUG:`, message, data || '');
		},
		info: (message: string, data?: Record<string, unknown>) => {
			console.log(`[${pluginId}] INFO:`, message, data || '');
		},
		warn: (message: string, data?: Record<string, unknown>) => {
			console.warn(`[${pluginId}] WARN:`, message, data || '');
		},
		error: (message: string, data?: Record<string, unknown>) => {
			console.error(`[${pluginId}] ERROR:`, message, data || '');
		}
	};
}

function createMockStorage(pluginId: string): PluginStorageAPI {
	const files = new Map<string, { buffer: Buffer; contentType: string }>();

	return {
		uploadFile: async (fileName: string, buffer: Buffer, contentType: string): Promise<string> => {
			const path = `mock-storage/${pluginId}/${fileName}`;
			files.set(path, { buffer, contentType });
			console.log(`[${pluginId}] Mock file uploaded: ${path}`);
			return `/api/mock-files/${path}`;
		},
		getFileUrl: (fileName: string): string => {
			return `/api/mock-files/mock-storage/${pluginId}/${fileName}`;
		}
	};
}

export interface ExecuteToolOptions {
	pluginId: string;
	toolId: string;
	params: Record<string, unknown>;
	env: Record<string, string>;
	config: ToolConfigValues;
}

export async function executeTool(options: ExecuteToolOptions): Promise<unknown> {
	const { pluginId, toolId, params, env, config } = options;

	const plugin = getPlugin(pluginId);
	if (!plugin) {
		throw new Error(`Plugin not found: ${pluginId}`);
	}

	const toolDef = plugin.tools.find((t) => t.id === toolId);
	if (!toolDef) {
		throw new Error(`Tool not found: ${toolId} in plugin ${pluginId}`);
	}

	// Check availability
	if (toolDef.isAvailable && !toolDef.isAvailable(env)) {
		throw new Error(`Tool ${toolId} is not available (missing required env vars)`);
	}

	// Create mock context
	const context: PluginContext = {
		datasourceId: null,
		conversationId: 'test-conversation-' + Date.now(),
		userId: 'test-user',
		userEmail: 'test@example.com',
		locale: 'fr',
		pluginConfig: config,
		env,
		logger: createMockLogger(pluginId),
		storage: createMockStorage(pluginId)
	};

	// Create and execute the tool
	const tool = toolDef.createTool(context);

	// Get the input schema to understand the parameters
	// The AI SDK tool has an execute method we can call
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result = await (tool as any).execute(params);

	return result;
}

export function getToolInputSchema(pluginId: string, toolId: string): object | null {
	const plugin = getPlugin(pluginId);
	if (!plugin) return null;

	const toolDef = plugin.tools.find((t) => t.id === toolId);
	if (!toolDef) return null;

	// Create a minimal context to get the tool instance
	const context: PluginContext = {
		datasourceId: null,
		conversationId: null,
		pluginConfig: {},
		env: {},
		logger: createMockLogger(pluginId),
		storage: createMockStorage(pluginId)
	};

	const tool = toolDef.createTool(context);

	// Extract schema from the tool (AI SDK format)
	// AI SDK tool() returns: { description, inputSchema, execute }
	// inputSchema has: { _type, jsonSchema, validate }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const toolAny = tool as any;

	// AI SDK uses inputSchema (not parameters)
	if (toolAny.inputSchema) {
		const inputSchema = toolAny.inputSchema;

		// The jsonSchema property contains the actual JSON Schema
		if (inputSchema.jsonSchema) {
			return inputSchema.jsonSchema;
		}

		// Fallback: if it has type: 'object' and properties, it's already a JSON schema
		if (inputSchema.type === 'object' && inputSchema.properties) {
			return inputSchema;
		}
	}

	// Legacy: check for parameters (older AI SDK versions)
	if (toolAny.parameters) {
		const params = toolAny.parameters;
		if (params.jsonSchema) {
			return params.jsonSchema;
		}
		if (params.type === 'object' && params.properties) {
			return params;
		}
	}

	return null;
}
