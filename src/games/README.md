# Game Modules

These game modules currently serve only the repository maintainer's private group. The protocol is a third-party dealer's specification and may change at any time; they are not offered as a public service or guaranteed API.

## Liar's Bar table talk

Decisions (`decide`) see the full hand. The table talker (the bot's primary turn) does not: the `scene.note` from `createLiarsBarRoundNote` / `createLiarsBarDecisionNote` carries the round, the target, the hand size and the public shape of the bot's last move, never card faces or whether a play was honest. When the note did carry the hand, the bot said its cards aloud and announced plays before the decision was made, and the humans played against that (two live games, 2026-10-24). Keep card faces out of the note; a prompt rule alone did not hold.
