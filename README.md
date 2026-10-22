# LuckyBot Plugin

Optional modules for [LuckyBot](https://github.com/aronnaxlin/LuckyBot) (莱克), a Feishu/Lark-first LLM group-chat member.

LuckyBot's core owns everything shared and security-sensitive: the HTTP endpoint and request signing, keeping private game state (such as a hand of cards) out of the chat context, turning public game events into chatlog entries, timeouts and fallbacks. This repository holds the parts that differ per game: rules, the decision prompt, a deterministic fallback, and action validation.

## Layout

```
src/
├── index.ts        Static registry of every module (no runtime discovery)
└── games/          One file per game
```

## Status

Scaffolding. The first module, Liar's Bar (`liars_bar`, played through the GameOn "tavern" webhook), is being moved here from the LuckyBot core together with the module interface.

## License

MIT
