import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {codexObserverArguments,codexObserverEnvironment,runCodexObserver} from "../src/claude-observer-hook.js";
import {runHook} from "../src/hook.js";
import {claimClaudeObserverPrompt,claimCodexObserverTurn,consumeHostObserverSuggestion,recordClaudeObserverModel} from "../src/lib/session-timeline.js";
import {recordSessionTimelineHead,sealSessionTimelineState,sessionTimelineStatePaths} from "../src/lib/session-timeline-auth.js";
import {enrollTimelineWithHostReceipt} from "./session-timeline-invocation-support.js";

const hash=value=>createHash("sha256").update(value).digest("hex");
const scope={entityId:"agent:codex-observer",userId:"person:observer",tenantId:"tenant:observer",projectId:"project:observer",currentTaskId:"task:observer",goalId:null,goalStepId:null,groupId:null,timelineVisibility:"private-verified"};
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),"agentspine-codex-observer-")),state=join(workspace,"state"),profile=join(workspace,"codex"),root=join(workspace,"project"),directory=join(profile,"sessions","2026","09","25"),transcript=join(directory,"session-observer.jsonl");
await Promise.all([mkdir(state),mkdir(join(root,".git"),{recursive:true}),mkdir(directory,{recursive:true})]);await writeFile(transcript,`${JSON.stringify({timestamp:"2026-09-25T11:00:00.000Z",type:"session_meta",payload:{id:"session:observer",session_id:"session:observer",cwd:root,cli_version:"0.0.0",originator:"codex_cli_rs",source:"cli",history_mode:"legacy"}})}\n`);
const keys=["AGENTSPINE_STATE_DIR","CODEX_HOME","AGENTSPINE_TIMELINE_SESSION_CAPABILITY","AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID"],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,{AGENTSPINE_STATE_DIR:state,CODEX_HOME:profile,AGENTSPINE_TIMELINE_SESSION_CAPABILITY:`astc_${"a".repeat(43)}`,AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID:"session:observer"});
t.after(async()=>{for(const key of keys)prior[key]===undefined?delete process.env[key]:process.env[key]=prior[key];await rm(workspace,{recursive:true,force:true,maxRetries:3});});
assert.equal((await enrollTimelineWithHostReceipt({root,host:"codex",sessionId:"session:observer",scope,transcriptPath:transcript,hostHome:profile})).status,"enrolled");return {root,transcript,profile};}
function input(item,patch={}){return {hook_event_name:"UserPromptSubmit",cwd:item.root,session_id:"session:observer",turn_id:"turn:one",transcript_path:item.transcript,model:"gpt-6-sol",prompt:"Nein, erst die Prüfsumme prüfen.",timestamp:"2026-09-25T11:00:01.000Z",entity_id:scope.entityId,user_id:scope.userId,tenant_id:scope.tenantId,project_id:scope.projectId,task_id:scope.currentTaskId,group_id:null,...patch};}

