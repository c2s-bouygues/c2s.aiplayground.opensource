/**
 * Cost estimation for the VLM-vs-OCR comparison (extract_fields compareWithOcr).
 *
 * Token prices for the extraction LLM come from the public OpenRouter catalog
 * (https://openrouter.ai/api/v1/models — per-token USD prices as strings),
 * cached in-module for 24h. The model-matching strategy is a trimmed port of
 * the host's model-pricing.ts (exact id → version-normalized → substring →
 * longest boundary-delimited reverse match), restricted to the `anthropic/`
 * prefix since the extraction connector speaks the Anthropic Messages API.
 *
 * Mistral OCR is billed PER PAGE, not per token, and is not listed on
 * OpenRouter (it is not a chat model): its price is a constant — default
 * $1 / 1000 pages, the price of `mistral-ocr-2503`, the plugin's default OCR
 * model — overridable via the plugin config (`ocrPricePerPage`, USD per page).
 *
 * Everything here is best-effort and never throws: on fetch failure the cost
 * simply stays unknown (null) and the panel shows token counts without prices.
 */

import type { TokenUsage } from './extraction';

/** $1 / 1000 pages — Mistral OCR (mistral-ocr-2503, the plugin default). */
export const DEFAULT_OCR_PRICE_PER_PAGE_USD = 0.001;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANTHROPIC_PREFIX = 'anthropic/';

interface PricedModel {
	/** OpenRouter model id (lowercase, e.g. "anthropic/claude-haiku-4.5"). */
	id: string;
	/** USD per input token. */
	inputPrice: number;
	/** USD per output token. */
	outputPrice: number;
}

/** Cost breakdown of one VLM-vs-OCR comparison, all amounts in USD. */
export interface ComparisonCost {
	currency: 'USD';
	/** OpenRouter id the configured LLM model was matched to (panel note). */
	pricingModel: string;
	/** Token prices, USD per million tokens (panel note). */
	inputPerMTok: number;
	outputPerMTok: number;
	ocrPricePerPage: number;
	/** LLM cost of the vision extraction (= total of the VLM approach). */
	vlmLlmUsd: number;
	/** LLM cost of the text extraction over the OCR markdown. */
	ocrLlmUsd: number;
	/** Mistral OCR pass (pages × per-page price). */
	ocrPagesUsd: number;
	vlmTotalUsd: number;
	/** Total of the OCR approach: Mistral OCR pass + text-extraction LLM. */
	ocrTotalUsd: number;
}

let cache: { models: PricedModel[]; fetchedAt: number } | null = null;

/**
 * Anthropic entries of the OpenRouter catalog, from the in-module cache when
 * fresh (< 24h). Never throws: a failed fetch falls back to the stale cache,
 * then to null (cost stays unknown).
 */
async function getAnthropicModels(): Promise<PricedModel[] | null> {
	if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models;
	try {
		const response = await fetch(OPENROUTER_MODELS_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);
		const data = (await response.json()) as {
			data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
		};
		const models = (data.data ?? [])
			.filter(
				(m): m is { id: string; pricing: { prompt: string; completion: string } } =>
					typeof m.id === 'string' &&
					m.id.toLowerCase().startsWith(ANTHROPIC_PREFIX) &&
					typeof m.pricing?.prompt === 'string' &&
					typeof m.pricing?.completion === 'string'
			)
			.map((m) => ({
				id: m.id.toLowerCase(),
				inputPrice: parseFloat(m.pricing.prompt),
				outputPrice: parseFloat(m.pricing.completion)
			}))
			.filter((m) => Number.isFinite(m.inputPrice) && Number.isFinite(m.outputPrice));
		if (models.length === 0) throw new Error('OpenRouter catalog without anthropic entries');
		cache = { models, fetchedAt: Date.now() };
		return models;
	} catch {
		return cache?.models ?? null;
	}
}

/**
 * True when `needle` occurs in `haystack` delimited by non-alphanumeric
 * boundaries (start/end count as boundaries) — prevents `claude-3` from
 * matching inside `claude-3-5` while still matching `claude-3-opus`.
 */
function containsAtBoundary(haystack: string, needle: string): boolean {
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return false;
		const before = idx === 0 ? '' : haystack[idx - 1];
		const after = idx + needle.length >= haystack.length ? '' : haystack[idx + needle.length];
		if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
		from = idx + 1;
	}
	return false;
}

/**
 * Match the configured extraction model to an OpenRouter anthropic entry —
 * same ladder as the host's findPricingEntry: exact id, version-normalized
 * (`-4-5` → `-4.5`), substring, then longest boundary-delimited reverse match
 * (Azure deployments often suffix the catalog name).
 */
export function findAnthropicPricing(models: PricedModel[], model: string): PricedModel | null {
	const modelLower = model.toLowerCase();
	const byId = new Map(models.map((m) => [m.id, m]));

	const exact = byId.get(ANTHROPIC_PREFIX + modelLower);
	if (exact) return exact;

	const normalized = modelLower.replace(/-(\d+)-(\d+)/g, '-$1.$2');
	const normalizedHit = byId.get(ANTHROPIC_PREFIX + normalized);
	if (normalizedHit) return normalizedHit;

	for (const m of models) {
		if (m.id.includes(modelLower) || m.id.includes(normalized)) return m;
	}

	let reverseMatch: PricedModel | null = null;
	let reverseMatchLength = 0;
	for (const m of models) {
		const shortId = m.id.slice(ANTHROPIC_PREFIX.length);
		if (shortId.length <= reverseMatchLength) continue;
		if (containsAtBoundary(modelLower, shortId) || containsAtBoundary(normalized, shortId)) {
			reverseMatch = m;
			reverseMatchLength = shortId.length;
		}
	}
	return reverseMatch;
}

/**
 * Estimate the USD cost of both sides of a comparison run. Returns null when
 * the OpenRouter catalog is unreachable or the model is unknown there —
 * callers then simply omit the cost (token counts remain).
 */
export async function estimateComparisonCost(
	llmModel: string,
	usage: { vlm?: TokenUsage; ocr?: TokenUsage },
	ocrPageCount: number,
	ocrPricePerPage?: number
): Promise<ComparisonCost | null> {
	const models = await getAnthropicModels();
	if (!models) return null;
	const priced = findAnthropicPricing(models, llmModel);
	if (!priced) return null;

	const perPage =
		typeof ocrPricePerPage === 'number' && Number.isFinite(ocrPricePerPage) && ocrPricePerPage >= 0
			? ocrPricePerPage
			: DEFAULT_OCR_PRICE_PER_PAGE_USD;
	const llmCost = (u?: TokenUsage) =>
		u ? u.inputTokens * priced.inputPrice + u.outputTokens * priced.outputPrice : 0;

	const vlmLlmUsd = llmCost(usage.vlm);
	const ocrLlmUsd = llmCost(usage.ocr);
	const ocrPagesUsd = Math.max(0, ocrPageCount) * perPage;
	return {
		currency: 'USD',
		pricingModel: priced.id,
		inputPerMTok: priced.inputPrice * 1_000_000,
		outputPerMTok: priced.outputPrice * 1_000_000,
		ocrPricePerPage: perPage,
		vlmLlmUsd,
		ocrLlmUsd,
		ocrPagesUsd,
		vlmTotalUsd: vlmLlmUsd,
		ocrTotalUsd: ocrLlmUsd + ocrPagesUsd
	};
}
