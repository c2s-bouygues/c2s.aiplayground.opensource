<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from 'bits-ui';
	import Icon from '@iconify/svelte';
	import { cn, type WithElementRef } from '$lib/utils.js';

	type Props = WithElementRef<CheckboxPrimitive.RootProps>;

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		...restProps
	}: Props = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	bind:checked
	class={cn(
		'peer border-input ring-offset-background focus-visible:ring-ring data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary size-4 shrink-0 rounded-sm border shadow-xs transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<div class="flex items-center justify-center text-current">
			{#if indeterminate}
				<Icon icon="hugeicons:minus-sign" class="size-3.5" />
			{:else if checked}
				<Icon icon="hugeicons:checkmark-square-02" class="size-3.5" />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
