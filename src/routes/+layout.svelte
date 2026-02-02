<script>
	import '../app.css';

	let { children } = $props();
</script>

<div class="dark min-h-screen">
	{@render children()}
</div>
