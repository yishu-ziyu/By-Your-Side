# ego-chess — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Play a Lichess game until it ends, reading the board each turn"

Fixture: http://127.0.0.1:8995/chess/game (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 在这个本地棋盘上和机器人下一盘棋，我执白，一直下到对局结束，每步先看清棋盘。

Pass criterion / expected:
Game reaches an end state on the page (checkmate or king captured). Bot plays scripted e5, Nc6, Nf6, a6, h6... so Scholar's mate (Bc4, Qh5/Qf3, Qxf7#) ends it. Distractor: illegal/meaningless moves are accepted but don't end the game. Pass = state result recorded.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
