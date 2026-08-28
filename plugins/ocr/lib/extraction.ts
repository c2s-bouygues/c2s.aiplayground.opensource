/**
 * Field-extraction engine — port of IdeaStudio.MagicOcrV2 (`server/services/ocr.ts`).
 *
 * VLM-based structured field extraction: the document (image or PDF) is sent
 * inline (base64) to the Anthropic Messages API together with a French prompt
 * describing the fields to extract; the model answers with a JSON payload
 * (fields, per-field confidences, errors, warnings, coherence-check results).
 *
 * Kept fetch-based (no `@anthropic-ai/sdk` dependency) to match the other
 * playground plugins. Works against api.anthropic.com or any Anthropic-
 * compatible proxy (e.g. the "Azure AI" proxy MagicOCR uses in production).
 *
 * Faithful ports from MagicOCR:
 * - `buildExtractionPrompt` (prompt text extended with a per-field provenance
 *   contract: `fieldSources` — page number + short exact quote — rendered by
 *   the extraction panel as verifiable "p. N" links)
 * - required-field post-validation
 * - double extraction: two independent calls merged field by field with
 *   confidence penalties (×0.8 when only one call found a value, ×0.6 on
 *   divergence) and coherence results merged by name.
 * Errors never throw out of the extraction functions: they degrade into a
 * result with `confidence: 0` and an `errors` entry (MagicOCR behavior).
 */

import { foldText } from './result-store';

export interface TemplateField {
	name: string;
	type: 'text' | 'number' | 'date' | 'email';
	required?: boolean;
	validationRule?: string;
}

export interface CoherenceCheck {
	name: string;
	rule: string;
}

export interface CoherenceCheckResult {
	name: string;
	passed: boolean;
	message: string;
}

/** Where a field's value was found in the document (model-reported, verifiable). */
export interface FieldSource {
	/** 1-based page number; null when the model could not tell. */
	page: number | null;
	/** Short exact quote of the passage containing the value; null when unknown. */
	quote: string | null;
	/**
	 * Set by verifyFieldSources when OCR text is available: true when the quote
	 * was found in the OCR text (page corrected if needed), false when it was
	 * not. Absent when no OCR text was available to check against.
	 */
	verified?: boolean;
}

export interface ExtractionResult {
	fields: Record<string, unknown>;
	confidence: number;
	fieldConfidences: Record<string, number>;
	/** Per-field provenance (absent when the model returned none). */
	fieldSources?: Record<string, FieldSource>;
	errors: string[];
	warnings: string[];
	coherenceCheckResults: CoherenceCheckResult[];
	/** true when the LLM call itself failed (transport/parse) — no data at all. */
	failed?: boolean;
}

export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/** Anthropic Messages content block for the document being analyzed. */
export type DocumentBlock =
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

const LLM_TIMEOUT_MS = 120_000;
// MagicOCR used 4096; the provenance quotes (fieldSources) lengthen the answer.
const MAX_TOKENS = 8192;
/** Provenance quotes are display material — keep them bounded whatever the model does. */
const MAX_SOURCE_QUOTE_CHARS = 200;
const ANTHROPIC_VERSION = '2023-06-01';

export const IMAGE_MEDIA_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp'
]);

/** Build the content block for a conversation file, or null if unsupported. */
export function buildDocumentBlock(buffer: Buffer, contentType: string): DocumentBlock | null {
	const mediaType = (contentType || '').split(';')[0].trim().toLowerCase();
	if (mediaType === 'application/pdf') {
		return {
			type: 'document',
			source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }
		};
	}
	if (IMAGE_MEDIA_TYPES.has(mediaType)) {
		return {
			type: 'image',
			source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') }
		};
	}
	return null;
}

