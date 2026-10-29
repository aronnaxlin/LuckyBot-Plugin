# Game Modules

These game modules currently serve only the repository maintainer's private group. The protocol is a third-party dealer's specification and may change at any time; they are not offered as a public service or guaranteed API. The vendored OpenAPI document is `../tavern/openapi.json`; prose docs live at <https://docs.linkong.dev/protocol/>.

## Modules

| Game | id | Notes |
| --- | --- | --- |
| Liar's Bar | `liars_bar` | `classic`, `devil` and `chaos` modes; demon cards and aim requests. |
| Bullet Poker | `bullet_poker` | Hold'em-style hands paid in bullets; swap → pick is two decisions under one deadline. |

`GameModule` (`types.ts`) is a plain object of functions:

- `describeState(req)` — private summary for the generic `choices` prompt (hand/hole cards, board, odds, log, chat). Only the decision model sees this.
- `fallbackChoice(req)` — an id from `req.choices` when the model fails; the protocol handler falls back to a uniformly random valid id if it is missing or invalid.
- `decideAction(req, deps)` / `fallback(req)` / `validate(req, reply)` — the legacy per-game action path, used only when a decision has no usable `choices` array.
- `describeEvent`, `wakesBot`, `isGameEnd` — public event text and scheduling.
- `createRoundNote(req)` / `createDecisionNote(req, reply)` — the private `scene.note`.

## Decision paths

Every decision request from the dealer now carries `ask`, `prompt`, `rules` and `choices`. The generic path builds the model prompt from those plus `describeState`, accepts only an id present in `choices`, and replies `{ "turn_id": <path turn_id>, "choice": "<id>" }`. The legacy per-game path remains for dealers that omit `choices`, and uses the game's own validation and fallback.

Budget: `min(config.decisionTimeoutMs, deadline_ms - 3000)`, floor 1000 ms. Default `decisionTimeoutMs` is 40000, capped at 58000.

## Table talk privacy

Decisions see the full private state. The table talker (the bot's primary turn) does not: the `scene.note` from `createRoundNote` / `createDecisionNote` carries the round, mode, target, hand size and the public shape of the bot's last move only — never card faces, hole cards, swap-offer cards, or whether a play was honest.

This rule was learned from live games (2026-10-24): when the note carried the hand, the bot said its cards aloud and announced plays before the decision was made, and the humans played against that. A prompt rule alone did not hold. Keep the notes blind; `protocol.test.ts` scripts a game of each type and asserts that no private card reaches any `scene.note` or `chat.publish` text.

Public events (revealed cards at a challenge, showdown hands) may be described; the swap event never says what was drawn.
