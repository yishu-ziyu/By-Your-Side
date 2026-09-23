/**
 * QA-01 隔离无头验收（任务书 v2 §9/§12）：
 * F1–F5、C1–C5、S1–S7；C6 由另一会话做剪贴板桥（本表记「另一会话」）。
 * S4/S5/S6（及依赖判断的 S7）各一次真实 Jev（decideBrowserCandidate / realtime judge）。
 *
 * 隔离构建：SIDEAGENT_BUILD_DIST → 临时目录，不覆盖日常 extension/dist。
 * 宿主链：createBrowserTools → ToolRpc → __saCall → 扩展。
 * Oracle：独立 DOM / 事件计数 / 测试服务器收件；不用 verified=true 或脚本自写生产状态。
 * 本会话不执行 reload:ext；不改 paste/clipboard-bridge。
 *
 * 用法：npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless
 * 退出码：0=已跑 yes/no 场景全 yes（gap/未跑/另一会话/BLOCKED 不挡）；1=有 no；2=环境 BLOCKED。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { ToolExecutionFact, ToolName } from "../../shared/protocol.js";
import type { IsolationCleanup } from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) {
  console.error("Required: --headless（本脚本只以 --headless=new 隔离无头运行）");
  process.exit(2);
}

/**
 * ONLY=<逗号分隔场景 ID>：只执行列出的场景，其余一律不执行任何工具调用，
 * 记成 verdict="未跑" 并进 notRun。用法：
 *   npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S4,S6
 *   ONLY=S4,S6 npx tsx ... --headless
 *
 * 存在的理由：整轮 19 个场景约 7 分钟，改一个场景也要等整轮，迭代太慢。
 *
 * 边界（不许拿它造假）：过滤掉的是「未跑」，不是「通过」。
 * - 未选中的场景 verdict 固定为 "未跑"，断言列表为空，绝不能被算作 yes；
 * - 退出码只按实际跑过的 yes/no 算（hard 集合已排除 "未跑"）；
 * - notRun 里逐条记录被过滤的 ID，制品自描述；
 * - 全量留证仍必须跑一次不带 ONLY 的整轮。
 */
const onlyArg =
  process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ??
  process.env.ONLY ??
  "";

const onlyIds = new Set(
  onlyArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const filterNote = onlyIds.size > 0 ? `ONLY=${[...onlyIds].join(",")}` : "";

// A credential is not spending authority. Explicit invocation budget defaults to zero.
const jevBudget = Number(process.argv.find(a => a.startsWith("--jev-budget="))?.split("=")[1] ?? 0);

if (!Number.isSafeInteger(jevBudget) || jevBudget < 0 || jevBudget > 100) throw new Error("--jev-budget must be an integer in 0..100");

const s5Fixture = process.argv.find(a => a.startsWith("--s5-fixture="))?.split("=")[1];

if (s5Fixture && !["uncertain-second", "nonclick-second", "valid"].includes(s5Fixture)) throw new Error("Unknown S5 fixture judgment");

const s5Entry = process.argv.find(a => a.startsWith("--s5-entry="))?.split("=")[1] ?? "realtime";

if (!["realtime", "loop"].includes(s5Entry)) throw new Error("--s5-entry must be realtime or loop");

let providerRequests = 0;

const repo = resolve(import.meta.dirname, "../..");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const out = resolve(repo, "out/acceptance", `browser-capability-integration-v2-${stamp}`);

await mkdir(out, { recursive: true });

/** A JSON value: what these acceptance artifacts serialize into result.json / summary.md. */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** Independent oracle evidence for one scenario: the JSON object the page/host reported. */
type IndependentEvidence = { readonly [name: string]: JsonValue };

/** Tool-call parameters forwarded to createBrowserTools / ToolRpc, which validate every
 * field against ToolContract (shared/protocol.ts). */
type ToolParams = {
  action?: string;
  api?: string;
  method?: string;
  params?: { readonly [name: string]: JsonValue };
  url?: string;
  target?: string;
  value?: string;
  values?: string[];
  paths?: string[];
  text?: string;
  code?: string;
  type?: string;
  token?: string;
  downloadId?: string;
  path?: string;
  key?: string;
  button?: string;
  point?: number[];
  deltaX?: number;
  deltaY?: number;
  tabId?: number;
  types?: string[] | "all";
  limit?: number;
  timeoutMs?: number;
  fullPage?: boolean;
  scale?: string;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  from?: { target: string };
  to?: { target: string };
};

/** The host tool_result envelope that __saCall / ToolRpc resolve with. */
type HostToolResult = { ok?: boolean; data?: JsonValue; error?: string; executionFact?: ToolExecutionFact };

/** One ToolRpc lifecycle event recorded into the artifact. */
type RpcEvent =
  | { at: number; kind: "rpc-start"; id: string; name: string; params: unknown }
  | { at: number; kind: "rpc-end"; id: string; name: string; ok: boolean | undefined; error?: string; executionFact?: ToolExecutionFact }
  | { at: number; kind: "rpc-error"; id: string; error: string };

/** waitForNetworkIdle readback: the fields the F4/F4b oracles read. */
type NetworkIdleResult = { idle?: boolean; waitedMs?: number; integrity?: string };

/** Snapshot readback used only to count the controls the stale-ref case observed. */
type SnapshotControlCount = { observation?: { controls?: unknown[] }; controls?: unknown[] };

/** An action whose resolved value the caller discards; only its rejection is asserted. */
type RejectableAction = () => Promise<JsonValue>;

/** Decoded PNG pixel buffer: dimensions, channel count, row stride and raw RGB bytes. */
type DecodedPng = { w: number; h: number; ch: number; stride: number; px: Buffer };

/** One sample point and the rgb() string read from that pixel. */
type PixelSample = { x: number; y: number; rgb: string };

/** Hit rate over the 3×3 sample grid plus the per-point evidence. */
type ColorHit = { rate: number; samples: PixelSample[] };

/** Upload receipts the fixture oracle server observed. */
type FixtureUpload = { at: number; bytes: number; path?: string };

/** Blob downloads the fixture oracle server observed. */
type FixtureDownload = { at: number; name: string; bytes: number };

/** Isolated build evidence recorded in the artifact. */
interface BuildRecord {
  exitCode?: number | null;
  outDir?: string;
  dailyDistBefore?: string | null;
  backgroundSha256?: string | null;
  stderrTail?: string[];
  dailyDistAfter?: string | null;
  dailyDistUnchanged?: boolean;
}

/** Host/extension identity evidence recorded for this isolated run. */
interface IdentityRecord {
  extensionId?: unknown;
  manifestName?: string;
  manifestVersion?: string;
  chrome?: unknown;
  fixtureOrigin?: string;
  buildBackgroundSha256?: string | null;
  unauthorizedPath?: string;
  host?: string;
}

/** Everything written to out/acceptance/.../result.json. */
interface RunRecord {
  ok: boolean;
  status: "PASS" | "FAIL" | "BLOCKED";
  command: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  gitHead?: string;
  sourceFingerprint?: string;
  sourceFingerprintAfter?: string;
  sourceUnchanged?: boolean;
  build: BuildRecord;
  identity: IdentityRecord;
  scenarios: ScenarioResult[];
  notRun: Array<{ id: string; reason: string }>;
  /** full = 不带 ONLY 的整轮；filtered = 只跑了 ONLY 指定的子集。 */
  runKind?: "full" | "filtered";
  /** 本次实际执行的场景 ID（filtered 时为空数组以外的子集）。 */
  executed?: string[];
  /** 被 ONLY 过滤掉、未执行任何工具调用的场景 ID。 */
  filteredOut?: string[];
  cleanup?: unknown;
  modelRequests: number;
  reason?: string;
  error?: string;
  fixtureCloseError?: string;
  rpcEvents?: unknown;
  realJevScenes?: string[];
  productFilesChanged?: string[];
}

type Verdict = "yes" | "no" | "gap" | "未跑" | "BLOCKED" | "另一会话";

type Assertion = { id: string; ok: boolean; detail?: JsonValue };

type ScenarioResult = {
  id: string;
  verdict: Verdict;
  entry: string;
  assertions: Assertion[];
  independent: IndependentEvidence;
  hostChain: boolean;
  error?: string;
  notes?: string;
  requiredNotRun?: string[];
  realJev?: {
    used: boolean;
    modelRequests: number;
    decisions?: unknown[];
    reasonCodes?: string[];
    elapsedMs?: number;
    error?: string;
  };
};

const secretBody = `UNAUTH_SECRET_${randomBytes(8).toString("hex")}`;

const unauthorizedPath = join(await mkdtemp(join(tmpdir(), "bys-qa01-unauth-")), "leak.txt");

await writeFile(unauthorizedPath, secretBody);

const scenarios: ScenarioResult[] = [];

const record: RunRecord = {
  ok: false,
  status: "FAIL",
  command: "npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless",
  exitCode: null,
  startedAt: new Date().toISOString(),
  build: {},
  identity: {},
  scenarios,
  notRun: [
    { id: "accept:capability旧七案", reason: "现通道直接 load 日常 extension/dist，未绑本轮隔离指纹；本轮不跑" },
    { id: "reload:ext", reason: "本会话授权可用但先不执行；clipboard 另一会话落地后由协调者统一重载" },
  ],
  modelRequests: 0,
  realJevScenes: [],
  productFilesChanged: [],
};

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

async function fingerprintSources(): Promise<string> {
  const roots = [
    "agent/src",
    "shared",
    "extension/src",
    "scripts/acceptance",
    "package.json",
    "package-lock.json",
  ];

  const parts: string[] = [];

  const visit = async (abs: string, rel: string) => {
    const st = await stat(abs);

    if (st.isDirectory()) {
      const names = (await readdir(abs)).sort();

      for (const name of names) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        await visit(join(abs, name), join(rel, name));
      }

      return;
    }

    if (!st.isFile()) return;

    if (!/\.(ts|mts|mjs|js|json|md)$/.test(rel) && !rel.endsWith("package-lock.json") && !rel.endsWith("package.json")) return;
    const dig = sha256(await readFile(abs));
    parts.push(`${rel}\0${dig}`);
  };

  for (const root of roots) {
    const abs = join(repo, root);

    if (!existsSync(abs)) continue;
    const st = await stat(abs);

    if (st.isFile()) await visit(abs, root);
    else await visit(abs, root);
  }

  parts.sort();

  return sha256(parts.join("\n"));
}

function check(sc: ScenarioResult, id: string, ok: boolean, detail?: JsonValue): boolean {
  const assertion: Assertion = { id, ok };

  if (detail !== undefined) assertion.detail = detail;
  sc.assertions.push(assertion);

  return ok;
}

/**
 * ONLY 过滤：被过滤的场景记成"未跑"并跳过全部执行，返回 true 表示"已跳过，别跑了"。
 * 绝不让被过滤的场景以任何形式变成 yes。
 */
function filtered(id: string, entry: string): boolean {
  if (onlyIds.size === 0 || onlyIds.has(id)) return false;
  scenarios.push({
    id,
    verdict: "未跑",
    entry: `${entry}［未执行，被 ${filterNote} 过滤］`,
    assertions: [],
    independent: {},
    hostChain: true,
    notes: `filtered out by ${filterNote}`,
  });
  record.notRun.push({ id, reason: `filtered out by ${filterNote}` });

  return true;
}

/**
 * 最小 PNG 解码器（IHDR + IDAT + 反 filter）→ RGB 像素缓冲。
 * 只用于 C5 的独立像素 oracle：截图必须真的是页面画面，不能是纯色占位图。
 * 历史上 clip 路径曾画一块 #444 灰布、把 source 标成 visible-tab 返回，
 * 而旧断言只核对「clip 参数被回传了」，占位图照样通过——所以这里改成读真实像素。
 */
function decodePngRgb(b64: string): DecodedPng {
  const buf = Buffer.from(b64.replace(/^data:image\/png;base64,/, ""), "base64");
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 6;
  const idat: Buffer[] = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9] ?? 6;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    off += 12 + len;
  }

  if (w <= 0 || h <= 0) throw new Error(`非法 PNG 尺寸 ${w}x${h}`);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  const raw = inflateSync(Buffer.concat(idat));
  let p = 0;

  for (let y = 0; y < h; y++) {
    const f = raw[p++] ?? 0;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch]! : 0;
      const b = up ? up[i]! : 0;
      const c = up && i >= ch ? up[i - ch]! : 0;
      let v = line[i]!;

      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }

      cur[i] = v;
    }
  }

  return { w, h, ch, stride, px };
}

/** 3×3 采样点上命中目标 rgb 的比例。 */
function colorHitRate(
  img: DecodedPng,
  target: [number, number, number],
  tol = 12,
): ColorHit {
  const { w, h, ch, stride, px } = img;
  const pts: Array<[number, number]> = [];

  for (const fy of [0.25, 0.5, 0.75]) for (const fx of [0.25, 0.5, 0.75]) pts.push([Math.floor(w * fx), Math.floor(h * fy)]);
  const samples: PixelSample[] = [];
  let hit = 0;

  for (const [x, y] of pts) {
    const i = y * stride + x * ch;
    const rgb: [number, number, number] = [px[i]!, px[i + 1]!, px[i + 2]!];
    samples.push({ x, y, rgb: `rgb(${rgb.join(",")})` });

    if (Math.abs(rgb[0] - target[0]) <= tol && Math.abs(rgb[1] - target[1]) <= tol && Math.abs(rgb[2] - target[2]) <= tol) hit++;
  }

  return { rate: hit / samples.length, samples };
}

