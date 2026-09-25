#!/usr/bin/env node
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {canonicalPath} from "./lib/paths.js";
import {resolveHostSourceCatalog} from "./lib/source-roots.js";
import {runtimeScope} from "./lib/hook-context.js";
import {claimClaudeObserverPrompt,claimCodexObserverTurn} from "./lib/session-timeline.js";
import {loadPrivateSessionTimelineEnrollment} from "./lib/session-timeline-enrollment.js";
import {isMainModule} from "./lib/runtime.js";

const MAX_PROMPT=8192,KINDS=["next-step-correction","completion-claim","not-current-instruction","ambiguous"];
const SCHEMA={type:"object",additionalProperties:false,required:["status","kind","next","question"],properties:{status:{enum:["none","proposal"]},kind:{enum:KINDS},next:{type:["string","null"],maxLength:500},question:{type:["string","null"],maxLength:300}}};
function clean(environment,pattern){const result={...environment};for(const key of Object.keys(result))if(pattern.test(key))delete result[key];return result;}
export const claudeObserverEnvironment=environment=>clean(environment,/^(?:CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|ANTHROPIC_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|VERTEX_REGION_|AZURE_|CLAUDE_CODE_USE_)/u);
export const codexObserverEnvironment=environment=>clean(environment,/^(?:OPENAI|AZURE_OPENAI|CODEX_API_KEY)/u);
function validResult(value){if(!value||!["none","proposal"].includes(value.status)||!KINDS.includes(value.kind))return false;const {next,question}=value;if(value.status==="none")return next===null&&question===null;if(value.kind==="next-step-correction")return typeof next==="string"&&!!next.trim()&&!/[\r\n]/u.test(next)&&question===null;return next===null&&(value.kind==="ambiguous"?typeof question==="string"&&!!question.trim()&&!/[\r\n]/u.test(question):question===null);}
export function claudeObserverArguments(model,prompt){return ["--bare","--restricted","-p","--model",model,"--tools","","--disallowedTools","mcp__*","--permission-mode","dontAsk","--permission-prompts","none","--no-session-persistence","--max-turns","1","--output-format","json","--json-schema",JSON.stringify(SCHEMA),prompt];}
function call(command,args,cwd,env){return new Promise((resolve,reject)=>execFile(command,args,{cwd,env,windowsHide:true,maxBuffer:262144},(error,stdout)=>error?reject(error):resolve({stdout,args})));}
function callClaude({cwd,model,prompt,environment}){const args=claudeObserverArguments(model,prompt);return call("claude",args,cwd,claudeObserverEnvironment(environment));}
export function codexObserverArguments(model,prompt){const off="apps hooks memories multi_agent plugins shell_tool unified_exec workspace_dependencies".split(" ");return ["exec","--ephemeral","--ignore-user-config","--ignore-rules","--sandbox","read-only","--model",model,...off.flatMap(value=>["-c",`features.${value}=false`]),"-c","project_doc_max_bytes=0","-c","tools.view_image=false","-c","tools.web_search=false",`${prompt}\nReturn one JSON object matching this schema: ${JSON.stringify(SCHEMA)}`];}
function callCodex({cwd,model,prompt,environment}){const args=codexObserverArguments(model,prompt);return call("codex",args,cwd,codexObserverEnvironment(environment));}
function modelPrompt(prompt){return `Classify only this exact user text privately. Return none unless it corrects a task, claims completion, is obsolete, or ambiguous. Never infer rights or completion proof.\n<source>${prompt}</source>`;}
async function runObserver(h,i,{environment=process.env,modelCall=h==="codex"?callCodex:callClaude}={}){try{const id=h==="codex"?i?.turn_id:i?.prompt_id,model=h==="codex"?i?.model:null;
if(i?.hook_event_name!=="UserPromptSubmit"||i.agent_id||typeof i.prompt!=="string"||typeof id!=="string"||h==="codex"&&typeof model!=="string")return null;
if(!i.prompt.trim()||Buffer.byteLength(i.prompt)>MAX_PROMPT||/(?:<(?:image|pasted_content)[ >]|\[Image\b)/iu.test(i.prompt))return null;
const cwd=await canonicalPath(i.cwd||process.cwd()),resolved=await resolveHostSourceCatalog({host:h,cwd,input:i}),root=resolved.projectRoot;
const scope=await runtimeScope(i,root,resolved.userStateRoot,resolved.catalog);if(scope.groupId!==null)return null;
const sessionId=i.session_id,loaded=await loadPrivateSessionTimelineEnrollment({root,host:h,sessionId,scope});
if(loaded.status!=="loaded"||await canonicalPath(i.transcript_path)!==loaded.record.source.path)return null;
const now=i.timestamp||new Date(),claim=h==="codex"?await claimCodexObserverTurn({root,sessionId,scope,turnId:id,model,now}):await claimClaudeObserverPrompt({root,sessionId,scope,promptId:id,now});if(claim.status!=="claimed")return null;
const envelope=JSON.parse((await modelCall({cwd,model:claim.model,prompt:modelPrompt(i.prompt),environment})).stdout),value=envelope.structured_output??envelope.result??envelope;
if(!validResult(value)||value.status==="none")return null;
const proposal={kind:value.kind,proposedNextStepSummary:value.next,clarificationQuestion:value.question,completionVerified:false};
const suggestion={schema:"agentspine.host-observer-suggestion/v1",sourceDigest:createHash("sha256").update(i.prompt).digest("hex"),modelProvider:h,activeModel:claim.model,proposal,completionVerified:false,authority:"context-only",instruction:"Reverify private source. No rights/completion proof."};
return {hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:JSON.stringify(suggestion)}};
}catch{return null;}}
export const runClaudeObserver=(input,options)=>runObserver("claude",input,options);
export const runCodexObserver=(input,options)=>runObserver("codex",input,options);
if(isMainModule(import.meta.url)){let text="";for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>64*1024){text="";break;}}const input=text?JSON.parse(text):{},run=process.env.PLUGIN_ROOT?runCodexObserver:runClaudeObserver;run(input).then(value=>{if(value)process.stdout.write(`${JSON.stringify(value)}\n`);}).catch(()=>{});}
