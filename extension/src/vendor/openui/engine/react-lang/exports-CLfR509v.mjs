import { ACTION_STEPS, ACTION_STEPS as ACTION_STEPS$1, BuiltinActionType, BuiltinActionType as BuiltinActionType$1, ToolNotFoundError, ToolNotFoundError as ToolNotFoundError$1, action, buildMessage, builtInValidators, createLibrary, createParser, createQueryManager, createStore, createStreamingParser, createStreamingParser as createStreamingParser$1, defineAction, defineComponent, defineFunction, enrichErrors, evaluate, evaluateRoot, extractToolResult, extractToolResult as extractToolResult$1, generatePrompt, generateSystemPrompt, isReactiveAssign, markReactive, mergeStatements, parseMessage, parseMessage as parseMessage$1, parseRules, parseStructuredRules, resolveStateField, steps, tagSchemaId, validate, validate as validate$1 } from "@openuidev/lang-core";
import { observability } from "@openuidev/observability";
import { Component, Fragment, createContext, useCallback, useContext, useEffect, useId, useInsertionEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/publishLibrary.ts
/**
* Shared with `@openuidev/devtools` via `Symbol.for`. Not a public API —
* the live library object stays off the observability bus (serializable ping
* only). Keep the string in sync with `packages/devtools/src/libraryRegistry.ts`.
*/
const DEVTOOLS_LIBRARIES_KEY = Symbol.for("openui.devtools.libraries");
const LIBRARY_EVENT_KIND = "react-lang:library";
function libraryKey(library) {
	return library.id ?? library.root ?? Object.keys(library.components).sort().join(",");
}
function getRegistry() {
	const store = globalThis;
	return store[DEVTOOLS_LIBRARIES_KEY] ??= {};
}
/** Dev-only: stash the live library and emit a serializable registration ping. */
function publishLibrary(library, key = libraryKey(library)) {
	getRegistry()[key] = library;
	observability.info({
		kind: LIBRARY_EVENT_KIND,
		__libraryId: library.__libraryId,
		...library.id !== void 0 ? { id: library.id } : {},
		...library.root !== void 0 ? { root: library.root } : {},
		components: Object.keys(library.components),
		message: library.id ? `Library "${library.id}" registered` : `Library registered (root: ${library.root ?? "none"})`
	});
}
//#endregion
//#region src/library.ts
function defineComponent$1(config) {
	return defineComponent(config);
}
function createLibrary$1(input) {
	return published(createLibrary(input));
}
let extendCount = 0;
function published(library, key = libraryKey(library)) {
	if (process.env["NODE_ENV"] !== "production") publishLibrary(library, key);
	const extend = library.extend;
	return Object.assign(library, { extend: ((ext) => published(extend(ext), `${key}:extend-${++extendCount}`)) });
}
//#endregion
//#region src/context.ts
const OpenUIContext = createContext(null);
/**
* Access the full OpenUI context. Throws if used outside a <Renderer />.
*/
function useOpenUI() {
	const ctx = useContext(OpenUIContext);
	if (!ctx) throw new Error("useOpenUI must be used within a <Renderer /> component.");
	return ctx;
}
/**
* Get the renderNode function for rendering nested component values.
*/
function useRenderNode() {
	return useOpenUI().renderNode;
}
/**
* Get the triggerAction function for firing structured action events.
*
* @example
* ```tsx
* const triggerAction = useTriggerAction();
* <button onClick={() => triggerAction("Submit", "myForm")}>
* ```
*/
function useTriggerAction() {
	return useOpenUI().triggerAction;
}
/**
* Whether the LLM is currently streaming content.
*/
function useIsStreaming() {
	return useOpenUI().isStreaming;
}
/**
* Whether any Query is currently fetching data.
* Useful for showing skeleton/loading states in data-driven components.
*/
function useIsQueryLoading() {
	return useOpenUI().isQueryLoading;
}
/**
* Get a form field value from the form state context.
*
* @example
* ```tsx
* const getFieldValue = useGetFieldValue();
* const name = getFieldValue("contactForm", "name");
* ```
*/
function useGetFieldValue() {
	return useOpenUI().getFieldValue;
}
/**
* Get the setFieldValue function for updating form field values.
*
* @example
* ```tsx
* const setFieldValue = useSetFieldValue();
* <input onChange={(e) => setFieldValue("contactForm", "Input", "name", e.target.value, false)} />
* ```
*/
function useSetFieldValue() {
	return useOpenUI().setFieldValue;
}
const FormNameContext = createContext(void 0);
/**
* Get the current form name (set by the nearest parent Form component).
* Returns undefined if not inside a Form.
*/
function useFormName() {
	return useContext(FormNameContext);
}
/**
* Persists a component's default/initial value into form state once streaming
* finishes — but only if the user hasn't already set a value.
*
* Call this inside any form component that has a `defaultValue` or
* `defaultChecked` prop. It is a no-op during streaming so that LLM
* prop changes don't fight with partial state.
*
* @param shouldTriggerSaveCallback — defaults to `false` (only local state, no message persistence)
*/
function useSetDefaultValue({ formName, componentType, name, existingValue, defaultValue, shouldTriggerSaveCallback = false }) {
	const setFieldValue = useSetFieldValue();
	const isStreaming = useIsStreaming();
	useEffect(() => {
		if (!isStreaming && existingValue === void 0 && defaultValue !== void 0) setFieldValue(formName, componentType, name, defaultValue, shouldTriggerSaveCallback);
	}, [
		defaultValue,
		existingValue,
		formName,
		componentType,
		name,
		isStreaming,
		setFieldValue,
		shouldTriggerSaveCallback
	]);
}
//#endregion
//#region src/responseBundle.ts
const SCRIPTS = "]]>openui:scripts";
const CONTENT_LINE = /^\]\]>openui:content(?:\?.*)?\r?$(\n?)/m;
const BARE_SCRIPTS = /^\]\]>openui:scripts(?=\?|\r?$)/gm;
function markerIndex(text) {
	let quote = "";
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === quote) quote = "";
		} else if (c === "#" || c === "/" && text[i + 1] === "/") {
			const newline = text.indexOf("\n", i);
			if (newline < 0) return -1;
			i = newline;
		} else if (c === "\"" || c === "'") quote = c;
		else if (text.startsWith("]]>", i)) return i;
	}
	return -1;
}
function readScripts(header, payload) {
	try {
		const { count } = JSON.parse(header);
		const values = JSON.parse(payload);
		if (!Array.isArray(values) || !Number.isSafeInteger(count) || count !== values.length) return null;
		const names = /* @__PURE__ */ new Set();
		for (const script of values) {
			if (!script || typeof script.name !== "string" || !script.name || typeof script.code !== "string" || names.has(script.name)) return null;
			names.add(script.name);
		}
		return {
			names,
			revision: JSON.stringify(values.map((script) => ({
				name: script.name,
				code: script.code
			})).sort((a, b) => a.name.localeCompare(b.name)))
		};
	} catch {
		return null;
	}
}
/** Reads an OpenUI Cloud response: a stored message (see parseMessage) plus its scripts section. */
function parseResponseBundle(response, streaming) {
	const text = response ?? "";
	const line = CONTENT_LINE.exec(text);
	const framed = !!line && (!streaming || line[1] === "\n");
	const { content, attributes, end } = parseMessage(text.replace(BARE_SCRIPTS, "$& "), { streaming });
	let program = content;
	let section = false;
	let scripts = null;
	const at = markerIndex(program);
	if (at >= 0 && program.startsWith(SCRIPTS, at)) {
		section = true;
		const newline = program.indexOf("\n", at);
		let to = program.length;
		if (newline >= 0) {
			const next = markerIndex(program.slice(newline + 1));
			if (next >= 0) to = newline + 1 + next;
			scripts = readScripts(program.slice(at + 17, newline), program.slice(newline + 1, to));
		}
		const before = at > 0 ? program.slice(0, at).replace(/\r?\n$/, "") : "";
		const after = program.slice(to);
		program = after ? `${before}\n${after}` : before;
	}
	const metadata = {};
	if (!framed && !section && !end) return {
		program,
		metadata,
		scripts: /* @__PURE__ */ new Set(),
		complete: true,
		isBundle: false,
		error: void 0
	};
	if (framed && attributes.name !== void 0) metadata.name = attributes.name;
	const error = section && !scripts ? "Invalid scripts bundle" : void 0;
	return {
		program,
		metadata,
		scripts: scripts?.names ?? /* @__PURE__ */ new Set(),
		complete: !error && (end || !streaming || !framed),
		isBundle: true,
		error: streaming ? void 0 : error,
		...scripts?.names.size ? { scriptRevision: scripts.revision } : {}
	};
}
//#endregion
//#region src/hooks/useOpenUIErrors.ts
/** Aggregates Renderer errors and owns the public onError callback behavior. */
function useOpenUIErrors({ response, isStreaming, result, evaluatedResult, library, querySnapshot, parseExceptionRef, runtimeErrorsRef, renderErrorsRef, onError }) {
	const errorsRef = useRef([]);
	const [errorRevision, setErrorRevision] = useState(0);
	const lastErrorKeyRef = useRef("");
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	useEffect(() => {
		if (isStreaming) {
			errorsRef.current = [];
			if (lastErrorKeyRef.current !== "") {
				lastErrorKeyRef.current = "";
				onErrorRef.current?.([]);
			}
			return;
		}
		const errors = [];
		if (parseExceptionRef.current) errors.push(parseExceptionRef.current);
		if (response && !result?.meta.statementCount && !parseExceptionRef.current) errors.push({
			source: "parser",
			code: "parse-failed",
			message: "Response could not be parsed as valid openui-lang",
			hint: `The entire response must be valid openui-lang code starting with root = ${library.root ?? "Root"}(...)`
		});
		if (result?.meta.errors.length) errors.push(...enrichErrors(result.meta.errors, library.toJSONSchema(), Object.keys(library.components)));
		errors.push(...runtimeErrorsRef.current);
		errors.push(...renderErrorsRef.current);
		renderErrorsRef.current = [];
		errors.push(...querySnapshot.__openui_errors ?? []);
		errorsRef.current = errors;
		const errorKey = JSON.stringify(errors);
		if (errorKey === lastErrorKeyRef.current) return;
		lastErrorKeyRef.current = errorKey;
		setErrorRevision((revision) => revision + 1);
		if (onErrorRef.current) onErrorRef.current(errors);
		else if (errors.length > 0) for (const error of errors) console.warn(`[openui] ${error.source}/${error.code}: ${error.message}`);
	}, [
		isStreaming,
		response,
		result,
		evaluatedResult,
		querySnapshot,
		library,
		parseExceptionRef,
		runtimeErrorsRef,
		renderErrorsRef
	]);
	return {
		errorsRef,
		errorRevision
	};
}
//#endregion
//#region src/hooks/streamEvent.ts
/**
* Producer-side contract for the stream lifecycle events this package emits on
* `@openuidev/observability`. Intentionally duplicated (not imported) in
* `@openuidev/observability-cloud` (src/events/stream.ts), which consumes these
* events; the two packages have no dependency on each other. Keep the string
* constants and the settled detail shape in sync when changing either side.
*/
const STREAM_EVENT_KIND = "react-lang:stream";
const STREAM_PHASE_STREAMING = "streaming";
const STREAM_PHASE_SETTLED = "settled";
//#endregion
//#region src/hooks/useStreamingObservability.ts
let fallbackId = 0;
function createStreamId() {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	fallbackId += 1;
	return `openui-lang-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}
function createStreamingObservabilityState() {
	return {
		id: null,
		updateIndex: 0,
		lastResponse: null,
		hasPublishedStreamingSnapshot: false,
		settled: false,
		lastSettledErrorKey: null,
		startedAt: null,
		durationMs: null
	};
}
function captureStreamTiming(state, now = Date.now()) {
	state.startedAt ??= now;
	if (state.settled) state.durationMs ??= Math.max(0, now - state.startedAt);
	const elapsedMs = state.durationMs ?? Math.max(0, now - state.startedAt);
	return {
		startedAt: state.startedAt,
		elapsedMs,
		...state.durationMs != null ? { durationMs: state.durationMs } : {}
	};
}
/** Advances a Renderer through successive stream lifecycles. */
function advanceStreamingObservability(state, isStreaming, response, settledErrorKey = null, idFactory = createStreamId) {
	if (isStreaming) {
		if (state.settled) Object.assign(state, createStreamingObservabilityState());
		state.id ??= idFactory();
		if (state.hasPublishedStreamingSnapshot && state.lastResponse === response) return null;
		state.hasPublishedStreamingSnapshot = true;
		state.lastResponse = response;
		state.updateIndex += 1;
		return {
			id: state.id,
			phase: STREAM_PHASE_STREAMING,
			updateIndex: state.updateIndex
		};
	}
	if (!state.id) return null;
	if (state.settled && (settledErrorKey === null || state.lastSettledErrorKey === settledErrorKey)) return null;
	state.updateIndex += 1;
	state.settled = true;
	state.lastSettledErrorKey = settledErrorKey;
	return {
		id: state.id,
		phase: STREAM_PHASE_SETTLED,
		updateIndex: state.updateIndex
	};
}
function parserMetadata(result) {
	if (!result) return void 0;
	return {
		incomplete: result.meta.incomplete,
		unresolved: result.meta.unresolved,
		orphaned: result.meta.orphaned,
		statementCount: result.meta.statementCount
	};
}
/**
* Publishes the incremental OpenUI Lang stream lifecycle. The stable id is
* created only after this Renderer instance has actually entered streaming.
*/
function useStreamingObservability({ response, isStreaming, result, errorsRef, errorRevision, publish = true, __libraryId }) {
	const streamRef = useRef(createStreamingObservabilityState());
	useEffect(() => {
		if (!publish) return;
		const errors = errorsRef.current;
		const settledErrorKey = isStreaming ? null : JSON.stringify(errors);
		const update = advanceStreamingObservability(streamRef.current, isStreaming, response, settledErrorKey);
		const libraryIdFields = __libraryId !== void 0 ? { __libraryId } : {};
		if (isStreaming) {
			if (update) observability.info({
				id: update.id,
				kind: STREAM_EVENT_KIND,
				phase: update.phase,
				updateIndex: update.updateIndex,
				response,
				responseLength: response?.length ?? 0,
				parser: parserMetadata(result),
				...captureStreamTiming(streamRef.current),
				...libraryIdFields,
				message: "OpenUI Lang is streaming"
			});
			return;
		}
		if (update?.phase === "settled") observability(errors.length > 0 ? "error" : "info", {
			id: update.id,
			kind: STREAM_EVENT_KIND,
			phase: STREAM_PHASE_SETTLED,
			updateIndex: update.updateIndex,
			response,
			responseLength: response?.length ?? 0,
			parser: parserMetadata(result),
			errors,
			errorCount: errors.length,
			...captureStreamTiming(streamRef.current),
			...libraryIdFields,
			message: errors.length > 0 ? `OpenUI Lang settled with ${errors.length} error${errors.length === 1 ? "" : "s"}` : "OpenUI Lang settled"
		});
	}, [
		publish,
		isStreaming,
		response,
		result,
		errorsRef,
		errorRevision,
		__libraryId
	]);
}
//#endregion
//#region src/hooks/useOpenUIState.ts
/** Unwrap { value, componentType } wrapper from form field entries. Returns raw value. */
function unwrapFieldValue(v) {
	if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) return v.value;
	return v;
}
/**
* Core state hook — extracts all form state, action handling, parser
* management, and context assembly out of the Renderer component.
*
* Store holds everything: $bindings as top-level keys, form fields nested
* under formName as plain values.
*/
function useOpenUIState({ response: raw, library, isStreaming, onAction, onStateUpdate, initialState, toolProvider, onError, publishObservability }, renderDeep) {
	const bundle = useMemo(() => parseResponseBundle(raw, isStreaming), [raw, isStreaming]);
	const blocked = isStreaming || !bundle.complete || !!bundle.error;
	const bundleBlocked = bundle.isBundle && blocked;
	const settledScripts = useRef({
		revision: null,
		names: /* @__PURE__ */ new Set()
	});
	if (!blocked) settledScripts.current = {
		revision: "scriptRevision" in bundle ? bundle.scriptRevision ?? null : null,
		names: bundle.scripts
	};
	const scriptRevision = settledScripts.current.revision;
	const scriptNames = settledScripts.current.names;
	const schema = useMemo(() => library.toJSONSchema(), [library]);
	const sp = useMemo(() => createStreamingParser(schema, library.root), [schema, library.root]);
	const functions = useMemo(() => Object.fromEntries(Object.entries(schema.functions ?? {}).flatMap(([name, s]) => {
		const fn = library.functions?.[name]?.fn;
		return fn ? [[name, {
			...s,
			fn
		}]] : [];
	})), [schema, library.functions]);
	const parseExceptionRef = useRef(null);
	const result = useMemo(() => {
		parseExceptionRef.current = bundle.error ? {
			source: "parser",
			code: "parse-failed",
			message: bundle.error
		} : null;
		if (!bundle.program) return null;
		try {
			return sp.set(bundle.program, !isStreaming);
		} catch (e) {
			parseExceptionRef.current = {
				source: "parser",
				code: "parse-exception",
				message: `Parser crashed: ${e instanceof Error ? e.message : String(e)}`,
				hint: "The response may contain syntax the parser cannot handle"
			};
			return null;
		}
	}, [
		sp,
		bundle.program,
		bundle.error,
		isStreaming
	]);
	const store = useMemo(() => createStore(), []);
	const queryManager = useMemo(() => createQueryManager(toolProvider ?? null), [toolProvider]);
	useEffect(() => {
		queryManager.activate();
		return () => queryManager.dispose();
	}, [queryManager]);
	const initializingRef = useRef(false);
	const storeInitKeyRef = useRef(Symbol());
	useEffect(() => {
		if (!result?.stateDeclarations && !initialState) return;
		const key = `${JSON.stringify(result?.stateDeclarations)}::${JSON.stringify(initialState)}`;
		if (storeInitKeyRef.current === key) return;
		storeInitKeyRef.current = key;
		const bindingDefaults = {};
		if (initialState) for (const [key, value] of Object.entries(initialState)) if (key.startsWith("$")) bindingDefaults[key] = value;
		else store.set(key, value);
		initializingRef.current = true;
		store.initialize(result?.stateDeclarations ?? {}, bindingDefaults);
		initializingRef.current = false;
	}, [
		result?.stateDeclarations,
		store,
		initialState
	]);
	const storeSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const querySnapshot = useSyncExternalStore(queryManager.subscribe, queryManager.getSnapshot, queryManager.getSnapshot);
	const evaluationContext = useMemo(() => ({
		getState: (name) => unwrapFieldValue(store.get(name)),
		resolveRef: (name) => {
			const mutResult = queryManager.getMutationResult(name);
			if (mutResult) return mutResult;
			return queryManager.getResult(name);
		},
		functions,
		actions: schema.actions
	}), [
		store,
		queryManager,
		functions,
		schema.actions
	]);
	useEffect(() => {
		if (blocked) return;
		const evaluatedNodes = (result?.queryStatements ?? []).map((qn) => {
			const relevantDeps = {};
			const toolName = qn.toolAST ? evaluate(qn.toolAST, evaluationContext) : "";
			if (qn.deps) for (const ref of qn.deps) relevantDeps[ref] = storeSnapshot[ref];
			if (scriptNames.has(toolName)) relevantDeps.__openuiScriptRevision = scriptRevision;
			return {
				statementId: qn.statementId,
				toolName,
				args: qn.argsAST ? evaluate(qn.argsAST, evaluationContext) : null,
				defaults: qn.defaultsAST ? evaluate(qn.defaultsAST, evaluationContext) : null,
				refreshInterval: qn.refreshAST ? evaluate(qn.refreshAST, evaluationContext) : void 0,
				deps: Object.keys(relevantDeps).length > 0 ? relevantDeps : void 0,
				complete: qn.complete
			};
		});
		queryManager.evaluateQueries(evaluatedNodes);
	}, [
		blocked,
		result?.queryStatements,
		evaluationContext,
		queryManager,
		storeSnapshot,
		scriptRevision,
		scriptNames
	]);
	useEffect(() => {
		if (blocked) return;
		const nodes = (result?.mutationStatements ?? []).map((mn) => ({
			statementId: mn.statementId,
			toolName: mn.toolAST ? evaluate(mn.toolAST, evaluationContext) : ""
		}));
		queryManager.registerMutations(nodes);
	}, [
		blocked,
		result?.mutationStatements,
		evaluationContext,
		queryManager
	]);
	const propsRef = useRef({
		onAction,
		onStateUpdate
	});
	propsRef.current = {
		onAction,
		onStateUpdate
	};
	const resultRef = useRef(result);
	resultRef.current = result;
	const lastInitSnapshotRef = useRef(null);
	useEffect(() => {
		lastInitSnapshotRef.current = store.getSnapshot();
		return store.subscribe(() => {
			const currentSnapshot = store.getSnapshot();
			if (initializingRef.current || currentSnapshot === lastInitSnapshotRef.current) return;
			lastInitSnapshotRef.current = null;
			propsRef.current.onStateUpdate?.(currentSnapshot);
		});
	}, [store]);
	const getFieldValue = useCallback((formName, name) => {
		if (!formName) return unwrapFieldValue(store.get(name));
		const formData = store.get(formName);
		if (!formData || typeof formData !== "object" || Array.isArray(formData)) return void 0;
		return unwrapFieldValue(formData[name]);
	}, [store]);
	const setFieldValue = useCallback((formName, componentType, name, value, shouldTriggerSaveCallback = true) => {
		const wrapped = {
			value,
			componentType
		};
		if (!formName) store.set(name, wrapped);
		else {
			const raw = store.get(formName);
			const formData = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
			store.set(formName, {
				...formData,
				[name]: wrapped
			});
		}
		if (shouldTriggerSaveCallback) propsRef.current.onStateUpdate?.(store.getSnapshot());
	}, [store]);
	const getFormPayload = useCallback((formName) => {
		if (formName) {
			const raw = store.get(formName);
			if (raw && typeof raw === "object" && !Array.isArray(raw)) return { [formName]: raw };
		}
		return store.getSnapshot();
	}, [store]);
	const triggerAction = useCallback(async (userMessage, formName, action) => {
		if (bundleBlocked) return;
		const { onAction: handler } = propsRef.current;
		if (action && !("steps" in action)) {
			const formPayload = getFormPayload(formName);
			const actionType = action.type || BuiltinActionType.ContinueConversation;
			if (schema.actions && Object.prototype.hasOwnProperty.call(schema.actions, actionType)) return;
			const params = { ...action.params || {} };
			if (action.url) params.url = action.url;
			if (action.context) params.context = action.context;
			handler?.({
				type: actionType,
				params,
				humanFriendlyMessage: userMessage,
				formState: formPayload,
				formName
			});
			return;
		}
		const actionPlan = action;
		if (actionPlan?.steps) {
			for (const step of actionPlan.steps) switch (step.type) {
				case ACTION_STEPS.Run:
					if (step.refType === "mutation") {
						const mn = resultRef.current?.mutationStatements?.find((m) => m.statementId === step.statementId);
						const evaluatedArgs = mn?.argsAST ? evaluate(mn.argsAST, evaluationContext) : {};
						if (!await queryManager.fireMutation(step.statementId, evaluatedArgs)) return;
					} else queryManager.invalidate([step.statementId]);
					break;
				case ACTION_STEPS.ToAssistant:
					handler?.({
						type: BuiltinActionType.ContinueConversation,
						params: step.context !== void 0 ? { context: step.context } : {},
						humanFriendlyMessage: step.message,
						formState: getFormPayload(formName),
						formName
					});
					break;
				case ACTION_STEPS.OpenUrl:
					handler?.({
						type: BuiltinActionType.OpenUrl,
						params: { url: step.url },
						humanFriendlyMessage: "",
						formState: getFormPayload(formName),
						formName
					});
					break;
				case "custom_action":
					handler?.({
						type: step.name,
						params: step.params,
						humanFriendlyMessage: "",
						formState: getFormPayload(formName),
						formName
					});
					break;
				case ACTION_STEPS.Set: {
					if (!step.valueAST) {
						console.warn(`[openui] Set action for ${step.target} has no valueAST — skipping`);
						break;
					}
					const value = evaluate(step.valueAST, evaluationContext);
					store.set(step.target, value);
					break;
				}
				case ACTION_STEPS.Reset: {
					const decls = resultRef.current?.stateDeclarations ?? {};
					for (const target of step.targets) store.set(target, decls[target] ?? null, { pristine: true });
					break;
				}
			}
			return;
		}
		handler?.({
			type: BuiltinActionType.ContinueConversation,
			params: {},
			humanFriendlyMessage: userMessage,
			formState: getFormPayload(formName),
			formName
		});
	}, [
		bundleBlocked,
		queryManager,
		evaluationContext,
		getFormPayload,
		store,
		schema.actions
	]);
	const renderErrorsRef = useRef([]);
	const isStreamingRef = useRef(isStreaming);
	isStreamingRef.current = isStreaming;
	const reportError = useCallback((error) => {
		if (isStreamingRef.current) return;
		renderErrorsRef.current.push(error);
	}, []);
	const isQueryLoading = querySnapshot.__openui_loading.length > 0 || isStreaming && bundleBlocked && (result?.queryStatements.length ?? 0) > 0;
	const queryErrors = useMemo(() => querySnapshot.__openui_errors.filter((error) => error.source === "query"), [querySnapshot]);
	const retryQueries = useCallback(() => {
		if (bundleBlocked) return;
		queryManager.invalidate(queryErrors.map((error) => error.statementId));
	}, [
		bundleBlocked,
		queryManager,
		queryErrors
	]);
	const runtimeErrorsRef = useRef([]);
	const evaluatedResult = useMemo(() => {
		if (!result?.root && !result?.rootExpression) return result;
		const errors = [];
		const evalCtx = {
			ctx: evaluationContext,
			library,
			store,
			errors
		};
		try {
			const evaluatedRoot = evaluateRoot(result, evalCtx);
			runtimeErrorsRef.current = errors;
			return {
				...result,
				root: evaluatedRoot
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push({
				source: "runtime",
				code: "runtime-error",
				message: `Prop evaluation failed: ${msg}`
			});
			runtimeErrorsRef.current = errors;
			return result;
		}
	}, [
		result,
		evaluationContext,
		library,
		store,
		storeSnapshot,
		querySnapshot
	]);
	const contextValue = useMemo(() => ({
		library,
		renderNode: renderDeep,
		triggerAction,
		isStreaming: blocked,
		getFieldValue,
		setFieldValue,
		store,
		evaluationContext,
		reportError,
		isQueryLoading
	}), [
		library,
		renderDeep,
		blocked,
		isQueryLoading,
		triggerAction,
		getFieldValue,
		setFieldValue,
		store,
		evaluationContext,
		reportError
	]);
	const { errorsRef, errorRevision } = useOpenUIErrors({
		response: bundle.program,
		isStreaming,
		result,
		evaluatedResult,
		library,
		querySnapshot,
		parseExceptionRef,
		runtimeErrorsRef,
		renderErrorsRef,
		onError
	});
	useStreamingObservability({
		response: bundle.program,
		isStreaming,
		result,
		errorsRef,
		errorRevision,
		publish: publishObservability,
		__libraryId: library.__libraryId
	});
	return {
		result: evaluatedResult,
		parseResult: result,
		contextValue,
		isQueryLoading,
		queryErrors,
		retryQueries
	};
}
//#endregion
//#region src/Renderer.tsx
/**
* Error boundary that intentionally shows the last successfully rendered
* children when a render error occurs. This "show last good state" behavior
* prevents the UI from going blank during streaming or transient evaluation
* errors, and auto-recovers when new valid children arrive.
*/
var ElementErrorBoundary = class extends Component {
	lastValidChildren = null;
	constructor(props) {
		super(props);
		this.state = { hasError: false };
	}
	static getDerivedStateFromError() {
		return { hasError: true };
	}
	componentDidMount() {
		if (!this.state.hasError) this.lastValidChildren = this.props.children;
	}
	componentDidUpdate(prevProps) {
		if (!this.state.hasError) this.lastValidChildren = this.props.children;
		if (this.state.hasError && prevProps.children !== this.props.children) this.setState({ hasError: false });
	}
	componentDidCatch(error) {
		const name = this.props.componentName ?? "Unknown";
		this.props.onError?.({
			source: "runtime",
			code: "render-error",
			component: name,
			message: `Component ${name} render failed: ${error.message}`
		});
	}
	render() {
		if (this.state.hasError) return this.lastValidChildren;
		return this.props.children;
	}
};
/**
* Recursively renders a parsed value (element, array, primitive)
* into React nodes.
*/
function renderDeep(value) {
	if (value == null) return null;
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map((v, i) => /* @__PURE__ */ jsx(Fragment, { children: renderDeep(v) }, i));
	if (typeof value === "object" && value !== null) {
		const obj = value;
		if (obj.type === "element") return /* @__PURE__ */ jsx(RenderNode, { node: obj });
	}
	return null;
}
/**
* Renders a single ElementNode.
*/
function RenderNode({ node }) {
	const { library, reportError } = useOpenUI();
	const Comp = library.components[node.typeName]?.component;
	if (!Comp) return null;
	return /* @__PURE__ */ jsx(ElementErrorBoundary, {
		componentName: node.typeName,
		onError: reportError,
		children: /* @__PURE__ */ jsx(RenderNodeInner, {
			el: node,
			Comp
		})
	});
}
/**
* Renders a resolved element using its renderer.
* Props are already evaluated by evaluate-tree — no AST awareness needed.
*/
function RenderNodeInner({ el, Comp }) {
	const renderNode = useRenderNode();
	return /* @__PURE__ */ jsx(Comp, {
		props: el.props,
		renderNode,
		statementId: el.statementId
	});
}
let loadingStyleInjected = false;
function ensureLoadingStyle() {
	if (loadingStyleInjected || typeof document === "undefined") return;
	loadingStyleInjected = true;
	const style = document.createElement("style");
	style.textContent = `@keyframes openui-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`;
	document.head.appendChild(style);
}
const DefaultQueryLoader = () => /* @__PURE__ */ jsx("div", {
	role: "status",
	"aria-label": "Loading data",
	style: {
		position: "absolute",
		top: 8,
		right: 8,
		width: 16,
		height: 16,
		border: "2px solid #e5e7eb",
		borderTopColor: "#3b82f6",
		borderRadius: "50%",
		animation: "openui-spin 0.6s linear infinite",
		zIndex: 10
	}
});
function RendererRoot({ response, library, isStreaming = false, onAction, onStateUpdate, initialState, onParseResult, toolProvider, queryLoader, children, onError, publishObservability }) {
	useInsertionEffect(() => {
		ensureLoadingStyle();
	}, []);
	const onParseResultRef = useRef(onParseResult);
	onParseResultRef.current = onParseResult;
	const toolProviderInputRef = useRef(toolProvider);
	toolProviderInputRef.current = toolProvider;
	const stableToolProvider = useRef({ async callTool(toolName, args) {
		const current = toolProviderInputRef.current ?? null;
		if (current == null) throw new Error("[openui] toolProvider is null");
		if (typeof current.callTool === "function") return extractToolResult(await current.callTool({
			name: toolName,
			arguments: args
		}));
		const map = current;
		const fn = map[toolName];
		if (!fn) throw new ToolNotFoundError(toolName, Object.keys(map));
		return fn(args);
	} });
	const { result, parseResult, contextValue, isQueryLoading, queryErrors, retryQueries } = useOpenUIState({
		response,
		library,
		isStreaming,
		onAction,
		onStateUpdate,
		initialState,
		toolProvider: toolProvider != null ? stableToolProvider.current : null,
		onError,
		publishObservability
	}, renderDeep);
	useEffect(() => {
		onParseResultRef.current?.(parseResult);
	}, [parseResult]);
	const query = useMemo(() => ({
		isLoading: isQueryLoading,
		errors: queryErrors,
		retry: retryQueries,
		isRetrying: queryErrors.length > 0 && isQueryLoading
	}), [
		isQueryLoading,
		queryErrors,
		retryQueries
	]);
	const value = {
		root: result?.root ?? null,
		query,
		queryLoader
	};
	return /* @__PURE__ */ jsx(OpenUIContext.Provider, {
		value: contextValue,
		children: /* @__PURE__ */ jsx(RendererContext.Provider, {
			value,
			children
		})
	});
}
const RendererContext = createContext(null);
function useRendererContext() {
	const context = useContext(RendererContext);
	if (!context) throw new Error("Renderer slots must be used within Renderer.Root or Renderer.");
	return context;
}
/** Access query loading, failures, and retry within the nearest Renderer root. */
function useRendererQuery() {
	return useRendererContext().query;
}
/** Displays generated content, preserving mounted components while queries load or fail. */
function RendererContent({ style, hidden, ...props }) {
	const { root, query } = useRendererContext();
	if (!root) return null;
	return /* @__PURE__ */ jsx("div", {
		...props,
		"aria-busy": query.isLoading,
		hidden: hidden || query.errors.length > 0,
		style: {
			opacity: query.isLoading ? .7 : 1,
			transition: "opacity 0.2s ease",
			...style
		},
		children: /* @__PURE__ */ jsx(RenderNode, { node: root })
	});
}
/** Shows query loading feedback, except while a query failure is being displayed. */
function RendererQueryLoading({ children }) {
	const { query: { isLoading, errors }, queryLoader } = useRendererContext();
	if (!isLoading || errors.length > 0) return null;
	return /* @__PURE__ */ jsx(Fragment$1, { children: children === void 0 ? queryLoader ?? /* @__PURE__ */ jsx(DefaultQueryLoader, {}) : children });
}
/** Shows the supplied content when queries fail; renders nothing without children. */
function RendererQueryError({ children }) {
	const { errors } = useRendererQuery();
	if (errors.length === 0) return null;
	return /* @__PURE__ */ jsx(Fragment$1, { children });
}
function RendererRetry({ children, onClick, disabled, ...props }) {
	const { retry, isLoading, errors } = useRendererQuery();
	const isDisabled = disabled || isLoading || errors.length === 0;
	return /* @__PURE__ */ jsx("button", {
		type: "button",
		...props,
		disabled: isDisabled,
		onClick: (event) => {
			if (isDisabled || event.defaultPrevented) return;
			onClick?.(event);
			if (!event.defaultPrevented) retry();
		},
		children
	});
}
function DefaultRendererContent() {
	const { root, query, queryLoader } = useRendererContext();
	if (!root) return null;
	return /* @__PURE__ */ jsxs("div", {
		"aria-busy": query.isLoading,
		style: { position: "relative" },
		children: [query.isLoading && (queryLoader ?? /* @__PURE__ */ jsx(DefaultQueryLoader, {})), /* @__PURE__ */ jsx("div", {
			style: {
				opacity: query.isLoading ? .7 : 1,
				transition: "opacity 0.2s ease"
			},
			children: /* @__PURE__ */ jsx(RenderNode, { node: root })
		})]
	});
}
function DefaultRenderer({ children, ...props }) {
	return /* @__PURE__ */ jsx(RendererRoot, {
		...props,
		children: children === void 0 ? /* @__PURE__ */ jsx(DefaultRendererContent, {}) : children
	});
}
/** Render with the default presentation, or compose slots around one shared runtime. */
const Renderer = Object.assign(DefaultRenderer, {
	Root: RendererRoot,
	Content: RendererContent,
	QueryLoading: RendererQueryLoading,
	QueryError: RendererQueryError,
	Retry: RendererRetry
});
//#endregion
//#region src/runtime/reactive.ts
/**
* Mark a schema prop as reactive so runtime evaluation can preserve $bindings.
*
* The widened return type carries the eventual value shape into helpers like
* `useStateField()`. The actual bound value is still resolved at render time.
*/
function reactive(schema) {
	markReactive(schema);
	return schema;
}
//#endregion
//#region src/hooks/useStateField.ts
function useStateField(name, value) {
	const ctx = useOpenUI();
	const formName = useFormName();
	return resolveStateField(name, value, ctx.store ?? null, ctx.evaluationContext ?? null, (fieldName) => ctx.getFieldValue(formName, fieldName), (fieldName, nextValue) => ctx.setFieldValue(formName, void 0, fieldName, nextValue));
}
//#endregion
//#region src/hooks/useFormValidation.ts
const FormValidationContext = createContext(null);
function useFormValidation() {
	return useContext(FormValidationContext);
}
function useCreateFormValidation() {
	const [errors, setErrors] = useState({});
	const errorsRef = useRef(errors);
	errorsRef.current = errors;
	const fieldsRef = useRef({});
	const getFieldError = useCallback((name) => errorsRef.current[name], []);
	const validateField = useCallback((name, value, rules) => {
		const error = validate(value, rules);
		setErrors((prev) => {
			if (prev[name] === error) return prev;
			return {
				...prev,
				[name]: error
			};
		});
		return !error;
	}, []);
	const registerField = useCallback((name, rules, getValue) => {
		fieldsRef.current[name] = {
			rules,
			getValue
		};
	}, []);
	const unregisterField = useCallback((name) => {
		delete fieldsRef.current[name];
	}, []);
	const validateForm = useCallback(() => {
		let allValid = true;
		const newErrors = {};
		for (const [name, reg] of Object.entries(fieldsRef.current)) {
			let value = reg.getValue();
			if (value != null && typeof value === "object" && "value" in value && "componentType" in value) value = value.value;
			const error = validate(value, reg.rules);
			newErrors[name] = error;
			if (error) allValid = false;
		}
		setErrors(newErrors);
		return allValid;
	}, []);
	const clearFieldError = useCallback((name) => {
		setErrors((prev) => {
			if (prev[name] === void 0) return prev;
			return {
				...prev,
				[name]: void 0
			};
		});
	}, []);
	return useMemo(() => ({
		errors,
		getFieldError,
		validateField,
		registerField,
		unregisterField,
		validateForm,
		clearFieldError
	}), [
		errors,
		getFieldError,
		validateField,
		registerField,
		unregisterField,
		validateForm,
		clearFieldError
	]);
}
//#endregion
//#region src/WithPreviewRenderer.tsx
const PreviewContext = createContext(null);
function usePreviewContext() {
	const context = useContext(PreviewContext);
	if (!context) throw new Error("Preview slots must be used within WithPreviewRenderer.Root or WithPreviewRenderer.");
	return context;
}
/** Read metadata and control the nearest preview. Available even while its content is closed. */
function useRendererPreview() {
	return usePreviewContext().state;
}
function PreviewRoot({ open: controlledOpen, defaultOpen = false, onOpenChange, onMetadata, children, ...rendererProps }) {
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const isOpen = controlledOpen ?? internalOpen;
	const isStreaming = rendererProps.isStreaming === true;
	const contentId = useId();
	const metadataName = useMemo(() => parseResponseBundle(rendererProps.response, isStreaming), [rendererProps.response, isStreaming]).metadata.name;
	const metadata = useMemo(() => metadataName === void 0 ? {} : { name: metadataName }, [metadataName]);
	const metadataCallback = useRef(onMetadata);
	metadataCallback.current = onMetadata;
	useEffect(() => {
		metadataCallback.current?.(metadata);
	}, [metadata]);
	const setOpen = useCallback((next) => {
		if (next === isOpen) return;
		if (controlledOpen === void 0) setInternalOpen(next);
		onOpenChange?.(next);
	}, [
		controlledOpen,
		isOpen,
		onOpenChange
	]);
	const open = useCallback(() => setOpen(true), [setOpen]);
	const close = useCallback(() => setOpen(false), [setOpen]);
	const state = useMemo(() => ({
		metadata,
		isOpen,
		isStreaming,
		contentId,
		open,
		close
	}), [
		metadata,
		isOpen,
		isStreaming,
		contentId,
		open,
		close
	]);
	return /* @__PURE__ */ jsx(PreviewContext.Provider, {
		value: {
			state,
			rendererProps
		},
		children
	});
}
function PreviewTrigger({ children, onClick, disabled, ...props }) {
	const { metadata, isOpen, isStreaming, contentId, open, close } = useRendererPreview();
	return /* @__PURE__ */ jsx("button", {
		type: "button",
		...props,
		disabled,
		"aria-expanded": isOpen,
		"aria-controls": isOpen ? contentId : void 0,
		onClick: (event) => {
			if (disabled || event.defaultPrevented) return;
			onClick?.(event);
			if (!event.defaultPrevented) (isOpen ? close : open)();
		},
		children: children === void 0 ? `${metadata.name || "Untitled artifact"}${isStreaming ? " (generating…)" : ""}` : children
	});
}
function PreviewClose({ children, onClick, disabled, ...props }) {
	const { metadata, close } = useRendererPreview();
	return /* @__PURE__ */ jsx("button", {
		type: "button",
		...props,
		disabled,
		onClick: (event) => {
			if (disabled || event.defaultPrevented) return;
			onClick?.(event);
			if (!event.defaultPrevented) close();
		},
		children: children === void 0 ? `Close ${metadata.name || "Untitled artifact"}` : children
	});
}
/** Mount one content slot per preview. Query hooks and Renderer slots belong inside it. */
function PreviewContent({ children, style, ...props }) {
	const { state, rendererProps } = usePreviewContext();
	if (!state.isOpen) return null;
	return /* @__PURE__ */ jsx("section", {
		"aria-label": state.metadata.name || "Untitled artifact",
		...props,
		id: state.contentId,
		style: {
			position: "relative",
			...style
		},
		children: children === void 0 ? /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx(PreviewClose, {}), /* @__PURE__ */ jsx(Renderer, { ...rendererProps })] }) : /* @__PURE__ */ jsx(Renderer, {
			...rendererProps,
			children
		})
	});
}
function DefaultWithPreviewRenderer({ children, ...props }) {
	return /* @__PURE__ */ jsx(PreviewRoot, {
		...props,
		children: children === void 0 ? /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx(PreviewTrigger, {}), /* @__PURE__ */ jsx(PreviewContent, {})] }) : children
	});
}
/** Adds a preview and expandable content. Use Renderer for a directly visible interface. */
const WithPreviewRenderer = Object.assign(DefaultWithPreviewRenderer, {
	Root: PreviewRoot,
	Trigger: PreviewTrigger,
	Content: PreviewContent,
	Close: PreviewClose
});
//#endregion
export { useRendererQuery as A, createLibrary$1 as B, useRendererPreview as C, useStateField as D, useFormValidation as E, useIsStreaming as F, useRenderNode as I, useSetDefaultValue as L, useFormName as M, useGetFieldValue as N, reactive as O, useIsQueryLoading as P, useSetFieldValue as R, WithPreviewRenderer as S, useCreateFormValidation as T, defineComponent$1 as V, parseRules as _, buildMessage as a, tagSchemaId as b, createStreamingParser$1 as c, extractToolResult$1 as d, generatePrompt as f, parseMessage$1 as g, mergeStatements as h, action as i, FormNameContext as j, Renderer as k, defineAction as l, isReactiveAssign as m, BuiltinActionType$1 as n, builtInValidators as o, generateSystemPrompt as p, ToolNotFoundError$1 as r, createParser as s, ACTION_STEPS$1 as t, defineFunction as u, parseStructuredRules as v, FormValidationContext as w, validate$1 as x, steps as y, useTriggerAction as z };

//# sourceMappingURL=exports-CLfR509v.mjs.map