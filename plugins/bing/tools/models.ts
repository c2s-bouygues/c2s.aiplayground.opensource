import type { Source } from '../../../src/types';

export interface SearchBingParams {
	q: string;
}

export interface ResponsesApiOutput {
	type: string;
	role?: string;
	content?: Array<{ type: string; text?: string }>;
}

export interface ResponsesApiResponse {
	output?: ResponsesApiOutput[];
	status?: string;
	error?: { message: string };
}

/** Structured response format returned by the Foundry agent */
export interface AgentSource {
	id: string;
	rank: number;
	title: string;
	url: string | null;
	domain: string | null;
	content: string;
	date: string | null;
	author: string | null;
	publisher: string | null;
	type: string | null;
}

export interface AgentError {
	code: string;
	message: string;
	details: string | null;
}

export interface AgentStructuredResponse {
	query: string;
	message: string;
	sources?: AgentSource[] | null;
	errors?: AgentError[];
}

/** Structured result returned to the application */
export interface SearchBingResult {
	message: string;
	sources?: Source[];
}
