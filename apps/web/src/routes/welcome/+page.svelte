<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Welcome · Brian</title>
</svelte:head>

<div class="card">
	<h1>Pick a username</h1>
	<p>
		It names your own brian, and the folder <code>brian/&lt;username&gt;/</code> where your agents write.
	</p>
	<p class="warning" role="note">
		<strong>You can set it only once.</strong> It can't be changed later, so choose carefully.
	</p>

	<form
		method="post"
		use:enhance={({ formData, cancel }) => {
			// Advisory only: the server sets the username once (UPDATE … WHERE username IS NULL).
			const name = String(formData.get('username') ?? '').trim().toLowerCase();
			if (!confirm(`Your username will be "${name}". You can't change it later. Continue?`)) cancel();
		}}
	>
		<input
			name="username"
			value={form?.username ?? ''}
			autocomplete="username"
			autocapitalize="none"
			spellcheck="false"
			required
			aria-describedby="rules"
		/>
		<button class="button">Continue</button>
	</form>
	<p id="rules" class="rules">{data.rules}</p>
	{#if form?.message}<p class="error">{form.message}</p>{/if}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		max-width: 26rem;
		margin: 4rem auto 0;
		padding: 2rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		background: var(--surface);
	}

	p {
		margin: 0 0 0.5rem;
		color: var(--muted);
	}

	form {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--bg);
		font: inherit;
	}

	.warning {
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--collar);
		border-radius: 0.5rem;
		color: inherit;
	}

	.rules {
		font-size: 0.85rem;
	}

	.error {
		color: var(--collar);
	}
</style>
