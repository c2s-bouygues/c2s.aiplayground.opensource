import { jsonSchema, tool } from 'ai';
import type { AnyTool, PluginContext } from '../../../src/types';
import { readJson, REQUEST_TIMEOUT_MS, runTool } from './api';
import { isRecord, parsePage, requireUuid, validateDateRange, type ApiCall, type ApiPage } from './shared';

const MAX_KPI_PAGES = 10;
// Duree maximale de lecture des pages pour un calcul KPI; au-dela, on renvoie des resultats partiels.
const KPI_MAX_DURATION_MS = 60_000;
const KPI_PAGE_SIZE = 500;

interface KpiParams {
	from: string;
	to: string;
	agentId?: string;
	campaignName?: string;
	metric: 'count' | 'total_duration' | 'average_duration' | 'rate';
	filters?: CallFilters;
	numerator?: CallFilters;
	missingCategoryPolicy?: 'include' | 'exclude';
	groupBy?: 'day' | 'agent' | 'direction' | 'status' | 'category';
	groupCategory?: string;
}

interface CallFilters {
	statuses?: string[];
	directions?: Array<'INBOUND' | 'OUTBOUND'>;
	categories?: Array<{ name: string; labels: string[] }>;
}

function categoryLabels(call: ApiCall): Map<string, string> {
	const labels = new Map<string, string>();
	if (Array.isArray(call.classifiers)) {
		for (const item of call.classifiers) {
			if (item && typeof item.name === 'string' && typeof item.value === 'string' && item.value.trim()) {
				labels.set(item.name, item.value);
			}
		}
	}
	if (isRecord(call.classificationData)) {
		for (const [name, value] of Object.entries(call.classificationData)) {
			if (typeof value === 'string' && value.trim()) labels.set(name, value);
		}
	}
	return labels;
}

const callFiltersSchema = {
	type: 'object' as const,
	additionalProperties: false,
	properties: {
		statuses: { type: 'array' as const, minItems: 1, maxItems: 30, items: { type: 'string' as const, minLength: 1 } },
		directions: { type: 'array' as const, minItems: 1, maxItems: 2, items: { type: 'string' as const, enum: ['INBOUND', 'OUTBOUND'] } },
		categories: {
			type: 'array' as const, minItems: 1, maxItems: 20,
			items: {
				type: 'object' as const, additionalProperties: false,
				properties: {
					name: { type: 'string' as const, minLength: 1 },
					labels: { type: 'array' as const, minItems: 1, maxItems: 50, items: { type: 'string' as const, minLength: 1 } }
				},
				required: ['name', 'labels']
			}
		}
	}
};

function validateCallFilters(value: unknown): void {
	if (value === undefined) return;
	if (!isRecord(value) || Object.keys(value).some((key) => !['statuses', 'directions', 'categories'].includes(key))) {
		throw new Error('Filtres non reconnus.');
	}
	const validStrings = (items: unknown, maximum: number): items is string[] =>
		Array.isArray(items) && items.length > 0 && items.length <= maximum &&
		items.every((item) => typeof item === 'string' && item.trim().length > 0);
	if (value.statuses !== undefined && !validStrings(value.statuses, 30)) throw new Error('Statuts invalides.');
	if (value.directions !== undefined && (!validStrings(value.directions, 2) ||
		value.directions.some((direction) => !['INBOUND', 'OUTBOUND'].includes(direction)))) {
		throw new Error('Sens des appels invalides.');
	}
	if (value.categories !== undefined && (!Array.isArray(value.categories) ||
		value.categories.length === 0 || value.categories.length > 20 ||
		value.categories.some((category) => !isRecord(category) ||
			Object.keys(category).some((key) => !['name', 'labels'].includes(key)) ||
			typeof category.name !== 'string' || !category.name.trim() || !validStrings(category.labels, 50)))) {
		throw new Error('Categories invalides: fournir un nom exact et au moins un label.');
	}
}