test("Codex observer uses the active host model once and preserves its private source",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));let calls=0,seen;
const output=await runCodexObserver(input(item),{modelCall:async request=>{calls++;seen=request;return {stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Erst die Prüfsumme prüfen.",question:null})};}});assert.equal(calls,1);assert.equal(seen.model,"gpt-6-sol");assert.equal(seen.cwd.href,new URL("..",import.meta.url).href);assert.equal(hash(await readFile(item.transcript)),before);assert.equal(output,null);
assert.equal((await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:one",now:"2026-09-25T11:00:02.000Z"})).status,"none");const next=await runHook(input(item,{turn_id:"turn:two",event_id:"event:observer:next",prompt:"Bitte weiter.",timestamp:"2026-09-25T11:00:03.000Z"})),context=JSON.parse(next.context).sourceResolution.observer;assert.equal(context.status,"proposal");assert.equal(context.modelProvider,"codex");assert.equal(context.authority,"context-only");assert.equal(context.completionVerified,false);assert.equal(context.proposal.proposedNextStepSummary,null);assert.equal(context.sourceDigest,hash(input(item).prompt));
assert.equal((await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:three",now:"2026-09-25T11:00:04.000Z"})).status,"none");
assert.equal(hash(await readFile(item.transcript)),before,"next-turn source verification preserves transcript bytes");
assert.equal(await runCodexObserver(input(item),{modelCall:async()=>{throw new Error("duplicate invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:image",prompt:"<image source>"}),{modelCall:async()=>{throw new Error("image invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:foreign",group_id:"group:foreign"}),{modelCall:async()=>{throw new Error("foreign invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:failure"}),{modelCall:async()=>{throw new Error("provider unavailable");}}),null);});

test("Codex handoff rejects a replaced enrolled source without consuming it",async t=>{const item=await fixture(t),replacement=`${JSON.stringify({type:"session_meta",timestamp:"2026-09-25T11:00:02.000Z",payload:{id:"session:other"}})}\n`;await runCodexObserver(input(item),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});await rm(item.transcript);await writeFile(item.transcript,replacement);const delivered=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:two",now:"2026-09-25T11:00:03.000Z"});assert.equal(delivered.status,"unavailable");assert.equal(await readFile(item.transcript,"utf8"),replacement);});

test("Codex observer discards a result superseded by a newer native turn",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));let release,started;const ready=new Promise(resolve=>started=resolve),late=runCodexObserver(input(item),{modelCall:()=>new Promise(resolve=>{release=()=>resolve({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})});started();})});await ready;await runCodexObserver(input(item,{turn_id:"turn:newer",prompt:"Only the newer turn.",timestamp:"2026-09-25T11:00:02.000Z"}),{modelCall:async()=>({stdout:JSON.stringify({status:"none",kind:"ambiguous",next:null,question:null})})});release();await late;const handoff=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:later",now:"2026-09-25T11:00:04.000Z"});assert.equal(handoff.status,"delivered");assert.equal(handoff.suggestion.status,"none");assert.equal(hash(await readFile(item.transcript)),before);});

test("Codex observer rejects delayed and conflicting equal-time turn events",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript)),newPrompt="Newest verified correction.";let staleCalls=0;
await runCodexObserver(input(item,{turn_id:"turn:newest",prompt:newPrompt,timestamp:"2026-09-25T11:00:03.000Z"}),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});
for(const request of [input(item,{turn_id:"turn:older",prompt:"Delayed older correction.",timestamp:"2026-09-25T11:00:02.000Z"}),input(item,{turn_id:"turn:equal",prompt:"Conflicting equal-time correction.",timestamp:"2026-09-25T11:00:03.000Z"})])await runCodexObserver(request,{modelCall:async()=>{staleCalls++;throw new Error("stale turn invoked");}});
assert.equal(staleCalls,0);const handoff=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:handoff",now:"2026-09-25T11:00:04.000Z"});assert.equal(handoff.status,"delivered");assert.equal(handoff.suggestion.sourceDigest,hash(newPrompt));assert.equal(hash(await readFile(item.transcript)),before);
});

test("Codex retains the newest observation when the bounded handoff queue is full",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));let newestPrompt;
for(let index=1;index<=5;index++){newestPrompt=`Correction ${index}.`;await runCodexObserver(input(item,{turn_id:`turn:queue:${index}`,prompt:newestPrompt,timestamp:`2026-09-25T11:00:0${index}.000Z`}),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});}
const delivered=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:queue:handoff",now:"2026-09-25T11:00:06.000Z"});
assert.equal(delivered.status,"delivered");assert.equal(delivered.suggestion.sourceDigest,hash(newestPrompt));assert.equal(hash(await readFile(item.transcript)),before);
});

