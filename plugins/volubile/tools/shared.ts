// Types et briques communes a tous les outils Volubile (sans appel reseau).

export interface ApiPage<T> {
	content: T[];
	page: number;
	size: number;
	totalElements: number;
	totalPages: number;
}

export interface ApiAgent {
	id?: string;
	name?: string;
	type?: string;
	active?: boolean;
	recordable?: boolean;
	archived?: boolean;
	created?: string;
	configuration?: unknown;
}

export interface ApiCall {
	id?: string;
	agentId?: string;
	phone?: string;
	type?: string;
	status?: string;
	duration?: number;
	startTime?: string;
	endTime?: string;
	created?: string;
	summary?: string;
	classificationData?: Record<string, string>;
	classifiers?: Array<{ name?: string; value?: string }>;
	tags?: string[];
	recorded?: boolean;
	context?: unknown;
	watchedVariables?: unknown;
	extractedData?: unknown;
}

export interface IdParams {
	id: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePage<T>(value: unknown): ApiPage<T> {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		throw new Error('Le format de reponse paginee de Volubile est inattendu.');
	}
	return {
		content: value.content as T[],
		page: Number(value.page) || 1,
		size: Number(value.size) || value.content.length,
		totalElements: Number(value.totalElements) || value.content.length,
		totalPages: Number(value.totalPages) || 1
	};
}

export function toSafeAgent(agent: ApiAgent) {
	const configuration = isRecord(agent.configuration) ? agent.configuration : {};
	const classifiers = Array.isArray(configuration.classifiers) ? configuration.classifiers : [];
	const categories = classifiers.filter(isRecord).map((classifier) => ({
		name: typeof classifier.name === 'string' ? classifier.name : undefined,
		description: typeof classifier.description === 'string' ? classifier.description : undefined,
		labels: Array.isArray(classifier.values) ? classifier.values : []
	}));

	return {
		id: agent.id,
		name: agent.name,
		type: agent.type,
		active: agent.active,
		recordable: agent.recordable,
		archived: agent.archived,
		created: agent.created,
		callCategories: categories
	};
}

export function toSafeCall(call: ApiCall) {
	const classificationData = isRecord(call.classificationData) ? call.classificationData : {};
	return {
		id: call.id,
		agentId: call.agentId,
		type: call.type,
		status: call.status,
		durationSeconds: call.duration,
		startTime: call.startTime,
		endTime: call.endTime,
		created: call.created,
		summary: call.summary,
		categories: classificationData,
		tags: call.tags,
		recorded: call.recorded
	};
}

export function requireUuid(value: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error('L identifiant doit etre un UUID valide.');
	}
	return encodeURIComponent(value);
}

function isValidDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateDateRange(from: string, to: string): void {
	if (!isValidDate(from) || !isValidDate(to)) {
		throw new Error('Les dates doivent etre au format AAAA-MM-JJ.');
	}
	if (from > to) throw new Error('La date de debut doit etre avant la date de fin.');
}
