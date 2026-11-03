<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const providerNames: Record<string, string> = { google: 'Google', github: 'GitHub', apple: 'Apple' };
	const date = (seconds: number) =>
		new Date(seconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
</script>

<svelte:head>
	<title>Account · Brian</title>
</svelte:head>

<article>
	<h1>Account</h1>
	<p>Signed in as {data.user?.email}.</p>

	<h2>Logins</h2>
	<ul>
		{#each data.logins as login (login.provider)}
			<li>{providerNames[login.provider] ?? login.provider} <span class="muted">· {login.email}</span></li>
		{/each}
	</ul>
	{#if data.addable.length}
		<p class="add">
			{#each data.addable as provider (provider.id)}
				<a href="/login/{provider.id}?link" class="button ghost small" data-sveltekit-reload>
					Add {provider.label}
				</a>
			{/each}
		</p>
	{/if}

	<h2>Connected apps</h2>
	{#if data.connections.length}
		<ul>
			{#each data.connections as connection (connection.grantId)}
				<li class="row">
					<span>{connection.clientName} <span class="muted">· since {date(connection.createdAt)}</span></span>
					<form method="post" action="?/disconnect" use:enhance>
						<input type="hidden" name="grantId" value={connection.grantId} />
						<button class="button ghost small">disconnect</button>
					</form>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">No apps yet. <a href="/connect">Connect one.</a></p>
	{/if}

	<h2>Your data</h2>
	<p><a href="/account/export" class="button ghost" data-sveltekit-reload>Export as zip</a></p>

	<h2>Sessions</h2>
	<form method="post" action="?/signOutEverywhere">
		<button class="button ghost">Sign out everywhere</button>
	</form>

	<h2>Delete account</h2>
	<p class="muted">
		This erases your Brian and disconnects every app. It can't be undone, so export first if you want a copy.
	</p>
	<form method="post" action="?/delete" class="delete">
		<label>
			Type <strong>{data.user?.email}</strong> to confirm
			<input name="confirm" autocomplete="off" />
		</label>
		<button class="button danger">Delete my account</button>
	</form>
	{#if form?.message}<p class="error">{form.message}</p>{/if}
</article>

<style>
	article {
		max-width: 36rem;
		padding-top: 3rem;
	}

	h2 {
		margin: 2.25rem 0 0.75rem;
		font-size: 1.3rem;
		font-weight: 500;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		padding: 0.4rem 0;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.muted,
	p {
		color: var(--muted);
	}

	.small {
		padding: 0.3rem 0.8rem;
		font-size: 0.85rem;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.delete {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		color: var(--muted);
	}

	input {
		width: 20rem;
		max-width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
		font: inherit;
	}

	.danger {
		border-color: var(--collar);
		background: var(--collar);
		color: #fff;
	}

	.error {
		color: var(--collar);
	}
</style>
