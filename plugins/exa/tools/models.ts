import type { Source } from '../../../src/types';

export interface SearchExaParams {
	q: string;
	numResults?: number;
}

export interface ExaSearchResult {
	id: string;
	title?: string | null;
	url: string;
	publishedDate?: string | null;
	author?: string | null;
	score?: number | null;
	text?: string | null;
	highlights?: string[] | null;
	highlightScores?: number[] | null;
}

export interface ExaSearchResponse {
	requestId?: string;
	autopromptString?: string;
	results?: ExaSearchResult[];
}

export interface ExaErrorResponse {
	error?: string | { message?: string };
	message?: string;
}

export interface SearchExaResult {
	message: string;
	sources?: Source[];
	content?: string;
}
