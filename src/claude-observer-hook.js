#!/usr/bin/env node
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {canonicalPath} from "./lib/paths.js";
import {resolveHostSourceCatalog} from "./lib/source-roots.js";
import {runtimeScope} from "./lib/hook-context.js";
import {claimClaudeObserverPrompt} from "./lib/session-timeline.js";
import {loadPrivateSessionTimelineEnrollment} from "./lib/session-timeline-enrollment.js";
import {isMainModule} from "./lib/runtime.js";

const MAX_PROMPT=8192,KINDS=["next-step-correction","completion-claim","not-current-instruction","ambiguous"];
const SCHEMA={type:"object",additionalProperties:false,required:["status","kind","next","question"],properties:{status:{enum:["none","proposal"]},kind:{enum:KINDS},next:{type:["string","null"],maxLength:500},question:{type:["string","null"],maxLength:300}}};
export function claudeObserverEnvironment(environment){const result={...environment};for(const key of Object.keys(result))if(["CLAUDECODE","CLAUDE_CODE_ENTRYPOINT"].includes(key)||/^(?:ANTHROPIC_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|VERTEX_REGION_|AZURE_|CLAUDE_CODE_USE_)/u.test(key))delete result[key];return result;}
function validResult(value){if(!value||!["none","proposal"].includes(value.status)||!KINDS.includes(value.kind))return false;const {next,question}=value;if(value.status==="none")return next===null&&question===null;if(value.kind==="next-step-correction")return typeof next==="string"&&!!next.trim()&&!/[\r\n]/u.test(next)&&question===null;return next===null&&(value.kind==="ambiguous"?typeof question==="string"&&!!question.trim()&&!/[\r\n]/u.test(question):question===null);}
export function claudeObserverArguments(model,prompt){return ["--bare","--restricted","-p","--model",model,"--tools","","--disallowedTools","mcp__*","--permission-mode","dontAsk","--permission-prompts","none","--no-session-persistence","--max-turns","1","--output-format","json","--json-schema",JSON.stringify(SCHEMA),prompt];}
function callClaude({cwd,model,prompt,environment}){const args=claudeObserverArguments(model,prompt);
return new Promise((resolve,reject)=>execFile("claude",args,{cwd,env:claudeObserverEnvironment(environment),windowsHide:true,maxBuffer:256*1024},(error,stdout)=>error?reject(error):resolve({stdout,args})));}
function modelPrompt(prompt){return `Privately classify only this exact user text. Return none unless it corrects a task, claims completion, is no longer current, or is ambiguous. Never infer rights or verified completion.\n<source>${prompt}</source>`;}
export async function runClaudeObserver(input,{environment=process.env,modelCall=callClaude}={}){
try{if(input?.hook_event_name!=="UserPromptSubmit"||input.agent_id||typeof input.prompt!=="string"||typeof input.prompt_id!=="string")return null;
if(!input.prompt.trim()||Buffer.byteLength(input.prompt)>MAX_PROMPT||/(?:<(?:image|pasted_content)[ >]|\[Image\b)/iu.test(input.prompt))return null;
const cwd=await canonicalPath(input.cwd||process.cwd()),resolved=await resolveHostSourceCatalog({host:"claude",cwd,input}),root=resolved.projectRoot;
const scope=await runtimeScope(input,root,resolved.userStateRoot,resolved.catalog);if(scope.groupId!==null)return null;
const sessionId=input.session_id,loaded=await loadPrivateSessionTimelineEnrollment({root,host:"claude",sessionId,scope});
if(loaded.status!=="loaded"||await canonicalPath(input.transcript_path)!==loaded.record.source.path)return null;
const claim=await claimClaudeObserverPrompt({root,sessionId,scope,promptId:input.prompt_id,now:input.timestamp||new Date()});if(claim.status!=="claimed")return null;
const response=await modelCall({cwd,model:claim.model,prompt:modelPrompt(input.prompt),environment});const envelope=JSON.parse(response.stdout),value=envelope.structured_output??envelope.result??envelope;
if(!validResult(value)||value.status==="none")return null;
const proposal={kind:value.kind,proposedNextStepSummary:value.next,clarificationQuestion:value.question,completionVerified:false};
const suggestion={schema:"agentspine.host-observer-suggestion/v1",sourceDigest:createHash("sha256").update(input.prompt).digest("hex"),modelProvider:"claude",activeModel:claim.model,proposal,completionVerified:false,authority:"context-only",instruction:"Suggestion only; reverify its private source. No rights or completion proof."};
return {hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:JSON.stringify(suggestion)}};
}catch{return null;}}
if(isMainModule(import.meta.url)){let text="";for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>64*1024){text="";break;}}runClaudeObserver(text?JSON.parse(text):{}).then(value=>{if(value)process.stdout.write(`${JSON.stringify(value)}\n`);}).catch(()=>{});}