/** Shared tail of the extraction prompts (field list, rules, JSON contract). */
function buildPromptTail(fields: TemplateField[], coherenceChecks: CoherenceCheck[]): string {
	const fieldDescriptions = fields
		.map((f) => {
			let desc = `- "${f.name}" (type: ${f.type}${f.required ? ', obligatoire' : ', optionnel'})`;
			if (f.validationRule) desc += ` - Règle: ${f.validationRule}`;
			return desc;
		})
		.join('\n');

	const coherenceDesc =
		coherenceChecks.length > 0
			? `\n\nRègles de cohérence à vérifier:\n${coherenceChecks.map((c) => `- ${c.name}: ${c.rule}`).join('\n')}`
			: '';

	return `Champs à extraire:
${fieldDescriptions}
${coherenceDesc}

Instructions:
1. Extrait chaque champ demandé depuis le document
2. Pour les champs de type "number", ne garde que la valeur numérique
3. Pour les champs de type "date", utilise le format YYYY-MM-DD
4. Pour les champs de type "email", vérifie qu'il s'agit d'un email valide
5. Si un champ n'est pas trouvé, indique null
6. Indique ton niveau de confiance (0-100) pour chaque champ
7. Vérifie les règles de cohérence si présentes
8. Pour chaque champ trouvé, indique dans fieldSources la page où la valeur apparaît (numéro à partir de 1) et une citation courte et EXACTE du passage contenant la valeur (moins de 150 caractères, texte tel qu'il apparaît dans le document) ; utilise null quand tu ne peux pas le déterminer

Réponds UNIQUEMENT avec un JSON valide dans ce format exact:
{
  "fields": {
    "Nom du champ": "valeur extraite ou null"
  },
  "confidence": 85,
  "fieldConfidences": {
    "Nom du champ": 90
  },
  "fieldSources": {
    "Nom du champ": { "page": 1, "quote": "citation exacte du passage" }
  },
  "errors": ["liste des erreurs détectées"],
  "warnings": ["liste des avertissements"],
  "coherenceCheckResults": [
    {
      "name": "Nom du contrôle",
      "passed": true,
      "message": "Description du résultat"
    }
  ]
}`;
}

/** Prompt ported from MagicOcrV2 `buildExtractionPrompt` (vision input), extended with fieldSources. */
export function buildExtractionPrompt(
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): string {
	return `Tu es un expert en extraction de données de documents. Analyse ce document et extrait les informations demandées.

${buildPromptTail(fields, coherenceChecks)}`;
}

/** OCR-text budget for the text-based extraction prompt (~100k tokens). */
const MAX_TEXT_PROMPT_CHARS = 400_000;

/** Same contract as the vision prompt, but the input is the OCR'd text. */
export function buildTextExtractionPrompt(
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[],
	documentText: string
): string {
	const text =
		documentText.length > MAX_TEXT_PROMPT_CHARS
			? `${documentText.slice(0, MAX_TEXT_PROMPT_CHARS)}\n[…texte tronqué]`
			: documentText;
	return `Tu es un expert en extraction de données de documents. Analyse le TEXTE de document suivant (obtenu par OCR) et extrait les informations demandées. Les pages sont délimitées par des marqueurs « --- Page N --- » : utilise-les pour renseigner les numéros de page de fieldSources.

Texte du document:
---
${text}
---

${buildPromptTail(fields, coherenceChecks)}`;
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Coerce the model's parsed JSON into a well-formed ExtractionResult. */
function normalizeResult(parsed: Record<string, unknown>): ExtractionResult {
	const rawChecks = Array.isArray(parsed.coherenceCheckResults) ? parsed.coherenceCheckResults : [];
	const coherenceCheckResults: CoherenceCheckResult[] = rawChecks
		.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
		.map((c) => ({
			name: typeof c.name === 'string' ? c.name : '?',
			passed: c.passed === true,
			message: typeof c.message === 'string' ? c.message : ''
		}));

	const fieldConfidences: Record<string, number> = {};
	if (typeof parsed.fieldConfidences === 'object' && parsed.fieldConfidences !== null) {
		for (const [key, value] of Object.entries(parsed.fieldConfidences)) {
			fieldConfidences[key] = toNumber(value, 0);
		}
	}

	// Provenance: keep only well-formed entries; cap quotes (display material).
	const fieldSources: Record<string, FieldSource> = {};
	if (typeof parsed.fieldSources === 'object' && parsed.fieldSources !== null) {
		for (const [key, value] of Object.entries(parsed.fieldSources as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null) continue;
			const v = value as Record<string, unknown>;
			const page =
				typeof v.page === 'number' && Number.isFinite(v.page) && v.page >= 1
					? Math.round(v.page)
					: null;
			const quote =
				typeof v.quote === 'string' && v.quote.trim() !== ''
					? v.quote.slice(0, MAX_SOURCE_QUOTE_CHARS)
					: null;
			if (page !== null || quote !== null) fieldSources[key] = { page, quote };
		}
	}

	return {
		fields:
			typeof parsed.fields === 'object' && parsed.fields !== null
				? (parsed.fields as Record<string, unknown>)
				: {},
		confidence: toNumber(parsed.confidence, 0),
		fieldConfidences,
		...(Object.keys(fieldSources).length > 0 ? { fieldSources } : {}),
		errors: toStringArray(parsed.errors),
		warnings: toStringArray(parsed.warnings),
		coherenceCheckResults
	};
}

/**
 * Resolve the Messages route from the configured base URL:
 * - a URL already ending in /messages is used as-is (full route configured);
 * - a bare Azure AI Foundry base URL (https://<resource>.services.ai.azure.com)
 *   gets the Anthropic-compatible route `/anthropic/v1/messages`;
 * - anything else gets the Anthropic-native `/v1/messages`.
 */
export function buildMessagesUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	if (/\/messages$/i.test(trimmed)) return trimmed;
	try {
		const url = new URL(trimmed);
		if (
			(url.pathname === '' || url.pathname === '/') &&
			url.hostname.toLowerCase().endsWith('.services.ai.azure.com')
		) {
			return `${trimmed}/anthropic/v1/messages`;
		}
	} catch {
		// not a parseable URL — let fetch surface the error
	}
	return `${trimmed}/v1/messages`;
}

