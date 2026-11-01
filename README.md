# Brian

Your personal brain: a second brain for your agents.

## Structure

```
apps/
  web/      SvelteKit website (Cloudflare Workers)
  server/   Backend Worker: MCP server, API, Durable Objects
packages/
  shared/   Types and code shared between apps
docs/       Private notes (gitignored)
```

## Development

```sh
pnpm install
pnpm dev:web
pnpm dev:server
```
