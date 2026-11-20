<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const view = $derived(data.view);
	const owner = $derived(view.member && view.brian.role === 'owner');
</script>

<svelte:head>
	<title>{view.brian.name} · Brian</title>
</svelte:head>

<article>
	<h1>{view.brian.name}</h1>
	<p class="read"><a class="button ghost" href="/b/{view.brian.id}/read">Read it</a></p>

	{#if !view.member}
		<p>A public brian. Sync to it to get it in your Brian as a read-only folder in <code>brian/</code>.</p>
		<form method="post" action="?/join" use:enhance>
			<button class="button">Sync to this brian</button>
		</form>
	{:else}
		<p>
			In your Brian at <code>brian/{view.brian.mount}/</code>. You're {view.brian.role === 'owner' ? 'the owner' : `a ${view.brian.role}`},
			and it's {view.brian.visibility}{view.brian.visibility === 'public' ? ': anyone with this page’s link can sync to it as a viewer' : ': invite only'}.
			<a href="/activity?brian={view.brian.id}">See its activity</a>.
		</p>

		<h2>Members</h2>
		<ul>
			{#each view.members as member (member.username)}
				<li class="row">
					<span>{member.username} <span class="muted">· {member.role}</span></span>
					{#if owner && member.role !== 'owner'}
						<span class="actions">
							<form method="post" action="?/role" use:enhance>
								<input type="hidden" name="username" value={member.username} />
								<input type="hidden" name="role" value={member.role === 'editor' ? 'viewer' : 'editor'} />
								<button class="button ghost small">make {member.role === 'editor' ? 'viewer' : 'editor'}</button>
							</form>
							<form method="post" action="?/remove" use:enhance>
								<input type="hidden" name="username" value={member.username} />
								<button class="button ghost small">remove</button>
							</form>
						</span>
					{/if}
				</li>
			{/each}
		</ul>

		{#if owner}
			{#if view.invites.length}
				<h3>Invited</h3>
				<ul>
					{#each view.invites as sent, i (`${i}:${sent.who}`)}
						<li class="row">
							<span>{sent.who} <span class="muted">· {sent.role} · waiting for an answer</span></span>
							<form method="post" action="?/cancel" use:enhance>
								<input type="hidden" name="who" value={sent.who} />
								<button class="button ghost small">cancel</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			<h2>Invite someone</h2>
			<form method="post" action="?/invite" use:enhance class="inline">
				<input
					name="who"
					value={form?.who && !form?.invited ? form.who : ''}
					placeholder="username or email"
					list="friends"
					autocapitalize="none"
					autocomplete="off"
					spellcheck="false"
					required
				/>
				<datalist id="friends">
					{#each data.friends as friend (friend)}<option value={friend}></option>{/each}
				</datalist>
				<select name="role">
					<option value="editor">editor</option>
					<option value="viewer">viewer</option>
				</select>
				<button class="button ghost">Invite</button>
			</form>
			{#if form?.invited === 'email'}
				<p class="notice">
					Invited {form.who.toLowerCase()}. It waits for whoever signs in to Brian with that address, and they join once they accept.
					Brian doesn't email them, so let them know.
				</p>
			{:else if form?.invited}
				<p class="notice">Invited {form.who}. They join once they accept.</p>
			{/if}
			<p class="muted small-print">
				They join once they accept. Editors' changes reach every member; viewers can read, but not change it.
			</p>

			<h2>Visibility</h2>
			<form method="post" action="?/visibility" use:enhance>
				<input type="hidden" name="visibility" value={view.brian.visibility === 'public' ? 'private' : 'public'} />
				<button class="button ghost">Make {view.brian.visibility === 'public' ? 'private' : 'public'}</button>
			</form>

			<h2>Delete</h2>
			<p class="muted">
				This removes the brian for every member. It stays in the trash for 30 days, and you can restore it, with its members, from
				<a href="/brians">Brians</a> until then.
			</p>
			<form method="post" action="?/delete" class="stack">
				<label>
					Type <strong>{view.brian.name}</strong> to confirm
					<input name="confirm" autocomplete="off" />
				</label>
				<button class="button danger">Delete this brian</button>
			</form>
		{:else}
			<h2>Leave</h2>
			<form method="post" action="?/leave">
				<button class="button ghost">Leave this brian</button>
			</form>
		{/if}
	{/if}

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

	h3 {
		margin: 1.5rem 0 0.5rem;
		font-size: 1.05rem;
		font-weight: 500;
	}

	ul {
		margin: 0 0 1rem;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
	}

	p,
	.muted {
		color: var(--muted);
	}

	.small {
		padding: 0.3rem 0.8rem;
		font-size: 0.85rem;
	}

	.read {
		margin: 1rem 0 0;
	}

	.small-print {
		font-size: 0.85rem;
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 0.5rem;
	}

	/* Fields beside a pill button: the same height and shape. */
	.inline input,
	.inline select {
		padding: 0.65rem 1.1rem;
		border-radius: 999px;
		font-size: 0.95rem;
	}

	.stack {
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

	input,
	select {
		min-width: 0;
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

	.notice {
		color: var(--ink);
	}
</style>