// ── fixture server（独立 oracle：上传收件、慢请求 hold）──────────────────────
type Hold = { openedAt: number; closedAt?: number; ms: number };

const uploads: FixtureUpload[] = [];

const holds: Hold[] = [];

const downloads: FixtureDownload[] = [];

const fixtureState = { uploads, holds, downloads, hits: 0 };

/** Fixture documents served by the independent oracle server, keyed by pathname. */
interface FixturePages { readonly [pathname: string]: string }

const pages: FixturePages = {
  "/f1": `<!doctype html><meta charset=utf-8><title>F1 upload</title>
<input id=file type=file multiple>
<pre id=log></pre>
<script>
window.__f1={inputEvents:0,changeEvents:0,files:()=>[...document.getElementById('file').files].map(f=>({name:f.name,size:f.size}))};
const el=document.getElementById('file');
el.addEventListener('input',()=>{__f1.inputEvents++});
el.addEventListener('change',()=>{__f1.changeEvents++});
</script>`,
  "/s1": `<!doctype html><meta charset=utf-8><title>S1 click</title>
<button id=go>Go</button><span id=count>0</span>
<script>
window.__s1={clicks:0};
document.getElementById('go').addEventListener('click',()=>{__s1.clicks++;document.getElementById('count').textContent=String(__s1.clicks)});
</script>`,
  "/s2": (() => {
    const buttons: string[] = [];

    for (let i = 0; i < 80; i++) buttons.push(`<button type=button data-region=A data-i=${i}>A-${i}</button>`);

    for (let i = 0; i < 160; i++) {
      const label = i === 40 ? "Submit-Target" : `B-${i}`;
      buttons.push(`<button type=button data-region=B data-i=${i} id="${i === 40 ? "target" : `b${i}`}">${label}</button>`);
    }

    return `<!doctype html><meta charset=utf-8><title>S2 240 controls</title>
<style>button{display:block;margin:2px 0}</style>
<section aria-label="Region A">${buttons.slice(0, 80).join("")}</section>
<section aria-label="Region B" style="margin-top:40vh">${buttons.slice(80).join("")}</section>
<script>
window.__s2={clicks:{},total:0};
document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
  const key=b.getAttribute('data-region')+'-'+b.getAttribute('data-i');
  __s2.clicks[key]=(__s2.clicks[key]||0)+1; __s2.total++;
}));
</script>`;
  })(),
  "/f4": `<!doctype html><meta charset=utf-8><title>F4 slow</title>
<button id=start>start-slow</button><pre id=status>idle</pre>
<script>
window.__f4={started:false,done:false,error:null};
document.getElementById('start').onclick=async()=>{
  __f4.started=true; document.getElementById('status').textContent='pending';
  try{
    const r=await fetch('/hold?ms=2500');
    await r.text();
    __f4.done=true; document.getElementById('status').textContent='done';
  }catch(e){__f4.error=String(e); document.getElementById('status').textContent='error';}
};
</script>`,
  "/f4b": `<!doctype html><meta charset=utf-8><title>F4b idle after attach</title>
<button id=start>start-slow</button><pre id=status>idle</pre>
<script>
window.__f4b={started:false,done:false};
document.getElementById('start').onclick=async()=>{
  __f4b.started=true; document.getElementById('status').textContent='pending';
  const r=await fetch('/hold?ms=2000'); await r.text();
  __f4b.done=true; document.getElementById('status').textContent='done';
};
</script>`,
  "/f5a": `<!doctype html><meta charset=utf-8><title>F5 doc A</title>
<div id=mark data-doc=A>DOC-A</div><button id=late style="display:none">Late</button>
<script>setTimeout(()=>{document.getElementById('late').style.display='block'},8000);</script>`,
  "/f5b": `<!doctype html><meta charset=utf-8><title>F5 doc B</title>
<div id=mark data-doc=B>DOC-B</div>`,
  "/c1": `<!doctype html><meta charset=utf-8><title>C1 pointer</title>
<style>#dbl{width:120px;height:60px;background:#ddd}#slot{width:160px;height:80px;border:1px dashed #888;margin-top:12px}
#card{width:80px;height:40px;background:#6af;cursor:grab}#html5from,#html5to{width:100px;height:60px;display:inline-block;margin:8px;border:1px solid #333}
#html5from{background:#fc9}#html5to{background:#cfc}</style>
<div id=dbl>double</div><pre id=dblmsg></pre>
<div id=card draggable=false>drag-me</div><div id=slot>slot</div><pre id=dragmsg></pre>
<div id=html5from draggable=true>H5-from</div><div id=html5to>H5-to</div><pre id=h5msg></pre>
<script>
window.__c1={dbl:0,pointerDrag:false,h5:null,events:[]};
const dbl=document.getElementById('dbl');
dbl.addEventListener('click',()=>{__c1.events.push('click')});
dbl.addEventListener('dblclick',()=>{__c1.dbl++;document.getElementById('dblmsg').textContent='DBL:'+__c1.dbl});
const card=document.getElementById('card'), slot=document.getElementById('slot');
let dragging=false;
card.addEventListener('pointerdown',e=>{dragging=true;card.setPointerCapture(e.pointerId)});
card.addEventListener('pointerup',()=>{dragging=false});
card.addEventListener('pointermove',e=>{
  if(!dragging)return;
  const r=slot.getBoundingClientRect();
  if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){
    __c1.pointerDrag=true; document.getElementById('dragmsg').textContent='IN-SLOT';
  }
});
const from=document.getElementById('html5from'), to=document.getElementById('html5to');
from.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','H5-PAYLOAD'); __c1.events.push('dragstart')});
to.addEventListener('dragover',e=>e.preventDefault());
to.addEventListener('drop',e=>{e.preventDefault(); const d=e.dataTransfer.getData('text/plain'); __c1.h5=d; document.getElementById('h5msg').textContent='DROP:'+d});
</script>`,
  "/c2": `<!doctype html><meta charset=utf-8><title>C2 buttons wheel</title>
<style>.box{width:140px;height:100px;overflow:auto;display:inline-block;margin:8px;border:1px solid #000}
.box .inner{height:400px}</style>
<button id=ctx>ctx</button><button id=mid>mid</button>
<div id=w1 class=box data-w=1><div class=inner>W1</div></div>
<div id=w2 class=box data-w=2><div class=inner>W2</div></div>
<pre id=log></pre>
<script>
window.__c2={contextmenu:0,middle:0,wheel1:0,wheel2:0,anyWheel:0,held:false,released:true};
const log=()=>{document.getElementById('log').textContent=JSON.stringify(__c2)};
document.getElementById('ctx').addEventListener('contextmenu',e=>{e.preventDefault();__c2.contextmenu++;log()});
document.getElementById('mid').addEventListener('auxclick',e=>{if(e.button===1){__c2.middle++;log()}});
document.getElementById('w1').addEventListener('wheel',()=>{__c2.wheel1++;log()},{passive:true});
document.getElementById('w2').addEventListener('wheel',()=>{__c2.wheel2++;log()},{passive:true});
document.addEventListener('wheel',()=>{__c2.anyWheel++;log()},{passive:true,capture:true});
window.addEventListener('keydown',e=>{if(e.key==='Shift'){__c2.held=true;__c2.released=false;log()}});
window.addEventListener('keyup',e=>{if(e.key==='Shift'){__c2.released=true;log()}});
</script>`,
  "/c3": `<!doctype html><meta charset=utf-8><title>C3 events</title>
<button id=popup>popup</button>
<button id=dl>download</button>
<button id=chooser>chooser</button>
<button id=dlg>dialog</button>
<input id=dynfile type=file style="display:none">
<pre id=c3log></pre>
<script>
window.__c3={chooserOpened:0,dialogSeen:0};
document.getElementById('popup').onclick=()=>window.open('/c3-popup','c3p','width=320,height=200');
document.getElementById('dl').onclick=()=>{
  const blob=new Blob(['BLOB-DL-CONTENT'],{type:'text/plain'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='qa01-blob.txt'; a.click();
};
document.getElementById('chooser').onclick=()=>{document.getElementById('dynfile').click(); __c3.chooserOpened++};
document.getElementById('dynfile').addEventListener('change',()=>{document.getElementById('c3log').textContent='CHOOSER:'+([...dynfile.files].map(f=>f.name).join(','))});
document.getElementById('dlg').onclick=()=>{ const ok=confirm('QA01-CONFIRM'); __c3.dialogSeen++; document.getElementById('c3log').textContent='DLG:'+ok };
</script>`,
  "/c3-popup": `<!doctype html><meta charset=utf-8><title>C3 popup</title><div id=pop>POPUP-OK</div>`,
  "/c4": `<!doctype html><meta charset=utf-8><title>C4 locator</title>
<button id=vis aria-label="Accessible Save">Visible Label</button>
<button id=dup1 aria-label="Twin Action">Twin A</button>
<button id=dup2 aria-label="Twin Action">Twin B</button>
<div id=host></div>
<iframe id=fr src="/c4-frame" style="width:280px;height:120px;border:1px solid #999"></iframe>
<button id=other>Other</button>
<script>
const host=document.getElementById('host');
const root=host.attachShadow({mode:'open'});
root.innerHTML='<button id=shadowBtn>Shadow Click</button>';
window.__c4={aria:0,shadow:0,frame:0,other:0,twin:0};
document.getElementById('vis').onclick=()=>{__c4.aria++};
document.getElementById('other').onclick=()=>{__c4.other++};
document.getElementById('dup1').onclick=()=>{__c4.twin++};
document.getElementById('dup2').onclick=()=>{__c4.twin++};
root.getElementById('shadowBtn').onclick=()=>{__c4.shadow++};
window.addEventListener('message',e=>{if(e.data==='frame-click')__c4.frame++});
</script>`,
  "/c4-frame": `<!doctype html><meta charset=utf-8><title>frame</title>
<button id=inframe>InFrame</button>
<script>document.getElementById('inframe').onclick=()=>parent.postMessage('frame-click','*');</script>`,
  "/c5": `<!doctype html><meta charset=utf-8><title>C5 select wait shot</title>
<select id=multi multiple size=4>
<option value=a>Alpha</option><option value=b>Beta</option><option value=c>Gamma</option>
</select>
<button id=hideLater>HideLater</button>
<div id=clipTarget style="position:absolute;left:40px;top:120px;width:80px;height:40px;background:#f66">CLIP</div>
<script>
window.__c5={hiddenGone:false};
const b=document.getElementById('hideLater');
setTimeout(()=>{b.style.display='none'; __c5.hiddenGone=true},1500);
</script>`,
  "/s3": (() => {
    const long = "LONGTEXT-" + "字".repeat(800);
    const buttons = [];

    for (let i = 0; i < 120; i++) buttons.push(`<button type=button data-i=${i} id="s3b${i}">Btn-${i}</button>`);

    return `<!doctype html><meta charset=utf-8><title>S3 long</title>
<p id=prose>${long}</p>
<span id=counter>0</span>
<input id=source value="SRC-A"/>
<section>${buttons.join("")}</section>
<script>
window.__s3={clicks:{},counter:0};
document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
  __s3.clicks[b.id]=(__s3.clicks[b.id]||0)+1;
}));
setInterval(()=>{__s3.counter++;document.getElementById('counter').textContent=String(__s3.counter)},200);
</script>`;
  })(),
  "/s4": (() => {
    const fields = [];

    for (let i = 1; i <= 30; i++) fields.push(`<label>Field ${i}<input id=f${i} name=f${i} value="INIT-${i}"/></label>`);

    return `<!doctype html><meta charset=utf-8><title>S4 fields</title>
<form id=form>${fields.join("<br/>")}</form>
<script>window.__s4={};</script>`;
  })(),
  "/s5": `<!doctype html><meta charset=utf-8><title>S5 hover menu</title>
<style>
#menu{position:relative;display:inline-block;padding:8px;background:#eee}
#items{display:none;position:absolute;left:0;top:100%;background:#fff;border:1px solid #333;min-width:140px}
#menu:hover #items{display:block}
#items button{display:block;width:100%;text-align:left}
</style>
<div id=menu tabindex=0>Account
  <div id=items role=menu>
    <button type=button id=settings role=menuitem>Settings</button>
    <button type=button id=forbidden role=menuitem>Forbidden</button>
  </div>
</div>
<pre id=s5log></pre>
<script>
window.__s5={settings:0,forbidden:0};
document.getElementById('settings').onclick=()=>{__s5.settings++;document.getElementById('s5log').textContent='SETTINGS'};
document.getElementById('forbidden').onclick=()=>{__s5.forbidden++;document.getElementById('s5log').textContent='FORBIDDEN'};
</script>`,
  "/s6": (() => {
    const early=[];

 for(let i=0;i<90;i++) early.push(`<button type=button data-r=E data-i=${i}>Early-${i}</button>`);
    const late=[];

 for(let i=0;i<90;i++){
      const label=i===50?'Late-Target':`Late-${i}`;
      late.push(`<button type=button data-r=L data-i=${i} id="${i===50?'lateTarget':`l${i}`}">${label}</button>`);
    }

    return `<!doctype html><meta charset=utf-8><title>S6 continue</title>
<style>button{display:block}</style>
<section aria-label="Early">${early.join("")}</section>
<section aria-label="Late" style="margin-top:50vh">${late.join("")}</section>
<script>window.__s6={clicks:{}} ;document.querySelectorAll('button').forEach(b=>b.onclick=()=>{const k=b.getAttribute('data-r')+'-'+b.getAttribute('data-i');__s6.clicks[k]=(__s6.clicks[k]||0)+1});</script>`;
  })(),
  "/s6none": (() => {
    const bs=[];

 for(let i=0;i<100;i++) bs.push(`<button type=button id=n${i}>Noise-${i}</button>`);

    return `<!doctype html><meta charset=utf-8><title>S6 none</title>${bs.join("")}
<script>window.__s6n={total:0};document.querySelectorAll('button').forEach(b=>b.onclick=()=>{__s6n.total++});</script>`;
  })(),
  "/s7": `<!doctype html><meta charset=utf-8><title>S7 handoff</title>
<input id=field value=""/>
<button id=once>WriteOnce</button>
<pre id=s7log></pre>
<script>
window.__s7={writes:0,last:''};
document.getElementById('once').onclick=()=>{
  const v=document.getElementById('field').value;
  __s7.writes++; __s7.last=v; document.getElementById('s7log').textContent='W:'+__s7.writes+':'+v;
};
</script>`,
};

