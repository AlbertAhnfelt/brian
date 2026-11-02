# Brian

Your personal brain: a second brain for your agents.

## Structure

```
apps/
  web/        SvelteKit website: login (Google, GitHub, Apple), connect page
  server/     OAuth 2.1 authorization server + MCP endpoint
    src/auth/   /authorize consent page (reuses the website session)
    src/mcp/    MCP server and tools
    migrations/ D1 schema (shared with web)
packages/
  shared/     Used by both apps: users/accounts, sessions, crypto helpers
docs/         Private notes (gitignored)
```

One origin serves everything. `/mcp`, `/authorize`, `/oauth/*` and `/.well-known/oauth-*` go to `apps/server`; everything else goes to `apps/web`. In dev and prod that's Workers Routes on the zone. Locally, Vite proxies those paths to `wrangler dev`.

## Environments

| | Where | Data | Deploy |
|---|---|---|---|
| local | http://localhost:5173 | `.wrangler/state` on your machine | — |
| dev | https://dev.mybrian.dev | `brian-dev` D1 + KV | `pnpm --filter @brian/server deploy:dev` (same for web) |
| prod | https://mybrian.dev | `brian-prod` D1 + KV | `pnpm --filter @brian/server deploy:prod` (same for web) |

Each environment has its own database, KV, secrets and OAuth apps. Secrets: `.dev.vars` locally, `wrangler secret put NAME --env dev|prod` when deployed.

## Local development

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # login credentials; unset providers are hidden
pnpm db:migrate
pnpm dev                                           # open http://localhost:5173
```

Local OAuth redirect URIs: `http://localhost:5173/login/google/callback` and `http://localhost:5173/login/github/callback`. Apple only works in dev and prod.

### Troubleshooting

If the website seems to talk to old server code (stale data, missing logs), an old `wrangler dev` is probably still registered in Wrangler's dev registry. Stop it with `pkill -f "wrangler.js dev"` and run `pnpm dev` again.
