<script lang="ts">
	import { Label as LabelPrimitive } from 'bits-ui';
	import { cn, type WithElementRef } from '$lib/utils.js';

	type Props = WithElementRef<LabelPrimitive.RootProps>;

	let { ref = $bindable(null), class: className, ...restProps }: Props = $props();
</script>

<LabelPrimitive.Root
	bind:ref
	class={cn(
		'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
		className
	)}
	{...restProps}
/>