function validateAnalysis(params: KpiParams): void {
	validateDateRange(params.from, params.to);
	if (!['count', 'total_duration', 'average_duration', 'rate'].includes(params.metric)) {
		throw new Error('Choisir count, total_duration, average_duration ou rate.');
	}
	validateCallFilters(params.filters);
	validateCallFilters(params.numerator);
	if (params.metric === 'rate') {
		if (!params.numerator || !Object.keys(params.numerator).length || !params.missingCategoryPolicy) {
			throw new Error('Un taux exige un filtre numerator et une politique include/exclude pour les categories manquantes.');
		}
	} else if (params.numerator !== undefined || params.missingCategoryPolicy !== undefined) {
		throw new Error('numerator et missingCategoryPolicy sont reserves au calcul de taux.');
	}
	if (params.missingCategoryPolicy !== undefined && !['include', 'exclude'].includes(params.missingCategoryPolicy)) {
		throw new Error('Politique de categories manquantes invalide.');
	}
	if (params.groupBy !== undefined && !['day', 'agent', 'direction', 'status', 'category'].includes(params.groupBy)) {
		throw new Error('Regroupement inconnu.');
	}
	if (params.groupBy === 'category' ? typeof params.groupCategory !== 'string' || !params.groupCategory.trim() : params.groupCategory !== undefined) {
		throw new Error('groupCategory doit etre fourni uniquement pour un regroupement par categorie.');
	}
}

function matchesCall(call: ApiCall, filters: CallFilters = {}): boolean {
	return (!filters.statuses || filters.statuses.includes(call.status || '')) &&
		(!filters.directions || filters.directions.includes(call.type as 'INBOUND' | 'OUTBOUND')) &&
		(!filters.categories || filters.categories.every(({ name, labels }) => {
			const label = categoryLabels(call).get(name);
			return label !== undefined && labels.includes(label);
		}));
}

function aggregateCalls(calls: ApiCall[], params: KpiParams) {
	const numeratorCategories = params.numerator?.categories?.map(({ name }) => name) || [];
	const missingCategories = calls.filter((call) => numeratorCategories.some((name) => !categoryLabels(call).has(name)));
	const eligible = params.missingCategoryPolicy === 'exclude'
		? calls.filter((call) => numeratorCategories.every((name) => categoryLabels(call).has(name)))
		: calls;
	const durations = calls.map((call) => call.duration)
		.filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration) && duration >= 0);
	const durationTotal = durations.reduce((total, duration) => total + duration, 0);
	const numerator = params.metric === 'rate' ? eligible.filter((call) => matchesCall(call, params.numerator)).length : null;
	let value: number | null = calls.length;
	if (params.metric === 'total_duration') value = durations.length ? durationTotal : null;
	if (params.metric === 'average_duration') value = durations.length ? durationTotal / durations.length : null;
	if (params.metric === 'rate') value = eligible.length ? (numerator! / eligible.length) * 100 : null;
	return {
		value: value === null ? null : Math.round(value * 100) / 100,
		callsMatched: calls.length,
		numerator,
		denominator: params.metric === 'rate' ? eligible.length : null,
		callsMissingNumeratorCategories: missingCategories.length,
		callsWithValidDuration: durations.length,
		callsMissingOrInvalidDuration: calls.length - durations.length
	};
}

function groupKey(call: ApiCall, params: KpiParams): string | null {
	switch (params.groupBy) {
		case 'agent': return call.agentId || null;
		case 'direction': return call.type || null;
		case 'status': return call.status || null;
		case 'category': return categoryLabels(call).get(params.groupCategory!) ?? null;
		case 'day': {
			const date = new Date(call.startTime || call.created || '');
			return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
		}
		default: return null;
	}
}