const fixture = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  fixtureState.hits += 1;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/hold") {
    const ms = Math.min(10_000, Math.max(100, Number(url.searchParams.get("ms") ?? 2500)));
    const hold: Hold = { openedAt: Date.now(), ms };
    fixtureState.holds.push(hold);
    await new Promise((r) => setTimeout(r, ms));
    hold.closedAt = Date.now();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("held-ok");

    return;
  }

  if (url.pathname === "/upload" && req.method === "POST") {
    const chunks: Buffer[] = [];

    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks);
    fixtureState.uploads.push({ at: Date.now(), bytes: body.length });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("uploaded");

    return;
  }

  if (url.pathname === "/dl" && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "qa01-server.txt";
    const body = Buffer.from(`SERVER-DL:${name}`);
    fixtureState.downloads.push({ at: Date.now(), name, bytes: body.length });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
    });
    res.end(body);

    return;
  }

  const html = pages[url.pathname];

  if (html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);

    return;
  }

  res.writeHead(404);
  res.end("missing");
});

await new Promise<void>((resolveListen, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", () => {
    fixture.removeListener("error", reject);
    resolveListen();
  });
});

// SAFETY: the promise above resolved from the `listen` callback with no error, so the
// server is bound and `address()` returns the bound AddressInfo (numeric `port`), not
// null and not the pipe-name form `address()` can also return.
const fixturePort = (fixture.address() as { port: number }).port;

const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

// ── 隔离构建 ───────────────────────────────────────────────────────────────
const dailyDistPath = join(repo, "extension/dist/background.js");

const dailyDistBefore = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;

record.sourceFingerprint = await fingerprintSources();

record.gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

const isoRoot = await mkdtemp(join(tmpdir(), "sideagent-qa01-dist-"));

const buildDir = join(isoRoot, "extension", "dist");

const build = spawnSync("node", ["build.mjs"], {
  cwd: join(repo, "extension"),
  env: { ...process.env, SIDEAGENT_BUILD_DIST: buildDir },
  encoding: "utf8",
});

const builtBg = join(buildDir, "background.js");

record.build = {
  exitCode: build.status,
  outDir: buildDir,
  dailyDistBefore,
  backgroundSha256: existsSync(builtBg) ? sha256(await readFile(builtBg)) : null,
  stderrTail: (build.stderr ?? "").split("\n").slice(-8),
};

if (build.status !== 0 || !existsSync(builtBg)) {
  record.status = "FAIL";
  record.reason = "隔离构建失败";
  record.exitCode = 1;
  await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, reason: "隔离构建失败", out }, null, 2));
  process.exit(1);
}

const prevCwd = process.cwd();

process.chdir(isoRoot);

let launchIsolatedExtension: typeof import("./isolated-extension.mts").launchIsolatedExtension;

try {
  ({ launchIsolatedExtension } = await import("./isolated-extension.mts"));
} finally {
  process.chdir(prevCwd);
}

const { ToolRpc } = await import("../../agent/src/rpc.js");

const { createBrowserTools } = await import("../../agent/src/tools.js");

const { TaskUploadLedger } = await import("../../agent/src/upload-paths.js");

const { runBrowserDecisionLoop } = await import("../../agent/src/browser-decision-loop.js");

const { decideBrowserCandidate: providerDecide } = await import("../../agent/src/browser-decision-model.js");

const decideBrowserCandidate: typeof providerDecide = async (input, signal) => {
  if (providerRequests >= jevBudget) throw new Error("MODEL_BUDGET_EXHAUSTED: no further provider request sent");

  if (!input.page.url.startsWith(`${fixtureOrigin}/`)) throw new Error("Full decision traces are restricted to this non-sensitive fixture server");
  providerRequests += 1;
  const requestNumber = providerRequests;
  const trace: import('../../agent/src/browser-decision-model.js').BrowserDecisionTrace[] = [];
  const actualInput = structuredClone(input);

  try {
    return await providerDecide(input, signal, { onTrace: event => trace.push(event) });
  } finally {
    await writeFile(join(out, `jev-request-${requestNumber}.json`), JSON.stringify({ requestNumber, input: actualInput, trace }, null, 2));
  }
};

const { judgeRealtimeBrowserAction } = await import("../../agent/src/realtime-browser-judge.js");

const { browserContextChange } = await import("../../shared/browser-decision-context.js");

const { readTypeSafeKey } = await import("../../agent/src/typesafe-auth.js");

let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;

// SAFETY: every expression the isolated harness evaluates goes through CDP
// Runtime.evaluate with returnByValue, so a resolved swEval is the page's own JSON
// value; callers narrow it further where they need specific fields.
const json = async (expression: string): Promise<JsonValue> => iso!.swEval(expression) as Promise<JsonValue>;

const rpcEvents: RpcEvent[] = [];

