// Tiny real request per model: pi ModelRuntime resolves the id (same path as the companion),
// then one chat completion to its baseUrl. Key read from ~/.pi/agent/auth.json, never printed.
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs"; import { homedir } from "node:os";

const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"));

const rt = await ModelRuntime.create();

let bad = 0;

for (const full of process.argv.slice(2)) {
  const [prov, ...rest] = full.split("/");
  const r = resolveCliModel({ cliProvider: prov, cliModel: rest.join("/"), modelRuntime: rt });

  if (!r.model) { console.log(full, "RESOLVE_FAIL", r.error); bad++; continue; }

  const m: any = r.model; const t0 = Date.now();

  const res = await fetch(`${m.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth[prov].key}`, "x-opencode-session": `bys-modelcheck-${Date.now()}`, "x-opencode-client": "pi" },
    body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 800 }) });

  const j: any = await res.json().catch(() => ({}));
  const text = j.choices?.[0]?.message?.content ?? "";

  if (!res.ok) bad++;
  console.log(full, `api=${m.api}`, `http=${res.status}`, JSON.stringify(String(text).slice(0, 40)), `${Date.now() - t0}ms`, res.ok ? "" : JSON.stringify(j).slice(0, 300));
}

process.exit(bad ? 1 : 0);
