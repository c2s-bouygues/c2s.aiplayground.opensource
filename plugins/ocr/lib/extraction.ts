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
 * - `buildExtractionPrompt` (prompt text unchanged)
 * - required-field post-validation
 * - double extraction: two independent calls merged field by field with
 *   confidence penalties (×0.8 when only one call found a value, ×0.6 on
 *   divergence) and coherence results merged by name.
 * Errors never throw out of the extraction functions: they degrade into a
 * result with `confidence: 0` and an `errors` entry (MagicOCR behavior).
 */

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

export interface ExtractionResult {
	fields: Record<string, unknown>;
	confidence: number;
	fieldConfidences: Record<string, number>;
	errors: string[];
	warnings: string[];
	coherenceCheckResults: CoherenceCheckResult[];
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
const MAX_TOKENS = 4096;
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

/** Prompt ported verbatim from MagicOcrV2 `buildExtractionPrompt`. */
export function buildExtractionPrompt(
	fields: TemplateField[],
	coherenceChecks: CoherenceCheck[]
): string {
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

	return `Tu es un expert en extraction de données de documents. Analyse ce document et extrait les informations demandées.

Champs à extraire:
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

Réponds UNIQUEMENT avec un JSON valide dans ce format exact:
{
  "fields": {
    "Nom du champ": "valeur extraite ou null"
  },
  "confidence": 85,
  "fieldConfidences": {
    "Nom du champ": 90
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

	return {
		fields:
			typeof parsed.fields === 'object' && parsed.fields !== null
				? (parsed.fields as Record<string, unknown>)
				: {},
		confidence: toNumber(parsed.confidence, 0),
		fieldConfidences,
		errors: toStringArray(parsed.errors),
		warnings: toStringArray(parsed.warnings),
		coherenceCheckResults
	};
}

/** One Messages API round-trip; throws on transport/parse failure. */
async function callClaude(
	llm: LlmConfig,
	block: DocumentBlock,
	prompt: string
): Promise<ExtractionResult> {
	const response = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': llm.apiKey,
			'anthropic-version': ANTHROPIC_VERSION
		},
		body: JSON.stringify({
			model: llm.model,
			max_tokens: MAX_TOKENS,
			messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }]
		}),
		signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
	}

	const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
	const text = (data.content ?? [])
		.filter((c) => c.type === 'text' && typeof c.text === 'string')
		.map((c) => c.text)
		.join('');

	// MagicOCR parsing: first JSON object in the free-text answer.
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error('réponse du modèle sans JSON exploitable');
	}
	return normalizeResult(JSON.parse(match[0]) as Record<string, unknown>);
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
		const result = await callClaude(llm, block, buildExtractionPrompt(fields, coherenceChecks));
		for (const field of fields) {
			if (field.required && (result.fields[field.name] === null || result.fields[field.name] === undefined)) {
				result.errors.push(`Champ obligatoire manquant: ${field.name}`);
			}
		}
		return result;
	} catch (error) {
		return {
			fields: {},
			confidence: 0,
			fieldConfidences: {},
			errors: [`Erreur d'extraction: ${error instanceof Error ? error.message : String(error)}`],
			warnings: [],
			coherenceCheckResults: []
		};
	}
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
		coherenceCheckResults: []
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
		} else if (v1 === null) {
			merged.fields[name] = v2;
			merged.fieldConfidences[name] = c2 * 0.8;
			merged.warnings.push(`Champ "${name}": trouvé par une seule des deux extractions`);
		} else if (v2 === null) {
			merged.fields[name] = v1;
			merged.fieldConfidences[name] = c1 * 0.8;
			merged.warnings.push(`Champ "${name}": trouvé par une seule des deux extractions`);
		} else {
			const useFirst = c1 >= c2;
			merged.fields[name] = useFirst ? v1 : v2;
			merged.fieldConfidences[name] = (useFirst ? c1 : c2) * 0.6;
			merged.warnings.push(
				`Champ "${name}": divergence entre les deux extractions (${JSON.stringify(v1)} vs ${JSON.stringify(v2)})`
			);
		}
	}

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
	}
	return result;
}
