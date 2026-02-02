<script lang="ts">
	import { onMount } from 'svelte';

	interface ToolInfo {
		id: string;
		name: string;
		description: string;
	}

	interface PluginInfo {
		id: string;
		name: string;
		version: string;
		description: string;
		author: string;
		icon?: string;
		category?: string;
		requiredEnvVars: string[];
		optionalEnvVars: string[];
		configSchema?: {
			properties: Record<
				string,
				{
					type: string;
					title: string;
					description?: string;
					default?: unknown;
					enum?: string[];
				}
			>;
		};
		tools: ToolInfo[];
	}

	interface SchemaProperty {
		type: string;
		description?: string;
		default?: unknown;
		enum?: (string | number)[];
		minimum?: number;
		maximum?: number;
	}

	interface ToolSchema {
		type: string;
		properties?: Record<string, SchemaProperty>;
		required?: string[];
		description?: string;
	}

	let plugins = $state<PluginInfo[]>([]);
	let selectedPlugin = $state<PluginInfo | null>(null);
	let selectedTool = $state<ToolInfo | null>(null);

	// Form state
	let envVars = $state<Record<string, string>>({});
	let configValues = $state<Record<string, unknown>>({});
	let toolSchema = $state<ToolSchema | null>(null);
	let toolParamValues = $state<Record<string, unknown>>({});
	let useRawJson = $state(false);
	let rawJsonParams = $state('{}');

	// Execution state
	let isExecuting = $state(false);
	let executionResult = $state<unknown>(null);
	let executionError = $state<string | null>(null);

	onMount(async () => {
		await loadPlugins();
	});

	async function loadPlugins() {
		const response = await fetch('/api/plugins');
		const data = await response.json();
		plugins = data.plugins;
	}

	function selectPlugin(plugin: PluginInfo) {
		selectedPlugin = plugin;
		selectedTool = null;
		executionResult = null;
		executionError = null;
		toolSchema = null;
		toolParamValues = {};

		// Initialize env vars
		envVars = {};
		for (const v of [...plugin.requiredEnvVars, ...plugin.optionalEnvVars]) {
			envVars[v] = '';
		}

		// Initialize config with defaults
		configValues = {};
		if (plugin.configSchema?.properties) {
			for (const [key, prop] of Object.entries(plugin.configSchema.properties)) {
				if (prop.default !== undefined) {
					configValues[key] = prop.default;
				}
			}
		}
	}

	async function selectTool(tool: ToolInfo) {
		selectedTool = tool;
		executionResult = null;
		executionError = null;
		toolParamValues = {};
		rawJsonParams = '{}';

		// Load tool schema
		if (selectedPlugin) {
			const response = await fetch(
				`/api/plugins?pluginId=${selectedPlugin.id}&toolId=${tool.id}`
			);
			const data = await response.json();
			toolSchema = data.schema as ToolSchema;

			// Initialize param values with defaults
			if (toolSchema?.properties) {
				const newParams: Record<string, unknown> = {};
				for (const [key, prop] of Object.entries(toolSchema.properties)) {
					if (prop.default !== undefined) {
						newParams[key] = prop.default;
					} else if (prop.type === 'string') {
						newParams[key] = '';
					} else if (prop.type === 'number' || prop.type === 'integer') {
						newParams[key] = prop.minimum ?? 0;
					} else if (prop.type === 'boolean') {
						newParams[key] = false;
					} else if (prop.type === 'array') {
						newParams[key] = [];
					}
				}
				toolParamValues = newParams;
				rawJsonParams = JSON.stringify(newParams, null, 2);
			}
		}
	}

	function isRequired(key: string): boolean {
		return toolSchema?.required?.includes(key) ?? false;
	}

	function getParamsForExecution(): Record<string, unknown> {
		if (useRawJson) {
			return JSON.parse(rawJsonParams);
		}
		// Filter out empty optional strings
		const params: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(toolParamValues)) {
			if (value === '' && !isRequired(key)) continue;
			if (value === null || value === undefined) continue;
			params[key] = value;
		}
		return params;
	}

	async function executeCurrentTool() {
		if (!selectedPlugin || !selectedTool) return;

		isExecuting = true;
		executionResult = null;
		executionError = null;

		try {
			const params = getParamsForExecution();

			const response = await fetch('/api/execute', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pluginId: selectedPlugin.id,
					toolId: selectedTool.id,
					params,
					env: envVars,
					config: configValues
				})
			});

			const data = await response.json();

			if (data.success) {
				executionResult = data.result;
			} else {
				executionError = data.error;
			}
		} catch (e) {
			executionError = e instanceof Error ? e.message : 'Invalid JSON parameters';
		} finally {
			isExecuting = false;
		}
	}

	function syncRawJson() {
		rawJsonParams = JSON.stringify(toolParamValues, null, 2);
	}

	function syncFromRawJson() {
		try {
			toolParamValues = JSON.parse(rawJsonParams);
		} catch {
			// Invalid JSON, ignore
		}
	}