/** One Messages API round-trip; throws on transport/parse failure. */
async function callClaude(llm: LlmConfig, content: unknown[]): Promise<ExtractionResult> {
	const response = await fetch(buildMessagesUrl(llm.baseUrl), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			// Anthropic expects x-api-key; Azure AI Foundry accepts api-key —
			// sending both keeps one connector for both routes.
			'x-api-key': llm.apiKey,
			'api-key': llm.apiKey,
			'anthropic-version': ANTHROPIC_VERSION
		},
		body: JSON.stringify({
			model: llm.model,
			max_tokens: MAX_TOKENS,
			messages: [{ role: 'user', content }]
		}),
		signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
	}

	const data = (await response.json()) as {
		content?: Array<{ type?: string; text?: string }>;
		stop_reason?: string;
	};
	const text = (data.content ?? [])
		.filter((c) => c.type === 'text' && typeof c.text === 'string')
		.map((c) => c.text)
		.join('');

	// A max_tokens stop means the JSON answer was cut mid-stream: name the real
	// cause (too many fields in one call) instead of a cryptic parse error.
	const truncated = data.stop_reason === 'max_tokens';
	// MagicOCR parsing: first JSON object in the free-text answer.
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error(
			truncated
				? 'réponse tronquée (max_tokens atteint) — trop de champs demandés en un seul appel'
				: 'réponse du modèle sans JSON exploitable'
		);
	}
	try {
		return normalizeResult(JSON.parse(match[0]) as Record<string, unknown>);
	} catch (error) {
		if (truncated) {
			throw new Error(
				'réponse tronquée (max_tokens atteint) — trop de champs demandés en un seul appel'
			);
		}
		throw error;
	}
}

/**
 * Single extraction: LLM call + required-field post-validation.
 * Never throws — API/parse failures degrade into `{ confidence: 0, errors: [...] }`.
 */
export async function extractFromDocument(
	llm: LlmConfig,
	block: DocumentBlock,
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): Promise<ExtractionResult> {
	try {
		const result = await callClaude(llm, [
			block,
			{ type: 'text', text: buildExtractionPrompt(fields, coherenceChecks) }
		]);
		validateRequired(result, fields);
		return result;
	} catch (error) {
		return degradedResult(error);
	}
}

/**
 * Text-based extraction: same field contract, but the model reads the OCR'd
 * text instead of the document image. Used by the VLM-vs-OCR comparison mode.
 * Never throws — failures degrade like extractFromDocument.
 */
export async function extractFromText(
	llm: LlmConfig,
	documentText: string,
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): Promise<ExtractionResult> {
	try {
		const result = await callClaude(llm, [
			{ type: 'text', text: buildTextExtractionPrompt(fields, coherenceChecks, documentText) }
		]);
		validateRequired(result, fields);
		return result;
	} catch (error) {
		return degradedResult(error);
	}
}