function parseAnalysisPage(value: unknown): ApiPage<ApiCall> {
	if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isRecord) ||
		!Number.isInteger(value.totalElements) || Number(value.totalElements) < 0 ||
		!Number.isInteger(value.totalPages) || Number(value.totalPages) < 0 ||
		(value.totalElements === 0 ? value.content.length > 0 : Number(value.totalPages) < 1)) {
		throw new Error('Pagination Volubile incomplete: impossible de garantir la couverture du calcul.');
	}
	return { ...parsePage<ApiCall>(value), totalElements: Number(value.totalElements), totalPages: Number(value.totalPages) };
}

export function createGetCallKpisTool(context: PluginContext): AnyTool {
	return tool({
		description: 'Analyse parametrable des appels, en lecture seule. Choisir le calcul et les filtres selon le besoin client. Utiliser les noms exacts des categories/labels observes, jamais une definition inventee de reussite. Clarifier le denominateur et les categories manquantes pour un taux. Maximum 5000 appels collectes, resultats potentiellement partiels.',
		inputSchema: jsonSchema<KpiParams>({
			type: 'object',
			additionalProperties: false,
			properties: {
				from: { type: 'string', format: 'date', description: 'Date de debut incluse, au format AAAA-MM-JJ.' },
				to: { type: 'string', format: 'date', description: 'Date de fin incluse, au format AAAA-MM-JJ.' },
				agentId: { type: 'string', format: 'uuid', description: 'Filtrer par identifiant d agent.' },
				campaignName: { type: 'string', description: 'Filtrer par nom de campagne.' },
				metric: { type: 'string', enum: ['count', 'total_duration', 'average_duration', 'rate'], description: 'Nombre, duree totale/moyenne en secondes, ou taux en pourcentage.' },
				filters: { ...callFiltersSchema, description: 'Population de reference. ET entre champs/categories; OU entre valeurs du meme champ. Egalite exacte, sensible a la casse. Une categorie absente ne correspond pas au filtre.' },
				numerator: { ...callFiltersSchema, description: 'Pour rate uniquement: conditions supplementaires sur la population filtree pour compter le numerateur. Au moins une condition obligatoire.' },
				missingCategoryPolicy: { type: 'string', enum: ['include', 'exclude'], description: 'Obligatoire pour rate: inclure ou exclure du denominateur les appels sans les categories du numerateur. Ils ne comptent jamais comme correspondances du numerateur.' },
				groupBy: { type: 'string', enum: ['day', 'agent', 'direction', 'status', 'category'], description: 'Regroupement facultatif. Jour en UTC; agent par identifiant, sans fusionner les noms identiques.' },
				groupCategory: { type: 'string', minLength: 1, description: 'Nom exact de la categorie, obligatoire uniquement si groupBy=category.' }
			},
			required: ['from', 'to', 'metric']
		}),
		execute: async (params) =>
			runTool(context, 'get_call_kpis', async () => {
				validateAnalysis(params);
				const search = new URLSearchParams({
					from: params.from,
					to: params.to,
					page: '1',
					size: String(KPI_PAGE_SIZE)
				});
				if (params.agentId) search.set('agentId', requireUuid(params.agentId));
				if (params.campaignName) search.set('campaignName', params.campaignName);

				const deadline = Date.now() + KPI_MAX_DURATION_MS;
				const firstPage = parseAnalysisPage(
					await readJson<unknown>(context, `/v1/calls?${search.toString()}`)
				);
				const pagesToRead = Math.min(Math.max(firstPage.totalPages, 1), MAX_KPI_PAGES);
				const maximumCalls = MAX_KPI_PAGES * KPI_PAGE_SIZE;
				const calls = firstPage.content.slice(0, maximumCalls);
				let overflow = firstPage.content.length > maximumCalls;
				let pagesRead = 1;
				let stoppedByTimeLimit = false;

				for (let pageNumber = 2; pageNumber <= pagesToRead && calls.length < maximumCalls; pageNumber += 1) {
					// Temps restant avant la limite globale; chaque page attend au plus ce temps-la.
					const timeLeft = deadline - Date.now();
					if (timeLeft < 1000) {
						stoppedByTimeLimit = true;
						break;
					}
					search.set('page', String(pageNumber));
					let rawPage: unknown;
					try {
						rawPage = await readJson<unknown>(
							context,
							`/v1/calls?${search.toString()}`,
							Math.min(REQUEST_TIMEOUT_MS, timeLeft)
						);
					} catch (error) {
						// Page trop lente: on garde les pages deja lues au lieu de tout perdre.
						if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
						stoppedByTimeLimit = true;
						break;
					}
					const page = parseAnalysisPage(rawPage);
					if (page.totalElements !== firstPage.totalElements || page.totalPages !== firstPage.totalPages) {
						throw new Error('Les donnees ont change pendant la pagination. Relancer sur une periode stable.');
					}
					const remaining = maximumCalls - calls.length;
					overflow ||= page.content.length > remaining;
					calls.push(...page.content.slice(0, remaining));
					pagesRead += 1;
					if (!page.content.length) break;
				}

				const ids = new Set<string>();
				for (const call of calls) {
					if (call.id && ids.has(call.id)) throw new Error('Appel duplique pendant la pagination; calcul annule.');
					if (call.id) ids.add(call.id);
				}
				if (calls.length > firstPage.totalElements) throw new Error('Nombre total incoherent dans la pagination Volubile.');
				const selected = calls.filter((call) => matchesCall(call, params.filters));
				const groups = new Map<string | null, ApiCall[]>();
				if (params.groupBy) {
					for (const call of selected) {
						const key = groupKey(call, params);
						const group = groups.get(key) || [];
						group.push(call);
						groups.set(key, group);
					}
				}
				const referencedCategories = [...new Set([
					...(params.filters?.categories?.map(({ name }) => name) || []),
					...(params.numerator?.categories?.map(({ name }) => name) || []),
					...(params.groupCategory ? [params.groupCategory] : [])
				])];
				const categoryCoverage = referencedCategories.map((name) => ({
					name,
					callsWithCategory: calls.filter((call) => categoryLabels(call).has(name)).length,
					callsMissingCategory: calls.filter((call) => !categoryLabels(call).has(name)).length
				}));
				const truncated = overflow || firstPage.totalPages > pagesRead || calls.length < firstPage.totalElements;
				const warnings: string[] = [];
				if (stoppedByTimeLimit) {
					warnings.push(`Lecture trop longue, arretee avant la fin (limite ${KPI_MAX_DURATION_MS / 1000} s ou page trop lente; ${pagesRead} pages lues sur ${firstPage.totalPages}): resultats partiels, ne pas extrapoler. Reduire la periode ou filtrer par agent ou campagne.`);
				} else if (truncated) {
					warnings.push('Resultats partiels: ne pas extrapoler a toute la periode. Reduire la periode.');
				}
				if (categoryCoverage.some((category) => category.callsMissingCategory > 0)) warnings.push('Certaines categories sont absentes: voir categoryCoverage et la politique du denominateur.');
				if (!selected.length) warnings.push('Aucun appel ne correspond aux filtres parmi les appels recuperes. Verifier les noms exacts des categories et labels.');
				return {
					definition: {
						...params,
						filters: params.filters || {},
						groupBy: params.groupBy || null,
						dayTimezone: 'UTC',
						filterSemantics: 'AND between fields/categories; OR between values; exact case-sensitive match'
					},
					callsFetched: calls.length,
					totalCallsReportedByApi: firstPage.totalElements,
					pagesRead,
					maximumCalls,
					truncated,
					stoppedByTimeLimit,
					warnings,
					categoryCoverage,
					unit: params.metric === 'rate' ? 'percent' : params.metric === 'count' ? 'calls' : 'seconds',
					result: aggregateCalls(selected, params),
					groups: [...groups.entries()]
						.sort(([left], [right]) => (left ?? '').localeCompare(right ?? ''))
						.map(([key, group]) => ({ key, ...aggregateCalls(group, params) }))
				};
			})
	});
}
