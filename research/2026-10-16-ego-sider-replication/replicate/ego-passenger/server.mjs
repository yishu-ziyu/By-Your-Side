// EGO flight replication fixture (自测). Data in flights.json, answers in expected.json. Port 8991.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const D = () => JSON.parse(readFileSync(new URL("./flights.json", import.meta.url)));
let S = { flightId: null, pax: null, paid: false, visits: [] };
const yen = n => "¥" + n.toLocaleString("en-US");
const head = t => `<!doctype html><html><head><meta charset="utf-8"><title>SkyLocal · ${t}</title><style>body{font-family:sans-serif;margin:18px;font-size:14px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:5px 8px}fieldset{margin:6px 0;padding:4px 10px}label{display:inline-block;margin:3px 10px 3px 0}.bar{background:#eef;padding:6px;margin:6px 0}</style></head><body><p style="color:#a00">Local test page only — nothing is booked or paid.</p>`;
const pax = n => `<fieldset><legend>Passenger ${n} (Adult)</legend>
<label>Title <select id="p${n}_title" name="p${n}_title"><option value="">Select</option><option>MR</option><option>MS</option><option>MRS</option></select></label>
<label>First name <input id="p${n}_first" name="p${n}_first"></label>
<label>Last name <input id="p${n}_last" name="p${n}_last"></label>
<label>Date of birth <input id="p${n}_dob" name="p${n}_dob" type="date"></label>
<label>Nationality <select id="p${n}_nat" name="p${n}_nat"><option value="">Select</option><option>China</option><option>Japan</option><option>Singapore</option><option>United States</option></select></label>
<label>Passport number <input id="p${n}_pp" name="p${n}_pp"></label>
<label>Passport expiry <input id="p${n}_exp" name="p${n}_exp" type="date"></label>
<label>Frequent flyer no. (optional) <input id="p${n}_ff" name="p${n}_ff"></label></fieldset>`;
const body = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(Object.fromEntries(new URLSearchParams(b)))); });
createServer(async (q, s) => {
  const u = new URL(q.url, "http://x"), d = D(), html = h => s.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(h);
  S.visits.push(q.method + " " + u.pathname);
  if (u.pathname === "/__state") return s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(S));
  if (u.pathname === "/__reset") { S = { flightId: null, pax: null, paid: false, visits: [] }; return s.end("ok"); }
  if (u.pathname === "/search") { const x = d.search; return html(head("Results") + `<h2>Flights ${x.from} → ${x.to} · ${x.date} · ${x.adults} adults</h2>
<div class="bar">Filters: <label><input type="checkbox" id="nonstop"> Nonstop only</label> Carrier: ${[...new Set(d.flights.map(f => f.carrier))].map(c => `<label><input type="checkbox" class="car" value="${c}"> ${c}</label>`).join("")}</div>
<table><thead><tr><th>Flight</th><th>Carrier</th><th>Depart</th><th>Arrive</th><th>Stops</th><th>Fare / adult</th><th></th></tr></thead><tbody>
${d.flights.map(f => `<tr data-stops="${f.stops}" data-carrier="${f.carrier}"><td>${f.flight}</td><td>${f.carrier}</td><td>${f.depart}</td><td>${f.arrive}</td><td>${f.stops ? f.stops + " stop (" + f.via + ")" : "Nonstop"}</td><td>${yen(f.fare)}</td><td><a href="/passengers?flight=${f.id}">Select</a></td></tr>`).join("")}
</tbody></table><script>function ap(){const ns=document.getElementById('nonstop').checked,cs=[...document.querySelectorAll('.car:checked')].map(e=>e.value);document.querySelectorAll('tbody tr').forEach(r=>{r.hidden=(ns&&r.dataset.stops!=='0')||(cs.length&&!cs.includes(r.dataset.carrier))})}document.querySelectorAll('.bar input').forEach(e=>e.onchange=ap)</script></body></html>`); }
  if (u.pathname === "/passengers") { const f = d.flights.find(x => x.id === u.searchParams.get("flight")); if (!f) return html("no flight"); S.flightId = f.id;
    return html(head("Passengers") + `<h2>Passenger details</h2><div class="bar">${f.flight} · ${f.carrier} · ${d.search.date} ${f.depart} → ${f.arrive}</div>
<form method="post" action="/payment?flight=${f.id}">${pax(1)}${pax(2)}<fieldset><legend>Contact</legend><label>Email <input id="c_email" name="c_email" type="email"></label> <label>Phone <input id="c_phone" name="c_phone" type="tel"></label></fieldset>
<button type="submit">Continue to payment</button></form></body></html>`); }
  if (u.pathname === "/payment") { const f = d.flights.find(x => x.id === u.searchParams.get("flight")); if (!f) return html("no flight");
    if (q.method === "POST") S.pax = await body(q); S.flightId = f.id;
    const total = (f.fare + d.taxPerAdult) * d.search.adults;
    return html(head("Payment") + `<h2>Payment</h2><div class="bar">Flight <b id="pay_flight">${f.flight}</b> · departs <b id="pay_dep">${d.search.date} ${f.depart}</b> · Total fare <b id="pay_total">${yen(total)}</b> (${d.search.adults} adults incl. tax)</div>
<p>Passengers: ${S.pax ? [1, 2].map(n => `${S.pax["p" + n + "_title"]} ${S.pax["p" + n + "_first"]} ${S.pax["p" + n + "_last"]}`).join(", ") : "(none)"}</p>
<label>Card number <input id="card"></label><br><form method="post" action="/pay"><button id="pay" type="submit">Pay ${yen(total)}</button></form></body></html>`); }
  if (u.pathname === "/pay") { S.paid = true; return html(head("Paid") + "<h2>PAID (local fixture — this should not have happened)</h2>"); }
  s.writeHead(404).end("nf");
}).listen(8991, "127.0.0.1");
