/**
 * MCP Plugin Types
 *
 * Shared types for external plugins. Keep in sync with the main project's types.
 */

import type { Tool } from 'ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

export type Locale = 'fr' | 'en' | 'es' | 'zh';

export interface ToolConfigProperty {
	type: 'string' | 'number' | 'boolean' | 'array';
	title: string;
	description?: string;
	default?: unknown;
	enum?: (string | number)[];
	enumLabels?: Record<string, string>;
	minimum?: number;
	maximum?: number;
	'x-ui-widget'?: 'select' | 'radio' | 'checkbox' | 'slider' | 'textarea' | 'icon-select' | 'image-select';
	'x-ui-icon'?: string;
	'x-ui-preview'?: string;
	'x-ui-order'?: number;
	'x-ui-group'?: string;
}

export interface ToolConfigSchema {
	type: 'object';
	title: string;
	description?: string;
	properties: Record<string, ToolConfigProperty>;
	required?: string[];
}

export interface ToolConfigValues {
	[key: string]: string | number | boolean | string[] | null;
}

/**
 * Tool context passed from the main application
 */
export interface ToolContext {
	datasourceId: string | null;
	conversationId: string | null;
	userId?: string | null;
	userEmail?: string | null;
	toolOptions?: Record<string, string>;
	locale?: Locale;
}

/**
 * Logger interface for plugins
 */
export interface PluginLogger {
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Storage API for plugins to upload files to MinIO
 */
export interface PluginStorageAPI {
	uploadFile: (fileName: string, buffer: Buffer, contentType: string) => Promise<string>;
	getFileUrl: (fileName: string) => string;
}

/**
 * Extended context passed to plugin tools
 */
export interface PluginContext extends ToolContext {
	pluginConfig: ToolConfigValues;
	env: Record<string, string | undefined>;
	logger: PluginLogger;
	storage: PluginStorageAPI;
}

/**
 * Tool declaration in the manifest
 */
export interface PluginToolDeclaration {
	id: string;
	name: string;
	description: string;
	category?: string;
	icon?: string;
	requiresDatasource?: boolean;
	requiresMicrosoftAuth?: boolean;
	requiresGmailAuth?: boolean;
	systemPromptInstructions: string | { [locale: string]: string };
}

/**
 * Plugin manifest
 */
export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	license: string;
	icon?: string;
	category?: string;
	homepage?: string;
	repository?: string;
	minCoreVersion?: string;
	requiredEnvVars?: string[];
	optionalEnvVars?: string[];
	configSchema?: ToolConfigSchema;
	tools: PluginToolDeclaration[];
	i18n?: {
		supportedLocales: string[];
		defaultLocale: string;
	};
}

/**
 * Tool definition within a plugin
 */
export interface PluginToolDefinition {
	id: string;
	createTool: (context: PluginContext) => AnyTool;
	isAvailable?: (env: Record<string, string | undefined>) => boolean;
}

/**
 * Main plugin export interface
 */
export interface PluginExport {
	manifest: PluginManifest;
	tools: PluginToolDefinition[];
	onLoad?: () => Promise<void>;
	onUnload?: () => Promise<void>;
	validateConfig?: (config: ToolConfigValues) => boolean | string;
}