</script>

<svelte:head>
	<title>Plugin Playground</title>
</svelte:head>

<div class="flex h-screen">
	<!-- Sidebar - Plugin List -->
	<aside class="w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] overflow-y-auto">
		<div class="p-4 border-b border-[var(--border)]">
			<h1 class="text-xl font-bold">Plugin Playground</h1>
			<p class="text-sm text-[var(--text-secondary)] mt-1">Test your MCP plugins</p>
		</div>

		<nav class="p-2">
			{#each plugins as plugin}
				<button
					class="w-full text-left p-3 rounded-lg mb-1 transition-colors {selectedPlugin?.id ===
					plugin.id
						? 'bg-[var(--accent)] text-white'
						: 'hover:bg-[var(--bg-tertiary)]'}"
					onclick={() => selectPlugin(plugin)}
				>
					<div class="font-medium">{plugin.name}</div>
					<div class="text-sm opacity-70">{plugin.tools.length} tool(s)</div>
				</button>
			{/each}

			{#if plugins.length === 0}
				<p class="text-[var(--text-secondary)] text-sm p-3">No plugins loaded</p>
			{/if}
		</nav>
	</aside>

	<!-- Main Content -->
	<main class="flex-1 overflow-y-auto">
		{#if selectedPlugin}
			<div class="p-6">
				<!-- Plugin Header -->
				<header class="mb-6">
					<h2 class="text-2xl font-bold">{selectedPlugin.name}</h2>
					<p class="text-[var(--text-secondary)] mt-1">{selectedPlugin.description}</p>
					<div class="flex gap-4 mt-2 text-sm text-[var(--text-secondary)]">
						<span>v{selectedPlugin.version}</span>
						<span>by {selectedPlugin.author}</span>
						{#if selectedPlugin.category}
							<span class="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded"
								>{selectedPlugin.category}</span
							>
						{/if}
					</div>
				</header>

				<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<!-- Left Column: Configuration -->
					<div class="space-y-6">
						<!-- Environment Variables -->
						{#if selectedPlugin.requiredEnvVars.length > 0 || selectedPlugin.optionalEnvVars.length > 0}
							<section class="bg-[var(--bg-secondary)] rounded-lg p-4">
								<h3 class="font-semibold mb-3">Environment Variables</h3>
								<div class="space-y-3">
									{#each selectedPlugin.requiredEnvVars as envVar}
										<div>
											<label class="block text-sm mb-1" for="env-{envVar}">
												{envVar}
												<span class="text-[var(--error)]">*</span>
											</label>
											<input
												id="env-{envVar}"
												type="text"
												bind:value={envVars[envVar]}
												class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
												placeholder="Required"
											/>
										</div>
									{/each}
									{#each selectedPlugin.optionalEnvVars as envVar}
										<div>
											<label class="block text-sm mb-1 text-[var(--text-secondary)]" for="env-{envVar}"
												>{envVar}</label
											>
											<input
												id="env-{envVar}"
												type="text"
												bind:value={envVars[envVar]}
												class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
												placeholder="Optional"
											/>
										</div>
									{/each}
								</div>
							</section>
						{/if}

						<!-- Plugin Configuration -->
						{#if selectedPlugin.configSchema?.properties}
							<section class="bg-[var(--bg-secondary)] rounded-lg p-4">
								<h3 class="font-semibold mb-3">Configuration</h3>
								<div class="space-y-3">
									{#each Object.entries(selectedPlugin.configSchema.properties) as [key, prop]}
										<div>
											<label class="block text-sm mb-1" for="config-{key}">{prop.title}</label>
											{#if prop.description}
												<p class="text-xs text-[var(--text-secondary)] mb-1">{prop.description}</p>
											{/if}
											{#if prop.enum}
												<select
													id="config-{key}"
													bind:value={configValues[key]}
													class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
												>
													{#each prop.enum as option}
														<option value={option}>{option}</option>
													{/each}
												</select>
											{:else if prop.type === 'number'}
												<input
													id="config-{key}"
													type="number"
													bind:value={configValues[key]}
													class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
												/>
											{:else if prop.type === 'boolean'}
												<input
													id="config-{key}"
													type="checkbox"
													checked={!!configValues[key]}
													onchange={(e) => (configValues[key] = e.currentTarget.checked)}
													class="w-4 h-4"
												/>
											{:else}
												<input
													id="config-{key}"
													type="text"
													bind:value={configValues[key]}
													class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
												/>
											{/if}
										</div>
									{/each}
								</div>
							</section>
						{/if}
					</div>

					<!-- Right Column: Tools -->
					<div class="space-y-6">
						<!-- Tool Selection -->
						<section class="bg-[var(--bg-secondary)] rounded-lg p-4">
							<h3 class="font-semibold mb-3">Tools</h3>
							<div class="space-y-2">
								{#each selectedPlugin.tools as tool}
									<button
										class="w-full text-left p-3 rounded border transition-colors {selectedTool?.id ===
										tool.id
											? 'border-[var(--accent)] bg-[var(--accent)]/10'
											: 'border-[var(--border)] hover:border-[var(--accent)]'}"
										onclick={() => selectTool(tool)}
									>
										<div class="font-medium">{tool.name}</div>
										<div class="text-sm text-[var(--text-secondary)]">{tool.description}</div>
									</button>
								{/each}
							</div>
						</section>

						<!-- Tool Execution -->
						{#if selectedTool}
							<section class="bg-[var(--bg-secondary)] rounded-lg p-4">
								<div class="flex items-center justify-between mb-3">
									<h3 class="font-semibold">Execute: {selectedTool.name}</h3>
									<label class="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
										<input
											type="checkbox"
											bind:checked={useRawJson}
											onchange={() => {
												if (useRawJson) syncRawJson();
												else syncFromRawJson();
											}}
											class="w-4 h-4"
										/>
										Raw JSON
									</label>
								</div>

								{#if toolSchema?.description}
									<p class="text-sm text-[var(--text-secondary)] mb-4 p-2 bg-[var(--bg-primary)] rounded">
										{toolSchema.description}
									</p>
								{/if}

								{#if useRawJson}
									<!-- Raw JSON Mode -->
									<div class="mb-4">
										<label class="block text-sm mb-1" for="raw-params">Parameters (JSON)</label>
										<textarea
											id="raw-params"
											bind:value={rawJsonParams}
											rows={8}
											class="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2 text-sm font-mono"
										></textarea>
									</div>
								{:else if toolSchema?.properties}
									<!-- Dynamic Form Mode -->
									<div class="space-y-4 mb-4">
										{#each Object.entries(toolSchema.properties) as [key, prop]}
											{@const required = isRequired(key)}
											<div class="p-3 bg-[var(--bg-primary)] rounded">
												<label class="block text-sm font-medium mb-1" for="param-{key}">
													{key}
													{#if required}
														<span class="text-[var(--error)]">*</span>
													{:else}
														<span class="text-[var(--text-secondary)] font-normal">(optional)</span>
													{/if}
												</label>
												{#if prop.description}
													<p class="text-xs text-[var(--text-secondary)] mb-2">{prop.description}</p>
												{/if}

												{#if prop.enum}
													<!-- Enum select -->
													<select
														id="param-{key}"
														bind:value={toolParamValues[key]}
														class="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
													>
														{#if !required}
															<option value="">-- Select --</option>
														{/if}
														{#each prop.enum as option}
															<option value={option}>{option}</option>
														{/each}
													</select>
												{:else if prop.type === 'number' || prop.type === 'integer'}
													<!-- Number input -->
													<input
														id="param-{key}"
														type="number"
														bind:value={toolParamValues[key]}
														min={prop.minimum}
														max={prop.maximum}
														class="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
														placeholder={prop.default !== undefined
															? `Default: ${prop.default}`
															: ''}
													/>
													{#if prop.minimum !== undefined || prop.maximum !== undefined}
														<p class="text-xs text-[var(--text-secondary)] mt-1">
															{#if prop.minimum !== undefined && prop.maximum !== undefined}
																Range: {prop.minimum} - {prop.maximum}
															{:else if prop.minimum !== undefined}
																Min: {prop.minimum}
															{:else if prop.maximum !== undefined}
																Max: {prop.maximum}
															{/if}
														</p>
													{/if}
												{:else if prop.type === 'boolean'}
													<!-- Boolean checkbox -->
													<div class="flex items-center gap-2">
														<input
															id="param-{key}"
															type="checkbox"
															checked={!!toolParamValues[key]}
															onchange={(e) => (toolParamValues[key] = e.currentTarget.checked)}
															class="w-4 h-4"
														/>
														<span class="text-sm text-[var(--text-secondary)]">
															{toolParamValues[key] ? 'true' : 'false'}
														</span>
													</div>
												{:else if prop.type === 'array'}
													<!-- Array as JSON -->
													<textarea
														id="param-{key}"
														value={JSON.stringify(toolParamValues[key] || [], null, 2)}
														oninput={(e) => {
															try {
																toolParamValues[key] = JSON.parse(e.currentTarget.value);
															} catch {
																// Invalid JSON, keep as is
															}
														}}
														rows={3}
														class="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm font-mono"
														placeholder="[]"
													></textarea>
												{:else}
													<!-- String input (default) -->
													<input
														id="param-{key}"
														type="text"
														bind:value={toolParamValues[key]}
														class="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm"
														placeholder={prop.default !== undefined
															? `Default: ${prop.default}`
															: required
																? 'Required'
																: 'Optional'}
													/>
												{/if}
											</div>
										{/each}
									</div>
								{:else}
									<p class="text-sm text-[var(--text-secondary)] mb-4">
										This tool has no parameters.
									</p>
								{/if}

								<!-- Execute Button -->
								<button
									onclick={executeCurrentTool}
									disabled={isExecuting}
									class="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-medium py-2 px-4 rounded transition-colors"
								>
									{#if isExecuting}
										Executing...
									{:else}
										Execute Tool
									{/if}
								</button>
							</section>

							<!-- Results -->
							{#if executionResult !== null || executionError}
								<section class="bg-[var(--bg-secondary)] rounded-lg p-4">
									<h3 class="font-semibold mb-3">Result</h3>

									{#if executionError}
										<div class="p-3 bg-[var(--error)]/20 border border-[var(--error)] rounded">
											<p class="text-[var(--error)] font-medium">Error</p>
											<p class="text-sm mt-1">{executionError}</p>
										</div>
									{:else}
										<div
											class="p-3 bg-[var(--success)]/20 border border-[var(--success)] rounded mb-3"
										>
											<p class="text-[var(--success)] font-medium">Success</p>
										</div>
										<pre
											class="p-3 bg-[var(--bg-primary)] rounded text-sm overflow-x-auto max-h-96">{JSON.stringify(
												executionResult,
												null,
												2
											)}</pre>
									{/if}
								</section>
							{/if}
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<!-- Welcome Screen -->
			<div class="h-full flex items-center justify-center">
				<div class="text-center">
					<h2 class="text-2xl font-bold mb-2">Welcome to Plugin Playground</h2>
					<p class="text-[var(--text-secondary)]">
						Select a plugin from the sidebar to begin testing
					</p>
				</div>
			</div>
		{/if}
	</main>
</div>
