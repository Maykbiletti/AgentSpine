import {createHash} from "node:crypto";
import {authorizeSessionTimelineInvocation,searchSessionTimeline} from "./session-timeline.js";
import {resolvePrivateSessionTimelineEnrollment} from "./session-timeline-enrollment.js";
import {rankTimelineEvents,timelineTerms} from "./session-timeline-query.js";
import {timelineTransportDigest} from "./session-timeline-transport.js";

const SCHEMA="agentspine.pre-answer-timeline-recall/v1", AUTHORITY="context-only";
const hash=value=>createHash("sha256").update(value).digest("hex");
const unavailable=(reason,s=0,o=0)=>({schema:SCHEMA,status:"unavailable",reason,awaited:true,
  sourceReads:s,events:[],omittedEvents:o,completionVerified:false,authority:AUTHORITY});

function exactScope(binding,visibility){
  const {host,sessionId,taskId,...continuity}=binding;
  return {...continuity,groupId:null,currentTaskId:taskId,timelineVisibility:visibility};
}

function prefix(values){
  let value=values[0]||"";
  for (const item of values.slice(1)) while(value&&!item.startsWith(value)) value=value.slice(0,-1);
  return value;
}

function compact(events){
  const sources=[],indices=new Map(),messagePrefix=prefix(events.map(item=>item.messageRef)),
    timePrefix=prefix(events.map(item=>item.at));
  const rows=events.map(item=>{
    const key=`${item.sourceDigest}\0${item.sourceProvider}\0${item.sessionRef}`;
    let source=indices.get(key);
    if(source===undefined){source=sources.length;indices.set(key,source);
      sources.push({digest:item.sourceDigest,provider:item.sourceProvider,session:item.sessionRef});}
    const kind=item.kind === "objective-result" ? "result" : item.kind === "user-message-candidate" ? "user" : "correction";
    const value=kind === "result" ? [item.outcome,item.count?.value ?? null,item.count?.total ?? null,
      item.testLabel, item.excerpt] : kind === "correction" ? item.nextStepSummary : item.sourceText;
    return [source, item.messageRef.slice(messagePrefix.length), item.at.slice(timePrefix.length), kind, value];
  });
  const fields = ["source", "message", "at", "kind", "value"], prefixes = [messagePrefix, timePrefix];
  return sources.length === 1 ? { source: sources[0], prefixes, fields: fields.slice(1), events: rows.map((row) => row.slice(1)) }
    : { sources, prefixes, fields, events: rows };
}

async function lane({root,enrollment,hostHome,transport,turnId,name,query,ref,at,environment}){
  const {binding:b,enrollmentDigest:d,timelineVisibility:v}=enrollment,{host,...fields}=b,w=at?900:0;
  const scope = exactScope(b,v);
  const runtime = { root, host, sessionId:b.sessionId, scope, hostHome, environment };
  const request = { root, tool: "search", ...fields, groupId: null,
    timelineVisibility:v, enrollmentDigest:d, at:at||null, query, windowSeconds:w,
    includePriorSessions: true, includePriorProviders: false, ...(ref && { ref }) };
  const authorized = await authorizeSessionTimelineInvocation({ ...runtime, tool: "search", request,
    toolUseId: `automatic-pre-answer:${hash(`${turnId}\0${name}\0${d}`)}`,
    transportDigest: transport, enrollmentDigest:d });
  return authorized && searchSessionTimeline({ ...runtime, at, query, windowSeconds:w, includePriorSessions: true,
    includePriorProviders: false, invocationRequest: request, invocationTool: "search", transportDigest: transport,
    enrollmentDigest:d });
}

export async function automaticPreAnswerTimelineRecall({root,host,sessionId,scope,hostHome,eventId,
  turnId,prompt,environment=process.env}) {
  if(!scope||scope.groupId!==null||!scope.currentTaskId)return unavailable("private-task-scope-unavailable");
  let sourceReads=0;
  try {
    const enrollment=await resolvePrivateSessionTimelineEnrollment({root,host,sessionId,hostHome});
    if(enrollment.status!=="enrolled")return unavailable("private-enrollment-unavailable");
    const transport=timelineTransportDigest({root,binding:enrollment.binding,environment});
    if(!transport)return unavailable("timeline-transport-unavailable");
    const recallId=turnId||eventId||"turn",terms=timelineTerms(prompt);
    sourceReads++;
    const objective = await lane({ root, enrollment, hostHome, transport, turnId: recallId,
      name: "objective", query: ["objective result", ...terms].join(" ").slice(0,512), environment });
    if(!objective||objective.blocked)return unavailable("timeline-search-unavailable",sourceReads);
    const selected = rankTimelineEvents((objective.events || []).map((item) =>
      ({ ...item, terms: timelineTerms(item.excerpt) })), terms)[0];
    if(!selected)return timelineRecallNotFound(sourceReads);
    sourceReads++;
    const natural = await lane({ root, enrollment, hostHome, transport, turnId: recallId,
      name: "natural-feedback", query: "user message", ref: selected?.sessionRef, at:selected?.at, environment });
    if(!natural||natural.blocked)return unavailable("timeline-search-unavailable",sourceReads);
    const events = [...selected ? [selected] : [], ...(natural.events || []).slice(0, 3)];
    const unique = [...new Map(events.map((item) => [`${item.sourceDigest}\0${item.id}`, item])).values()];
    return { schema: SCHEMA, status: unique.length ? "recalled" : "not-found", awaited: true,
      sourceReads, ...compact(unique), omittedEvents:(objective.events?.length||0)
        +(natural.events?.length||0)-unique.length,completionVerified:false,
      naturalMessages: "unresolved", trust: "untrusted-session-history", authority: AUTHORITY };
  } catch { return unavailable("timeline-search-unavailable", sourceReads); }
}

const removeLast=r=>r.events.length>1?{...r,events:r.events.slice(0,-1),omittedEvents:r.omittedEvents+1}
  :unavailable("host-context-budget",r.sourceReads,r.omittedEvents+1);
export const timelineRecallNotFound=(s=0)=>({...unavailable(null,s),status:"not-found"});

export function fitTimelineRecallToHostContext({timeline,render,maximumBytes}) {
  let fitted=timeline,recall=timeline?.preAnswerRecall,context=render(fitted);
  while (Buffer.byteLength(context)>maximumBytes&&recall?.events?.length) {
    recall=removeLast(recall); fitted={...fitted,preAnswerRecall:recall}; context=render(fitted);
  }
  if (Buffer.byteLength(context)>maximumBytes&&recall) {
    fitted={...fitted,preAnswerRecall:unavailable("host-context-budget",recall.sourceReads,
      recall.omittedEvents)}; context=render(fitted);
  }
  if (Buffer.byteLength(context)>maximumBytes) {
    fitted={schema:"agentspine.session-timeline/v1",status:"unavailable",
      reason: "host-context-budget", authority: AUTHORITY }; context = render(fitted);
  }
  return {timeline:fitted,context};
}