function validateRequired(result: ExtractionResult, fields: TemplateField[]): void {
	for (const field of fields) {
		if (
			field.required &&
			(result.fields[field.name] === null || result.fields[field.name] === undefined)
		) {
			result.errors.push(`Champ obligatoire manquant: ${field.name}`);
		}
	}
}

function degradedResult(error: unknown): ExtractionResult {
	return {
		fields: {},
		confidence: 0,
		fieldConfidences: {},
		errors: [`Erreur d'extraction: ${error instanceof Error ? error.message : String(error)}`],
		warnings: [],
		coherenceCheckResults: [],
		failed: true
	};
}

/**
 * Double extraction with cross-validation (MagicOCR `extractWithDoubleValidation`):
 * two identical calls in parallel, then a field-by-field merge.
 */
export async function extractWithDoubleValidation(
	llm: LlmConfig,
	block: DocumentBlock,
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): Promise<ExtractionResult> {
	const [r1, r2] = await Promise.all([
		extractFromDocument(llm, block, fields, coherenceChecks),
		extractFromDocument(llm, block, fields, coherenceChecks)
	]);

	const merged: ExtractionResult = {
		fields: {},
		confidence: 0,
		fieldConfidences: {},
		errors: [...r1.errors, ...r2.errors],
		warnings: [...r1.warnings, ...r2.warnings],
		coherenceCheckResults: [],
		...(r1.failed && r2.failed ? { failed: true } : {})
	};
	const mergedSources: Record<string, FieldSource> = {};
	// The provenance follows the value that was kept.
	const keepSource = (name: string, from: ExtractionResult, fallback?: ExtractionResult) => {
		const source = from.fieldSources?.[name] ?? fallback?.fieldSources?.[name];
		if (source) mergedSources[name] = source;
	};

	for (const field of fields) {
		const name = field.name;
		const v1 = r1.fields[name] ?? null;
		const v2 = r2.fields[name] ?? null;
		const c1 = r1.fieldConfidences[name] ?? 0;
		const c2 = r2.fieldConfidences[name] ?? 0;

		if (JSON.stringify(v1) === JSON.stringify(v2)) {
			merged.fields[name] = v1;
			merged.fieldConfidences[name] = Math.max(c1, c2);
			keepSource(name, r1, r2);
		} else if (v1 === null) {
			merged.fields[name] = v2;
			merged.fieldConfidences[name] = c2 * 0.8;
			keepSource(name, r2);
			merged.warnings.push(`Champ "${name}": trouvé par une seule des deux extractions`);
		} else if (v2 === null) {
			merged.fields[name] = v1;
			merged.fieldConfidences[name] = c1 * 0.8;
			keepSource(name, r1);
			merged.warnings.push(`Champ "${name}": trouvé par une seule des deux extractions`);
		} else {
			const useFirst = c1 >= c2;
			merged.fields[name] = useFirst ? v1 : v2;
			merged.fieldConfidences[name] = (useFirst ? c1 : c2) * 0.6;
			keepSource(name, useFirst ? r1 : r2);
			merged.warnings.push(
				`Champ "${name}": divergence entre les deux extractions (${JSON.stringify(v1)} vs ${JSON.stringify(v2)})`
			);
		}
	}
	if (Object.keys(mergedSources).length > 0) merged.fieldSources = mergedSources;

	const confidences = Object.values(merged.fieldConfidences);
	merged.confidence =
		confidences.length > 0
			? Math.round(confidences.reduce((sum, c) => sum + c, 0) / confidences.length)
			: 0;

	// Coherence results merged by name (handles differing lengths).
	const byName = new Map<string, CoherenceCheckResult>();
	for (const check of r1.coherenceCheckResults) byName.set(check.name, { ...check });
	for (const check of r2.coherenceCheckResults) {
		const existing = byName.get(check.name);
		if (!existing) {
			byName.set(check.name, { ...check });
		} else if (existing.passed !== check.passed) {
			byName.set(check.name, {
				name: check.name,
				passed: false,
				message: `Divergence: ${existing.message} / ${check.message}`
			});
		}
	}
	merged.coherenceCheckResults = [...byName.values()];

	return merged;
}

