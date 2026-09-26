import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {codexObserverArguments,codexObserverEnvironment,runCodexObserver} from "../src/claude-observer-hook.js";
import {claimClaudeObserverPrompt,claimCodexObserverTurn,recordClaudeObserverModel} from "../src/lib/session-timeline.js";
import {enrollTimelineWithHostReceipt} from "./session-timeline-invocation-support.js";

const hash=value=>createHash("sha256").update(value).digest("hex");
const scope={entityId:"agent:codex-observer",userId:"person:observer",tenantId:"tenant:observer",projectId:"project:observer",currentTaskId:"task:observer",goalId:null,goalStepId:null,groupId:null,timelineVisibility:"private-verified"};
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),"agentspine-codex-observer-")),state=join(workspace,"state"),profile=join(workspace,"codex"),root=join(workspace,"project"),directory=join(profile,"sessions","2026","09","25"),transcript=join(directory,"session-observer.jsonl");
await Promise.all([mkdir(state),mkdir(join(root,".git"),{recursive:true}),mkdir(directory,{recursive:true})]);await writeFile(transcript,`${JSON.stringify({timestamp:"2026-09-25T11:00:00.000Z",type:"session_meta",payload:{id:"session:observer",session_id:"session:observer",cwd:root,cli_version:"0.0.0",originator:"codex_cli_rs",source:"cli",history_mode:"legacy"}})}\n`);
const keys=["AGENTSPINE_STATE_DIR","CODEX_HOME","AGENTSPINE_TIMELINE_SESSION_CAPABILITY","AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID"],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,{AGENTSPINE_STATE_DIR:state,CODEX_HOME:profile,AGENTSPINE_TIMELINE_SESSION_CAPABILITY:`astc_${"a".repeat(43)}`,AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID:"session:observer"});
t.after(async()=>{for(const key of keys)prior[key]===undefined?delete process.env[key]:process.env[key]=prior[key];await rm(workspace,{recursive:true,force:true,maxRetries:3});});
assert.equal((await enrollTimelineWithHostReceipt({root,host:"codex",sessionId:"session:observer",scope,transcriptPath:transcript,hostHome:profile})).status,"enrolled");return {root,transcript};}
function input(item,patch={}){return {hook_event_name:"UserPromptSubmit",cwd:item.root,session_id:"session:observer",turn_id:"turn:one",transcript_path:item.transcript,model:"gpt-6-sol",prompt:"Nein, erst die Prüfsumme prüfen.",entity_id:scope.entityId,user_id:scope.userId,tenant_id:scope.tenantId,project_id:scope.projectId,task_id:scope.currentTaskId,group_id:null,...patch};}

test("Codex observer uses the active host model once and preserves its private source",async t=>{const item=await fixture(t),before=hash(await readFile(item.transcript));let calls=0,seen;
const output=await runCodexObserver(input(item),{modelCall:async request=>{calls++;seen=request;return {stdout:JSON.stringify({status:"proposal",kind:"next-step-correction",next:"Erst die Prüfsumme prüfen.",question:null})};}});assert.equal(calls,1);assert.equal(seen.model,"gpt-6-sol");assert.equal(hash(await readFile(item.transcript)),before);const context=JSON.parse(output.hookSpecificOutput.additionalContext);assert.equal(context.modelProvider,"codex");assert.equal(context.authority,"context-only");assert.equal(context.completionVerified,false);assert.equal(context.sourceDigest,hash(input(item).prompt));
assert.equal(context.proposal.proposedNextStepSummary,null);assert.equal(context.proposal.clarificationQuestion,null);assert.doesNotMatch(output.hookSpecificOutput.additionalContext,/Erst die Prüfsumme prüfen\./u);
assert.equal(await runCodexObserver(input(item),{modelCall:async()=>{throw new Error("duplicate invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:image",prompt:"<image source>"}),{modelCall:async()=>{throw new Error("image invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:foreign",group_id:"group:foreign"}),{modelCall:async()=>{throw new Error("foreign invoked");}}),null);
assert.equal(await runCodexObserver(input(item,{turn_id:"turn:failure"}),{modelCall:async()=>{throw new Error("provider unavailable");}}),null);});

test("Codex child is ephemeral, tool-less and cannot inherit an API key",()=>{const args=codexObserverArguments("gpt-6-sol","source");for(const flag of ["--ephemeral","--ignore-user-config","--ignore-rules"])assert.ok(args.includes(flag));for(const value of ["features.apps=false","features.hooks=false","features.multi_agent=false","features.plugins=false","features.shell_tool=false","features.unified_exec=false","project_doc_max_bytes=0","tools.view_image=false","tools.web_search=false"])assert.ok(args.includes(value),value);assert.equal(args[args.indexOf("--sandbox")+1],"read-only");assert.equal(args[args.indexOf("--model")+1],"gpt-6-sol");assert.deepEqual(codexObserverEnvironment({PATH:"safe",CODEX_HOME:"host-login",OPENAI_API_KEY:"foreign",OpenAI_Api_Key:"foreign",OPENAI_BASE_URL:"foreign",AZURE_OPENAI_API_KEY:"foreign",aZuRe_OpEnAi_ApI_KeY:"foreign",CODEX_API_KEY:"foreign"}),{PATH:"safe",CODEX_HOME:"host-login"});});

test("Claude and Codex deduplicate identical native turn ids independently",async t=>{const item=await fixture(t),id="turn:same-provider-local-id";
assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope,model:"claude-sonnet-5"})).status,"recorded");
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:id})).status,"claimed");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:id,model:"gpt-6-sol"})).status,"claimed");
assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope,promptId:id})).status,"duplicate");
assert.equal((await claimCodexObserverTurn({root:item.root,sessionId:"session:observer",scope,turnId:id,model:"gpt-6-sol"})).status,"duplicate");});

test("observer deduplication stays bound to the exact private task and goal",async t=>{const item=await fixture(t),id="turn:same-task-local-id",task={...scope,currentTaskId:"task:other"},goal={...scope,goalId:"goal:other",goalStepId:"step:other"};
for(const current of [scope,task,goal])assert.equal((await recordClaudeObserverModel({root:item.root,sessionId:"session:observer",scope:current,model:"claude-sonnet-5"})).status,"recorded");
for(const current of [scope,task,goal])assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope:current,promptId:id})).status,"claimed");
for(const current of [scope,task,goal])assert.equal((await claimClaudeObserverPrompt({root:item.root,sessionId:"session:observer",scope:current,promptId:id})).status,"duplicate");});