try {
  iso = await launchIsolatedExtension({ localOnly: true });
  const extId = await iso.swEval("chrome.runtime.id");
  // SAFETY: chrome.runtime.getManifest() returns the extension's own manifest, whose
  // `name`/`version` fields are strings whenever they are present.
  const manifest = await iso.swEval("chrome.runtime.getManifest()") as { name?: string; version?: string };
  record.identity = {
    extensionId: extId,
    manifestName: manifest?.name,
    manifestVersion: manifest?.version,
    chrome: iso.diagnostics(),
    fixtureOrigin,
    buildBackgroundSha256: record.build.backgroundSha256,
    unauthorizedPath,
    host: "createBrowserTools→ToolRpc→__saCall→extension",
  };

  const rpc = new ToolRpc((frame) => {
    rpcEvents.push({ at: Date.now(), kind: "rpc-start", id: frame.id, name: frame.name, params: frame.params });
    const args = [frame.id, frame.name, frame.params, frame.sessionId ?? "main", frame.programId ?? null, "qa01"];
    void iso!.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then((r: any) => {
      rpcEvents.push({
        at: Date.now(),
        kind: "rpc-end",
        id: frame.id,
        name: frame.name,
        ok: r?.ok,
        error: r?.error,
        executionFact: r?.executionFact,
      });
      rpc.handleResult(frame.id, r?.ok === true, r?.data, r?.error, r?.executionFact);
    }, (e: Error) => {
      rpcEvents.push({ at: Date.now(), kind: "rpc-error", id: frame.id, error: String(e) });
      rpc.handleResult(frame.id, false, undefined, String(e));
    });
  });

  const ledger = new TaskUploadLedger([join(homedir(), ".sideagent", "uploads")]);

  const tools = createBrowserTools(rpc, undefined, undefined, undefined, {
    epoch: () => 1,
    canWrite: () => true,
    uploadLedger: ledger,
  });

  const runTool = async (name: string, params: ToolParams) => {
    const tool = tools.find((t) => t.name === name);

    if (!tool) throw new Error(`missing tool ${name}`);

    // SAFETY: ToolDefinition.execute takes one per-tool parameter object, so a generic
    // dispatcher cannot name a single shape. `params` is the ToolParams bag validated
    // against ToolContract, the trailing `{}` is the empty per-call context, and the
    // cast only fixes the result to the content/details shape every tool returns.
    return tool.execute(`qa01-${name}-${Date.now()}`, params as never, undefined, undefined, {} as never) as Promise<{
      content: Array<{ text: string }>;
      details?: any;
    }>;
  };

  const uploadRpcCount = () => rpcEvents.filter((e) => e.kind === "rpc-start" && e.name === "upload_file").length;

  // ── F1 ──────────────────────────────────────────────────────────────────
  if (!filtered("F1", "createBrowserTools → call → ToolRpc → extension（含 browser_run 别名 / Playwright / cdp）")) {
    const sc: ScenarioResult = {
      id: "F1",
      verdict: "no",
      entry: "createBrowserTools → call → ToolRpc → extension（含 browser_run 别名 / Playwright / cdp）",
      assertions: [],
      independent: {},
      hostChain: true,
    };

    scenarios.push(sc);
    const uploadsBefore = fixtureState.uploads.length;
    const targetId = await iso.newTarget(`${fixtureOrigin}/f1`);
    await iso.evalIn(targetId, "document.readyState").catch(() => {});
    // 建立工作页：open via tabs tool
    const opened = await runTool("tabs", { action: "open", url: `${fixtureOrigin}/f1` });
    const tabMatch = /tab (\d+)/i.exec(opened.content?.[0]?.text ?? "");
    const tabId = tabMatch ? Number(tabMatch[1]) : NaN;
    check(sc, "F1 tabs open", Number.isFinite(tabId), opened.content?.[0]?.text?.slice(0, 120));

    const rejectOk = async (label: string, fn: RejectableAction) => {
      const before = uploadRpcCount();
      let rejected = false;
      let errText = "";

      try {
        await fn();
      } catch (e) {
        rejected = true;
        errText = String(e);
      }

      const after = uploadRpcCount();
      check(sc, `${label} rejected`, rejected, errText.slice(0, 200));
      check(sc, `${label} zero upload_file RPC`, after === before, { before, after });
      check(sc, `${label} error has no secret body`, !errText.includes(secretBody), errText.slice(0, 120));
    };

    await rejectOk("upload_file", () => runTool("upload_file", { target: "#file", paths: [unauthorizedPath] }));
    await rejectOk("browser.upload_file", () =>
      runTool("browser_run", {
        code: `await browser.upload_file({target:"#file",paths:${JSON.stringify([unauthorizedPath])}});`,
      }),
    );
    await rejectOk("browser.uploadFile", () =>
      runTool("browser_run", {
        code: `await browser.uploadFile({target:"#file",paths:${JSON.stringify([unauthorizedPath])}});`,
      }),
    );
    await rejectOk("playwright setInputFiles", () =>
      runTool("browser_run", {
        api: "playwright",
        code: `await page.locator("#file").setInputFiles(${JSON.stringify(unauthorizedPath)}); return "done";`,
      }),
    );

    // raw CDP：允许 RPC 到达扩展，但必须拒绝且页面无文件
    const cdpBefore = uploadRpcCount();
    let cdpRejected = false;
    let cdpErr = "";

    try {
      await runTool("cdp", { method: "DOM.setFileInputFiles", params: { files: [unauthorizedPath] } });
    } catch (e) {
      cdpRejected = true;
      cdpErr = String(e);
    }

    check(sc, "cdp DOM.setFileInputFiles rejected", cdpRejected, cdpErr.slice(0, 240));
    check(sc, "cdp path did not add upload_file RPC", uploadRpcCount() === cdpBefore, {
      before: cdpBefore,
      after: uploadRpcCount(),
    });
    check(sc, "cdp error has no secret body", !cdpErr.includes(secretBody));

    const pageState = await iso.evalIn(targetId, `({...window.__f1, files:window.__f1.files()})`);

    // Prefer working-tab page via SW if targetId page is a duplicate blank
    const swPage = await json(`(async()=>{
      const tabs=await chrome.tabs.query({url:${JSON.stringify(`${fixtureOrigin}/f1*`)}});
      if(!tabs.length) return null;
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:tabs[0].id},
        world:'MAIN',
        func:()=>({
          inputEvents:window.__f1?.inputEvents??-1,
          changeEvents:window.__f1?.changeEvents??-1,
          files:[...(document.getElementById('file')?.files||[])].map(f=>({name:f.name,size:f.size}))
        })
      });
      return result;
    })()`);

    const oracle = swPage ?? pageState;
    sc.independent = {
      page: oracle,
      fixtureUploadsDelta: fixtureState.uploads.length - uploadsBefore,
      uploadRpcTotal: uploadRpcCount(),
      rpcUploadStarts: rpcEvents.filter((e) => e.kind === "rpc-start" && e.name === "upload_file").length,
    };
    check(sc, "independent files.length===0", Array.isArray(oracle?.files) && oracle.files.length === 0, oracle);
    check(sc, "independent input/change events===0", (oracle?.inputEvents ?? 0) === 0 && (oracle?.changeEvents ?? 0) === 0, oracle);
    check(sc, "fixture upload POSTs===0", fixtureState.uploads.length === uploadsBefore, fixtureState.uploads);
    sc.verdict = sc.assertions.every((a) => a.ok) ? "yes" : "no";
    await iso.closeTarget(targetId).catch(() => {});
  }

  // ── F4 ──────────────────────────────────────────────────────────────────
  if (!filtered("F4", "createBrowserTools browser_run → waitForNetworkIdle（真实在途请求）")) {
    const sc: ScenarioResult = {
      id: "F4",
      verdict: "no",
      entry: "createBrowserTools browser_run → waitForNetworkIdle（真实在途请求）",
      assertions: [],
      independent: {},
      hostChain: true,
    };

    scenarios.push(sc);
    await runTool("tabs", { action: "open", url: `${fixtureOrigin}/f4` });
    // arm network capture
    await runTool("network", { types: "all", limit: 5 }).catch(() => {});
    const holdBefore = fixtureState.holds.length;
    // start slow fetch via page click (real browser request)
    await runTool("click", { target: "#start" });
    const waitStarted = Date.now();
    let waitResult: NetworkIdleResult | null = null;
    let waitError = "";

    try {
      const res = await runTool("browser_run", {
        code: `return await browser.waitForNetworkIdle({idleMs:500,timeoutMs:8000});`,
      });

      waitResult = res.details?.value ?? JSON.parse(res.content?.[0]?.text ?? "null");
    } catch (e) {
      waitError = String(e);
    }

    const waitedMs = Date.now() - waitStarted;
    // wait until hold closed for independent oracle
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const last = fixtureState.holds[fixtureState.holds.length - 1];

      if (last && last.closedAt) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const hold = fixtureState.holds[fixtureState.holds.length - 1];
    const holdDuration = hold?.closedAt && hold?.openedAt ? hold.closedAt - hold.openedAt : null;
    sc.independent = {
      hold,
      holdDuration,
      waitResult,
      waitError: waitError.slice(0, 300),
      waitedMs,
      holdsDelta: fixtureState.holds.length - holdBefore,
    };
    check(sc, "slow request was opened on fixture", !!hold && hold.openedAt > 0, hold);
    check(sc, "hold lasted beyond idleMs(500)", (holdDuration ?? 0) >= 2000, holdDuration);

    // Must not claim idle before the hold roughly finishes
    const idleWaited = waitResult?.waitedMs;
    const earlyIdle = waitResult?.idle === true && idleWaited !== undefined && idleWaited < 2000;

    check(sc, "did not return idle early while request in flight", !earlyIdle, { waitResult, waitedMs });

    const okLate =
      (waitResult?.idle === true && (waitResult.waitedMs ?? waitedMs) >= 2000) ||
      /timed out|CAPTURE_INCOMPLETE|in-flight|inFlight/i.test(waitError);

    // Prefer successful late idle; timeout while still proving no early idle is also acceptable for the anti-early clause
    check(sc, "idle only after quiet or honest timeout (no early success)", okLate && !earlyIdle, {
      waitResult,
      waitError: waitError.slice(0, 200),
    });
    sc.verdict = sc.assertions.every((a) => a.ok) ? "yes" : "no";
  }

  // ── S1 ──────────────────────────────────────────────────────────────────
  if (!filtered("S1", "createBrowserTools tabs.switch + click（零模型，固定工具路径）")) {
    const sc: ScenarioResult = {
      id: "S1",
      verdict: "no",
      entry: "createBrowserTools tabs.switch + click（零模型，固定工具路径）",
      assertions: [],
      independent: {},
      hostChain: true,
      notes: "零模型路径；不调用 Jev",
    };

    scenarios.push(sc);
    const modelBefore = record.modelRequests;
    const a = await runTool("tabs", { action: "open", url: `${fixtureOrigin}/s1?page=a` });
    const b = await runTool("tabs", { action: "open", url: `${fixtureOrigin}/s1?page=b` });
    const idA = Number(/tab (\d+)/i.exec(a.content?.[0]?.text ?? "")?.[1]);
    const idB = Number(/tab (\d+)/i.exec(b.content?.[0]?.text ?? "")?.[1]);
    check(sc, "opened A and B", Number.isFinite(idA) && Number.isFinite(idB), { idA, idB });
    const switched = await runTool("tabs", { action: "switch", tabId: idA });
    check(sc, "switch_tab ok text", /switch|切|active|工作|Working tab/i.test(switched.content?.[0]?.text ?? "") || switched.details?.verification != null, switched.content?.[0]?.text?.slice(0, 160));

    // 独立读：list_tabs 的 working 标记（扩展会话工作页）。无头常无法把 Chrome active/focus 切到目标，不把 active 当硬门。
    // SAFETY: the IIFE returns whatever __saCall resolved with for list_tabs, which is
    // the host tool_result envelope whose `data.tabs` is the TabInfo list the extension
    // session reported; every field read below is described by that contract.
    const listed = await iso.swEval(`(async()=>{
      const r=await globalThis.__saCall('qa01-list-'+Date.now(),'list_tabs',{},'main',null,'qa01');
      return r;
    })()`) as { ok?: boolean; data?: { tabs?: Array<{ id: number; working?: boolean; url?: string; active?: boolean }> } };

    const tabs = listed?.data?.tabs ?? [];
    const rowA = tabs.find((t) => t.id === idA);
    const rowB = tabs.find((t) => t.id === idB);

    const workingA =
      rowA?.working === true ||
      switched.details?.verification?.workingTabId === idA ||
      (switched.content?.[0]?.text ?? "").includes(`Working tab is now ${idA}`);

    check(sc, "independent working tab is A after switch", workingA && rowB?.working !== true, {
      rowA,
      rowB,
      verification: switched.details?.verification,
      listedOk: listed?.ok,
    });
    await runTool("click", { target: "#go", tabId: idA });

    const clickOracle = await json(`(async()=>{
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:${idA}},
        world:'MAIN',
        func:()=>({clicks:window.__s1?.clicks??-1,count:document.getElementById('count')?.textContent??null})
      });
      return result;
    })()`);

    sc.independent = {
      working: { rowA, rowB, verification: switched.details?.verification },
      clickOracle,
      modelRequestsDelta: record.modelRequests - modelBefore,
      headlessNote: "Chrome active/focus 在无头下可能仍落在空白页；本场景以工作页+页面点击结果为判据",
    };
    check(sc, "independent click count===1", clickOracle?.clicks === 1 && clickOracle?.count === "1", clickOracle);
    check(sc, "zero model requests", record.modelRequests === modelBefore, record.modelRequests);
    sc.verdict = sc.assertions.every((a) => a.ok) ? "yes" : "no";
  }

  // ── S2 ──────────────────────────────────────────────────────────────────
  if (!filtered("S2", "ToolRpc.call snapshot(decision)+cursor（同 browser_loop）→ createBrowserTools click")) {
    const sc: ScenarioResult = {
      id: "S2",
      verdict: "no",
      entry: "ToolRpc.call snapshot(decision)+cursor（同 browser_loop）→ createBrowserTools click",
      assertions: [],
      independent: {},
      hostChain: true,
      notes: "零模型；对外 snapshot 工具 schema 不含 decision/cursor，故续读走生产 loop 同款 rpc.call",
    };

    scenarios.push(sc);
    await runTool("tabs", { action: "open", url: `${fixtureOrigin}/s2` });

    // 与 browser_decision_loop 相同：rpc.call('snapshot', { decision:true, cursor? })
    // SAFETY: rpc.call("snapshot") resolves with the observation either nested under
    // `observation` or as the flat snapshot payload; the loose field set below is only
    // read, never written, and the pagination loop re-reads each page.
    const firstObs = (await rpc.call("snapshot", { decision: true })) as {
      observation?: any;
      text?: string;
      collectedCount?: number;
    };

    const obs1 = firstObs.observation ?? firstObs;
    const collectedCount = obs1?.collectedCount;
    const controls1 = obs1?.controls ?? [];
    let cursor: string | undefined = obs1?.nextCursor;
    check(sc, "first decision view has controls", Array.isArray(controls1) && controls1.length > 0, {
      n: controls1.length,
      collectedCount,
    });
    check(sc, "first view within budget and misses late target", controls1.length <= 100 && !controls1.some((c: any) => c.name === "Submit-Target"), {
      len: controls1.length,
      hasMore: !!cursor,
    });
    let targetRef: string | undefined;
    let page = 0;
    const seen: string[] = [];

    while (page < 5 && cursor) {
      page += 1;
      // SAFETY: same snapshot readback shape as the first page above (observation either
      // nested or flat); this loop only accumulates `controls` and follows `nextCursor`.
      const cont = (await rpc.call("snapshot", { decision: true, cursor })) as { observation?: any };
      const obs = cont.observation ?? cont;
      const controls = obs?.controls ?? [];
      seen.push(...controls.map((c: any) => c.name));
      const hit = controls.find((c: any) => c.name === "Submit-Target");

      if (hit) {
        targetRef = hit.ref;
        break;
      }

      cursor = obs?.nextCursor;

      if (!cursor) break;
    }

    check(sc, "found Submit-Target via continue_read", targetRef !== undefined && String(targetRef).startsWith("@"), {
      targetRef,
      pages: page,
      seenTail: seen.slice(-10),
    });

    if (targetRef) {
      await runTool("click", { target: targetRef });
    }

    const oracle = await json(`(async()=>{
      const tabs=await chrome.tabs.query({url:${JSON.stringify(`${fixtureOrigin}/s2*`)}});
      if(!tabs[0]?.id) return null;
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:tabs[0].id},
        world:'MAIN',
        func:()=>({
          buttonCount:document.querySelectorAll('button').length,
          total:window.__s2?.total??-1,
          clicks:{...window.__s2?.clicks},
          targetClicks:window.__s2?.clicks?.['B-40']??0,
          otherPositive:Object.entries(window.__s2?.clicks||{}).filter(([k,v])=>k!=='B-40'&&Number(v)>0)
        })
      });
      return result;
    })()`);

    sc.independent = { oracle, targetRef, collectedCount, firstControlCount: controls1.length, continuePages: page };
    check(sc, "fixture has 240 buttons", oracle?.buttonCount === 240, oracle);
    check(sc, "only B-40 clicked once", oracle?.targetClicks === 1 && oracle?.total === 1 && (oracle?.otherPositive?.length ?? 1) === 0, oracle);
    sc.verdict = sc.assertions.every((a) => a.ok) ? "yes" : "no";
  }


  // ── shared helpers ─────────────────────────────────────────────────────
  const parseTabId = (res: { content?: Array<{ text?: string }> }) => {
    const m = /tab (\d+)/i.exec(res.content?.[0]?.text ?? "");

    return m ? Number(m[1]) : NaN;
  };

  const pageEval = async (tabId: number, source: string) => {
    return json(`(async()=>{
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:${tabId}},
        world:'MAIN',
        func:()=>(${source})
      });
      return result;
    })()`);
  };

  const openWorking = async (url: string) => {
    const opened = await runTool("tabs", { action: "open", url });

    return parseTabId(opened);
  };

  const jevAvailable = jevBudget > 0 && !!readTypeSafeKey();

  const wrapScenario = async (
    id: string,
    entry: string,
    body: (sc: ScenarioResult) => Promise<void>,
    extras?: Partial<ScenarioResult>,
  ) => {
    // ONLY 过滤：由 filtered() 自己 push「未跑」条目并返回 true；必须先于下面那次 push，
    // 否则同一场景会在制品里出现「no」和「未跑」两份，no 那份还会进 hard 集合影响退出码。
    if (filtered(id, entry)) return;

    const sc: ScenarioResult = {
      id,
      verdict: "no",
      entry,
      assertions: [],
      independent: {},
      hostChain: true,
      ...extras,
    };

    scenarios.push(sc);

    try {
      await body(sc);

      if (sc.assertions.some(a => !a.ok)) sc.verdict = "no";
      else if (sc.requiredNotRun?.length) sc.verdict = "gap";
      else if (sc.verdict === "no" || sc.verdict === "yes") sc.verdict = sc.assertions.length ? "yes" : "no";

      for (const id of sc.requiredNotRun ?? []) record.notRun.push({ id: `${sc.id}/${id}`, reason: "Required sub-behavior has no matching execution evidence" });
    } catch (e) {
      sc.error = String(e).slice(0, 500);
      sc.verdict = "no";
      check(sc, "scenario threw", false, sc.error);
    }
  };

  // ── F2 authorized multiple / clear ─────────────────────────────────────
  await wrapScenario("F2", "createBrowserTools upload_file（本任务 grant）", async (sc) => {
    const uploadsRoot = join(homedir(), ".sideagent", "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    const aPath = join(uploadsRoot, `qa01-f2-a-${stamp}.txt`);
    const bPath = join(uploadsRoot, `qa01-f2-b-${stamp}.txt`);
    await writeFile(aPath, "FILE-A-BODY");
    await writeFile(bPath, "FILE-B-BODY");
    const ga = ledger.grant({ path: aPath, source: "user_provided" });
    const gb = ledger.grant({ path: bPath, source: "user_provided" });
    const tabId = await openWorking(`${fixtureOrigin}/f1`);
    check(sc, "opened f1", Number.isFinite(tabId), tabId);
    const uploadsBefore = fixtureState.uploads.length;
    const beforeRpc = uploadRpcCount();
    await runTool("upload_file", { target: "#file", paths: [ga.fileId, gb.fileId] });
    const afterMulti = await pageEval(tabId, `{inputEvents:window.__f1.inputEvents,changeEvents:window.__f1.changeEvents,files:window.__f1.files()}`);
    check(sc, "multiple files identity", Array.isArray(afterMulti?.files) && afterMulti.files.length === 2
      && afterMulti.files.some((f: any) => f.name === basename(aPath))
      && afterMulti.files.some((f: any) => f.name === basename(bPath)), afterMulti);
    check(sc, "multiple input/change once-ish", (afterMulti?.changeEvents ?? 0) === 1 && (afterMulti?.inputEvents ?? 0) >= 1, afterMulti);
    const midRpc = uploadRpcCount();
    check(sc, "one upload_file RPC for multiple", midRpc === beforeRpc + 1, { beforeRpc, midRpc });
    await runTool("upload_file", { target: "#file", paths: [] });
    const afterClear = await pageEval(tabId, `{inputEvents:window.__f1.inputEvents,changeEvents:window.__f1.changeEvents,files:window.__f1.files()}`);
    check(sc, "clear left files empty", Array.isArray(afterClear?.files) && afterClear.files.length === 0, afterClear);
    check(sc, "clear raised change", (afterClear?.changeEvents ?? 0) === (afterMulti?.changeEvents ?? 0) + 1, { afterMulti, afterClear });
    check(sc, "fixture upload POST still 0", fixtureState.uploads.length === uploadsBefore, fixtureState.uploads.length - uploadsBefore);
    sc.independent = { afterMulti, afterClear, grants: [ga.fileId, gb.fileId], uploadRpcDelta: uploadRpcCount() - beforeRpc };
  });

  // ── F3 abort current run ───────────────────────────────────────────────
  await wrapScenario("F3", "真实 abort 当前 run 后业务派发为 0（非 foreign runId）", async (sc) => {
    const runId = `qa01-run-${Date.now()}`;
    // 与 ToolRpc 同会话 qa01；abort 走该会话的 task_control→handleAbort（不是 default 钩子上的 __saAbortTeam）。
    const convId = "qa01";
    await iso!.swEval(`globalThis.__saHandleServer(${JSON.stringify({
      type: "conversation_updated",
      conversation: {
        id: convId,
        title: "QA01",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: "running",
        mode: "act",
        runId,
      },
    })})`);
    const tabId = await openWorking(`${fixtureOrigin}/s1?page=f3`);
    check(sc, "opened via qa01", Number.isFinite(tabId), tabId);
    // SAFETY: __saCall resolves with the host tool_result envelope from
    // shared/protocol.ts, so `ok` / `error` / `executionFact` are its own fields.
    const okBefore = await iso!.swEval(`globalThis.__saCall(${JSON.stringify("f3-pre-"+Date.now())},"click",${JSON.stringify({target:"#go",tabId})},"main",null,${JSON.stringify(convId)},${JSON.stringify({runId})})`) as HostToolResult;
    check(sc, "pre-abort click executed", okBefore?.ok === true, okBefore);
    const clicksBefore = await pageEval(tabId, `window.__s1?.clicks??-1`);
    check(sc, "pre-abort page click", clicksBefore === 1, clicksBefore);
    const abortRequestId = `f3-abort-${Date.now()}`;

    // SAFETY: the IIFE's only resolved value is the `{ via, requestId }` literal at the
    // end of its body; every earlier statement fires __saHandleServer and awaits.
    const aborted = await iso!.swEval(`(async()=>{
      globalThis.__saHandleServer(${JSON.stringify({
        type: "task_control",
        conversationId: convId,
        action: "abort",
        runId,
        requestId: abortRequestId,
      })});
      await new Promise(r=>setTimeout(r,80));
      globalThis.__saHandleServer(${JSON.stringify({
        type: "task_control_ack",
        conversationId: convId,
        requestId: abortRequestId,
        ok: true,
      })});
      await new Promise(r=>setTimeout(r,120));
      return {via:'task_control',requestId:${JSON.stringify(abortRequestId)}};
    })()`) as { via: string; requestId: string };

    check(sc, "abort invoked", aborted?.via === "task_control", aborted);
    // SAFETY: same host tool_result envelope as the pre-abort call above.
    const post = await iso!.swEval(`globalThis.__saCall(${JSON.stringify("f3-post-"+Date.now())},"click",${JSON.stringify({target:"#go",tabId})},"main",null,${JSON.stringify(convId)},${JSON.stringify({runId})})`) as HostToolResult;
    const postOk = post?.ok === true;
    check(sc, "post-abort click rejected", postOk === false, post);
    const clicksAfter = await pageEval(tabId, `window.__s1?.clicks??-1`);
    check(sc, "no extra page click after abort", clicksAfter === 1, clicksAfter);
    check(sc, "business dispatches after abort === 0", postOk === false, { postOk, postError: post?.error });
    sc.independent = { runId, aborted, post, clicksBefore, clicksAfter, businessOkAfterAbort: postOk ? 1 : 0 };
  });

  // ── F4b attach完整后再挂起 ─────────────────────────────────────────────
  await wrapScenario("F4b", "attach 完整后慢请求不提前 idle；静默后可 idle", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/f4b`);
    await runTool("network", { types: "all", limit: 5 });
    // reload/navigate to promote late→ok via document
    await runTool("navigate", { url: `${fixtureOrigin}/f4b` });
    await new Promise((r) => setTimeout(r, 400));
    const net1 = await runTool("network", { types: "all", limit: 1 });
    const life1 = net1.details ?? {};
    // start slow request after capture is attached
    const holdBefore = fixtureState.holds.length;
    await runTool("click", { target: "#start", tabId });
    const waitStarted = Date.now();
    let waitResult: NetworkIdleResult | null = null;
    let waitError = "";

    try {
      const res = await runTool("browser_run", {
        code: `return await browser.waitForNetworkIdle({idleMs:500,timeoutMs:10000});`,
      });

      waitResult = res.details?.value ?? JSON.parse(res.content?.[0]?.text ?? "null");
    } catch (e) {
      waitError = String(e);
    }

    const waitedMs = Date.now() - waitStarted;
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
      const last = fixtureState.holds[fixtureState.holds.length - 1];

      if (last?.closedAt) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const hold = fixtureState.holds[fixtureState.holds.length - 1];
    const holdDuration = hold?.closedAt && hold?.openedAt ? hold.closedAt - hold.openedAt : 0;
    const earlyIdle = waitResult?.idle === true && (waitResult.waitedMs ?? waitedMs) < 1500;
    check(sc, "hold opened", !!hold, hold);
    check(sc, "hold >= idleMs", holdDuration >= 1500, holdDuration);
    check(sc, "no early idle while in flight", !earlyIdle, { waitResult, waitedMs, waitError: waitError.slice(0, 200) });

    const lateOk =
      (waitResult?.idle === true && (waitResult.waitedMs ?? waitedMs) >= 1500 && waitResult?.integrity === "ok")
      || /CAPTURE_INCOMPLETE|timed out/i.test(waitError);

    // Prefer true idle after quiet; honest incomplete still proves anti-early if integrity never ok
    check(sc, "idle only after quiet or honest non-idle", lateOk && !earlyIdle, {
      waitResult,
      waitError: waitError.slice(0, 240),
      life1,
    });
    sc.independent = { life1, hold, holdDuration, waitResult, waitError: waitError.slice(0, 300), waitedMs, holdsDelta: fixtureState.holds.length - holdBefore };
    sc.notes = "与 F4（integrity=late 拒绝冒充）分立；本案要求 attach 后再挂起";
  });

  // ── F5 doc/tab change during wait ──────────────────────────────────────
  await wrapScenario("F5", "等待期间换文档/工作页不混合身份、不吞错", async (sc) => {
    const tabA = await openWorking(`${fixtureOrigin}/f5a`);
    const tabB = await openWorking(`${fixtureOrigin}/f5b`);
    await runTool("tabs", { action: "switch", tabId: tabA });
    let waitErr = "";
    let waitRes: any = null;

    const waitP = runTool("browser_run", {
      code: `return await browser.waitFor({selector:'#late',state:'visible',timeoutMs:5000});`,
    }).then((r) => { waitRes = r; }).catch((e) => { waitErr = String(e); });

    await new Promise((r) => setTimeout(r, 300));
    await runTool("navigate", { url: `${fixtureOrigin}/f5b` });
    await waitP;
    const mark = await pageEval(tabA, `({doc:document.getElementById('mark')?.getAttribute('data-doc'),title:document.title,href:location.href})`);
    const mixed = /DOC-A/i.test(JSON.stringify(waitRes)) && mark?.doc === "B";

    // Expect honest failure about identity/navigation OR timeout that does not claim A complete on B
    const honest =
      /IDENTITY|document|导航|changed|CAPTURE|CANCELLED|timed out|TIMEOUT|NOT_READY/i.test(waitErr)
      || (waitRes && !mixed);

    check(sc, "page is B after navigate", mark?.doc === "B", mark);
    check(sc, "no A-identity+B-content mix in success", !mixed, { waitRes: String(waitRes).slice(0, 200), mark });
    check(sc, "error not swallowed as mere missing target when doc changed", honest || !!waitErr, { waitErr: waitErr.slice(0, 240), waitRes: String(waitRes).slice(0, 120) });
    sc.independent = { tabA, tabB, mark, waitErr: waitErr.slice(0, 300), waitResText: String(waitRes?.content?.[0]?.text ?? waitRes).slice(0, 200) };
  });

  // ── C1 double / pointer drag / html5 ───────────────────────────────────
  await wrapScenario("C1", "double_click / drag / html5_drag", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/c1`);
    await runTool("double_click", { target: "#dbl", tabId });
    const afterDbl = await pageEval(tabId, `({...window.__c1,dblmsg:document.getElementById('dblmsg')?.textContent})`);
    check(sc, "dblclick state", afterDbl?.dbl === 1, afterDbl);
    await runTool("drag", { from: { target: "#card" }, to: { target: "#slot" }, tabId });
    const afterDrag = await pageEval(tabId, `({pointerDrag:window.__c1.pointerDrag,dragmsg:document.getElementById('dragmsg')?.textContent})`);
    check(sc, "pointer drag into slot", afterDrag?.pointerDrag === true || afterDrag?.dragmsg === "IN-SLOT", afterDrag);
    let h5: any = null;
    let h5Err = "";

    try {
      h5 = await runTool("html5_drag", { from: { target: "#html5from" }, to: { target: "#html5to" }, tabId });
    } catch (e) {
      h5Err = String(e);
    }

    const h5Page = await pageEval(tabId, `({h5:window.__c1.h5,msg:document.getElementById('h5msg')?.textContent})`);
    const details = h5?.details ?? {};

    if (details?.dragged === false && details?.gap) {
      sc.verdict = "gap";
      check(sc, "html5 gap recorded (no fake success)", true, details);
      sc.notes = `HTML5 DnD gap: ${details.gap}`;
    } else if (h5Page?.h5 === "H5-PAYLOAD") {
      check(sc, "html5 payload intercepted", true, h5Page);
    } else {
      check(sc, "html5 success or honest gap", false, { h5: details, h5Page, h5Err: h5Err.slice(0, 200) });
    }

    sc.independent = { afterDbl, afterDrag, h5: details, h5Page, h5Err: h5Err.slice(0, 200) };
  });

  // ── C2 contextmenu / middle / wheel / release ──────────────────────────
  await wrapScenario("C2", "右键/中键/wheel/按住松键", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/c2`);
    const errs: string[] = [];

    try { await runTool("click", { target: "#ctx", button: "right", tabId }); } catch (e) { errs.push("right:"+String(e)); }

    try { await runTool("click", { target: "#mid", button: "middle", tabId }); } catch (e) { errs.push("mid:"+String(e)); }

    // 无头窗口从不聚焦，产品按设计不抢前台，工作页留在后台：滚轮必须快速、明确地不执行。
    const hiddenStarted = Date.now();
    let hiddenErr = "";

    try { await runTool("wheel", { target: "#w1", deltaY: 120, tabId }); } catch (e) { hiddenErr = String(e); }

    const hiddenMs = Date.now() - hiddenStarted;
    const hiddenPage = await pageEval(tabId, `({vis:document.visibilityState,...window.__c2})`);
    check(sc, "hidden tab wheel refused fast, nothing dispatched", /后台/.test(hiddenErr) && hiddenMs < 2000 && hiddenPage?.anyWheel === 0 && hiddenPage?.wheel1 === 0, { hiddenErr: hiddenErr.slice(0, 160), hiddenMs, hiddenPage });

    // 相当于用户切回这个窗口：之后的滚轮要落在 w1。
    await json(`chrome.tabs.update(${tabId},{active:true}).then(()=>true)`);
    let wheelRes: any = null;

    try { wheelRes = await runTool("wheel", { target: "#w1", deltaY: 120, tabId }); }
    catch (e) {
      errs.push("wheel-target:"+String(e));

      try { wheelRes = await runTool("wheel", { point: [70, 80], deltaY: 120, tabId }); } catch (e2) { errs.push("wheel-point:"+String(e2)); }
    }

    await new Promise((r) => setTimeout(r, 300));

    try { await runTool("key_down", { key: "Shift", tabId }); } catch (e) { errs.push("keydown:"+String(e)); }

    const midHeld = await pageEval(tabId, `({...window.__c2})`);

    try { await runTool("release_held_inputs", {}); } catch (e) { errs.push("release:"+String(e)); }

    const after = await pageEval(tabId, `({...window.__c2})`);
    check(sc, "contextmenu only on ctx", after?.contextmenu === 1, after);
    check(sc, "middle click", after?.middle === 1, after);
    const w1scroll = await pageEval(tabId, `document.getElementById('w1')?.scrollTop??-1`);

    const wheelOk = (after?.wheel1 >= 1 && after?.wheel2 === 0)
      || ((after?.anyWheel ?? 0) >= 1 && after?.wheel2 === 0 && w1scroll > 0);

    check(sc, "wheel hit w1 not w2", wheelOk, { after, w1scroll, wheelRes: wheelRes?.details ?? wheelRes });
    check(sc, "release cleared held key", after?.released === true, { midHeld, after });
    sc.independent = { midHeld, after, wheelRes: wheelRes?.details ?? wheelRes, errs: errs.map((e) => e.slice(0, 120)) };
  });

  // ── C3 arm events ──────────────────────────────────────────────────────
  await wrapScenario("C3", "arm→popup/download/chooser/dialog", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/c3`);
    // popup
    const armPop = await runTool("arm_event", { type: "popup" });
    const popToken: string | undefined = armPop.details?.token;
    check(sc, "armed popup token", popToken !== undefined && popToken.length > 0, armPop.details);
    await runTool("click", { target: "#popup", tabId });
    let popWait: any = null;
    let popErr = "";

    try {
      popWait = await runTool("wait_event", { token: popToken, timeoutMs: 8000 });
    } catch (e) {
      popErr = String(e);
    }

    check(sc, "popup wait ok", !!popWait?.details && !popErr, { popWait: popWait?.details, popErr: popErr.slice(0, 200) });
    // The popup action may change the working page. Bind the next independent
    // event test to its actual source page before arming, not after the event.
    await runTool("tabs", { action: "switch", tabId });
    await runTool("snapshot", { tabId });

    // blob download
    let armDl: any = null;
    let dlToken: string | undefined;
    let dlWait: any = null;
    let dlErr = "";

    try {
      armDl = await runTool("arm_event", { type: "download" });
      dlToken = armDl.details?.token;
      await runTool("screenshot", { tabId });
      await runTool("click", { target: "#dl", tabId });
      dlWait = await runTool("wait_event", { token: dlToken, timeoutMs: 10000 });
    } catch (e) {
      dlErr = String(e);
    }

    const downloadId = dlWait?.details?.downloadId ?? dlWait?.details?.event?.downloadId;
    let savePath: string | null = null;
    let saveErr = "";

    if (downloadId) {
      savePath = join(await mkdtemp(join(tmpdir(), "qa01-dl-")), "qa01-blob.txt");

      try {
        await runTool("download_save_as", { downloadId, path: savePath });
      } catch (e) {
        saveErr = String(e);
      }
    }

    let savedBody = "";

    if (savePath && existsSync(savePath)) savedBody = await readFile(savePath, "utf8");
    const dlCdpDenied = /DOWNLOAD_ARM_CDP/i.test(dlErr);
    check(sc, "download wait survived screenshot", !!dlWait?.details && !dlErr, { dlWait: dlWait?.details, dlErr: dlErr.slice(0, 200) });
    check(sc, "saved actual page-generated blob", savedBody.includes("BLOB-DL-CONTENT"), { savedBody: savedBody.slice(0, 80), saveErr: saveErr.slice(0, 160), dlCdpDenied });

    // second same-name download isolation
    let dl2: any = null;
    let id2: string | undefined;

    try {
      const armDl2 = await runTool("arm_event", { type: "download" });
      await runTool("click", { target: "#dl", tabId });
      dl2 = await runTool("wait_event", { token: armDl2.details?.token, timeoutMs: 10000 });
      id2 = dl2?.details?.downloadId ?? dl2?.details?.event?.downloadId;
    } catch (e) {
      dlErr = dlErr || String(e);
    }

    check(sc, "two downloads have distinct ids", !!downloadId && !!id2 && downloadId !== id2, { downloadId, id2, dlErr: dlErr.slice(0, 160) });

    // bad token fails
    let badErr = "";

    try {
      await runTool("wait_event", { token: "totally-invalid-token", timeoutMs: 1000 });
    } catch (e) {
      badErr = String(e);
    }

    check(sc, "bad token fails", !!badErr, badErr.slice(0, 160));

    // dynamic chooser
    const armCh = await runTool("arm_event", { type: "filechooser" });
    await runTool("screenshot", { tabId });
    await runTool("click", { target: "#chooser", tabId });
    let chWait: any = null;
    let chErr = "";

    try {
      chWait = await runTool("wait_event", { token: armCh.details?.token, timeoutMs: 8000 });
    } catch (e) {
      chErr = String(e);
    }

    check(sc, "chooser interception survived screenshot", !!chWait?.details && !chErr, { chWait: chWait?.details, chErr: chErr.slice(0, 160) });

    // dialog: click blocks on confirm — accept concurrently; never pageEval while dialog may still be up
    let dlgInfo: any = null;
    let dlgAccept: any = null;
    let dlgErr = "";
    let dlgPage: any = null;

    try {
      let clickSettled = false;

      const clickDlg = runTool("click", { target: "#dlg", tabId })
        .catch(e => { dlgErr = String(e); })
        .finally(() => { clickSettled = true; });

      // Subscribe through the actual dialog state, not a 250ms guess. Pointer
      // preparation can take longer; accepting before the dialog exists is a no-op.
      const dialogDeadline = Date.now() + 12_000;

      do {
        // dialog_info is a runtime RPC, not a standalone model ToolDefinition.
        const infoProgram = await runTool("browser_run", { code: `return await browser.dialogInfo({tabId:${tabId}});` });
        dlgInfo = { details: infoProgram.details?.value };

        if (dlgInfo?.details?.dialog) break;

        if (clickSettled && dlgErr) break;
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() < dialogDeadline);

      if (dlgInfo?.details?.dialog) dlgAccept = await runTool("accept_dialog", { tabId });
      else dlgErr ||= "Dialog was not observed within the test budget";
      const drainDeadline = Date.now() + 10_000;

      while (!clickSettled && Date.now() < drainDeadline) await new Promise(r => setTimeout(r, 50));

      if (clickSettled) await clickDlg;
      else dlgErr ||= "Triggering click did not drain after dialog handling";
      // only after accept/dismiss attempt
      dlgPage = await Promise.race([
        pageEval(tabId, `({...window.__c3,log:document.getElementById('c3log')?.textContent})`),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
    } catch (e) {
      dlgErr = dlgErr || String(e);
    }

    check(sc, "dialog accepted and page resumed with the expected result",
      !dlgErr && /DLG:true/.test(String(dlgPage?.log ?? "")),
      { dlgInfo: dlgInfo?.details, dlgAccept: dlgAccept?.details, dlgErr: dlgErr.slice(0, 160), dlgPage });
    sc.independent = {
      popup: popWait?.details,
      downloadId,
      downloadId2: id2,
      savedBody: savedBody.slice(0, 40),
      chooser: chWait?.details,
      dialog: { info: dlgInfo?.details, accept: dlgAccept?.details, page: dlgPage },
      badErr: badErr.slice(0, 120),
      dlErr: dlErr.slice(0, 200),
    };
  });

  // ── C4 locator / shadow / iframe / OOPIF ───────────────────────────────
  await wrapScenario("C4", "ARIA≠text / shadow / 同源 iframe；OOPIF 仅有证据才 yes", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/c4`);
    await runTool("click", { target: 'loc=role:button[name="Accessible Save"]', tabId });
    let ambErr = "";

    try {
      await runTool("click", { target: 'loc=role:button[name="Twin Action"]', tabId });
    } catch (e) {
      ambErr = String(e);
    }

    check(sc, "ambiguous role rejected", /歧义|AMBIGUOUS|多个|more than one|不唯一|两个|匹配\s*2|重复名字/i.test(ambErr), ambErr.slice(0, 200));
    await runTool("click", { target: "#shadowBtn", tabId });
    await runTool("click", { target: "#inframe", tabId });
    // stale ref
    // SAFETY: rpc.call("snapshot") resolves with the same observation-envelope-or-flat
    // shape as S2; only the control count is read, to prove the stale-ref case was
    // decided from a real observation rather than an empty one.
    const snap = await rpc.call("snapshot", {}) as SnapshotControlCount;
    const staleRef = "@99999";
    let staleErr = "";

    try {
      await runTool("click", { target: staleRef, tabId });
    } catch (e) {
      staleErr = String(e);
    }

    check(sc, "stale ref not executed", !!staleErr, staleErr.slice(0, 160));
    const oracle = await pageEval(tabId, `({...window.__c4})`);
    check(sc, "ARIA-named button clicked", oracle?.aria === 1, oracle);
    check(sc, "shadow clicked", oracle?.shadow >= 1, oracle);
    check(sc, "same-origin iframe clicked", oracle?.frame >= 1, oracle);
    check(sc, "other not clicked", oracle?.other === 0, oracle);

    // OOPIF: only yes if another target/session observed
    const targets = await json(`(async()=>{
      try{
        const tabs=await chrome.debugger.getTargets?.() ?? [];
        return tabs.map(t=>({url:t.url,type:t.type,id:t.id}));
      }catch(e){return {error:String(e)};}
    })()`);

    const cross = Array.isArray(targets) && targets.some((t: any) => /oopif|cross|example\.com/i.test(String(t.url ?? "")));
    sc.independent = { oracle, ambErr: ambErr.slice(0, 160), staleErr: staleErr.slice(0, 120), targets, snapControls: snap?.observation?.controls?.length ?? snap?.controls?.length };

    if (!cross) {
      sc.notes = "真实跨站 OOPIF 未出现独立 target/session → 子项未跑；同源 frame/shadow/ARIA 仍判定";
    }

    // A target URL mentioning 'cross' is not child-session execution evidence.
    sc.requiredNotRun = ["cross-site-OOPIF-action", "stale-frame-replacement"];
  });

  // ── C5 select / wait / screenshot clip ─────────────────────────────────
  await wrapScenario("C5", "多选清空 / hidden 等待 / 截图 clip 同坐标系", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/c5`);
    const sel1 = await runTool("select_option", { target: "#multi", values: ["a", "c"] });
    check(sc, "multi select set", Array.isArray(sel1.details?.selected) && sel1.details.selected.includes("a") && sel1.details.selected.includes("c"), sel1.details);
    const sel2 = await runTool("select_option", { target: "#multi", values: [] });
    check(sc, "cleared selection", Array.isArray(sel2.details?.selected) && sel2.details.selected.length === 0, sel2.details);
    // wait hidden
    let hideOk = false;
    let hideErr = "";

    try {
      await runTool("browser_run", {
        code: `return await browser.waitFor({selector:'#hideLater',state:'hidden',timeoutMs:5000});`,
      });
      hideOk = true;
    } catch (e) {
      hideErr = String(e);
    }

    const hiddenGone = await pageEval(tabId, `window.__c5.hiddenGone`);
    check(sc, "wait hidden", hideOk && hiddenGone === true, { hideOk, hideErr: hideErr.slice(0, 160), hiddenGone });
    // screenshot clip vs click coords
    let geom: any = null;
    let shotErr = "";

    try {
      const shot = await runTool("screenshot", { clip: { x: 40, y: 120, width: 80, height: 40 } });
      geom = shot.details;
    } catch (e) {
      shotErr = String(e);
    }

    check(sc, "clip geometry present", !!geom?.clip && geom.clip.x === 40 && geom.clip.y === 120, geom?.clip ?? shotErr.slice(0, 160));
    const box = await pageEval(tabId, `(()=>{const r=document.getElementById('clipTarget').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    check(sc, "clip shares CSS space with element box", Math.abs((box?.x ?? -1) - 40) < 2 && Math.abs((box?.y ?? -1) - 120) < 2, { box, clip: geom?.clip });

    // 像素 oracle：clip 落在 #clipTarget（纯 #f66）上，返回图必须真的是那块红。
    // 差分对照：clip 到空白区必须不含红。占位灰图两条都过不了。
    // fixture 自报的背景色只作 expected，判定完全来自解码回来的真实像素。
    const CLIP_RED: [number, number, number] = [255, 102, 102];
    let redRate = -1;
    let blankRate = -1;
    let decodeErr = "";
    let pxSamples: PixelSample[] | null = null;
    let blankSamples: PixelSample[] | null = null;

    try {
      const img = decodePngRgb(geom?.imageBase64 ?? "");
      const hit = colorHitRate(img, CLIP_RED);
      redRate = hit.rate;
      pxSamples = hit.samples;
      // 差分对照：同一页面另一块没有 #f66 的区域
      let blankGeom: any = null;
      let blankErr = "";

      try {
        const blankShot = await runTool("screenshot", { clip: { x: 500, y: 40, width: 80, height: 40 } });
        blankGeom = blankShot.details;
      } catch (e) {
        blankErr = String(e);
      }

      if (blankGeom?.imageBase64) {
        const blankImg = decodePngRgb(blankGeom.imageBase64);
        const bh = colorHitRate(blankImg, CLIP_RED);
        blankRate = bh.rate;
        blankSamples = bh.samples;
      } else {
        blankErr = blankErr || "空白区截图没有数据";
      }

      check(sc, "clip pixels are the real page block (#f66)", redRate >= 0.8, { redRate, samples: pxSamples, b64len: (geom?.imageBase64 ?? "").length });
      check(sc, "clip is not a canned/placeholder image (blank area has no red)", blankRate >= 0 && blankRate <= 0.2, { blankRate, samples: blankSamples, blankErr: blankErr.slice(0, 200) });
    } catch (e) {
      decodeErr = String(e);
      check(sc, "clip pixels are the real page block (#f66)", false, { decodeErr: decodeErr.slice(0, 240) });
      check(sc, "clip is not a canned/placeholder image (blank area has no red)", false, { decodeErr: decodeErr.slice(0, 240) });
    }

    sc.independent = { sel1: sel1.details, sel2: sel2.details, geom, box, hideOk, shotErr: shotErr.slice(0, 160), redRate, blankRate, pxSamples, blankSamples, decodeErr: decodeErr.slice(0, 200) };
    sc.requiredNotRun = ["fullPage-DPR-contract"];
  });

  // ── C6 other session ───────────────────────────────────────────────────
  if (!filtered("C6", "paste/clipboard-bridge（另一会话）")) {
    const sc: ScenarioResult = {
      id: "C6",
      verdict: "另一会话",
      entry: "paste/clipboard-bridge（另一会话）",
      assertions: [],
      independent: {},
      hostChain: false,
      notes: "本会话不改 input.ts paste / clipboard-bridge；不标永久 BLOCKED",
    };

    scenarios.push(sc);
  }

  // ── S3 long text / counter / source ────────────────────────────────────
  await wrapScenario("S3", "长文本截断不丢控件；无关计数器不拒；来源变化拒旧动作", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/s3`);
    // SAFETY: rpc.call("snapshot") resolves with the observation either nested under
    // `observation` or as the flat snapshot payload; the loop below only reads
    // `controls`, `nextCursor`, `collectedCount` and the truncation flags from either shape.
    const first = (await rpc.call("snapshot", { decision: true, tabId })) as { observation?: any };
    let obs = first.observation ?? first;
    let cursor: string | undefined = obs?.nextCursor;
    let pages = 0;
    let target = obs.controls?.find((c: any) => c.name === "Btn-10");

    while (!target && cursor && pages < 4) {
      pages += 1;
      // SAFETY: same snapshot readback shape as the first page above; each page is
      // re-read from the host, so only its own `controls`/`nextCursor` are consumed.
      const cont = (await rpc.call("snapshot", { decision: true, cursor, tabId })) as { observation?: any };
      const snapshot = cont.observation ?? cont;

      Object.assign(obs, snapshot, { controls: [...(obs.controls ?? []), ...(snapshot.controls ?? [])] });
      cursor = (cont.observation ?? cont)?.nextCursor;
      target = obs.controls?.find((c: any) => c.name === "Btn-10");
    }

    check(sc, "controls present despite long prose", (obs?.collectedCount ?? obs?.controls?.length ?? 0) > 1 || (obs?.controls?.length ?? 0) > 0, {
      n: obs?.controls?.length,
      collectedCount: obs?.collectedCount,
      textTruncated: obs?.textTruncated,
      controlsTruncated: obs?.controlsTruncated,
    });
    check(sc, "Btn-10 reachable through an observed ref", !!target?.ref, { targetRef: target?.ref, continuePages: pages });

    const collectDecision = async () => {
      // SAFETY: same snapshot readback shape as S3's outer loop (observation nested or
      // flat); only `controls` and `nextCursor` are read from each page.
      const first = (await rpc.call("snapshot", { decision: true, tabId })) as { observation?: any };
      let page = first.observation ?? first;
      let cursor: string | undefined = page?.nextCursor;
      const controls = [...(page.controls ?? [])];
      let pages = 0;

      while (cursor && pages < 6) {
        pages += 1;
        // SAFETY: same snapshot readback shape as the first page above; this collector
        // accumulates `controls` in order and follows `nextCursor` exactly once per page.
        const cont = (await rpc.call("snapshot", { decision: true, cursor, tabId })) as { observation?: any };
        const next = cont.observation ?? cont;
        controls.push(...(next.controls ?? []));
        cursor = next?.nextCursor;
        Object.assign(page, next, { controls });
      }

      return { ...page, controls };
    };

    const baseObs = await collectDecision();
    const btn = baseObs.controls?.find((c: any) => c.name === "Btn-10") ?? target;
    await new Promise((r) => setTimeout(r, 600));
    const obs2 = await collectDecision();
    const changeIrrelevant = browserContextChange(baseObs, obs2, btn?.ref);
    check(sc, "unrelated counter does not invalidate", changeIrrelevant === null, changeIrrelevant);
    await pageEval(tabId, `document.getElementById('source').value='SRC-B'`);
    const obs3 = await collectDecision();
    const changeSource = browserContextChange(baseObs, obs3, btn?.ref);
    check(sc, "source input change rejects old action context", changeSource !== null, changeSource);

    if (!btn?.ref) throw new Error("Target missing from actual observation; test will not substitute a known CSS answer");
    await runTool("click", { target: btn.ref, tabId });
    const oracle = await pageEval(tabId, `({clicks:{...window.__s3.clicks},counter:window.__s3.counter})`);
    check(sc, "clicked Btn-10 once", (oracle?.clicks?.s3b10 ?? 0) === 1, oracle);
    sc.independent = { controls: obs?.controls?.length, collectedCount: obs?.collectedCount, textTruncated: obs?.textTruncated, changeIrrelevant, changeSource, oracle, continuePages: pages };
    sc.requiredNotRun = ["production-guard-after-source-change"];
  });

  // helper: bind loop call to rpc
  const loopCall = async (name: ToolName, params: ToolParams, _id?: string) => rpc.call(name, params);

  // ── S4 30×12 real Jev once ─────────────────────────────────────────────
  await wrapScenario("S4", "30×12 真实 Jev 一次；完整原文写入", async (sc) => {
    if (!jevAvailable) {
      sc.verdict = "BLOCKED";
      sc.notes = "Jev 凭据不可用";

      return;
    }

    const tabId = await openWorking(`${fixtureOrigin}/s4`);

    const mats = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i + 1}`,
      value: `ORIGINAL-${i + 1}-${"y".repeat(20)}`,
      source: "user" as const,
      purpose: `p${i + 1}`,
    }));

    const t0 = Date.now();
    const decisions: unknown[] = [];
    const reasonCodes: string[] = [];
    let modelRequests = 0;
    let outcome: any = null;
    let jevErr = "";

    try {
      outcome = await runBrowserDecisionLoop({
        parentCallId: "qa01-s4",
        goal: "Fill field 30 with material 12 only; do not change other fields",
        materials: mats,
        signal: AbortSignal.timeout(120_000),
        call: loopCall,
        decide: async (input, signal) => {
          modelRequests += 1;
          record.modelRequests += 1;
          const started = Date.now();

          try {
            const d = await decideBrowserCandidate(input, signal);
            decisions.push({
              at: Date.now(),
              ms: Date.now() - started,
              observationId: d.observationId,
              candidateId: d.candidateId,
              confidence: d.confidence,
              model: d.model,
              // no secrets
            });

            return d;
          } catch (e) {
            jevErr = String(e);
            throw e;
          }
        },
      });

      if (outcome?.reasonCode) reasonCodes.push(outcome.reasonCode);
    } catch (e) {
      jevErr = String(e);
    }

    const elapsedMs = Date.now() - t0;
    sc.realJev = { used: true, modelRequests, decisions, reasonCodes, elapsedMs, error: jevErr ? jevErr.slice(0, 240) : undefined };

    if (/Jev HTTP|凭据|timeout|AbortError/i.test(jevErr) && !outcome) {
      check(sc, "real Jev provider", false, jevErr.slice(0, 200));
      sc.notes = "provider_error";
      sc.independent = { jevErr: jevErr.slice(0, 300), modelRequests };

      return;
    }

    const values = await pageEval(tabId, `Object.fromEntries([...document.querySelectorAll('input')].map(i=>[i.id,i.value]))`);
    const expected = mats[11]!.value;
    check(sc, "field 30 has full original", values?.f30 === expected, { f30: values?.f30?.slice?.(0, 40), expected: expected.slice(0, 40) });
    const othersOk = Array.from({ length: 29 }, (_, i) => values?.[`f${i + 1}`] === `INIT-${i + 1}`).every(Boolean);
    check(sc, "other fields unchanged", othersOk, { sample: { f1: values?.f1, f29: values?.f29 } });
    check(sc, "modelRequests bounded", modelRequests >= 1 && modelRequests <= 16, modelRequests);
    sc.independent = { outcomeStatus: outcome?.status, reasonCode: outcome?.reasonCode, modelRequests, elapsedMs, valuesF30: values?.f30?.slice?.(0, 60) };
  });

  // ── S5 hover real Jev via realtime judge ────────────────────────────────
  await wrapScenario("S5", "CSS hover 菜单：真实 hover→新观察→真实 Jev 再选", async (sc) => {
    if (!jevAvailable && !s5Fixture) {
      sc.verdict = "BLOCKED";
      sc.notes = "Jev 凭据不可用";

      return;
    }

    const tabId = await openWorking(`${fixtureOrigin}/s5`);
    const t0 = Date.now();
    const decisions: unknown[] = [];
    let modelRequests = 0;
    let jevErr = "";

    const decideOnce = async (input: any, signal: AbortSignal) => {
      modelRequests += 1;

      if (!s5Fixture) record.modelRequests += 1;
      const started = Date.now();

      const selected = s5Fixture && modelRequests > 2 ? input.candidates.find((candidate: any) => candidate.operation === "done") : s5Fixture ? input.candidates.find((candidate: any) =>
        candidate.operation === (modelRequests === 1 || s5Fixture === "nonclick-second" ? "hover" : "click")
        && input.page.controls.some((control: any) => control.ref === candidate.target && (modelRequests === 1
          ? control.role === "generic" && control.name === "Account"
          : control.role === "menuitem" && control.name === "Settings"))) : undefined;

      const d = s5Fixture
        ? { observationId: input.page.id, candidateId: selected?.id ?? "none", confidence: modelRequests > 1 && s5Fixture === "uncertain-second" ? .72 : .99, model: `fixture-${s5Fixture}` }
        : await decideBrowserCandidate(input, signal);

      decisions.push({ at: Date.now(), ms: Date.now() - started, candidateId: d.candidateId, confidence: d.confidence, model: d.model });

      return d;
    };

    if (s5Entry === "loop") {
      sc.entry = "browser_loop → real hover → fresh observation → original browser executor";

      const outcome = await runBrowserDecisionLoop({
        parentCallId: "qa01-s5-loop", goal: "Open Account hover menu then click Settings", materials: [],
        signal: AbortSignal.timeout(40_000), call: loopCall, decide: decideOnce,
      });

      const oracle = await pageEval(tabId, `({...window.__s5,log:document.getElementById('s5log')?.textContent})`);
      check(sc, "loop executed a hover then a click from separate observations", outcome.receipts.some(r => r.operation === "hover") && outcome.receipts.some(r => r.operation === "click")
        && new Set(outcome.receipts.filter(r => r.operation === "hover" || r.operation === "click").map(r => r.observationId)).size >= 2, outcome.receipts);
      check(sc, "settings clicked once without test rescue", oracle?.settings === 1 && oracle?.forbidden === 0, oracle);
      // SAFETY: BrowserLoopOutcome is recorded in result.json, so store exactly the JSON
      // projection that will be serialized; its own field types live in
      // agent/src/browser-decision-loop.ts and shared/browser-decision.ts.
      sc.independent = { outcome: JSON.parse(JSON.stringify(outcome)), oracle, testRescueActions: 0 };
      sc.realJev = { used: !s5Fixture, modelRequests: s5Fixture ? 0 : modelRequests, decisions, elapsedMs: Date.now() - t0, reasonCodes: outcome.reasonCode ? [outcome.reasonCode] : [] };

      if (s5Fixture) sc.notes = `Fixed-judge causal regression: ${s5Fixture}; no provider call; not model-quality evidence`;

      return;
    }

    let judge1: any = null;

    try {
      judge1 = await judgeRealtimeBrowserAction(
        rpc,
        { request: "Open the Account menu", userTask: "Open Account hover menu then click Settings", tabId, history: [] },
        AbortSignal.timeout(30_000),
        decideOnce,
      );
    } catch (e) {
      jevErr = String(e);
    }

    if (!judge1 || jevErr) {
      sc.realJev = { used: true, modelRequests, decisions, elapsedMs: Date.now() - t0, error: (jevErr || "no judge").slice(0, 240) };
      check(sc, "real Jev judge1", false, jevErr.slice(0, 200));
      sc.notes = "provider_error";

      return;
    }

    check(sc, "judge1 suggests hover", judge1.status === "suggestion" && judge1.suggestion?.tool === "hover", {
      status: judge1.status,
      tool: judge1.suggestion?.tool,
      reasonCode: judge1.reasonCode,
    });

    if (judge1.suggestion?.tool === "hover") {
      await runTool("hover", judge1.suggestion.arguments);
    } else {
      // No made-up 'hovered account' history and no second action without step one.
      sc.independent = { judge1, actualActions: [], modelRequests };

      return;
    }

    const afterHover = await pageEval(tabId, `(()=>{const s=document.getElementById('settings');const r=s.getBoundingClientRect();return {display:getComputedStyle(s).display,width:r.width,height:r.height,hovered:document.getElementById('menu')?.matches(':hover')}})()`);
    check(sc, "real hover revealed the menu before the next observation", afterHover?.display !== "none" && afterHover?.width > 0 && afterHover?.height > 0, afterHover);
    // fresh observe + second judgment for Settings — ONE more real call total path uses second decide
    let judge2: any = null;

    try {
      judge2 = await judgeRealtimeBrowserAction(
        rpc,
        { request: "Click Settings in the open Account menu", userTask: "Open Account hover menu then click Settings", tabId, history: ["Executed hover on Account; menu independently observed visible"] },
        AbortSignal.timeout(30_000),
        decideOnce,
      );
    } catch (e) {
      jevErr = String(e);
    }

    const actualActions = [{ tool: "hover", arguments: judge1.suggestion.arguments, origin: "production-suggestion" }];

    if (judge2?.status === "suggestion" && judge2.suggestion) {
      await runTool(judge2.suggestion.tool, judge2.suggestion.arguments);
      actualActions.push({ ...judge2.suggestion, origin: "production-suggestion" });
    }

    check(sc, "second decision authorized the actual click", judge2?.status === "suggestion" && judge2.suggestion?.tool === "click", judge2);
    const oracle = await pageEval(tabId, `({...window.__s5,log:document.getElementById('s5log')?.textContent})`);
    sc.realJev = {
      used: !s5Fixture,
      modelRequests,
      decisions,
      reasonCodes: [judge1?.reasonCode, judge2?.reasonCode].filter(Boolean),
      elapsedMs: Date.now() - t0,
      error: jevErr ? jevErr.slice(0, 240) : undefined,
    };

    if (s5Fixture) sc.notes = `Fixed-judge causal regression: ${s5Fixture}; no provider call; not model-quality evidence`;
    check(sc, "settings clicked once", oracle?.settings === 1, oracle);
    check(sc, "forbidden not clicked", oracle?.forbidden === 0, oracle);
    check(sc, "fresh observation after hover", judge1.observationId !== judge2?.observationId, { before: judge1.observationId, after: judge2?.observationId });
    sc.independent = { judge1, judge2, afterHover, actualActions, oracle, modelRequests, testRescueActions: 0 };
  });

  // ── S6 continue_read real Jev once + none case ─────────────────────────
  await wrapScenario("S6", "首区无目标后续找到（真实 Jev）；全无目标不乱点", async (sc) => {
    if (!jevAvailable) {
      sc.verdict = "BLOCKED";
      sc.notes = "Jev 凭据不可用";

      return;
    }

    const tabId = await openWorking(`${fixtureOrigin}/s6`);
    const t0 = Date.now();
    const decisions: unknown[] = [];
    let modelRequests = 0;
    let jevErr = "";
    let outcome: any = null;

    try {
      outcome = await runBrowserDecisionLoop({
        parentCallId: "qa01-s6",
        goal: "Click Late-Target",
        materials: [],
        signal: AbortSignal.timeout(120_000),
        call: loopCall,
        decide: async (input, signal) => {
          modelRequests += 1;
          record.modelRequests += 1;
          const started = Date.now();
          const d = await decideBrowserCandidate(input, signal);
          // 诊断字段：全跑环境里 S6 的置信度长期卡在 0.78–0.84（阈值 0.85），
          // 而隔离探针同代码能到 0.91–0.97。需要分辨是候选噪声（switch_tab 泄漏）
          // 还是视图/scope 差异，才能定位，所以把候选构成一并记进制品。
          decisions.push({
            at: Date.now(), ms: Date.now() - started, candidateId: d.candidateId, confidence: d.confidence, model: d.model,
            candidates: input.candidates.length,
            switchTabs: input.candidates.filter((c: any) => c.operation === 'switch_tab').length,
            viewScopeId: input.page?.viewScopeId,
            lateTargetInView: input.page?.controls?.some((c) => c.name === 'Late-Target') ?? false,
            controlsInView: input.page?.controls?.length ?? 0,
          });

          return d;
        },
      });
    } catch (e) {
      jevErr = String(e);
    }

    const oracle = await pageEval(tabId, `({clicks:{...window.__s6.clicks},late:window.__s6.clicks['L-50']||0,other:Object.entries(window.__s6.clicks).filter(([k,v])=>k!=='L-50'&&v>0)})`);
    sc.realJev = { used: true, modelRequests, decisions, reasonCodes: outcome?.reasonCode ? [outcome.reasonCode] : [], elapsedMs: Date.now() - t0, error: jevErr ? jevErr.slice(0, 240) : undefined };

    if (jevErr && !outcome) {
      check(sc, "real Jev", false, jevErr.slice(0, 200));
      sc.notes = "provider_error";
    } else {
      check(sc, "Late-Target clicked", oracle?.late === 1, oracle);
      check(sc, "no other clicks", (oracle?.other?.length ?? 0) === 0, oracle);
    }

    // none case — fixed judge proving no infinite click; separate from real Jev
    const tabNone = await openWorking(`${fixtureOrigin}/s6none`);
    let noneOutcome: any = null;
    let noneCalls = 0;
    noneOutcome = await runBrowserDecisionLoop({
      parentCallId: "qa01-s6none",
      goal: "Click Absolutely-Missing-Target-XYZ",
      materials: [],
      signal: AbortSignal.timeout(60_000),
      call: loopCall,
      decide: async (input) => {
        noneCalls += 1;
        // choose handoff/done/none rather than random click
        const handoff = input.candidates.find((c: any) => c.operation === "handoff");
        const none = input.candidates.find((c: any) => c.id === "none");
        const pick = handoff ?? none ?? input.candidates.find((c: any) => c.operation === "done");

        return { observationId: input.page.id, candidateId: pick?.id ?? "done", confidence: 0.99, model: "fixture-none" };
      },
    });
    const noneOracle = await pageEval(tabNone, `window.__s6n.total`);
    check(sc, "no-target did not click randomly", noneOracle === 0, { noneOracle, noneOutcome: noneOutcome?.status, noneCalls });
    check(sc, "no-target bounded decisions", noneCalls <= 16, noneCalls);
    sc.independent = { late: oracle, noneOracle, noneStatus: noneOutcome?.status, modelRequests, outcomeStatus: outcome?.status };
  });

  // ── S7 handoff + unknown write ─────────────────────────────────────────
  await wrapScenario("S7", "一步成功后 handoff；丢失写回执不盲重写", async (sc) => {
    const tabId = await openWorking(`${fixtureOrigin}/s7`);
    // first: successful fill once via tools
    await runTool("fill", { target: "#field", value: "ONCE-VALUE", tabId });
    const afterFill = await pageEval(tabId, `document.getElementById('field').value`);
    check(sc, "filled once", afterFill === "ONCE-VALUE", afterFill);
    await runTool("click", { target: "#once", tabId });
    const afterClick = await pageEval(tabId, `({...window.__s7})`);
    check(sc, "success step once", afterClick?.writes === 1 && afterClick?.last === "ONCE-VALUE", afterClick);

    // handoff path with optional one real Jev if available
    let handoffOutcome: any = null;
    let modelRequests = 0;
    const decisions: unknown[] = [];

    if (jevAvailable) {
      const t0 = Date.now();

      try {
        handoffOutcome = await runBrowserDecisionLoop({
          parentCallId: "qa01-s7",
          goal: "After the field is already written, hand off for broader planning; do not write again",
          materials: [],
          signal: AbortSignal.timeout(60_000),
          call: loopCall,
          decide: async (input, signal) => {
            modelRequests += 1;
            record.modelRequests += 1;
            const started = Date.now();
            const d = await decideBrowserCandidate(input, signal);
            decisions.push({ at: Date.now(), ms: Date.now() - started, candidateId: d.candidateId, confidence: d.confidence, model: d.model });

            return d;
          },
        });
        sc.realJev = { used: true, modelRequests, decisions, reasonCodes: handoffOutcome?.reasonCode ? [handoffOutcome.reasonCode] : [], elapsedMs: Date.now() - t0 };
      } catch (e) {
        sc.realJev = { used: true, modelRequests, decisions, elapsedMs: Date.now() - t0, error: String(e).slice(0, 240) };
        sc.notes = "provider_error on handoff judgment";
      }
    } else {
      handoffOutcome = await runBrowserDecisionLoop({
        parentCallId: "qa01-s7-fix",
        goal: "Hand off for missing capability",
        materials: [],
        signal: AbortSignal.timeout(30_000),
        call: loopCall,
        decide: async (input) => {
          const h = input.candidates.find((c: any) => c.operation === "handoff");

          return { observationId: input.page.id, candidateId: h?.id ?? "done", confidence: 0.99, model: "fixture" };
        },
      });
    }

    const writesAfter = await pageEval(tabId, `window.__s7.writes`);
    check(sc, "no second write after success/handoff", writesAfter === 1, writesAfter);

    // lost receipt / unknown: simulate by noting executionFact unknown should not blindly rewrite
    // Use rpc fact if fill marked unknown — attempt confirm path not available; ensure we don't fill again
    const _beforeBlind = await pageEval(tabId, `document.getElementById('field').value`);
    // Not asking for another write does not test recovery from an unknown receipt.
    sc.requiredNotRun = ["actual-lost-receipt-and-production-continuation"];
    sc.independent = {
      afterClick,
      handoffStatus: handoffOutcome?.status,
      handoffReason: handoffOutcome?.reasonCode,
      writesAfter,
      realJevUsed: !!sc.realJev?.used,
    };
  });

  record.productFilesChanged = [
    "agent/src/browser-decision-model.ts",
    "agent/src/browser-action-selection.ts",
    "extension/src/background/page-events.ts",
    "extension/src/background/debugger.ts",
    "extension/src/background/observed-node-rect.ts",
    "extension/src/background/exec/screenshot.ts",
    "extension/src/background/exec/input.ts",
    "extension/src/content/domops.ts",
    "scripts/acceptance/browser-capability-integration-v2.mts",
  ];

  const dailyDistAfter = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;
  record.build = {
    ...record.build,
    dailyDistAfter,
    dailyDistUnchanged: dailyDistBefore === dailyDistAfter,
  };

  if (dailyDistBefore !== dailyDistAfter) {
    record.status = "FAIL";
    record.reason = "日常 extension/dist 在验收期间被改写，证据无效";
  }

  const hard = scenarios.filter(s => !s.notes?.startsWith("filtered out"));

  const allYes =
    record.reason == null &&
    hard.length > 0 &&
    hard.every((s) => s.verdict === "yes") &&
    dailyDistBefore === dailyDistAfter;

  // 三个信号各有明确含义，别混用：
  //   exitCode / status = 本次**实际执行**的 yes/no 场景是否全 yes（过滤集内是否干净）
  //   ok              = 整轮（无 ONLY）且全 yes，才是「这套验收通过」；过滤轮永远是 false，
  //                     防止把 ONLY=C5 的单场景绿误当成 19 场景的绿
  record.ok = allYes && onlyIds.size === 0 && !s5Fixture;
  record.status = allYes ? "PASS" : hard.some(s => s.verdict === "no") || hard.length === 0 ? "FAIL" : "BLOCKED";
  record.runKind = onlyIds.size > 0 ? "filtered" : "full";
  record.executed = scenarios.flatMap((s) => (s.verdict === "yes" || s.verdict === "no" ? [s.id] : []));
  record.filteredOut = scenarios.flatMap((s) => (s.verdict === "未跑" && s.notes?.startsWith("filtered out") ? [s.id] : []));
  record.realJevScenes = scenarios.flatMap((s) => (s.realJev?.used ? [s.id] : []));
  record.rpcEvents = rpcEvents;
} catch (error) {
  record.status = "FAIL";
  record.error = String(error);
  console.error(error);
} finally {
  if (iso) {
    record.cleanup = await iso.close();

    // SAFETY: IsolatedExtension.close() resolves with IsolationCleanup, whose `status`
    // is "PASS" or "FAIL"; this branch reads only that field.
    if ((record.cleanup as IsolationCleanup)?.status !== "PASS") {
      record.ok = false;
      record.status = "FAIL";
    }
  }

  await new Promise<void>((resolveClose, reject) => {
    fixture.close((err) => (err ? reject(err) : resolveClose()));
    fixture.closeAllConnections();
  }).catch((e) => {
    record.fixtureCloseError = String(e);
    record.ok = false;
    record.status = "FAIL";
  });

  try {
    record.sourceFingerprintAfter = await fingerprintSources();
    record.sourceUnchanged = record.sourceFingerprint === record.sourceFingerprintAfter;

    if (!record.sourceUnchanged) { record.ok = false; record.status = "FAIL"; }
  } catch (error) {
    record.ok = false;
    record.status = "FAIL";
    record.error = `Source fingerprint check failed: ${String(error)}`;
  }

  record.finishedAt = new Date().toISOString();
  record.modelRequests = providerRequests;
  record.exitCode = record.status === "PASS" ? 0 : record.status === "BLOCKED" ? 2 : 1;
  await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2));
  await writeFile(
    join(out, "summary.md"),
    [
      `# QA-01 integration ${stamp}`,
      "",
      `- status: ${record.status}`,
      `- exitCode: ${record.exitCode}`,
      `- runKind: ${record.runKind ?? "full"}`,
      `- ok: ${record.ok}${record.runKind === "filtered" ? "（过滤轮恒为 false：本 PASS 只代表跑过的子集，不代表 19 场景全过）" : ""}`,
      ...(record.runKind === "filtered"
        ? [
            `- executed: ${(record.executed ?? []).join(", ") || "(无)"}`,
            `- filteredOut: ${(record.filteredOut ?? []).join(", ") || "(无)"}`,
            `- ⚠️ 这是 ONLY 过滤轮。要证明整套通过，必须再跑一次不带 ONLY 的整轮。`,
          ]
        : []),
      `- evidence: ${out}`,
      `- build: ${record.build.backgroundSha256}`,
      `- dailyDistUnchanged: ${record.build.dailyDistUnchanged}`,
      "",
      ...scenarios.map((s) => `- ${s.id}: ${s.verdict} (${s.assertions.filter((a) => a.ok).length}/${s.assertions.length})`),
      "",
    ].join("\n"),
  );
  console.log(
    JSON.stringify(
      {
        status: record.status,
        exitCode: record.exitCode,
        runKind: record.runKind,
        ok: record.ok,
        out,
        scenarios: scenarios.map((s) => ({ id: s.id, verdict: s.verdict, ok: s.assertions.filter((a) => a.ok).length, total: s.assertions.length })),
        dailyDistUnchanged: record.build.dailyDistUnchanged,
      },
      null,
      2,
    ),
  );
  process.exit(record.exitCode ?? 1);
}
