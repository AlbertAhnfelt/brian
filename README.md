# Brian

Your personal brain: a second brain for your agents.

## Structure

```
apps/
  web/        SvelteKit website: login (Google, GitHub, Apple), username, connect, brians, account
  server/     OAuth 2.1 authorization server + MCP endpoint
    src/auth/   /authorize consent page (reuses the website session)
    src/mcp/    MCP server and tools
    src/brian/  brians: membership (members.ts) and path routing for MCP (router.ts)
    src/vault/  Vault Durable Object: one brian's pages (SQLite + full-text search + change feed,
                a Yjs document and history per page) and its sync WebSockets
    src/sync/   POST /mcp/sync (sync tickets) and GET /sync/socket
    src/account.ts  Account RPC the website calls over a service binding
    migrations/ D1 schema (shared with web)
packages/
  shared/     Used by both apps: users, usernames, sessions, brian types,
              BRIAN.md templates, LIMITS (every tunable amount), crypto helpers
  sync/       Shared by the server and the plugin: the sync protocol, text → Yjs edits,
              path rules, and the headless sync engine (BrianSync)
apps/obsidian/  The Obsidian plugin: sign-in, one sync engine per brian, vault events
docs/         Private notes (gitignored)
```

One origin serves everything. `/mcp`, `/authorize`, `/oauth/*`, `/sync/*` and `/.well-known/oauth-*` go to `apps/server`; everything else goes to `apps/web`. In dev and prod that's Workers Routes on the zone. Locally, Vite proxies those paths to `wrangler dev`.

## Brians

A user's **Brian** is made of **brians**, each a folder of markdown pages with its own `Vault` Durable Object:

- **Personal brian:** the vault root, plus `brian/<username>/`, a folder agents write in freely. Only its owner can see it, and it's never shared. Its Durable Object is named after the user ID.
- **Shared brians:** mounted at `brian/<name>/`, with members in D1. Each has exactly one owner, plus editors (their changes reach every member) and viewers (read-only). Each is **private** (invite only) or **public** (anyone with the link can join as a viewer). Its Durable Object is named after the brian ID (`b_<uuid>`).

On every MCP request, `src/brian/router.ts` loads the user's memberships and routes `brian/<mount>/…` to that brian's vault, with everything else going to the personal one. Roles are enforced there, in code. Each brian starts with a `BRIAN.md`, from templates in `packages/shared/src/templates.ts`: `brian/BRIAN.md` says how agents work with this user, and each shared brian's says what's in it. Agents keep both up to date.

Users choose a username once, on `/welcome`, before an app can connect. Shared brians are managed on `/brians` and `/b/<id>`. Limits (pages per brian, page size, shared brians per user, …) live in `packages/shared/src/limits.ts`.

## Environments

| | Where | Data | Deploy |
|---|---|---|---|
| local | http://localhost:5173 | `.wrangler/state` on your machine | — |
| dev | https://dev.mybrian.dev | `brian-dev` D1 + KV | `pnpm --filter @brian/server deploy:dev` (same for web) |
| prod | https://mybrian.dev | `brian-prod` D1 + KV | `pnpm --filter @brian/server deploy:prod` (same for web) |

Each environment has its own database, KV, secrets and OAuth apps. Secrets: `.dev.vars` locally, `wrangler secret put NAME --env dev|prod` when deployed.

**Deploying:** apply D1 migrations first (`pnpm --filter @brian/server db:migrate:dev`), then deploy the server, then the website, because the website calls the server's Account RPC.

**Dev is private:** sign-in on dev is limited to the `ALLOWED_EMAILS` secret (comma-separated). It must be set on **both** `brian-web-dev` and `brian-server-dev`. If it's missing, nobody can sign in ("This is a private test site.").

## Local development

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # login credentials; unset providers are hidden
pnpm db:migrate
pnpm dev                                           # open http://localhost:5173
pnpm test                                          # server tests run in the Workers runtime
```

### The Obsidian plugin

```sh
pnpm --filter @brian/obsidian build     # or `dev` to rebuild on every change
```

Copy `apps/obsidian/dist/main.js` and `apps/obsidian/manifest.json` into `<vault>/.obsidian/plugins/brian/`, turn on community plugins, and enable Brian. For dev, set Settings → Brian → Server to `https://dev.mybrian.dev` before signing in. Use a test vault: the plugin syncs the whole vault.

Local OAuth redirect URIs: `http://localhost:5173/login/google/callback` and `http://localhost:5173/login/github/callback`. Apple only works in dev and prod.

### Troubleshooting

- **Build output and type checks:** a leftover build in `apps/web/.svelte-kit/cloudflare` changes the generated Worker types, so `wrangler types --check` would fail. The website's `build` and `check` scripts run `pnpm clean` first, which removes it. If you run `wrangler types --check` by hand after a build, run `pnpm --filter @brian/web clean` first.
- **Cross-site form posts aren't blocked under `vite dev`.** SvelteKit's origin check only takes effect in a built app. A production build returns 403, so don't rely on the dev server for CSRF testing.
- If the website seems to talk to old server code (stale data, missing logs), an old `wrangler dev` is probably still registered in Wrangler's dev registry. Stop it with `pkill -f "wrangler.js dev"` and run `pnpm dev` again.

## License

[AGPL-3.0](LICENSE). You may run and change Brian, but if you offer a modified version as a service, you must publish your changes under the same license.
