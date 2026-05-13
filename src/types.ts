/**
 * MCP Plugin Types
 *
 * Shared types for external plugins. Keep in sync with the main project's types.
 */

import type { Tool } from 'ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

export type Locale = 'fr' | 'en' | 'es' | 'zh' | 'de';

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
	datasourceIds: string[];
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
 * Token payload exchanged with the generic plugin token store (plaintext on both sides;
 * encryption is handled by the core).
 */
export interface PluginTokenPayload {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: Date;
	scope?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Generic OAuth token storage scoped to (userId, pluginId).
 * `get()` auto-refreshes via `PluginExport.oauthHandlers.refresh` when needed.
 */
export interface PluginTokensAPI {
	save: (tokens: PluginTokenPayload) => Promise<void>;
	get: () => Promise<PluginTokenPayload | null>;
	delete: () => Promise<void>;
}

/**
 * Extended context passed to plugin tools
 */
export interface PluginContext extends ToolContext {
	pluginConfig: ToolConfigValues;
	env: Record<string, string | undefined>;
	logger: PluginLogger;
	storage: PluginStorageAPI;
	tokens: PluginTokensAPI;
}

/**
 * Web source metadata returned by search tools (kept in sync with the main app's Source type)
 */
export interface SourceMetadata {
	source: string;
	type: string;
	url?: string;
	domain?: string;
	age?: string;
}

/**
 * A structured source entry returned by search tools so the UI can render source citations
 */
export interface Source {
	id: string;
	content: string;
	metadata: SourceMetadata;
	similarity: number;
}

/**
 * Tool declaration in the manifest
 */
export interface PluginToolDeclaration {
	id: string;
	name: string;
	description: string;
	category?: string;
	/** Human-readable label for the category. Used by the UI when the category is dynamic and has no i18n entry. */
	categoryLabel?: string;
	icon?: string;
	requiresDatasource?: boolean;
	requiresMicrosoftAuth?: boolean;
	requiresGmailAuth?: boolean;
	/** Plugin-managed OAuth: value is the pluginId owning the OAuth flow. */
	requiresPluginOAuth?: string;
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
 * OAuth handlers a plugin can declare to enable the generic per-user OAuth flow.
 */
export interface PluginOAuthHandlers {
	buildAuthUrl: (params: {
		redirectUri: string;
		state: string;
		config: ToolConfigValues;
		env: Record<string, string | undefined>;
	}) => string | Promise<string>;
	exchangeCode: (params: {
		code: string;
		redirectUri: string;
		config: ToolConfigValues;
		env: Record<string, string | undefined>;
	}) => Promise<{
		accessToken: string;
		refreshToken?: string;
		expiresIn?: number;
		scope?: string;
		metadata?: Record<string, unknown>;
	}>;
	refresh?: (params: {
		refreshToken: string;
		config: ToolConfigValues;
		env: Record<string, string | undefined>;
	}) => Promise<{
		accessToken: string;
		refreshToken?: string;
		expiresIn?: number;
		scope?: string;
	}>;
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
	oauthHandlers?: PluginOAuthHandlers;
}
