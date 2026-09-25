import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import {completeTimelineBinding,hasVerifiedTimelinePrivateScope,sameTimelineBinding,sessionTimelineBinding,TIMELINE_ID_RE,validTimelineBinding} from "./session-timeline-contract.js";
export {sessionTimelineBinding};
import {ensureSessionTimelineTrust,sessionTimelineStatePaths} from "./session-timeline-auth.js";
import { consumeSessionTimelineInvocation, issueSessionTimelineInvocation } from "./session-timeline-invocation.js";
import {loadPrivateSessionTimelineEnrollment,resolvePrivateSessionTimelineEnrollment} from "./session-timeline-enrollment.js";
import { privateTimelinePrefixDigest } from "./session-timeline-enrollment-source.js";
import { timelineTransportEnrollmentMatches } from "./session-timeline-enrollment-transport.js";
import { sameTimelineTransportDigest, timelineTransportDigest } from "./session-timeline-transport.js";
import {matchesTimelineEvent,rankTimelineEvents,timelineQuery} from "./session-timeline-query.js";
import { timelineContinuationCapsule, timelineSearchResult } from "./session-timeline-results.js";
import { seekTimelineEvidence, verifyTimelineEvent } from "./session-timeline-search.js";
import { eventFromTimelineLine, extractTimelineTimestamp } from "./session-timeline-event-extract.js";
import { verifiedTimelineEventFromLine } from "./session-timeline-event-extract.js";
import { pathMatchesSource, sameSessionTimelineSourceLocation } from "./session-timeline-source.js";
import {captureTimelineAppend,MAX_BACKGROUND_CAPTURE_BYTES,readRange,sourceSnapshotDigest,unchangedHandle,validatedHandle} from "./session-timeline-source-open.js";
import { readTimelineState, saveTimelineState } from "./session-timeline-state.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";
import { priorTimelineHint, selectPriorTimelineSource, timelineSessionReference } from "./session-timeline-prior.js";
import { crossProviderTimelineEnabled } from "./session-timeline-provider.js";
export const SESSION_TIMELINE_SCHEMA = "agentspine.session-timeline/v1";
const STATE_SCHEMA = "agentspine.session-timeline-state/v1";
const AUTHORITY = "context-only";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCES = 64;
const MAX_EVENTS = 4096;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const ROOM_BYTES = 1024 * 1024;
const EVENT_OUTCOMES = new Set(["pass", "fail", "blocked", "timeout", "error", "skipped"]);
const EVENT_LABEL_RE = /^(?:suite-(?:0|[1-9]\d{0,3})|acceptance|audit|npm-check|ci|test)$/;
const EVENT_KEYS = new Set(["nativeMessageId", "id", "at", "offset", "bytes", "sha256", "kind", "outcome", "count", "testLabel", "nextStepSummary", "terms", "authority"]);
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function asDate(value) {const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.getTime()))throw new Error("session timeline timestamp is invalid");return date;}
function date(value) { return Number.isFinite(new Date(value).getTime()); }
function empty(root) { return { schema: STATE_SCHEMA, rootDigest: sessionTimelineRootDigest(root), sources: [], observers: [], authority: AUTHORITY }; }
function hasOnlyKeys(item, allowed) { return Object.keys(item).every((key) => allowed.has(key)); }
function validCount(item) {return item===null||Boolean(item&&typeof item==="object"&&Object.keys(item).length===2
&&Number.isSafeInteger(item.value)&&item.value>=0&&Number.isSafeInteger(item.total)&&item.total>0&&item.value<=item.total);}
function validEvent(item) {
const common = item && typeof item === "object" && hasOnlyKeys(item, EVENT_KEYS)
&& typeof item.id === "string" && TIMELINE_ID_RE.test(item.id) && date(item.at)
&& Number.isSafeInteger(item.offset) && item.offset >= 0 && Number.isSafeInteger(item.bytes) && item.bytes > 0
&& /^[a-f0-9]{64}$/.test(item.sha256 || "")
&& Array.isArray(item.terms) && item.terms.length <= 24 && item.terms.every((term) => /^[\p{L}\p{N}]{3,}$/u.test(term))
&& (item.nativeMessageId === undefined || typeof item.nativeMessageId === "string" && TIMELINE_ID_RE.test(item.nativeMessageId))
&& item.authority === AUTHORITY;
if (!common) return false;
if (item.kind === "user-message-candidate") return item.outcome === undefined
&& item.count === undefined && item.testLabel === undefined && item.nextStepSummary === undefined
&& item.terms.join(" ") === "user message";
if (item.kind === "objective-result") {
return EVENT_OUTCOMES.has(item.outcome) && validCount(item.count)
&& (item.testLabel === null || typeof item.testLabel === "string" && EVENT_LABEL_RE.test(item.testLabel))
&& item.nextStepSummary === undefined;
}
return item.kind === "explicit-next-step-correction" && item.outcome === undefined
&& item.count === undefined && item.testLabel === undefined
&& (item.nextStepSummary === undefined || typeof item.nextStepSummary === "string"
&& Boolean(item.nextStepSummary.trim()) && item.nextStepSummary.length <= 500);
}
function validSource(item) {
return item && validTimelineBinding(item.binding) && typeof item.path === "string" && isAbsolute(item.path)
&& item.path.length > 0 && item.path.length <= 4096 && typeof item.profileRoot === "string" && isAbsolute(item.profileRoot)
&& item.profileRoot.length > 0 && item.profileRoot.length <= 4096 && typeof item.projectsRoot === "string" && isAbsolute(item.projectsRoot)
&& item.projectsRoot.length > 0 && item.projectsRoot.length <= 4096 && item.pathDigest === digest(item.path)
&& typeof item.identity === "string" && item.identity.length <= 256
&& /^[0-9]+$/.test(item.mtimeNs || "") && /^[0-9]+$/.test(item.ctimeNs || "")
&& Number.isInteger(item.indexedBytes) && item.indexedBytes >= 0 && Number.isInteger(item.size) && item.size >= 0
&& item.indexedBytes <= item.size && Array.isArray(item.events) && item.events.length <= MAX_EVENTS
&& item.events.every((event) => validEvent(event) && event.bytes <= MAX_LINE_BYTES && event.offset + event.bytes <= item.size)
&& (item.lessonDigest === null || /^[a-f0-9]{64}$/.test(item.lessonDigest || ""))
&& (item.snapshotDigest === undefined || item.snapshotDigest === null || /^[a-f0-9]{64}$/.test(item.snapshotDigest))
&& date(item.updatedAt) && item.authority === AUTHORITY;
}
function validObserver(item){return item&&/^[a-f0-9]{64}$/.test(item.bindingDigest||"")
&&/^[A-Za-z0-9._:-]{1,256}$/.test(item.model||"")&&date(item.updatedAt)
&&Array.isArray(item.prompts)&&item.prompts.length<=32
&&item.prompts.every(value=>/^[a-f0-9]{64}$/.test(value))&&item.authority===AUTHORITY;}
function validate(value, root) {
if (!value || value.schema !== STATE_SCHEMA || value.rootDigest !== sessionTimelineRootDigest(root) || value.authority !== AUTHORITY
|| !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES || value.sources.some((item) => !validSource(item))
||value.observers!==undefined&&(!Array.isArray(value.observers)||value.observers.length>MAX_SOURCES||value.observers.some(item=>!validObserver(item)))) {
throw new Error("session timeline state is invalid");
}
return value;
}
function paths(root) {return sessionTimelineStatePaths(root);}
function readState(path,root,assertStable) {return readTimelineState({path,root,maximumBytes:MAX_STATE_BYTES,empty,validate,assertStable});}
function saveState(state,path,assertOwned,root,assertStable) {return saveTimelineState({state,path,root,maximumBytes:MAX_STATE_BYTES,assertOwned,assertStable});}
function status(value, extra = {}) { return { schema: SESSION_TIMELINE_SCHEMA, ...value, ...extra, authority: AUTHORITY }; }
function unavailable(reason) { return status({ status: "unavailable", reason }); }
function blocked(reason) { return { blocked: true, reason, authority: AUTHORITY }; }
function hasExactPrivateTimelineScope(scope) { return scope?.groupId === null; }
function sourceFor(state, scope) { return state.sources.find((item) => sameTimelineBinding(item.binding, scope)) || null; }
function observerBindingDigest(host,sessionId,scope){const binding=sessionTimelineBinding({host,sessionId,scope});
return ["claude","codex"].includes(host)&&completeTimelineBinding(binding)?digest(JSON.stringify(binding)):null;}
async function mutateObserver(root,bindingDigest,task){try{await ensureSessionTimelineTrust({create:true});const names=await paths(root);
return await withOwnedFileLock(names.lock,async({assertOwned})=>{const state=await readState(names.path,root,names.assertStable);
state.observers||=[];const result=task(state.observers.find(item=>item.bindingDigest===bindingDigest)||null,state);
if(result.save)await saveState(state,names.path,assertOwned,root,names.assertStable);return result;},{assertPath:names.assertStable});
}catch{return {status:"unavailable"};}}
export async function recordClaudeObserverModel({root,sessionId,scope,model,now=new Date()}){const bindingDigest=observerBindingDigest("claude",sessionId,scope),at=asDate(now).toISOString();
if(!bindingDigest||!/^[-A-Za-z0-9._:]{1,256}$/.test(model||""))return {status:"unavailable"};
return mutateObserver(root,bindingDigest,(current,state)=>{if(current){current.model=model;current.updatedAt=at;}
else{state.observers.unshift({bindingDigest,model,updatedAt:at,prompts:[],authority:AUTHORITY});state.observers=state.observers.slice(0,MAX_SOURCES);}
return {status:"recorded",save:true};});}
export async function claimClaudeObserverPrompt({root,sessionId,scope,promptId,now=new Date()}){const bindingDigest=observerBindingDigest("claude",sessionId,scope),prompt=digest(promptId||"");if(!bindingDigest||typeof promptId!=="string"||promptId.length>256)return {status:"unavailable"};
return mutateObserver(root,bindingDigest,(current)=>{if(!current)return {status:"unavailable"};if(current.prompts.includes(prompt))return {status:"duplicate"};current.prompts.push(prompt);current.prompts=current.prompts.slice(-32);
current.updatedAt=asDate(now).toISOString();return {status:"claimed",model:current.model,save:true};});}
export async function claimCodexObserverTurn({root,sessionId,scope,turnId,model,now=new Date()}){const bindingDigest=observerBindingDigest("codex",sessionId,scope),prompt=digest(turnId||"");if(!bindingDigest||typeof turnId!=="string"||turnId.length>256||!/^[-A-Za-z0-9._:]{1,256}$/.test(model||""))return {status:"unavailable"};
return mutateObserver(root,bindingDigest,(current,state)=>{if(!current){current={bindingDigest,model,prompts:[],authority:AUTHORITY};state.observers=[current,...state.observers].slice(0,MAX_SOURCES);}if(current.prompts.includes(prompt))return {status:"duplicate"};current.model=model;current.prompts.push(prompt);current.prompts=current.prompts.slice(-32);current.updatedAt=asDate(now).toISOString();return {status:"claimed",model,save:true};});}
function sourceMetadata(source) {const sourceDigest = digest(`${source.pathDigest}\0${source.identity}\0${source.size}\0${source.mtimeNs}\0${source.ctimeNs}`);
return { sourceDigest, indexedBytes: source.indexedBytes, size: source.size, events: source.events.length,
rooms: Math.ceil(source.size / ROOM_BYTES), continuation: timelineContinuationCapsule({ source, sourceDigest, roomBytes: ROOM_BYTES, authority: AUTHORITY }) };}
function sameSourceSnapshot(left, right) {
return Boolean(left && right) && ["path", "profileRoot", "projectsRoot", "pathDigest", "identity", "size", "mtimeNs", "ctimeNs"]
.every((key) => left[key] === right[key]);
}
async function confirmedSourceEnrollment({ root, scoped, source, hostHome }) {
if (source.snapshotDigest) {
const loaded=await loadPrivateSessionTimelineEnrollment({root,host:scoped.host,sessionId:scoped.sessionId,
scope:{...scoped,currentTaskId:scoped.taskId,timelineVisibility:"private-verified"}});
if(loaded.status!=="loaded"||!sameTimelineBinding(loaded.record.binding,scoped)
||!sameSessionTimelineSourceLocation(loaded.record.source,source)||!await pathMatchesSource(source,hostHome)
||await privateTimelinePrefixDigest(source,loaded.record.source.prefixBytes)!==loaded.record.source.prefixDigest) return false;
return await sourceSnapshotDigest(source,hostHome)===source.snapshotDigest;
}
const enrollment = await resolvePrivateSessionTimelineEnrollment({ root, host: scoped.host, sessionId: scoped.sessionId,
transcriptPath: source.path, hostHome });
if (enrollment.status !== "enrolled" || !sameTimelineBinding(enrollment.binding, scoped)
|| !sameSourceSnapshot(enrollment.source, source)) return false;
return true;
}
async function bootstrapEnrollment(root, enrollmentDigest, environment) {
const loaded = await loadPrivateSessionTimelineEnrollment({ root, enrollmentDigest });
if (loaded.status !== "loaded") return null;
const transportDigest = timelineTransportDigest({
root: loaded.rootPath, binding: loaded.record.binding, environment
});
return transportDigest && sameTimelineTransportDigest(loaded.record.transportDigest, transportDigest) ? loaded : null;
}
function enrolledSource(record, previous, now) {
const source = record.source;
const unchanged = previous && sameSourceSnapshot(previous, source);
return {
binding: record.binding, path: source.path, profileRoot: source.profileRoot, projectsRoot: source.projectsRoot,
pathDigest: source.pathDigest, identity: source.identity, size: source.size, mtimeNs: source.mtimeNs,
ctimeNs: source.ctimeNs, lessonDigest: unchanged ? previous.lessonDigest : null,
snapshotDigest: unchanged ? previous.snapshotDigest ?? null : null,
indexedBytes: unchanged ? previous.indexedBytes : 0, events: unchanged ? previous.events : [],
updatedAt: asDate(now).toISOString(), authority: AUTHORITY
};
}
export async function bootstrapSessionTimelineEnrollment({
root, enrollmentDigest, environment = process.env, now = new Date()
}) {
const loaded=await bootstrapEnrollment(root,enrollmentDigest,environment);
if(!loaded)return unavailable("private-enrollment-unavailable");
const {rootPath,record}=loaded;
try{await ensureSessionTimelineTrust({create:true});}
catch{return unavailable("timeline-state-unavailable");}
try{
const names=await paths(rootPath);
await withOwnedFileLock(names.lock,async({assertOwned})=>{
const state=await readState(names.path,rootPath,names.assertStable);
const previous=sourceFor(state,record.binding);
if(previous&&sameSourceSnapshot(previous,record.source))return;
state.sources=state.sources.filter(item=>!sameTimelineBinding(item.binding,record.binding));
const s=enrolledSource(record,previous,now);
state.sources.unshift(s);state.sources=state.sources.slice(0,MAX_SOURCES);
if(s.size<=MAX_BACKGROUND_CAPTURE_BYTES)try{const r=await indexRange(s,0,s.size,s.profileRoot);
if(r.status==="indexed"){s.indexedBytes=r.next;s.events=mergeEvents(s.events,r.events);
s.snapshotDigest=await sourceSnapshotDigest(s,s.profileRoot);}}catch{}
await saveState(state,names.path,assertOwned,rootPath,names.assertStable);
},{assertPath:names.assertStable});
return status({status:"registered"});
}catch{return unavailable("timeline-state-unavailable");}
}
export async function sessionTimelineLifecycleHint({
root, host, sessionId, scope, environment = process.env
}) {
const scoped = sessionTimelineBinding({ host, sessionId, scope });
if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
if (!completeTimelineBinding(scoped)) return unavailable("timeline-scope-unverified");
const loaded = await loadPrivateSessionTimelineEnrollment({ root, host, sessionId, scope });
if (loaded.status !== "loaded") return unavailable("private-enrollment-unavailable");
const transportDigest = timelineTransportDigest({ root: loaded.rootPath, binding: loaded.record.binding, environment });
if (!transportDigest || !sameTimelineTransportDigest(loaded.record.transportDigest, transportDigest)) {
return unavailable("private-enrollment-unavailable");
}
try {
await ensureSessionTimelineTrust();
const names = await paths(loaded.rootPath);
const state = await readState(names.path, loaded.rootPath, names.assertStable);
const source = sourceFor(state, scoped);
if (!source) return unavailable("timeline-not-registered");
return status({ status: source.indexedBytes >= source.size ? "indexed" : "partial", ...sourceMetadata(source),
priorSessions: priorTimelineHint(state, scoped, (item) => sourceMetadata(item).sourceDigest,
{ includePriorProviders: crossProviderTimelineEnabled(environment) }),
freshness: "source-not-read", instruction: "Use session_timeline_index before search when this snapshot is partial." });
} catch {
return unavailable("timeline-state-unavailable");
}
}
export async function registerSessionTimelineSource() {
return unavailable("timeline-enrollment-bootstrap-required");
}
function mergeEvents(existing, additions) {
const byId = new Map(existing.map((item) => [item.id, item]));
for (const item of additions) byId.set(item.id, item);
const ordered = [...byId.values()].sort((left, right) => left.at.localeCompare(right.at) || left.offset - right.offset);
const evidence = ordered.filter((item) => item.kind !== "user-message-candidate").slice(-MAX_EVENTS);
const available = Math.min(256, MAX_EVENTS - evidence.length);
const feedback = ordered.filter((item) => item.kind === "user-message-candidate")
.slice(available ? -available : ordered.length);
return [...evidence, ...feedback].sort((left, right) => left.at.localeCompare(right.at) || left.offset - right.offset);
}
function parsedEvents(buffer, start, dropFirst = false, host = "claude", includeUserMessages = false) {
const result = [];
let index = 0;
while (index < buffer.byteLength) {
const newline = buffer.indexOf(0x0a, index);
const end = newline < 0 ? buffer.byteLength : newline + 1;
const line = buffer.subarray(index, end);
if (!(dropFirst && index === 0) && line.byteLength) {
const event = eventFromTimelineLine(line.toString("utf8"), start + index, AUTHORITY, host);
if (event && (includeUserMessages || event.kind !== "user-message-candidate")) {
if (event.kind === "explicit-next-step-correction") delete event.nextStepSummary;
delete event.sourceText;
result.push(event);
}
}
index = end;
}
return result;
}
async function indexRange(source, start, maximum, hostHome = null) {
const opened = await validatedHandle(source, hostHome);
if (opened.status !== "open") return opened;
try {
if (start >= opened.size) return { status: "indexed", next: opened.size, events: [], size: opened.size };
const bytes = await readRange(opened.handle, start, Math.min(maximum, opened.size - start));
const last = bytes.lastIndexOf(0x0a);
const completeAtEnd = start + bytes.byteLength === opened.size;
if (last < 0 && !completeAtEnd) return { status: "partial-line", events: [], size: opened.size };
const selected = last < 0 || completeAtEnd ? bytes : bytes.subarray(0, last + 1);
const before = start > 0 ? await readRange(opened.handle, start - 1, 1) : Buffer.alloc(0);
if (!await unchangedHandle(opened.handle, source, hostHome)) return { status: "unavailable", reason: "transcript-changed" };
return { status: "indexed", next: start + selected.byteLength,
events: parsedEvents(selected, start, start > 0 && before[0] !== 0x0a, source.binding.host,
Boolean(source.binding.portalRef && source.binding.threadRef)), size: opened.size };
} finally { await opened.handle.close(); }
}
async function mutateSource(root, scoped, task) {
try { await ensureSessionTimelineTrust(); }
catch { return unavailable("timeline-state-unavailable"); }
let names;
try { names = await paths(root); }
catch { return unavailable("timeline-state-unavailable"); }
return withOwnedFileLock(names.lock, async ({ assertOwned }) => {
let state;
try { state = await readState(names.path, root, names.assertStable); }
catch { return unavailable("timeline-state-unavailable"); }
const source = sourceFor(state, scoped);
if (!source) return unavailable("timeline-not-registered");
const result = await task(source);
if (result.status === "indexed") {
if(result.source)Object.assign(source,result.source);
source.size = result.size;
if (!result.preserveCursor) source.indexedBytes = Math.max(source.indexedBytes, result.next);
if(result.snapshotDigest)source.snapshotDigest=result.snapshotDigest;
source.events = mergeEvents(source.events, result.events); source.updatedAt = new Date().toISOString();
await saveState(state, names.path, assertOwned, root, names.assertStable);
}
return result.status === "indexed" ? status({ status: source.indexedBytes >= source.size ? "indexed"
: result.preserveCursor ? "fresh-tail" : "partial", ...sourceMetadata(source), added: result.events.length })
: status(result);
}, { assertPath: names.assertStable }).catch(() =>
unavailable("timeline-state-unavailable"));
}
export async function indexSessionTimeline({
root, host, sessionId, scope, maxBytes = 4 * 1024 * 1024,
invocationRequest = null, transportDigest = null, enrollmentDigest = null, hostHome = null
}) {
const scoped = sessionTimelineBinding({ host, sessionId, scope });
if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
if (!hasVerifiedTimelinePrivateScope(scope)) return unavailable("timeline-scope-unverified");
if (!completeTimelineBinding(scoped)) return unavailable("missing-session-scope");
if (!Number.isInteger(maxBytes) || maxBytes < 64 * 1024 || maxBytes > MAX_INDEX_BYTES) throw new Error("timeline index byte budget is invalid");
return mutateSource(root, scoped, async (source) => {
if (!await confirmedSourceEnrollment({ root, scoped, source, hostHome })) {
return { status: "unavailable", reason: "private-enrollment-unavailable" };
}
const sourceDigest = sourceMetadata(source).sourceDigest;
if (!invocationRequest || !await timelineTransportEnrollmentMatches({ root, binding: scoped, enrollmentDigest, transportDigest, hostHome })
|| !await consumeSessionTimelineInvocation({ root, tool: "index", binding: scoped, sourceDigest,
request: invocationRequest, transportDigest })) {
return { status: "unavailable", reason: "timeline-invocation-unavailable" };
}
return indexRange(source, source.indexedBytes, maxBytes, hostHome);
});
}
export async function refreshSessionTimelineTail() {
return unavailable("timeline-mcp-index-required");
}
export async function captureSessionTimelineTail({root,host,sessionId,scope,hostHome,maxBytes=MAX_BACKGROUND_CAPTURE_BYTES}){
const scoped=sessionTimelineBinding({host,sessionId,scope});
if(!hasExactPrivateTimelineScope(scope))return status({status:"group-suppressed"});
if(!completeTimelineBinding(scoped))return unavailable("timeline-scope-unverified");
if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BACKGROUND_CAPTURE_BYTES)throw new Error("background capture byte budget is invalid");
return mutateSource(root,scoped,async(source)=>{
return captureTimelineAppend({source,hostHome,maxBytes,parse:(bytes,start)=>parsedEvents(bytes,start,false,
source.binding.host,Boolean(source.binding.portalRef&&source.binding.threadRef))});
});
}
export async function sessionTimelineStatus({ root, host, sessionId, scope, environment = process.env }) {
if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
if (!hasVerifiedTimelinePrivateScope(scope)) return unavailable("timeline-scope-unverified");
return sessionTimelineLifecycleHint({ root, host, sessionId, scope, environment });
}
export async function authorizeSessionTimelineInvocation({
root, host, sessionId, scope, hostHome, tool, request, toolUseId, transportDigest, enrollmentDigest,
environment = process.env
}) {
const scoped = sessionTimelineBinding({ host, sessionId, scope });
if (!hasExactPrivateTimelineScope(scope) || !completeTimelineBinding(scoped) || !/^(index|search|capture)$/.test(tool || "")) return null;
if (!hasVerifiedTimelinePrivateScope(scope)) return null;
try {
await ensureSessionTimelineTrust();
const names = await paths(root);
const state = await readState(names.path, root, names.assertStable);
const currentSource = sourceFor(state, scoped);
if (!currentSource || !await pathMatchesSource(currentSource, hostHome)
|| !await confirmedSourceEnrollment({ root, scoped, source: currentSource, hostHome })) return null;
const includePriorProviders = request?.includePriorProviders === true;
if (includePriorProviders && (request?.includePriorSessions !== true || !crossProviderTimelineEnabled(environment))) return null;
const query = tool !== "index" ? timelineQuery({ at: request?.at, query: request?.query }) : null;
const source = request?.includePriorSessions === true
? selectPriorTimelineSource(state, scoped, { ...query, windowMs: request.windowSeconds * 1000,
includePriorProviders, sessionRef: request?.ref }) : currentSource;
const sourceHome = source?.binding.host === scoped.host ? hostHome : source?.profileRoot;
if (!source || !await pathMatchesSource(source, sourceHome)
|| !await confirmedSourceEnrollment({ root, scoped: source.binding, source, hostHome: sourceHome })) return null;
const sourceDigest = sourceMetadata(source).sourceDigest;
if (!await timelineTransportEnrollmentMatches({ root, binding: scoped, enrollmentDigest, transportDigest, hostHome })) return null;
await issueSessionTimelineInvocation({
root, tool, binding: scoped, sourceDigest, request, toolUseId, transportDigest
});
return { sourceDigest, authority: AUTHORITY };
} catch { return null; }
}
export async function reverifyTimelineFeedbackSources({
root, host, sessionId, scope, references, includePriorProviders = false,
environment = process.env, hostHome = null
}) {
const scoped = sessionTimelineBinding({ host, sessionId, scope });
if (!completeTimelineBinding(scoped) || !hasVerifiedTimelinePrivateScope(scope)
|| !Array.isArray(references) || !references.length || references.length > 3
|| includePriorProviders && !crossProviderTimelineEnabled(environment)) return null;
try {
await ensureSessionTimelineTrust();
const names = await paths(root);
const state = await readState(names.path, root, names.assertStable);
const fields = ["entityId", "userId", "tenantId", "projectId", "taskId", "groupId", "portalRef", "threadRef"];
const eligible = state.sources.filter((source) => fields.every((key) =>
(source.binding[key] ?? null) === (scoped[key] ?? null))
&& (includePriorProviders || source.binding.host === scoped.host));
const verified = [];
for (const reference of references) {
const source = eligible.find((item) => item.binding.host === reference.sourceProvider
&& timelineSessionReference(item.binding) === reference.sessionRef
&& sourceMetadata(item).sourceDigest === reference.sourceDigest);
const sourceHome = source?.binding.host === scoped.host ? hostHome : source?.profileRoot;
const indexed = source?.events.find((item) => item.id === reference.eventId
&& item.sha256 === reference.messageDigest && item.at === reference.observedAt);
if (!source || !indexed || reference.messageRef !== reference.eventId
|| !await confirmedSourceEnrollment({ root, scoped: source.binding, source, hostHome: sourceHome })) return null;
const opened = await validatedHandle(source, sourceHome);
if (opened.status !== "open") return null;
try {
const current = await verifyTimelineEvent({ handle: opened.handle, event: indexed, readRange, digest,
eventFromLine: (line, offset) => verifiedTimelineEventFromLine(line, offset, AUTHORITY, source.binding.host) });
if (!current || current.kind !== "user-message-candidate"
|| !await unchangedHandle(opened.handle, source, sourceHome)) return null;
verified.push({ ...current, sourceDigest: reference.sourceDigest,
sourceProvider: reference.sourceProvider, sessionRef: reference.sessionRef });
} finally { await opened.handle.close(); }
}
return verified;
} catch { return null; }
}
function searchResult(source, target, wanted, mode, events, extra = {}, includeMessageDigest = false) {
const index = sourceMetadata(source);
return timelineSearchResult({ sourceDigest: index.sourceDigest, sessionRef: timelineSessionReference(source.binding),
sourceProvider: source.binding.host, binding: source.binding, target, wanted, mode, events, index,
roomBytes: ROOM_BYTES, authority: AUTHORITY, extra, includeMessageDigest });
}
export async function searchSessionTimeline({
root, host, sessionId, scope, at, query, windowSeconds = undefined,
includePriorSessions = false, includePriorProviders = false, environment = process.env,
invocationRequest = null, invocationTool = "search", transportDigest = null, enrollmentDigest = null, hostHome = null
}) {
const scoped = sessionTimelineBinding({ host, sessionId, scope });
if (!hasExactPrivateTimelineScope(scope) || !hasVerifiedTimelinePrivateScope(scope) || !completeTimelineBinding(scoped)) {
return blocked("session timeline scope is unavailable");
}
const { target, wanted } = timelineQuery({ at, query });
const boundedWindowSeconds = windowSeconds === undefined ? 0 : windowSeconds;
if (!Number.isInteger(boundedWindowSeconds) || boundedWindowSeconds < 0 || boundedWindowSeconds > 900) {
throw new Error("timeline window is invalid");
}
if (typeof includePriorSessions !== "boolean") throw new Error("prior session selection is invalid");
if (typeof includePriorProviders !== "boolean") throw new Error("prior provider selection is invalid");
if (includePriorProviders && (!includePriorSessions || !crossProviderTimelineEnabled(environment))) {
return blocked("cross-provider timeline recall is unavailable");
}
try { await ensureSessionTimelineTrust(); }
catch { return blocked("session timeline is unavailable"); }
let names; let state;
try {
names = await paths(root);
state = await readState(names.path, root, names.assertStable);
}
catch { return blocked("session timeline is unavailable"); }
const currentSource = sourceFor(state, scoped);
if (!currentSource) return blocked("session timeline is unavailable");
if (!await confirmedSourceEnrollment({ root, scoped, source: currentSource, hostHome })) {
return blocked("session timeline is unavailable");
}
const source=includePriorSessions
?selectPriorTimelineSource(state,scoped,{target,wanted,windowMs:boundedWindowSeconds*1000,
includePriorProviders,sessionRef:invocationRequest?.ref})
: currentSource;
const sourceHome=source?.binding.host===scoped.host?hostHome:source?.profileRoot;
if(!source||!await pathMatchesSource(source,sourceHome)
||!await confirmedSourceEnrollment({root,scoped:source.binding,source,hostHome:sourceHome})) {
return blocked("session timeline is unavailable");
}
const sourceDigest=sourceMetadata(source).sourceDigest;
const detailEventId=invocationRequest?.detailEventId;
if (detailEventId && (invocationTool!=="search" || invocationRequest.sourceDigest!==sourceDigest
|| invocationRequest.ref!==timelineSessionReference(source.binding)
|| !/^timeline-event:[a-f0-9]{32}$/.test(detailEventId))) {
return blocked("timeline detail source is unavailable");
}
if(!/^(search|capture)$/.test(invocationTool)||!invocationRequest
||!await timelineTransportEnrollmentMatches({root,binding:scoped,enrollmentDigest,transportDigest,hostHome})
||!await consumeSessionTimelineInvocation({root,tool:invocationTool,binding:scoped,sourceDigest,
request:invocationRequest,transportDigest})) {
return blocked("session timeline invocation is unavailable");
}
const matchAt=invocationRequest?.ref&&target&&query==="user message"?null:target;
const indexed=rankTimelineEvents(source.events
.filter(event=>(!detailEventId||event.id===detailEventId)
&&matchesTimelineEvent(event,wanted,matchAt,boundedWindowSeconds*1000)),wanted,target).slice(0,8);
if (detailEventId && (!indexed.length || indexed[0].kind!=="objective-result")) {
return blocked("timeline detail event is unavailable");
}
if (includePriorSessions && !indexed.length) {
return searchResult(source, target, wanted, "prior-index", [], { priorSession: true,
priorProvider: source.binding.host !== scoped.host }, invocationTool === "capture");
}
const opened = await validatedHandle(source, sourceHome);
if (opened.status !== "open") return blocked(opened.reason);
try {
const verified = [];
for (const event of indexed) {
const current = await verifyTimelineEvent({ handle: opened.handle, event, readRange, digest,
eventFromLine: (line, offset) => verifiedTimelineEventFromLine(line, offset, AUTHORITY,
source.binding.host, Boolean(detailEventId)) });
if(!current||!matchesTimelineEvent(current,wanted,matchAt,boundedWindowSeconds*1000)) return blocked("timeline evidence changed");
verified.push(current);
}
if (verified.length) {
if (!await unchangedHandle(opened.handle, source, sourceHome)) return blocked("transcript-changed");
return searchResult(source, target, wanted, includePriorSessions ? "prior-verified-index" : "verified-index", verified,
includePriorSessions ? { priorSession: true, priorProvider: source.binding.host !== scoped.host } : {},
invocationTool === "capture" || Boolean(detailEventId));
}
if (!target) return searchResult(source, target, wanted, "verified-index", [], {}, invocationTool === "capture");
const sought = await seekTimelineEvidence({ handle: opened.handle, size: opened.size, target, wanted,
windowMs: boundedWindowSeconds * 1000, readRange,
eventFromLine: (line, offset) => verifiedTimelineEventFromLine(line, offset, AUTHORITY, source.binding.host),
extractTimestamp: extractTimelineTimestamp,
matches: matchesTimelineEvent, rank: rankTimelineEvents });
if (sought.status === "searched") {
if (!await unchangedHandle(opened.handle, source, sourceHome)) return blocked("transcript-changed");
return searchResult(source, target, wanted, "timestamp-seek", sought.events,
{ budgetExhausted: sought.budgetExhausted }, invocationTool === "capture");
}
if (sought.status === "out-of-range") {
return searchResult(source, target, wanted, "timestamp-seek", [], {}, invocationTool === "capture");
}
return blocked(sought.reason);
} finally { await opened.handle.close(); }
}
