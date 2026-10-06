/**
 * Minimal MCP "Streamable HTTP" client for the Atlassian MCP Server (JSON-RPC 2.0).
 *
 * The Atlassian server is session-based: an `initialize` handshake returns an
 * `Mcp-Session-Id` header that must accompany subsequent requests. Sessions are
 * cached per Authorization header (i.e. per user token) and transparently
 * re-established when the server answers 404 (expired session).
 *
 * Responses may arrive as plain JSON or as a single-event SSE stream; both are
 * handled. Fetch-based on purpose: the playground does not depend on
 * @modelcontextprotocol/sdk.
 */

import type { ToolConfigValues } from '../../../src/types';
import { resolveMcpUrl, resolveTimeoutMs } from './config';

const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolDescriptor {
	name: string;
	title?: string;
	description?: string;
	inputSchema: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
	annotations?: Record<string, unknown>;
}

export interface McpPromptDescriptor {
	name: string;
	title?: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface McpToolCallResult {
	content: McpContentItem[];
	structuredContent?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string;
	method: string;
	params?: unknown;
}

interface JsonRpcSuccess<T> {
	jsonrpc: '2.0';
	id: string;
	result: T;
}

interface JsonRpcError {
	jsonrpc: '2.0';
	id: string;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

/** Session id cache keyed by `${url}|${authHeader}`. */
const sessions = new Map<string, string>();

function sessionKey(url: string, authHeader: string): string {
	return `${url}|${authHeader}`;
}

function newRequestId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


/** Build a 401 message that carries what Atlassian actually said (WWW-Authenticate + body). */
function unauthorizedMessage(res: Response, text: string): string {
	const www = res.headers.get('www-authenticate') ?? '';
	const detail = [www, text.trim()].filter(Boolean).join(' | ').slice(0, 600);
	return `Atlassian MCP rejected the credentials (401). Reconnect or check the API token.${detail ? ` Details: ${detail}` : ''}`;
}

export class McpHttpError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'McpHttpError';
	}
}

async function parseMcpResponse<T>(res: Response): Promise<JsonRpcResponse<T> | null> {
	if (res.status === 202 || res.status === 204) return null;
	const contentType = res.headers.get('content-type') || '';
	const raw = await res.text();
	if (!raw.trim()) return null;
	if (contentType.includes('text/event-stream')) {
		// Return the first JSON-RPC message carrying a `result` or `error`.
		const events = raw.split(/\r?\n\r?\n/);
		for (const event of events) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (!data) continue;
			try {
				const msg = JSON.parse(data) as JsonRpcResponse<T>;
				if ('result' in msg || 'error' in msg) return msg;
			} catch {
				// skip malformed / notification events
			}
		}
		throw new Error('Atlassian MCP returned an SSE stream without a JSON-RPC response');
	}
	try {
		return JSON.parse(raw) as JsonRpcResponse<T>;
	} catch {
		throw new Error(`Atlassian MCP returned an unparseable response (${contentType}): ${raw.slice(0, 500)}`);
	}
}

