# Brian

**A second brain for your AI agents.** Brian keeps your notes as markdown pages that Claude, ChatGPT and other AI apps can read and write, and syncs them with your Obsidian vault. What you write in Obsidian reaches your agents; what they write shows up in Obsidian.

Hosted at [mybrian.dev](https://mybrian.dev). Brian is early: expect rough edges, and keep a backup of your notes.

## How it works

- **Your Brian** is your notes, stored on Brian's servers. Agents reach it through [MCP](https://modelcontextprotocol.io): they can list, search, read, write, move and delete pages.
- **The Obsidian plugin** syncs your vault with your Brian, live, across all your devices. Edits from several devices and agents merge instead of overwriting each other.
- **`brian/` is where agents work.** `brian/<your username>/` is theirs to write in freely. Everything else in your vault is your own notes, which agents only edit when you ask them to.
- **`BRIAN.md` files tell agents how to work.** The one at the root holds the rules every agent follows, `brian/BRIAN.md` holds what they've learned about you, and each shared brian has its own guide. Agents keep them up to date.
- **Shared brians** are folders you share with friends, at `brian/<name>/`. Invite a friend as an editor (their changes reach everyone) or a viewer (read-only); they join once they accept. Public brians can be joined by anyone with the link, as viewers.

## Get started

1. Sign up at [mybrian.dev](https://mybrian.dev) with Google, GitHub or Apple, and pick a username.
2. **Connect an AI app:** add `https://mybrian.dev/mcp` as a custom connector (MCP server) in Claude, ChatGPT or any MCP client, and allow it when Brian asks.
3. **Sync Obsidian** (optional): install the plugin, then choose **Sign in** in its settings.

### Installing the Obsidian plugin

Brian isn't in Obsidian's community plugin list yet. Until it is, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Obsidian's community plugins.
2. In BRAT, choose **Add beta plugin** and enter `AlbertAhnfelt/brian`.
3. Enable **Brian** in Settings → Community plugins, and sign in from its settings.

Before you start:

- **Back up your vault.** Brian is new, and it syncs your whole vault.
- **Brian must be the only thing syncing the vault.** Turn off Obsidian Sync, iCloud, Git and Remotely Save for it first: with two sync tools, edits can arrive twice.
- A vault that already has a `brian/` folder has to rename it first.

### Disclosures

- **Account required.** Syncing needs a free Brian account at [mybrian.dev](https://mybrian.dev), signed in with Google, GitHub or Apple.
- **Network use.** The plugin sends the markdown notes in your vault to Brian's servers at mybrian.dev (hosted on Cloudflare), and receives changes from them, to sync your notes with your Brian, your other devices and your agents. Notes in a shared brian's folder also reach that brian's members. It sends nothing else: no images, attachments, settings or other files, and no telemetry.
- **Files.** It reads and writes markdown files in your vault only, never outside it. Deleted notes go to the trash you picked in Obsidian's settings.
- **No payments or ads.**
- **Open source.** All of Brian, the server included, is in this repository.

[Privacy policy](https://mybrian.dev/privacy) · [Terms](https://mybrian.dev/terms)

## Security

Your notes are private, so security reports matter a lot. If you find a vulnerability, please don't open a public issue: report it privately through GitHub's [security advisories](https://github.com/AlbertAhnfelt/brian/security/advisories/new), or email [privacy@mybrian.dev](mailto:privacy@mybrian.dev).

## Development

Brian runs on Cloudflare Workers: a SvelteKit website, an OAuth 2.1 + MCP server, Durable Objects (one SQLite database per brian), D1 and KV. Sync uses [Yjs](https://yjs.dev) over WebSockets.

### Structure

```
apps/
  web/        SvelteKit website: login (Google, GitHub, Apple), username, connect, brians, account
  server/     OAuth 2.1 authorization server + MCP endpoint
    src/auth/   /authorize consent page (reuses the website session)
    src/mcp/    MCP server and tools
    src/brian/  brians: membership and invitations (members.ts) and path routing for MCP (router.ts)
    src/vault/  Vault Durable Object: one brian's pages (SQLite + full-text search + change feed,
                a Yjs document and history per page) and its sync WebSockets
    src/sync/   POST /mcp/sync (sync tickets) and GET /sync/socket
    src/account.ts  Account RPC the website calls over a service binding
    migrations/ D1 schema (shared with web)
  obsidian/   The Obsidian plugin: sign-in, one sync engine per brian, vault events
packages/
  shared/     Used by both apps: users, usernames, sessions, brian types, agent rules and
              BRIAN.md templates, LIMITS (every tunable amount), crypto helpers
  sync/       Shared by the server and the plugin: the sync protocol, text → Yjs edits,
              path rules, and the headless sync engine (BrianSync)
```

One origin serves everything. `/mcp`, `/authorize`, `/oauth/*`, `/sync/*` and `/.well-known/oauth-*` go to `apps/server`; everything else goes to `apps/web`. Deployed, that's Workers Routes on the zone. Locally, Vite proxies those paths to `wrangler dev`.

### Brians, in code

A user's **Brian** is made of **brians**, each a folder of markdown pages with its own `Vault` Durable Object, so a request routed to one brian can never reach another's pages:

- **Personal brian:** the vault root, plus `brian/<username>/`. Only its owner can see it, and it's never shared. Its Durable Object is named after the user ID.
- **Shared brians:** mounted at `brian/<mount>/`, with members and invitations in D1. Each has exactly one owner, plus editors and viewers. Owners invite people from their friends list; nobody becomes a member without accepting. Its Durable Object is named after the brian ID (`b_<uuid>`).

On every MCP request, `src/brian/router.ts` loads the user's memberships and routes `brian/<mount>/…` to that brian's vault, with everything else going to the personal one. Roles are enforced there, in code, and pages from shared brians come labelled as such. The rules agents follow live in one place, `agentRules()` in `packages/shared/src/templates.ts`: they make up both the MCP server's instructions and the block Brian keeps current in each user's root `BRIAN.md`.

Users choose a username once, on `/welcome`, before an app can connect. Shared brians are managed on `/brians` and `/b/<id>`. Limits (pages per brian, page size, shared brians per user, …) live in `packages/shared/src/limits.ts`.

### Local development

Needs Node and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # login credentials; providers left unset are hidden
pnpm db:migrate
pnpm dev                                           # open http://localhost:5173
pnpm test                                          # server tests run in the Workers runtime
pnpm check                                         # types, for every package
```

Signing in locally needs your own Google or GitHub OAuth app, with the redirect URI `http://localhost:5173/login/google/callback` or `http://localhost:5173/login/github/callback`. Apple only works on a real HTTPS domain.

### Working on the Obsidian plugin

```sh
pnpm --filter @brian/obsidian build     # or `dev` to rebuild on every change
```

Copy `apps/obsidian/dist/main.js` and `apps/obsidian/manifest.json` into `<vault>/.obsidian/plugins/brian/`, turn on community plugins, and enable Brian. To point it at another server, change Settings → Brian → Server before signing in. Use a test vault: the plugin syncs the whole vault.

### Environments and deploying

| | Where | Deploy |
|---|---|---|
| local | http://localhost:5173 | — (data in `.wrangler/state`) |
| dev | https://dev.mybrian.dev | `pnpm --filter @brian/server deploy:dev`, then the same for `@brian/web` |
| prod | https://mybrian.dev | `pnpm --filter @brian/server deploy:prod`, then the same for `@brian/web` |

Each environment has its own D1 database, KV namespace, secrets and OAuth apps. Secrets come from `.dev.vars` locally and `wrangler secret put NAME --env dev|prod` when deployed. Deploy in this order: D1 migrations (`pnpm --filter @brian/server db:migrate:dev`), then the server, then the website, because the website calls the server's Account RPC.

Setting `RESTRICT_LOGIN` to `"true"` limits sign-in to the emails in the `ALLOWED_EMAILS` secret (comma-separated), set on both Workers. Dev uses this. With the list missing, nobody can sign in.

### Releasing the Obsidian plugin

`pnpm release:plugin 0.2.0` (from a clean, pushed `main`) bumps the version in `apps/obsidian/`, commits, tags `0.2.0` (no `v`: Obsidian wants the bare version) and pushes. The tag starts `.github/workflows/release-plugin.yml`, which runs the checks and tests, builds the plugin, publishes a GitHub release with `main.js` and `manifest.json`, and only then copies `manifest.json` to the repo root, where Obsidian looks for the latest version. So Obsidian never sees a version whose release doesn't exist yet. Run it with the current version to release that version for the first time.

### Troubleshooting

- **Build output and type checks:** a leftover build in `apps/web/.svelte-kit/cloudflare` changes the generated Worker types, so `wrangler types --check` would fail. The website's `build` and `check` scripts run `pnpm clean` first, which removes it. If you run `wrangler types --check` by hand after a build, run `pnpm --filter @brian/web clean` first.
- **Cross-site form posts aren't blocked under `vite dev`.** SvelteKit's origin check only takes effect in a built app. A production build returns 403, so don't rely on the dev server for CSRF testing.
- **The website talks to old server code** (stale data, missing logs): an old `wrangler dev` is probably still registered in Wrangler's dev registry. Stop it with `pkill -f "wrangler.js dev"` and run `pnpm dev` again.

## License

[AGPL-3.0](LICENSE). You may run and change Brian, but if you offer a modified version as a service, you must publish your changes under the same license.