/**
 * Merge the results of several field-batched extraction calls over the SAME
 * document into one ExtractionResult (large field lists — e.g. one field per
 * requirement — are split into bounded calls so the model's JSON answer never
 * hits max_tokens). Field maps are disjoint by construction; coherence checks
 * ride with the first batch only, so concatenation is a plain union. `failed`
 * survives only when every batch failed (partial results stay usable, the
 * per-batch degraded errors tell the rest).
 */
export function mergeBatchResults(results: ExtractionResult[]): ExtractionResult {
	const merged: ExtractionResult = {
		fields: {},
		confidence: 0,
		fieldConfidences: {},
		errors: [],
		warnings: [],
		coherenceCheckResults: []
	};
	const sources: Record<string, FieldSource> = {};
	let allFailed = results.length > 0;
	for (const result of results) {
		if (!result.failed) allFailed = false;
		Object.assign(merged.fields, result.fields);
		Object.assign(merged.fieldConfidences, result.fieldConfidences);
		if (result.fieldSources) Object.assign(sources, result.fieldSources);
		merged.errors.push(...result.errors);
		merged.warnings.push(...result.warnings);
		merged.coherenceCheckResults.push(...result.coherenceCheckResults);
	}
	if (Object.keys(sources).length > 0) merged.fieldSources = sources;
	const confidences = Object.values(merged.fieldConfidences);
	merged.confidence =
		confidences.length > 0
			? Math.round(confidences.reduce((sum, c) => sum + c, 0) / confidences.length)
			: 0;
	if (allFailed) merged.failed = true;
	return merged;
}

/** Accent/case-insensitive, whitespace-normalized form used for quote matching. */
function normalizeForMatch(text: string): string {
	return foldText(text).replace(/\s+/g, ' ').trim();
}

/**
 * Check the model-reported provenance quotes against the OCR'd page texts
 * (the only ground truth available): a quote found in a page marks the source
 * `verified: true` — trusting the OCR text over the model's page claim when
 * they disagree — and a quote found nowhere marks it `verified: false` (soft
 * signal rendered by the panel; confidence is deliberately NOT altered, since
 * a literal match can fail on legitimate OCR/VLM transcription differences).
 * Mutates `result.fieldSources` in place; no-op without sources or pages.
 */
export function verifyFieldSources(
	result: ExtractionResult,
	pages: Array<{ page: number; text: string }>
): void {
	if (!result.fieldSources || pages.length === 0) return;
	const normPages = pages.map((p) => ({ page: p.page, text: normalizeForMatch(p.text) }));
	for (const source of Object.values(result.fieldSources)) {
		if (!source.quote) continue;
		const needle = normalizeForMatch(source.quote);
		// Too short to be discriminating — matching would prove nothing.
		if (needle.length < 5) continue;
		const hits = normPages.filter((p) => p.text.includes(needle)).map((p) => p.page);
		if (hits.length === 0) {
			source.verified = false;
			continue;
		}
		source.verified = true;
		if (source.page === null || !hits.includes(source.page)) source.page = hits[0];
	}
}

/** Per-field detail of the VLM-vs-OCR comparison, rendered by the MCP App. */
export interface FieldComparison {
	name: string;
	vlmValue: unknown;
	ocrValue: unknown;
	vlmConfidence: number;
	ocrConfidence: number;
	/** true when both approaches produced the same value. */
	agree: boolean;
}

/**
 * Cross-modality validation (MagicOCR's double-extraction merge, applied to
 * two DIFFERENT approaches): the vision extraction (VLM reads the document
 * image) versus the text extraction (LLM reads the Mistral OCR markdown).
 * Same merge rules — agreement keeps the value at max confidence, a value
 * found by one side only is kept at ×0.8, a divergence keeps the most
 * confident value at ×0.6 with a warning — plus a per-field comparison table
 * for the panel. Coherence results are merged by name.
 */