async function rawPost(
	url: string,
	authHeader: string,
	sessionId: string | undefined,
	body: JsonRpcRequest,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const headers: Record<string, string> = {
		Authorization: authHeader,
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': PROTOCOL_VERSION
	};
	if (sessionId) headers['Mcp-Session-Id'] = sessionId;
	try {
		return await fetch(url, {
			method: 'POST',
			signal: controller.signal,
			headers,
			body: JSON.stringify(body)
		});
	} catch (err) {
		if (controller.signal.aborted) {
			throw new Error(`Atlassian MCP request timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function initialize(url: string, authHeader: string, timeoutMs: number): Promise<string | undefined> {
	const res = await rawPost(
		url,
		authHeader,
		undefined,
		{
			jsonrpc: '2.0',
			id: newRequestId(),
			method: 'initialize',
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'ai-playground-atlassian-plugin', version: '1.0.0' }
			}
		},
		timeoutMs
	);
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new McpHttpError(
			res.status,
			res.status === 401
				? unauthorizedMessage(res, text)
				: `Atlassian MCP initialize failed (${res.status}): ${text || res.statusText}`
		);
	}
	const parsed = await parseMcpResponse<unknown>(res);
	if (parsed && 'error' in parsed) {
		throw new Error(`Atlassian MCP initialize error (${parsed.error.code}): ${parsed.error.message}`);
	}
	const sessionId = res.headers.get('mcp-session-id') ?? undefined;
	// notifications/initialized — fire and forget (server answers 202).
	await rawPost(
		url,
		authHeader,
		sessionId,
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		timeoutMs
	).catch(() => undefined);
	return sessionId;
}

async function ensureSession(url: string, authHeader: string, timeoutMs: number): Promise<string | undefined> {
	const key = sessionKey(url, authHeader);
	if (sessions.has(key)) return sessions.get(key);
	const sessionId = await initialize(url, authHeader, timeoutMs);
	if (sessionId) sessions.set(key, sessionId);
	return sessionId;
}

async function mcpCall<T>(
	config: ToolConfigValues,
	authHeader: string,
	method: string,
	params: unknown,
	retry = true
): Promise<T> {
	const url = resolveMcpUrl(config);
	const timeoutMs = resolveTimeoutMs(config);
	const sessionId = await ensureSession(url, authHeader, timeoutMs);

	const res = await rawPost(
		url,
		authHeader,
		sessionId,
		{ jsonrpc: '2.0', id: newRequestId(), method, params },
		timeoutMs
	);

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		// 404 = unknown/expired session → re-initialize once.
		if ((res.status === 404 || res.status === 400) && retry && sessionId) {
			sessions.delete(sessionKey(url, authHeader));
			return mcpCall<T>(config, authHeader, method, params, false);
		}
		if (res.status === 401) {
			sessions.delete(sessionKey(url, authHeader));
			throw new McpHttpError(401, unauthorizedMessage(res, text));
		}
		if (res.status === 429) {
			const retryAfter = res.headers.get('retry-after');
			throw new McpHttpError(
				429,
				`Atlassian MCP rate limit reached${retryAfter ? ` (retry after ${retryAfter}s)` : ''}.`
			);
		}
		throw new McpHttpError(res.status, `Atlassian MCP HTTP error (${res.status}): ${text || res.statusText}`);
	}

	const parsed = await parseMcpResponse<T>(res);
	if (!parsed) {
		throw new Error(`Atlassian MCP returned an empty response for ${method}`);
	}
	if ('error' in parsed) {
		throw new Error(`Atlassian MCP JSON-RPC error (${parsed.error.code}): ${parsed.error.message}`);
	}
	return parsed.result;
}

/** List every tool, following `nextCursor` pagination (used by `?tools=all`). */
export async function listTools(config: ToolConfigValues, authHeader: string): Promise<McpToolDescriptor[]> {
	const all: McpToolDescriptor[] = [];
	let cursor: string | undefined;
	do {
		const result = await mcpCall<{ tools: McpToolDescriptor[]; nextCursor?: string }>(
			config,
			authHeader,
			'tools/list',
			cursor ? { cursor } : {}
		);
		all.push(...(result.tools ?? []));
		cursor = result.nextCursor || undefined;
	} while (cursor && all.length < 2000);
	return all;
}

export async function callTool(
	config: ToolConfigValues,
	authHeader: string,
	name: string,
	args: Record<string, unknown>
): Promise<McpToolCallResult> {
	return mcpCall<McpToolCallResult>(config, authHeader, 'tools/call', { name, arguments: args });
}

export async function listPrompts(config: ToolConfigValues, authHeader: string): Promise<McpPromptDescriptor[]> {
	const all: McpPromptDescriptor[] = [];
	let cursor: string | undefined;
	do {
		const result = await mcpCall<{ prompts: McpPromptDescriptor[]; nextCursor?: string }>(
			config,
			authHeader,
			'prompts/list',
			cursor ? { cursor } : {}
		);
		all.push(...(result.prompts ?? []));
		cursor = result.nextCursor || undefined;
	} while (cursor && all.length < 500);
	return all;
}

export async function getPrompt(
	config: ToolConfigValues,
	authHeader: string,
	name: string,
	args?: Record<string, string>
): Promise<string> {
	const result = await mcpCall<{
		description?: string;
		messages: Array<{ role: string; content: McpContentItem | McpContentItem[] }>;
	}>(config, authHeader, 'prompts/get', { name, arguments: args ?? {} });
	return (result.messages ?? [])
		.map((m) => {
			const items = Array.isArray(m.content) ? m.content : [m.content];
			return items
				.map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
				.filter(Boolean)
				.join('\n');
		})
		.filter(Boolean)
		.join('\n\n');
}
