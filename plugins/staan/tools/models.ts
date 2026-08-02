/**
 * Types for the Staan Web Search tool.
 *
 * API reference: https://docs.staan.ai/docs/web-for-ai
 */

import type { Source } from '../../../src/types';

/** Plugin config saved via the admin UI (all optional, sane defaults applied). */
export interface StaanPluginConfig {
	/** Staan API key. Falls back to the STAAN_API_KEY env var when empty. */
	apiKey?: string;
	defaultMarket?: string;
	maxSnippets?: number;
	minScore?: number;
	allowFullContent?: boolean;
	maxFullContentChars?: number;
}

/** Tool input parameters (LLM-facing). */
export interface StaanSearchParams {
	q: string;
	offset?: number;
	market?: string;
	extra_snippets?: boolean;
	full_content?: boolean;
	max_snippets?: number;
	min_score?: number;
}

/** A semantically scored content chunk extracted from a result page. */
export interface StaanExtraSnippet {
	chunk: string;
	score: number;
}

export interface StaanFullContent {
	text: string;
	format: string;
	length: number;
}

export interface StaanWebResult {
	title: string;
	url: string;
	snippet: string;
	display_url?: string;
	hostname?: string;
	published_date?: string;
	extra_snippets?: StaanExtraSnippet[];
	full_content?: StaanFullContent;
}

export interface StaanSearchResponse {
	search_id?: string;
	query?: {
		q: string;
		market?: string;
		count?: number;
		offset?: number;
	};
	web?: {
		results?: StaanWebResult[];
	};
}

/** Tool result: `sources` is for UI citation display, `results` for the LLM. */
export interface StaanSearchResult {
	message: string;
	sources?: Source[];
	results?: Array<{
		title: string;
		url: string;
		snippet: string;
		hostname?: string;
		publishedDate?: string;
		chunks?: StaanExtraSnippet[];
		fullContent?: string;
	}>;
}
