<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Brians · Brian</title>
</svelte:head>

<article>
	<h1>Brians</h1>
	<p>
		Your own notes are your brian, <strong>{data.user?.username}</strong>, and only you can see them. Shared
		brians are folders in <code>brian/</code> that other people are members of too.
	</p>

	{#if data.invites.length}
		<section class="invites" aria-labelledby="invites">
			<h2 id="invites">Invitations</h2>
			<ul>
				{#each data.invites as invite (invite.brianId)}
					<li class="invite">
						<div>
							<strong>{invite.brianName}</strong>
							<span class="muted">from {invite.from} · as {invite.role === 'editor' ? 'an editor' : 'a viewer'}</span>
						</div>
						<div class="answer">
							<form method="post" action="?/accept" use:enhance>
								<input type="hidden" name="brian" value={invite.brianId} />
								<button class="button small">Accept</button>
							</form>
							<form method="post" action="?/decline" use:enhance>
								<input type="hidden" name="brian" value={invite.brianId} />
								<button class="button ghost small">Decline</button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
			<p class="muted small-print">
				Accepting adds the brian as a folder in <code>brian/</code>, synced to your devices and visible to your agents.
				{#if data.invites.some((i) => i.role === 'editor')}As an editor, anything you put in it reaches every member.{/if}
			</p>
			{#if form?.inviteMessage}<p class="error">{form.inviteMessage}</p>{/if}
		</section>
	{/if}
	{#if form?.joined}<p class="notice">Joined. It's in your Brian at <code>brian/{form.joined}/</code>.</p>{/if}

	<h2>Shared with you</h2>
	{#if data.brians.length}
		<ul>
			{#each data.brians as brian (brian.id)}
				<li class="row">
					<a href="/b/{brian.id}">{brian.name}</a>
					<span class="muted">brian/{brian.mount}/ · {brian.role} · {brian.visibility}</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">None yet. Create one, or ask a friend to invite you to theirs.</p>
	{/if}

	<h2>New brian</h2>
	<form method="post" action="?/create" use:enhance class="create">
		<label>
			Name
			<input name="name" value={form?.name ?? ''} autocapitalize="none" spellcheck="false" required />
		</label>
		<fieldset>
			<label class="choice"><input type="radio" name="visibility" value="private" checked /> Private: invite only, even to see it</label>
			<label class="choice"><input type="radio" name="visibility" value="public" /> Public: anyone with the link can sync to it, as a viewer</label>
		</fieldset>
		<button class="button">Create</button>
	</form>
	<p class="muted small-print">{data.rules}</p>
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

	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0;
	}

	p,
	.muted {
		color: var(--muted);
	}

	.create {
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

	fieldset {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.choice {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	input:not([type='radio']) {
		width: 20rem;
		max-width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--surface);
		font: inherit;
	}

	.small-print {
		font-size: 0.85rem;
	}

	.invites {
		margin-top: 2rem;
		padding: 0.25rem 1.25rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		background: var(--surface);
	}

	.invites h2 {
		margin-top: 1rem;
	}

	.invite {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
		padding: 0.6rem 0;
	}

	.invite + .invite {
		border-top: 1px solid var(--line);
	}

	.invite div:first-child {
		display: flex;
		flex-direction: column;
	}

	.answer {
		display: flex;
		gap: 0.4rem;
	}

	.small {
		padding: 0.3rem 0.9rem;
		font-size: 0.9rem;
	}

	.notice {
		margin-top: 1.5rem;
	}

	.error {
		color: var(--collar);
	}
</style>
