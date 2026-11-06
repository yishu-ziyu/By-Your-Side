import { A as useRendererQuery, B as createLibrary, C as useRendererPreview, D as useStateField, E as useFormValidation, F as useIsStreaming, I as useRenderNode, L as useSetDefaultValue, M as useFormName, N as useGetFieldValue, O as reactive, P as useIsQueryLoading, R as useSetFieldValue, S as WithPreviewRenderer, T as useCreateFormValidation, V as defineComponent, _ as parseRules, a as buildMessage, b as tagSchemaId, c as createStreamingParser, d as extractToolResult, f as generatePrompt, g as parseMessage, h as mergeStatements, i as action, j as FormNameContext, k as Renderer, l as defineAction, m as isReactiveAssign, n as BuiltinActionType, o as builtInValidators, p as generateSystemPrompt, r as ToolNotFoundError, s as createParser, t as ACTION_STEPS, u as defineFunction, v as parseStructuredRules, w as FormValidationContext, x as validate, y as steps, z as useTriggerAction } from "./exports-CLfR509v.mjs";
//#region src/devtoolsBootstrap.ts
/**
* Auto-mounts the OpenUI Inspect widget in development.
*
* This module runs as a top-level side effect when the web entry is loaded in
* a browser. In production builds the whole block is dead-code-eliminated by
* the consumer's bundler (the NODE_ENV condition folds to false), so
* `@openuidev/devtools` never enters the production graph. The React Native
* entry (index.native.ts) never imports this module.
*
* This module is inlined into the web entry (dist/index.*), which is listed
* in package.json's `sideEffects` so bundlers preserve the side effect while
* the rest of the package stays tree-shakeable.
*/
if (process.env.NODE_ENV === "development") {
	const AUTO_MOUNT_FLAG = Symbol.for("openui.devtools.autoMount");
	const flags = globalThis;
	if (!flags[AUTO_MOUNT_FLAG]) {
		flags[AUTO_MOUNT_FLAG] = true;
		Promise.resolve().then(() => {
			if (typeof document === "undefined") return;
			Promise.all([
				import("@openuidev/devtools"),
				import("react"),
				import("react-dom/client")
			]).then(([{ OpenUIDevtools }, React, ReactDOMClient]) => {
				const attach = () => {
					const host = document.createElement("div");
					host.setAttribute("data-openui-devtools-auto-mount", "");
					document.body.appendChild(host);
					ReactDOMClient.createRoot(host).render(React.createElement(OpenUIDevtools, {
						version: "0",
						__autoMounted: true
					}));
				};
				if (document.body) attach();
				else document.addEventListener("DOMContentLoaded", attach, { once: true });
			}).catch(() => {});
		});
	}
}
//#endregion
export { ACTION_STEPS, BuiltinActionType, FormNameContext, FormValidationContext, Renderer, ToolNotFoundError, WithPreviewRenderer, action, buildMessage, builtInValidators, createLibrary, createParser, createStreamingParser, defineAction, defineComponent, defineFunction, extractToolResult, generatePrompt, generateSystemPrompt, isReactiveAssign, mergeStatements, parseMessage, parseRules, parseStructuredRules, reactive, steps, tagSchemaId, useCreateFormValidation, useFormName, useFormValidation, useGetFieldValue, useIsQueryLoading, useIsStreaming, useRenderNode, useRendererPreview, useRendererQuery, useSetDefaultValue, useSetFieldValue, useStateField, useTriggerAction, validate };

//# sourceMappingURL=index.mjs.map