<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '@iconify/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

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

	let envVars = $state<Record<string, string>>({});
	let configValues = $state<Record<string, unknown>>({});
	let toolSchema = $state<ToolSchema | null>(null);
	let toolParamValues = $state<Record<string, unknown>>({});
	let useRawJson = $state(false);
	let rawJsonParams = $state('{}');

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

		envVars = {};
		for (const v of [...plugin.requiredEnvVars, ...plugin.optionalEnvVars]) {
			envVars[v] = '';
		}

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

		if (selectedPlugin) {
			const response = await fetch(
				`/api/plugins?pluginId=${selectedPlugin.id}&toolId=${tool.id}`
			);
			const data = await response.json();
			toolSchema = data.schema as ToolSchema;

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
	<!-- Sidebar -->
	<aside class="w-72 bg-sidebar border-r border-sidebar-border overflow-y-auto">
		<div class="p-4 border-b border-sidebar-border">
			<div class="flex items-center gap-2">
				<Icon icon="hugeicons:plug-02" class="size-6 text-sidebar-primary" />
				<h1 class="text-xl font-bold text-sidebar-foreground">Plugin Playground</h1>
			</div>
			<p class="text-sm text-muted-foreground mt-1">Test your MCP plugins</p>
		</div>

		<nav class="p-2">
			{#each plugins as plugin (plugin.id)}
				<button
					class="w-full text-left p-3 rounded-lg mb-1 transition-colors {selectedPlugin?.id === plugin.id
						? 'bg-sidebar-primary text-sidebar-primary-foreground'
						: 'hover:bg-sidebar-accent text-sidebar-foreground'}"
					onclick={() => selectPlugin(plugin)}
				>
					<div class="flex items-center gap-2">
						<Icon icon="hugeicons:package" class="size-4" />
						<span class="font-medium">{plugin.name}</span>
					</div>
					<div class="text-sm opacity-70 mt-0.5 ml-6">{plugin.tools.length} tool(s)</div>
				</button>
			{/each}

			{#if plugins.length === 0}
				<div class="flex flex-col items-center justify-center py-8 text-muted-foreground">
					<Icon icon="hugeicons:inbox" class="size-12 mb-2 opacity-50" />
					<p class="text-sm">No plugins loaded</p>
				</div>
			{/if}
		</nav>
	</aside>

	<!-- Main Content -->
	<main class="flex-1 overflow-y-auto bg-background">
		{#if selectedPlugin}
			<div class="p-6">
				<!-- Plugin Header -->
				<header class="mb-6">
					<div class="flex items-center gap-3">
						<div class="p-2 rounded-lg bg-accent">
							<Icon icon="hugeicons:package" class="size-6 text-accent-foreground" />
						</div>
						<div>
							<h2 class="text-2xl font-bold text-foreground">{selectedPlugin.name}</h2>
							<p class="text-muted-foreground">{selectedPlugin.description}</p>
						</div>
					</div>
					<div class="flex gap-3 mt-3 text-sm text-muted-foreground">
						<span class="flex items-center gap-1">
							<Icon icon="hugeicons:tag-01" class="size-4" />
							v{selectedPlugin.version}
						</span>
						<span class="flex items-center gap-1">
							<Icon icon="hugeicons:user" class="size-4" />
							{selectedPlugin.author}
						</span>
						{#if selectedPlugin.category}
							<span class="px-2 py-0.5 bg-secondary text-secondary-foreground rounded-md text-xs">
								{selectedPlugin.category}
							</span>
						{/if}
					</div>
				</header>

				<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<!-- Left Column: Configuration -->
					<div class="space-y-6">
						<!-- Environment Variables -->
						{#if selectedPlugin.requiredEnvVars.length > 0 || selectedPlugin.optionalEnvVars.length > 0}
							<Card>
								<CardHeader>
									<CardTitle class="flex items-center gap-2">
										<Icon icon="hugeicons:key-01" class="size-5" />
										Environment Variables
									</CardTitle>
									<CardDescription>Configure API keys and secrets</CardDescription>
								</CardHeader>
								<CardContent class="space-y-4">
									{#each selectedPlugin.requiredEnvVars as envVar (envVar)}
										<div class="space-y-2">
											<Label for="env-{envVar}" class="flex items-center gap-1">
												{envVar}
												<span class="text-destructive">*</span>
											</Label>
											<Input
												id="env-{envVar}"
												type="password"
												bind:value={envVars[envVar]}
												placeholder="Required"
											/>
										</div>
									{/each}
									{#each selectedPlugin.optionalEnvVars as envVar (envVar)}
										<div class="space-y-2">
											<Label for="env-{envVar}" class="text-muted-foreground">{envVar}</Label>
											<Input
												id="env-{envVar}"
												type="password"
												bind:value={envVars[envVar]}
												placeholder="Optional"
											/>
										</div>
									{/each}
								</CardContent>
							</Card>
						{/if}

						<!-- Plugin Configuration -->
						{#if selectedPlugin.configSchema?.properties}
							<Card>
								<CardHeader>
									<CardTitle class="flex items-center gap-2">
										<Icon icon="hugeicons:settings-02" class="size-5" />
										Configuration
									</CardTitle>
									<CardDescription>Plugin-specific settings</CardDescription>
								</CardHeader>
								<CardContent class="space-y-4">
									{#each Object.entries(selectedPlugin.configSchema.properties) as [key, prop] (key)}
										<div class="space-y-2">
											<Label for="config-{key}">{prop.title}</Label>
											{#if prop.description}
												<p class="text-xs text-muted-foreground">{prop.description}</p>
											{/if}
											{#if prop.enum}
												<select
													id="config-{key}"
													bind:value={configValues[key]}
													class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring"
												>
													{#each prop.enum as option (option)}
														<option value={option}>{option}</option>
													{/each}
												</select>
											{:else if prop.type === 'number'}
												<Input
													id="config-{key}"
													type="number"
													bind:value={configValues[key]}
												/>
											{:else if prop.type === 'boolean'}
												<div class="flex items-center gap-2">
													<Checkbox
														id="config-{key}"
														checked={!!configValues[key]}
														onCheckedChange={(checked) => (configValues[key] = checked)}
													/>
													<Label for="config-{key}" class="text-muted-foreground">
														{configValues[key] ? 'Enabled' : 'Disabled'}
													</Label>
												</div>
											{:else}
												<Input
													id="config-{key}"
													type="text"
													bind:value={configValues[key]}
												/>
											{/if}
										</div>
									{/each}
								</CardContent>
							</Card>
						{/if}
					</div>

					<!-- Right Column: Tools -->
					<div class="space-y-6">
						<!-- Tool Selection -->
						<Card>
							<CardHeader>
								<CardTitle class="flex items-center gap-2">
									<Icon icon="hugeicons:wrench-01" class="size-5" />
									Tools
								</CardTitle>
								<CardDescription>Select a tool to execute</CardDescription>
							</CardHeader>
							<CardContent class="space-y-2">
								{#each selectedPlugin.tools as tool (tool.id)}
									<button
										class="w-full text-left p-3 rounded-lg border transition-all {selectedTool?.id === tool.id
											? 'border-ring bg-accent/50 ring-2 ring-ring/20'
											: 'border-border hover:border-ring hover:bg-accent/30'}"
										onclick={() => selectTool(tool)}
									>
										<div class="flex items-center gap-2">
											<Icon icon="hugeicons:code" class="size-4 text-muted-foreground" />
											<span class="font-medium text-foreground">{tool.name}</span>
										</div>
										<p class="text-sm text-muted-foreground mt-1 ml-6">{tool.description}</p>
									</button>
								{/each}
							</CardContent>
						</Card>

						<!-- Tool Execution -->
						{#if selectedTool}
							<Card>
								<CardHeader>
									<div class="flex items-center justify-between">
										<CardTitle class="flex items-center gap-2">
											<Icon icon="hugeicons:play" class="size-5" />
											Execute: {selectedTool.name}
										</CardTitle>
										<label class="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
											<Checkbox
												checked={useRawJson}
												onCheckedChange={(checked) => {
													useRawJson = !!checked;
													if (useRawJson) syncRawJson();
													else syncFromRawJson();
												}}
											/>
											Raw JSON
										</label>
									</div>
								</CardHeader>
								<CardContent class="space-y-4">
									{#if toolSchema?.description}
										<div class="p-3 bg-muted rounded-lg">
											<p class="text-sm text-muted-foreground">{toolSchema.description}</p>
										</div>
									{/if}

									{#if useRawJson}
										<div class="space-y-2">
											<Label for="raw-params">Parameters (JSON)</Label>
											<Textarea
												id="raw-params"
												bind:value={rawJsonParams}
												class="font-mono min-h-[200px]"
											/>
										</div>
									{:else if toolSchema?.properties}
										<div class="space-y-4">
											{#each Object.entries(toolSchema.properties) as [key, prop] (key)}
												{@const required = isRequired(key)}
												<div class="p-4 bg-muted/50 rounded-lg border border-border/50 space-y-2">
													<Label for="param-{key}" class="flex items-center gap-2">
														{key}
														{#if required}
															<span class="text-destructive text-xs">required</span>
														{:else}
															<span class="text-muted-foreground text-xs">optional</span>
														{/if}
													</Label>
													{#if prop.description}
														<p class="text-xs text-muted-foreground">{prop.description}</p>
													{/if}

													{#if prop.enum}
														<select
															id="param-{key}"
															bind:value={toolParamValues[key]}
															class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring"
														>
															{#if !required}
																<option value="">-- Select --</option>
															{/if}
															{#each prop.enum as option (option)}
																<option value={option}>{option}</option>
															{/each}
														</select>
													{:else if prop.type === 'number' || prop.type === 'integer'}
														<Input
															id="param-{key}"
															type="number"
															bind:value={toolParamValues[key]}
															min={prop.minimum}
															max={prop.maximum}
															placeholder={prop.default !== undefined ? `Default: ${prop.default}` : ''}
														/>
														{#if prop.minimum !== undefined || prop.maximum !== undefined}
															<p class="text-xs text-muted-foreground">
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
														<div class="flex items-center gap-2">
															<Checkbox
																id="param-{key}"
																checked={!!toolParamValues[key]}
																onCheckedChange={(checked) => (toolParamValues[key] = checked)}
															/>
															<span class="text-sm text-muted-foreground">
																{toolParamValues[key] ? 'true' : 'false'}
															</span>
														</div>
													{:else if prop.type === 'array'}
														<Textarea
															id="param-{key}"
															value={JSON.stringify(toolParamValues[key] || [], null, 2)}
															oninput={(e) => {
																try {
																	toolParamValues[key] = JSON.parse(e.currentTarget.value);
																} catch {
																	// Invalid JSON
																}
															}}
															class="font-mono min-h-[80px]"
															placeholder="[]"
														/>
													{:else}
														<Input
															id="param-{key}"
															type="text"
															bind:value={toolParamValues[key]}
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
										<p class="text-sm text-muted-foreground">This tool has no parameters.</p>
									{/if}

									<Button
										onclick={executeCurrentTool}
										disabled={isExecuting}
										class="w-full"
									>
										{#if isExecuting}
											<Icon icon="hugeicons:loading-02" class="size-4 animate-spin" />
											Executing...
										{:else}
											<Icon icon="hugeicons:play" class="size-4" />
											Execute Tool
										{/if}
									</Button>
								</CardContent>
							</Card>

							<!-- Results -->
							{#if executionResult !== null || executionError}
								<Card>
									<CardHeader>
										<CardTitle class="flex items-center gap-2">
											{#if executionError}
												<Icon icon="hugeicons:alert-02" class="size-5 text-destructive" />
												<span class="text-destructive">Error</span>
											{:else}
												<Icon icon="hugeicons:checkmark-circle-02" class="size-5 text-green-500" />
												<span class="text-green-500">Success</span>
											{/if}
										</CardTitle>
									</CardHeader>
									<CardContent>
										{#if executionError}
											<div class="p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
												<p class="text-sm text-destructive">{executionError}</p>
											</div>
										{:else}
											<pre class="p-4 bg-muted rounded-lg text-sm overflow-x-auto max-h-96 text-foreground">{JSON.stringify(executionResult, null, 2)}</pre>
										{/if}
									</CardContent>
								</Card>
							{/if}
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<!-- Welcome Screen -->
			<div class="h-full flex items-center justify-center">
				<div class="text-center max-w-md">
					<div class="mb-6 p-4 rounded-full bg-accent inline-block">
						<Icon icon="hugeicons:plug-02" class="size-16 text-accent-foreground" />
					</div>
					<h2 class="text-2xl font-bold text-foreground mb-2">Welcome to Plugin Playground</h2>
					<p class="text-muted-foreground">
						Select a plugin from the sidebar to begin testing your MCP tools and configurations.
					</p>
				</div>
			</div>
		{/if}
	</main>
</div>
