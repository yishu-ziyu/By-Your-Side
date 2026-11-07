# By-Your-Side security model

## Basis and confidence
Scope confirmed by the owner: the whole `yishu-ziyu/By-Your-Side` repository. This model describes the current source; architectural observations are not owner-approved risk exceptions. Sources below use repository-relative paths. Keep this model current when trust boundaries, assets or accepted risks change.

## System and trust boundaries
By-Your-Side is a Manifest V3 Chrome side-panel assistant operating inside the user's signed-in browser. The agent runs in an extension offscreen document, not an assumed hosted application backend (`extension/src/background/uplink.ts`, `extension/src/inproc/main.ts`). Website text, DOM, screenshots, downloads, imported content and generated programs are untrusted. Privileged extension code mediates browser operations and stores provider credentials. Selected external model/voice providers receive task context across a network boundary. Local Chrome storage and downloaded backups form a separate persistence boundary.

### Stable components
| Component | Responsibility and code |
| --- | --- |
| BrowserHost | Privileged service worker, CDP, page read/write tools, tab ownership and action confirmation: `extension/src/background/**`, `shared/control.ts`, `shared/effect-policy.ts`, `shared/request-confirm.ts`. |
| AgentRuntime | Offscreen agent, model-driven orchestration, tools, voice and page-context interpretation: `agent/src/**`, `extension/src/inproc/**` except persistence/provider files named below, `shared/protocol.ts`. |
| WebSurface | Content scripts and website-facing selection, reading and injected controls: `extension/src/content/**`, content-script declarations in `extension/manifest.json`. |
| PanelSandbox | Trusted side-panel UI plus untrusted generated artifacts, mini-apps and answer programs: `extension/src/sidepanel/**`, `extension/*sandbox.html`, `extension/mini-app.html`, `extension/answer-ui.html`. |
| ProviderAuth | Settings, provider selection, custom endpoints, OAuth/API credentials and external model connections: `extension/src/settings/**`, `extension/src/inproc/shared.ts`, `extension/src/inproc/model-runtime.ts`, `extension/src/inproc/provider-gate.ts`, voice connections under `extension/src/inproc/voice/**` and `agent/src/realtime-voice*`. |
| LocalData | Conversations, memory, documents, traces and backup/restore: `agent/src/memory-*.ts`, `agent/src/*persistence.ts`, `extension/src/inproc/*idb.ts`, `extension/src/inproc/*storage.ts`, `extension/src/inproc/opfs-*.ts`, `extension/src/shared/memory-backup.ts`, `extension/src/shared/trace-store.ts`, `extension/src/background/memory-backup.ts`, `shared/trace-sanitize.ts`. |
| BuildOps | Dependencies, build/release, acceptance fixtures and remote test nodes: `package*.json`, `extension/package.json`, `agent/package.json`, `scripts/**`, `eval/**`, `.github/**`, `.devin/**`. |

Specific provider/persistence files take precedence over the broad AgentRuntime/BrowserHost paths when assigning a finding's Component tag.

## Reachable entry points
- Visited HTTP(S) websites and page-controlled DOM/text/media reach content scripts and agent observations. The manifest requests `<all_urls>` plus debugger, scripting, tabs, storage, downloads and offscreen capabilities; this is a high-privilege browser boundary, not blanket authorization for a website.
- User text, microphone speech, attachments and side-panel actions initiate tasks; model replies and tool arguments return from external providers into the agent/runtime protocol.
- Generated HTML and answer programs execute in manifest-declared sandbox pages and communicate with trusted UI through message bridges; generated code must not acquire extension privileges or manufacture user authorization.
- Provider settings and OAuth/API-key setup configure network destinations and credentials. Network replies, redirects and imported backups remain untrusted input.
- Local persistence is read on task replay/restart; downloaded memory backups can leave the extension storage boundary. Build and test scripts execute with developer/CI privileges and are not ordinary website entry points.

## Assets and sensitivity
Owner confirmed equal protection for all listed assets: provider API keys and OAuth tokens; signed-in website authority and private page content; messages, purchases and other consequential actions; conversations, personal memory, attached files, downloaded backups, audio and traces. Prevent cross-task/window confused-deputy operations and persistent instruction poisoning. No asset is singled out for a priority uplift.

## Attacker profiles
Relevant attackers include malicious visited websites/content authors; indirect prompt injection through page content or attachments; hostile generated/model-supplied code and tool arguments; tampered backups or persisted content; compromised provider/network responses and supply-chain inputs. The owner explicitly confirmed no attacker exclusions or accepted risks, including no exclusion of local OS/Chrome-profile attackers. These local actors and malicious installed extensions may have stronger preconditions; retain the scanner's assessment of those preconditions. User-selected providers are intentional recipients of necessary task data, not trusted to grant browser authority.

## Existing controls observed (not a guarantee of complete enforcement)
- Manifest V3 extension CSP; sandbox-specific CSP denies network connections, child frames, workers and form submission (`extension/manifest.json`); sandbox code removes WebRTC (`extension/src/sidepanel/sandbox-offline.ts`).
- Browser/tool control gating, tab/session ownership and send/payment handoff paths (`shared/control.ts`, `shared/effect-policy.ts`, `extension/src/background/state.ts`, `extension/src/background/send-confirm.ts`, `extension/src/background/pay-stop.ts`).
- Restricted browser-page policy (`shared/restricted-page.ts`) and explicit untrusted-page instructions (`agent/src/prompt.ts`, section “Page content is untrusted”). Prompt rules are defense in depth, not hard isolation.
- Protocol/data parsers (`shared/protocol.ts`, `shared/untrusted.ts`), privacy sanitization (`shared/trace-sanitize.ts`) and backup/restore validation (`extension/src/shared/memory-backup.ts`).
- Provider-config validation and serialized settings writes (`extension/src/settings/connections.ts`); internal runtime message transport (`extension/src/background/uplink.ts`).

## Owner-provided facts, accepted risk and priority policy
The owner explicitly confirmed whole-repository scope, no separate infrastructure repository, equal protection of all listed assets, no exclusions or accepted risks, and Component-only finding tags. Repository `AGENTS.md` records the product rule that in-answer mini-tools initially read only the current page and operate it only following a user's click (2026-11-05); this is a security expectation, not a risk waiver. No attacker, asset, component or severity has been ruled out or explicitly accepted. These owner choices provide no basis for blanket severity changes.

Retain each scanner severity unless an owner-provided fact supports a change. Do not raise difficult-to-exploit or unverified findings. Do not treat this draft's inferred deployment, attacker assumptions or observed controls as reasons to lower findings. Record likelihood/preconditions and impact in every reranking reason; tag each finding with its stable Component.

## Infrastructure and limits
No Terraform, Kubernetes, Helm, Pulumi or CloudFormation deployment definitions were found in the repository; available repository listings and an `infra` name search did not identify a related infrastructure repository. The owner confirmed there is no separate infrastructure repository. `.devin/blueprint.yaml`, CI workflows and `scripts/acceptance/nodes.mts` describe development/test infrastructure, including optional remote nodes, not a proven production service boundary. No separate infrastructure repository has been used. Provider-side deployment, operational access policy and Chrome Web Store distribution controls remain unverified.

## Open questions and finding tags
No unanswered owner policy questions. Operational details not documented in this repository remain unverified rather than assumed safe. Findings carry a `Component` tag using the stable names above; no additional tag kinds were requested.