test("Codex child is ephemeral, tool-less and cannot inherit an API key",()=>{const args=codexObserverArguments("gpt-6-sol","PRIVATE_ARGV_SENTINEL");for(const flag of ["--ephemeral","--ignore-user-config","--ignore-rules","--skip-git-repo-check"])assert.ok(args.includes(flag));for(const value of ["features.apps=false","features.hooks=false","features.multi_agent=false","features.plugins=false","features.shell_tool=false","features.unified_exec=false","project_doc_max_bytes=0","tools.view_image=false","tools.web_search=false"])assert.ok(args.includes(value),value);assert.equal(args[args.indexOf("--sandbox")+1],"read-only");assert.equal(args[args.indexOf("--model")+1],"gpt-6-sol");assert.equal(args.at(-1),"-");assert.ok(!args.join("\0").includes("PRIVATE_ARGV_SENTINEL"));assert.deepEqual(codexObserverEnvironment({PATH:"safe",CODEX_HOME:"host-login",PLUGIN_ROOT:"private",agentspine_gateway_context:"private",BLUN_HOME:"private",OPENAI_API_KEY:"foreign",OpenAI_Api_Key:"foreign",OPENAI_BASE_URL:"foreign",AZURE_OPENAI_API_KEY:"foreign",aZuRe_OpEnAi_ApI_KeY:"foreign",CODEX_API_KEY:"foreign",CLAUDE_CODE_OAUTH_TOKEN:"foreign",Claude_Config_Dir:"foreign",ANTHROPIC_API_KEY:"foreign",AWS_SECRET_ACCESS_KEY:"foreign",Google_Application_Credentials:"foreign",NODE_OPTIONS:"--require=foreign.js",Node_Path:"foreign",LD_PRELOAD:"foreign.so",Dyld_Insert_Libraries:"foreign.dylib"}),{PATH:"safe",CODEX_HOME:"host-login"});});

test("Codex hands off one hidden no-observation acknowledgement on the next turn",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript)),request=input(item,{turn_id:"turn:none"});let calls=0;
await runCodexObserver(request,{modelCall:async()=>{calls++;return {stdout:JSON.stringify({status:"none",kind:"not-current-instruction",next:null,question:null})};}});
assert.equal((await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:request.turn_id,now:"2026-09-25T11:00:02.000Z"})).status,"none");
const next=await runHook(input(item,{turn_id:"turn:none-next",event_id:"event:none-next",prompt:"Continue.",timestamp:"2026-09-25T11:00:03.000Z"})),ack=JSON.parse(next.context).sourceResolution.observer;assert.equal(ack.schema,"agentspine.host-observer-ack/v1");assert.equal(ack.status,"none");assert.equal(ack.sourceDigest,hash(request.prompt));assert.equal(ack.authority,"context-only");assert.equal(ack.completionVerified,false);assert.equal("proposal" in ack,false);
assert.equal(await runCodexObserver(request,{modelCall:async()=>{calls++;throw new Error("duplicate invoked");}}),null);assert.equal(calls,1);assert.equal((await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:none-later",now:"2026-09-25T11:00:04.000Z"})).status,"none");assert.equal(hash(await readFile(item.transcript)),before);
});

test("Codex observer stays bound to the exact enrolled task scope",async t=>{const item=await fixture(t);let calls=0;
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:foreign-task",task_id:"task:other"}),{modelCall:async()=>{calls++;return {stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Wrong scope.",question:null})};}}),null);assert.equal(calls,0);
});

test("Codex observer rejects enrolled prefix mutation before invocation",async t=>{const item=await fixture(t),before=await readFile(item.transcript),changed=Buffer.from(before);changed[0]^=1;await writeFile(item.transcript,changed);let calls=0;
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:changed-source"}),{modelCall:async()=>{calls++;throw new Error("changed source invoked");}}),null);assert.equal(calls,0);assert.deepEqual(await readFile(item.transcript),changed);assert.notDeepEqual(changed,before);
});

