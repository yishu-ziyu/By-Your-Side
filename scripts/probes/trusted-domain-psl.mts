// 前提：tldts 按公共后缀表算域名，且能被扩展的 esbuild 打包。
import { getDomain } from "tldts";

const cases = { "zh.wikipedia.org": "wikipedia.org", "en.wikipedia.org": "wikipedia.org", "alice.github.io": "alice.github.io", "bob.github.io": "bob.github.io", "www.bbc.co.uk": "bbc.co.uk", "x.com": "x.com", "v.flomoapp.com": "flomoapp.com", "flomo.test": "flomo.test", "127.0.0.1": null };

const got = Object.fromEntries(Object.keys(cases).map(h => [h, getDomain(h, { allowPrivateDomains: true })]));

console.log(got);

process.exitCode = Object.entries(cases).every(([h, want]) => got[h] === want) ? 0 : 1;
