<svelte:head>
	<title>Privacy · Brian</title>
</svelte:head>

<h1>Privacy</h1>
<p class="updated">Last updated 9 November 2026</p>

<p>
	Brian stores your notes so your AI agents can use them. That only works if you trust us with
	them, so here is plainly what we keep, why, and who else touches it.
</p>

<h2>What we store</h2>
<ul>
	<li><strong>Your account:</strong> your email address, name and username, and an ID from each login provider you use (Google, GitHub or Apple).</li>
	<li><strong>Your Brian:</strong> the pages you, your agents or the Obsidian plugin write to it, and the shared brians you're in. Deleted pages stay in a trash for 30 days, then they are erased.</li>
	<li><strong>Edit history:</strong> for each page, who changed it, when, and with which app (for example "Claude" or "Obsidian"). Not the text of old versions.</li>
	<li><strong>Your friends:</strong> the people you've added as friends.</li>
	<li><strong>Sign-in data:</strong> website sessions and the access you grant to apps like Claude or ChatGPT. We store only fingerprints (hashes) of the secret tokens, never the tokens themselves.</li>
	<li><strong>Basic logs:</strong> request logs kept briefly to keep the service running and find bugs.</li>
</ul>

<h2>What other people see</h2>
<ul>
	<li>
		<strong>Your username</strong> is visible to the people you share a brian with, and to anyone who
		searches for your exact username or exact email address. A search shows your username, never your
		email.
	</li>
	<li>
		<strong>Shared brians</strong> are seen by all their members, and public ones by anyone who joins.
		Members can see who is in a brian and who changed its pages. Your personal Brian is never shared.
	</li>
</ul>

<h2>The Obsidian plugin</h2>
<p>
	The plugin syncs the markdown notes in your vault with your Brian, and nothing else: no images,
	attachments or settings. It keeps its sign-in and a copy of the sync state on your device. Notes in a
	shared brian's folder go to that brian, so its members see them.
</p>

<h2>What we don't do</h2>
<ul>
	<li>We don't sell your data or show you ads.</li>
	<li>We don't train AI models on your notes, or let anyone else do so.</li>
	<li>We don't read your notes, except when you ask us to help with a problem, or when the law requires it.</li>
</ul>

<h2>Who else is involved</h2>
<ul>
	<li><strong>Cloudflare</strong> hosts Brian and stores its data.</li>
	<li><strong>Google, GitHub and Apple</strong> handle signing in. They tell us your email and name, and nothing about your notes.</li>
	<li>
		<strong>The apps you connect</strong>, such as Claude or ChatGPT, can read and write your Brian once you
		allow them. What they do with it is governed by their own privacy policies. You can disconnect them
		at any time.
	</li>
</ul>

<h2>Your choices</h2>
<p>
	You can export your notes (the trash included), disconnect apps, leave shared brians and delete your account.
	Deleting your account erases your Brian, the shared brians you own, and your account data. What you wrote in
	other people's shared brians stays there, because it's theirs too. Backups may keep a copy for a short while
	before they expire.
</p>

<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:privacy@mybrian.dev">privacy@mybrian.dev</a>.</p>
