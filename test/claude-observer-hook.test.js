import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {claudeObserverArguments,claudeObserverEnvironment,runClaudeObserver} from "../src/claude-observer-hook.js";
import {runHook} from "../src/hook.js";
import {recordClaudeObserverModel} from "../src/lib/session-timeline.js";
import {enrollTimelineWithHostReceipt} from "./session-timeline-invocation-support.js";

const digest=value=>createHash("sha256").update(value).digest("hex");
function scope(){return {host:"claude",entityId:"agent:observer",userId:"person:observer",tenantId:"tenant:observer",projectId:"project:observer",currentTaskId:"task:observer",goalId:"goal:observer",goalStepId:"step:observer",groupId:null,timelineVisibility:"private-verified"};}
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),"agentspine-claude-observer-")),state=join(workspace,"state"),profile=join(workspace,"profile"),root=join(workspace,"project"),transcript=join(profile,"projects","observer","session.jsonl");
await Promise.all([mkdir(state),mkdir(join(root,".git"),{recursive:true}),mkdir(join(profile,"projects","observer"),{recursive:true})]);await writeFile(transcript,`${JSON.stringify({timestamp:"2026-09-25T04:00:00.000Z",message:{role:"user",content:"Earlier task"}})}\n`);
const keys=["AGENTSPINE_STATE_DIR","CLAUDE_CONFIG_DIR","AGENTSPINE_TIMELINE_SESSION_CAPABILITY","AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID"],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
Object.assign(process.env,{AGENTSPINE_STATE_DIR:state,CLAUDE_CONFIG_DIR:profile,AGENTSPINE_TIMELINE_SESSION_CAPABILITY:`astc_${"a".repeat(43)}`,AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID:"session:observer"});
t.after(async()=>{for(const key of keys)prior[key]===undefined?delete process.env[key]:process.env[key]=prior[key];await rm(workspace,{recursive:true,force:true,maxRetries:3});});
const privateScope=scope(),enrolled=await enrollTimelineWithHostReceipt({root,sessionId:"session:observer",scope:privateScope,transcriptPath:transcript,hostHome:profile});assert.equal(enrolled.status,"enrolled");
assert.equal((await recordClaudeObserverModel({root,sessionId:"session:observer",scope:privateScope,model:"claude-sonnet-5"})).status,"recorded");
return {root,transcript,privateScope};}
function input(item,patch={}){const s=item.privateScope;return {hook_event_name:"UserPromptSubmit",host:"claude",cwd:item.root,session_id:"session:observer",prompt_id:"550e8400-e29b-41d4-a716-446655440000",transcript_path:item.transcript,prompt:"Nein, erst die Prüfsumme prüfen.",entity_id:s.entityId,user_id:s.userId,tenant_id:s.tenantId,project_id:s.projectId,task_id:s.currentTaskId,goal_id:s.goalId,goal_step_id:s.goalStepId,group_id:null,...patch};}
const proposal={status:"proposal",kind:"next-step-correction",next:"Erst die Prüfsumme prüfen.",question:null};

test("Claude observer uses one scoped host model proposal and preserves source bytes",async t=>{const item=await fixture(t),before=digest(await readFile(item.transcript));let calls=0,seen;
const output=await runClaudeObserver(input(item),{modelCall:async request=>{calls++;seen=request;return {stdout:JSON.stringify({structured_output:proposal})};}});
assert.equal(calls,1);assert.equal(seen.model,"claude-sonnet-5");assert.match(seen.prompt,/exact user text/);assert.equal(digest(await readFile(item.transcript)),before);
const context=JSON.parse(output.hookSpecificOutput.additionalContext);assert.equal(context.authority,"context-only");assert.equal(context.completionVerified,false);assert.equal(context.proposal.kind,"next-step-correction");assert.equal(context.sourceDigest,digest("Nein, erst die Prüfsumme prüfen."));
assert.equal(await runClaudeObserver(input(item),{modelCall:async()=>{throw new Error("duplicate invoked");}}),null);
});

test("observer skips oversized, image, foreign-scope and failed model work without blocking",async t=>{const item=await fixture(t);let calls=0,call=async()=>{calls++;throw new Error("provider unavailable");};
assert.equal(await runClaudeObserver(input(item,{prompt_id:"prompt:large",prompt:"x".repeat(8193)}),{modelCall:call}),null);
assert.equal(await runClaudeObserver(input(item,{prompt_id:"prompt:image",prompt:"<image source>"}),{modelCall:call}),null);
assert.equal(await runClaudeObserver(input(item,{prompt_id:"prompt:group",group_id:"group:foreign"}),{modelCall:call}),null);
assert.equal(await runClaudeObserver(input(item,{prompt_id:"prompt:failure"}),{modelCall:call}),null);assert.equal(calls,1);
});

test("PostModelSwitch updates the exact session model used by the next observer",async t=>{const item=await fixture(t),base=input(item),switched=await runHook({...base,hook_event_name:"PostModelSwitch",from_model:"claude-sonnet-5",to_model:"claude-opus-5",source:"command"});
assert.equal(switched.observerModel,"recorded");let model=null;await runClaudeObserver(input(item,{prompt_id:"prompt:switched"}),{modelCall:async request=>{model=request.model;return {stdout:JSON.stringify({structured_output:{status:"none",kind:"not-current-instruction",next:null,question:null}})};}});assert.equal(model,"claude-opus-5");
});

test("observer CLI disables settings, tools, persistence, nested hooks and external API overrides",()=>{const args=claudeObserverArguments("claude-opus-5","source");
for(const pair of [["--model","claude-opus-5"],["--tools",""],["--disallowedTools","mcp__*"],["--permission-prompts","none"],["--max-turns","1"]]){const index=args.indexOf(pair[0]);assert.equal(args[index+1],pair[1]);}
for(const flag of ["--bare","--restricted","--no-session-persistence"])assert.ok(args.includes(flag));
const env=claudeObserverEnvironment({PATH:"safe",CLAUDECODE:"1",CLAUDE_CODE_ENTRYPOINT:"hook",CLAUDE_CODE_OAUTH_TOKEN:"host-login",ANTHROPIC_API_KEY:"foreign",Anthropic_Api_Key:"foreign",CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"eu-north-1",Aws_Secret_Access_Key:"foreign",CLAUDE_CODE_USE_VERTEX:"1",GOOGLE_APPLICATION_CREDENTIALS:"foreign.json",CLAUDE_CODE_USE_FOUNDRY:"1",AZURE_CLIENT_SECRET:"foreign",OPENAI_API_KEY:"foreign",OpenAI_Base_Url:"foreign",CODEX_API_KEY:"foreign",CODEX_HOME:"foreign"});
assert.deepEqual(env,{PATH:"safe",CLAUDE_CODE_OAUTH_TOKEN:"host-login"});
});
