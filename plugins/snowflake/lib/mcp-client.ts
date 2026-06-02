/**
 * Minimal JSON-RPC 2.0 over HTTP client for the Snowflake managed MCP server.
 *
 * The Snowflake Cortex MCP server speaks the MCP "Streamable HTTP" transport:
 * POST a JSON-RPC envelope to the MCP URL, accept either a JSON response
 * (single shot) or a text/event-stream (server-sent events). We only support
 * the single-shot JSON path here — Cortex tool calls return promptly.
 *
 * Keeping this fetch-based avoids pulling @modelcontextprotocol/sdk into the
 * open-source playground's dependency tree (the playground's existing plugins
 * all use raw fetch).
 */

import type { ToolConfigValues } from '../../../src/types';
import { resolveMcpUrl, resolveTimeoutMs } from './oauth';

export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
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
	isError?: boolean;
	[key: string]: unknown;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: string;
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

function newRequestId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parse either a plain JSON response or a single-event SSE stream emitted by
 * the MCP server. The Streamable HTTP transport may legitimately send either,
 * depending on the server's response Content-Type.
 */
async function parseMcpResponse<T>(res: Response): Promise<JsonRpcResponse<T>> {
	const contentType = res.headers.get('content-type') || '';
	const raw = await res.text();
	if (contentType.includes('application/json')) {
		return JSON.parse(raw) as JsonRpcResponse<T>;
	}
	if (contentType.includes('text/event-stream')) {
		const dataLines = raw
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart());
		const joined = dataLines.join('\n');
		if (!joined) {
			throw new Error('Snowflake MCP returned an empty SSE response');
		}
		return JSON.parse(joined) as JsonRpcResponse<T>;
	}
	try {
		return JSON.parse(raw) as JsonRpcResponse<T>;
	} catch {
		throw new Error(`Snowflake MCP returned an unparseable response (${contentType}): ${raw}`);
	}
}

async function mcpCall<T>(
	url: string,
	token: string,
	method: string,
	params: unknown,
	timeoutMs: number
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const requestBody: JsonRpcRequest = {
		jsonrpc: '2.0',
		id: newRequestId(),
		method,
		params
	};

	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify(requestBody)
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`Snowflake MCP HTTP error (${res.status}): ${text || res.statusText}`);
		}
		const parsed = await parseMcpResponse<T>(res);
		if ('error' in parsed) {
			throw new Error(
				`Snowflake MCP JSON-RPC error (${parsed.error.code}): ${parsed.error.message}`
			);
		}
		return parsed.result;
	} catch (err) {
		if (controller.signal.aborted) {
			throw new Error(`Snowflake MCP request timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

export async function listTools(
	config: ToolConfigValues,
	token: string
): Promise<McpToolDescriptor[]> {
	const result = await mcpCall<{ tools: McpToolDescriptor[] }>(
		resolveMcpUrl(config),
		token,
		'tools/list',
		{},
		resolveTimeoutMs(config)
	);
	return result.tools || [];
}

export async function callTool(
	config: ToolConfigValues,
	token: string,
	name: string,
	args: Record<string, unknown>
): Promise<McpToolCallResult> {
	return mcpCall<McpToolCallResult>(
		resolveMcpUrl(config),
		token,
		'tools/call',
		{ name, arguments: args },
		resolveTimeoutMs(config)
	);
}
