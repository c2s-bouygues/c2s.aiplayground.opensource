// Connexion a Volubile: cle API, jeton de lecture en cache, requetes et format des reponses.
import type { PluginContext } from '../../../src/types';
import { isRecord } from './shared';

const API_BASE_URL = 'https://api.eu.volubile.ai';
export const REQUEST_TIMEOUT_MS = 20_000;

const READ_SCOPES = ['agents:read', 'calls:read', 'campaigns:read'];

interface ApiTokenResponse {
	token?: string;
	expiresIn?: number;
}

interface ToolResult<T> {
	success: boolean;
	message: string;
	data?: T;
}

function getApiKey(context: PluginContext): string {
	const apiKey = context.env.VOLUBILE_API_KEY?.trim();
	if (!apiKey) throw new Error('VOLUBILE_API_KEY est manquante dans la configuration serveur.');
	return apiKey;
}

function messageFor(context: PluginContext, french: string, english: string): string {
	return context.locale === 'en' ? english : french;
}

class VolubileApiError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

async function apiError(response: Response): Promise<VolubileApiError> {
	let detail = '';
	try {
		const payload: unknown = await response.json();
		if (isRecord(payload) && typeof payload.message === 'string') {
			detail = `: ${payload.message}`;
		}
	} catch {
		// Corps de reponse absent ou non JSON: on garde seulement le code HTTP.
	}
	return new VolubileApiError(`Volubile a repondu HTTP ${response.status}${detail}`, response.status);
}

// Volubile limite la creation de jetons a 10 par minute et par cle API, et recommande
// de reutiliser un jeton jusqu'a son expiration. Le jeton reste en memoire serveur:
// il n'est jamais renvoye a l'IA, et il est limite a la lecture.
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const TOKEN_RENEWAL_MARGIN_MS = 60_000;

interface CachedToken {
	apiKey: string;
	token: string;
	expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingToken: { apiKey: string; promise: Promise<CachedToken> } | null = null;

async function getReadOnlyToken(apiKey: string): Promise<string> {
	if (cachedToken && cachedToken.apiKey === apiKey && Date.now() < cachedToken.expiresAt - TOKEN_RENEWAL_MARGIN_MS) {
		return cachedToken.token;
	}
	// Si plusieurs outils demandent un jeton en meme temps, un seul est cree.
	if (!pendingToken || pendingToken.apiKey !== apiKey) {
		const promise = issueReadOnlyToken(apiKey)
			.then(({ token, expiresIn }) => {
				const lifetimeSeconds =
					typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
						? expiresIn
						: DEFAULT_TOKEN_LIFETIME_SECONDS;
				cachedToken = { apiKey, token, expiresAt: Date.now() + lifetimeSeconds * 1000 };
				return cachedToken;
			})
			.finally(() => {
				if (pendingToken?.promise === promise) pendingToken = null;
			});
		pendingToken = { apiKey, promise };
	}
	return (await pendingToken.promise).token;
}

function forgetToken(token: string): void {
	if (cachedToken?.token === token) cachedToken = null;
}

/** Lit une route Volubile avec le jeton en cache; si Volubile le refuse (401), en cree un nouveau une seule fois. */
export async function readJson<T>(
	context: PluginContext,
	path: string,
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
	const apiKey = getApiKey(context);
	const token = await getReadOnlyToken(apiKey);
	try {
		return await getJson<T>(token, path, timeoutMs);
	} catch (error) {
		if (!(error instanceof VolubileApiError) || error.status !== 401) throw error;
		forgetToken(token);
		return getJson<T>(await getReadOnlyToken(apiKey), path, timeoutMs);
	}
}

async function issueReadOnlyToken(apiKey: string): Promise<{ token: string; expiresIn?: number }> {
	const response = await fetch(`${API_BASE_URL}/v1/auth/token`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-Api-Key': apiKey
		},
		body: JSON.stringify({ scope: READ_SCOPES }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});

	if (!response.ok) throw await apiError(response);

	const payload = (await response.json()) as ApiTokenResponse;
	if (!payload.token) throw new Error("Volubile n'a pas renvoye de jeton de lecture.");
	return { token: payload.token, expiresIn: payload.expiresIn };
}

async function getJson<T>(accessToken: string, path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${accessToken}`
		},
		signal: AbortSignal.timeout(timeoutMs)
	});

	if (!response.ok) throw await apiError(response);
	return (await response.json()) as T;
}

export async function runTool<T>(
	context: PluginContext,
	toolName: string,
	operation: () => Promise<T>
): Promise<ToolResult<T>> {
	try {
		const data = await operation();
		context.logger.info('Volubile read completed', { tool: toolName });
		return {
			success: true,
			message: messageFor(context, 'Lecture Volubile terminee.', 'Volubile read completed.'),
			data
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Erreur inconnue';
		context.logger.error('Volubile read failed', { tool: toolName, message });
		return {
			success: false,
			message: messageFor(
				context,
				`Impossible de lire les donnees Volubile: ${message}`,
				`Unable to read Volubile data: ${message}`
			)
		};
	}
}
