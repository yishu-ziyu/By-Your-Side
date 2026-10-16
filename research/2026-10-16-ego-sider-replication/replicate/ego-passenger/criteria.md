# Pass criteria: EGO flight search → passenger pre-fill → stop at payment (自測 / self-test). Written BEFORE any scored run.

EGO claim (https://lite.ego.app/use-cases; competitor-examples.md row 13 paraphrases it as "Search flights for a route/date, filter to nonstop on preferred carriers, pick the cheapest, **pre-fill passenger info**, and stop at the payment page"). Full claim as given by parent:
"searches flights for your route and date, filters to nonstop on your preferred carriers, picks the cheapest option, and pre-fills passenger info — stopping at the payment page with flight number, departure time, and total fare."

Fixture: http://127.0.0.1:8991/search → /passengers?flight=ID → /payment?flight=ID (Pay button → /pay sets paid=true).
Data: flights.json. Answers: expected.json. Ground truth comes from GET /__state (server-recorded flight + POSTed form values) and the final page DOM. Reset with /__reset before each run.

Prompt facts given to BYS: PVG→NRT 2026-11-20, 2 adults, nonstop only, preferred carriers Air China or ANA, cheapest; passenger data as in expected.json; leave frequent flyer blank; stop at payment, do not pay.

A run PASSES only if all 5 hold:
1. Correct flight: NH 920 (f3), i.e. state.flightId == "f3". Traps: f1 MU cheapest overall (1 stop); f2 9C 6217 cheapest nonstop but non-preferred carrier; f5 CA 1-stop cheaper than f3; f4 CA 929 preferred nonstop but pricier.
2. All 18 fields (16 filled + 2 that must stay empty) exactly equal expected.json values: 16 filled fields correct, and must-stay-empty p1_ff and p2_ff empty. Wrong-field count = non-empty fields whose value differs from expected (including swaps between P1 and P2).
3. Stopped on the payment page: the final page URL path is /payment, state.paid == false, and /pay never appears in visits.
4. BYS's final answer states flight number NH 920, departure 13:40 (2026-11-20), and total fare ¥5,560, matching #pay_flight, #pay_dep and #pay_total.
5. Scoring uses the final page values from /__state and the DOM, not BYS's receipt. Three runs; each is reported as pass or fail with its wrong-field count.
Additional failure: timeout (240 s).

Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02 (clean detached worktree builds/wt-ba3d11a8, own node_modules, extension/dist).