export function compareExtractions(
	vlm: ExtractionResult,
	ocr: ExtractionResult,
	fields: TemplateField[]
): { result: ExtractionResult; comparison: FieldComparison[] } {
	const merged: ExtractionResult = {
		fields: {},
		confidence: 0,
		fieldConfidences: {},
		errors: [...vlm.errors, ...ocr.errors],
		warnings: [...vlm.warnings, ...ocr.warnings],
		coherenceCheckResults: []
	};
	const comparison: FieldComparison[] = [];
	const mergedSources: Record<string, FieldSource> = {};
	// The provenance follows the value that was kept.
	const keepSource = (name: string, from: ExtractionResult, fallback?: ExtractionResult) => {
		const source = from.fieldSources?.[name] ?? fallback?.fieldSources?.[name];
		if (source) mergedSources[name] = source;
	};

	for (const field of fields) {
		const name = field.name;
		const v = vlm.fields[name] ?? null;
		const o = ocr.fields[name] ?? null;
		const cv = vlm.fieldConfidences[name] ?? 0;
		const co = ocr.fieldConfidences[name] ?? 0;
		const agree = JSON.stringify(v) === JSON.stringify(o);
		comparison.push({ name, vlmValue: v, ocrValue: o, vlmConfidence: cv, ocrConfidence: co, agree });

		if (agree) {
			merged.fields[name] = v;
			merged.fieldConfidences[name] = Math.max(cv, co);
			keepSource(name, vlm, ocr);
		} else if (v === null) {
			merged.fields[name] = o;
			merged.fieldConfidences[name] = co * 0.8;
			keepSource(name, ocr);
			merged.warnings.push(`Champ "${name}": trouvé uniquement par l'extraction texte (OCR)`);
		} else if (o === null) {
			merged.fields[name] = v;
			merged.fieldConfidences[name] = cv * 0.8;
			keepSource(name, vlm);
			merged.warnings.push(`Champ "${name}": trouvé uniquement par l'extraction vision (VLM)`);
		} else {
			const useVlm = cv >= co;
			merged.fields[name] = useVlm ? v : o;
			merged.fieldConfidences[name] = (useVlm ? cv : co) * 0.6;
			keepSource(name, useVlm ? vlm : ocr);
			merged.warnings.push(
				`Champ "${name}": divergence VLM/OCR (${JSON.stringify(v)} vs ${JSON.stringify(o)})`
			);
		}
	}
	if (Object.keys(mergedSources).length > 0) merged.fieldSources = mergedSources;

	const confidences = Object.values(merged.fieldConfidences);
	merged.confidence =
		confidences.length > 0
			? Math.round(confidences.reduce((sum, c) => sum + c, 0) / confidences.length)
			: 0;

	const byName = new Map<string, CoherenceCheckResult>();
	for (const check of vlm.coherenceCheckResults) byName.set(check.name, { ...check });
	for (const check of ocr.coherenceCheckResults) {
		const existing = byName.get(check.name);
		if (!existing) {
			byName.set(check.name, { ...check });
		} else if (existing.passed !== check.passed) {
			byName.set(check.name, {
				name: check.name,
				passed: false,
				message: `Divergence: ${existing.message} / ${check.message}`
			});
		}
	}
	merged.coherenceCheckResults = [...byName.values()];

	return { result: merged, comparison };
}

/**
 * STUB extraction: no external call, deterministic placeholder values so the
 * whole chain (download → merge → MCP App panel → CSV export) can be
 * demonstrated without an LLM key, mirroring the plugin's stub OCR connector.
 */
export function stubExtraction(
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): ExtractionResult {
	const result: ExtractionResult = {
		fields: {},
		confidence: 75,
		fieldConfidences: {},
		fieldSources: {},
		errors: [],
		warnings: ['Résultat de démonstration (connecteur LLM non configuré)'],
		coherenceCheckResults: coherenceChecks.map((c) => ({
			name: c.name,
			passed: true,
			message: 'Contrôle simulé (mode démo)'
		}))
	};
	for (const [i, field] of fields.entries()) {
		switch (field.type) {
			case 'number':
				result.fields[field.name] = (i + 1) * 100;
				break;
			case 'date':
				result.fields[field.name] = '2026-01-01';
				break;
			case 'email':
				result.fields[field.name] = 'demo@example.com';
				break;
			default:
				result.fields[field.name] = `[STUB] valeur de ${field.name}`;
		}
		result.fieldConfidences[field.name] = 75;
		result.fieldSources![field.name] = {
			page: 1,
			quote: `Extrait simulé pour « ${field.name} » (mode démo)`
		};
	}
	return result;
}
