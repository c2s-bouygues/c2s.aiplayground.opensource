/**
 * MCP Plugin Types
 *
 * Shared types for external plugins. Keep in sync with the main project's types.
 */

import type { Tool } from 'ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

/** Any JSON-serializable value — the shape a plugin tool snapshot must take to be persisted. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type Locale = 'fr' | 'en' | 'es' | 'zh' | 'de';

export interface ToolConfigProperty {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	title?: string;
	description?: string;
	default?: unknown;
	enum?: (string | number)[];
	enumLabels?: Record<string, string>;
	minimum?: number;
	maximum?: number;
	items?: ToolConfigProperty;
	properties?: Record<string, ToolConfigProperty>;
	required?: string[];
	additionalProperties?: boolean | ToolConfigProperty;
	'x-ui-widget'?:
		| 'select'
		| 'radio'
		| 'checkbox'
		| 'slider'
		| 'textarea'
		| 'icon-select'
		| 'image-select';
	'x-ui-icon'?: string;
	'x-ui-preview'?: string;
	'x-ui-order'?: number;
	'x-ui-group'?: string;
}

export interface ToolConfigSchema {
	type: 'object';
	title?: string;
	description?: string;
	properties: Record<string, ToolConfigProperty>;
	required?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolConfigValues {
	[key: string]: any;
}

/**
 * Tool context passed from the main application
 */
export interface ToolContext {
	datasourceIds: string[];
	conversationId: string | null;
	/**
	 * Agent ID when the conversation is linked to an agent. Used by smolagent tools
	 * to load agent attachments (files persisted at agent level) into /workspace/files/.
	 */
	agentId?: string | null;
	userId?: string | null;
	userEmail?: string | null;
	toolOptions?: Record<string, string>;
	locale?: Locale;
	// Note: the core ToolContext also carries `alwaysApproveToolNames?: Set<string>`.
	// It is intentionally omitted here — it's a core approval-orchestration concern
	// (decides `needsApproval` wrapping), not part of the plugin contract.
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
	requiresSharepointAuth?: boolean;
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
	/** Whether this plugin discovers tools dynamically at runtime (allows empty tools array) */
	dynamicTools?: boolean;
	/**
	 * Skip automatic tool discovery on app startup AND on config-save.
	 * Discovery is then only triggered manually (admin "Refresh tools" button).
	 */
	skipRefreshOnRestart?: boolean;
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
 * One discovered tool in a serializable form the core persists, so plugins with
 * `skipRefreshOnRestart` can rebuild their tools after a restart without re-contacting the
 * remote server. `declaration` is restored as-is; `inputSchema` + `meta` rebuild the executable
 * tool (`meta` is plugin-specific routing, e.g. server id + upstream tool name).
 */
export interface DiscoveredToolSnapshot {
	declaration: PluginToolDeclaration;
	inputSchema: JsonValue;
	meta: JsonValue;
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
	/**
	 * Optional: Discover tools dynamically at runtime (e.g., from remote MCP servers).
	 * Called at startup and when plugin config changes. `context.tokens` is provided
	 * for user-scoped discovery (e.g. admin "Refresh tools"); absent at startup.
	 */
	discoverTools?: (
		config: ToolConfigValues,
		env: Record<string, string | undefined>,
		context?: { tokens?: PluginTokensAPI }
	) => Promise<{
		tools: PluginToolDefinition[];
		declarations: PluginToolDeclaration[];
		/** Optional serializable snapshot persisted by the core for restart restore. */
		snapshot?: DiscoveredToolSnapshot[];
	}>;
	/**
	 * Optional: rebuild previously-discovered tools from a serialized snapshot, without
	 * contacting the remote server. Used at startup for plugins with `skipRefreshOnRestart`.
	 */
	rehydrateTools?: (
		config: ToolConfigValues,
		env: Record<string, string | undefined>,
		snapshot: DiscoveredToolSnapshot[]
	) =>
		| { tools: PluginToolDefinition[]; declarations: PluginToolDeclaration[] }
		| Promise<{ tools: PluginToolDefinition[]; declarations: PluginToolDeclaration[] }>;
	/** Optional: OAuth handlers for per-user authentication. */
	oauthHandlers?: PluginOAuthHandlers;
}