test("Codex handoff rejects a suggestion from a superseded private enrollment",async t=>{const item=await fixture(t),original=await readFile(item.transcript),replacement=item.transcript.replace("session-observer.jsonl","session-replacement.jsonl"),replacementBytes=Buffer.from(`${JSON.stringify({timestamp:"2026-09-25T11:00:02.000Z",type:"session_meta",payload:{id:"session:observer",session_id:"session:observer",cwd:item.root,cli_version:"0.0.0",originator:"codex_cli_rs",source:"cli",history_mode:"legacy"}})}\n`);
await runCodexObserver(input(item,{turn_id:"turn:old-enrollment"}),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});
await writeFile(replacement,replacementBytes);const enrolled=await enrollTimelineWithHostReceipt({root:item.root,host:"codex",sessionId:"session:observer",scope,transcriptPath:replacement,hostHome:item.profile});assert.equal(enrolled.status,"enrolled");
const handoff=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,hostHome:item.profile,currentEventId:"turn:next",now:"2026-09-25T11:00:03.000Z"});assert.equal(handoff.status,"unavailable");
assert.deepEqual(await readFile(item.transcript),original);assert.deepEqual(await readFile(replacement),replacementBytes);
});

test("Codex stale enrollment cannot starve a newer verified handoff",async t=>{const item=await fixture(t),original=await readFile(item.transcript),replacement=item.transcript.replace("session-observer.jsonl","session-replacement.jsonl"),replacementBytes=Buffer.from(`${JSON.stringify({timestamp:"2026-09-25T11:00:02.000Z",type:"session_meta",payload:{id:"session:observer",session_id:"session:observer",cwd:item.root,cli_version:"0.0.0",originator:"codex_cli_rs",source:"cli",history_mode:"legacy"}})}\n`),newPrompt="New verified correction.";
await runCodexObserver(input(item,{turn_id:"turn:stale-enrollment"}),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});
await writeFile(replacement,replacementBytes);assert.equal((await enrollTimelineWithHostReceipt({root:item.root,host:"codex",sessionId:"session:observer",scope,transcriptPath:replacement,hostHome:item.profile})).status,"enrolled");
await runCodexObserver(input(item,{turn_id:"turn:new-enrollment",prompt:newPrompt,transcript_path:replacement,timestamp:"2026-09-25T11:00:03.000Z"}),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});
const next=await runHook(input(item,{turn_id:"turn:handoff",event_id:"event:handoff",prompt:"Continue.",transcript_path:replacement,timestamp:"2026-09-25T11:00:04.000Z"})),handoff=JSON.parse(next.context).sourceResolution.observer;assert.equal(handoff.status,"proposal");assert.equal(handoff.sourceDigest,hash(newPrompt));
assert.deepEqual(await readFile(item.transcript),original);assert.deepEqual(await readFile(replacement),replacementBytes);
});

test("Codex lifecycle cannot seed Claude observer model state",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript)),event=input(item,{hook_event_name:"SessionStart",host:"codex",model:"gpt-6-sol"});
delete event.turn_id;delete event.prompt;
await runHook(event);
await runHook({...event,hook_event_name:"PostModelSwitch",from_model:"gpt-6-sol",to_model:"gpt-6-astra",source:"command"});
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:"prompt:cross-provider"})).status,"unavailable");
assert.equal(hash(await readFile(item.transcript)),before);
});
test("Claude and Codex deduplicate identical native turn ids independently",async t=>{const item=await fixture(t),id="turn:same-provider-local-id";
assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope,model:"claude-sonnet-5"})).status,"recorded");
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:id})).status,"claimed");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:id,model:"gpt-6-sol"})).status,"claimed");
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:id})).status,"duplicate");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:id,model:"gpt-6-sol"})).status,"duplicate");});

