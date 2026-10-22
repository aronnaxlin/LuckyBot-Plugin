# LuckyBot Plugin

This repository provides optional modular plugins for [LuckyBot](https://github.com/aronnaxlin/LuckyBot).

Core acts as the **host** providing strictly scoped capabilities (model invocation, HTTP routing, chat publishing, scoped storage, and logging). Plugins are declared statically and mount inside the LuckyBot core as a Git submodule at `plugins/`. For the complete normative specification, see [LuckyBot Plugin Specification (docs/plugins.md)](https://github.com/aronnaxlin/LuckyBot/blob/main/docs/plugins.md).

## Architecture & Principles

- **No host internals exposed**: Plugins never receive the DI container, database connections, platform clients, or chat context.
- **Privacy invariant**: Private data (e.g. card hands, internal secrets) stays in the plugin memory/storage and never enters the chat context or prompt history. Only public events are pushed via `ctx.capabilities.chat.publish`.
- **Default-off**: Plugins and game tables are disabled by default until enabled in deployment configuration.

## Layout

```text
src/
├── sdk/              Plugin SDK contract and type definitions
├── tavern/           Tavern webhook protocol (HMAC verification, routing, seq management)
├── games/
│   ├── types.ts      Game module interface
│   └── liars-bar/    Liar's Bar game logic (rules, prompt, fallback, validation)
└── index.ts          Static plugin registry export
```

## First Plugin: Tavern & Liar's Bar

The repository includes the `tavern` plugin implementing the dealer webhook protocol (OpenAPI v1) and the `liars_bar` game module. See `src/games/README.md` for deployment and maintenance notes.

### Reverse Proxy & Path Notice

The Tavern HMAC signature covers the exact request method, path, and raw body: `HMAC_SHA256(secret, "${timestamp}.${METHOD}.${path}.${rawBody}")`. When exposing the webhook via a reverse proxy or tunnel (such as Cloudflare Tunnel, Nginx, or frp), the proxy **must pass the request path through without rewriting or altering prefixes**, or the HMAC signature check will fail with HTTP 401.

## License

MIT