test("Claude model state survives bounded task and goal turnover",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript)),id="turn:same-task-local-id",scopes=Array.from({length:70},(_,index)=>({...scope,currentTaskId:`task:${index}`,goalId:`goal:${index}`,goalStepId:`step:${index}`}));
assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope,model:"claude-sonnet-5"})).status,"recorded");
for(const current of scopes){const claimed=await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope:current,promptId:id});assert.equal(claimed.status,"claimed");assert.equal(claimed.model,"claude-sonnet-5");}
for(const current of scopes.slice(-63))assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope:current,promptId:id})).status,"duplicate");
assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope:scopes.at(-1),model:"claude-opus-5"})).status,"recorded");
for(const [index,current] of scopes.entries()){const claimed=await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope:current,promptId:`turn:after-switch:${index}`});assert.equal(claimed.status,"claimed");assert.equal(claimed.model,"claude-opus-5");}
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:foreign",scope,promptId:"turn:foreign-session"})).status,"unavailable");assert.equal(hash(await readFile(item.transcript)),before);});

test("observer state repairs only an authenticated interrupted forward commit",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript)),state=await sessionTimelineStatePaths(item.root),headPath=state.path.replace("session-timeline-state-","session-timeline-head-");
const legacy=JSON.parse(await readFile(state.path,"utf8"));delete legacy.generation;delete legacy.previousSignature;delete legacy.signature;await sealSessionTimelineState(legacy);await writeFile(state.path,`${JSON.stringify(legacy,null,2)}\n`,{mode:0o600});await recordSessionTimelineHead({root:item.root,stateSignature:legacy.signature});
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:"turn:recovery:one",model:"gpt-6-sol"})).status,"claimed");
const priorHead=await readFile(headPath),priorState=await readFile(state.path),upgraded=JSON.parse(priorState);assert.equal(upgraded.generation,1);assert.equal(upgraded.previousSignature,legacy.signature);
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:"turn:recovery:two",model:"gpt-6-sol"})).status,"claimed");
const successor=JSON.parse(await readFile(state.path,"utf8")),successorHead=JSON.parse(await readFile(headPath,"utf8")),previous=JSON.parse(priorHead);
assert.equal(successor.generation,previous.generation+1);assert.equal(successor.previousSignature,previous.stateSignature);assert.equal(successorHead.stateSignature,successor.signature);
await writeFile(headPath,priorHead,{mode:0o600});
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:"turn:recovery:three",model:"gpt-6-sol"})).status,"claimed");
const repairedState=JSON.parse(await readFile(state.path,"utf8")),repairedHead=JSON.parse(await readFile(headPath,"utf8"));
assert.equal(repairedState.generation,successor.generation+1);assert.equal(repairedState.previousSignature,successor.signature);assert.equal(repairedHead.stateSignature,repairedState.signature);
await writeFile(state.path,priorState,{mode:0o600});
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:"turn:recovery:rollback",model:"gpt-6-sol"})).status,"unavailable");
assert.equal(hash(await readFile(item.transcript)),before);});

test("observer claims reject malformed native event ids without touching source bytes",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));
assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope,model:"claude-sonnet-5"})).status,"recorded");
for(const id of [""," ","turn:<invalid>","x".repeat(129),null,42,{}]){
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:id})).status,"unavailable");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:id,model:"gpt-6-sol"})).status,"unavailable");}
assert.equal(hash(await readFile(item.transcript)),before);
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:"prompt:valid"})).status,"claimed");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:"turn:valid",model:"gpt-6-sol"})).status,"claimed");});

test("observer handoff rejects malformed current event ids without consuming its suggestion",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));
await runCodexObserver(input(item),{modelCall:async()=>({stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Verify first.",question:null})})});
for(const currentEventId of [""," ","turn:<invalid>","x".repeat(129),null,42,{}])assert.equal((await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId,now:"2026-09-25T11:00:02.000Z"})).status,"unavailable");
const delivered=await consumeHostObserverSuggestion({root:item.root,host:"codex",sessionId:"session:observer",scope,currentEventId:"turn:valid-next",now:"2026-09-25T11:00:03.000Z"});
assert.equal(delivered.status,"delivered");assert.equal(delivered.suggestion.status,"proposal");assert.equal(hash(await readFile(item.transcript)),before);});
