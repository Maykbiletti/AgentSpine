import { coreCommands, runCoreCommand } from "./cli-core.js";
import { attentionCommands, runAttentionCommand } from "./cli-attention.js";
import { learningCommands, runLearningCommand } from "./cli-learning.js";
import { continuityCommands, runContinuityCommand } from "./cli-continuity.js";
import { agentCommands, runAgentCommand } from "./cli-agent.js";
import { sharingCommands, runSharingCommand } from "./cli-sharing.js";
import { diagnosticsCommands, runDiagnosticsCommand } from "./cli-diagnostics.js";
import { premortemCommands, runPremortemCommand } from "./cli-premortem.js";
import { output, parse } from "./cli-common.js";
import { VERSION } from "./version.js";
import { isMainModule } from "./lib/runtime.js";

function help() {
  return `AgentSpine ${VERSION}

Usage:
  agentspine scan [root] [--json]
  agentspine context [root] [--cwd path] [--host codex|claude|generic] [--max-bytes n] [--json]
  agentspine briefing [root] [--host codex|claude|generic] [--entity id] [--group id] [--project id] [--current-task id] [--include-private] [--max-bytes n] [--allow-attention] [--no-source-content]
  agentspine read <relative-path> [--root path] [--offset n] [--length n] [--json]
  agentspine verify [root] [--json]
  agentspine link <from.md> <to.md> --relation related [--reason text] [--confidence 0.8]
  agentspine annotate <path.md> --layer soul [--reason text] [--confidence 0.8]
  agentspine entity <id> --kind person [--name text] [--privacy private]
  agentspine relate <from> <to> --relation works-with [--privacy private]
  agentspine relationships <entity-id> [--group id] [--include-private] [--json]
  agentspine attention [root] [--group id] [--include-private] [--focus-active] [--mark-presented]
  agentspine attention-events [root] [--include-history]
  agentspine attention-add [id] --kind promise --summary text [--entity id] [--group id] [--due date]
  agentspine attention-resolve <id> [--status completed|dismissed|open]
  agentspine attention-touch <entity-id> [--kind interaction] [--at date]
  agentspine attention-delete <signal-id>
  agentspine attention-event-delete <event-id>
  agentspine attention-purge <entity-id>
  agentspine attention-config [root] [--enabled true|false] [--quiet-start 22 --quiet-end 7 --utc-offset 120]
  agentspine learn-propose [id] --kind preference|behavior --claim text --evidence text [--persona id --user id --tenant id --project id --group id --task id]
  agentspine learn-evidence <id> --summary text [--type interaction] [--source path.md]
  agentspine learn-evidence-revoke <learning-id> --evidence-id id --reason-code retracted|source-invalid|measurement-invalid|duplicate|other --reason text --confirm-local-evidence
  agentspine learn-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine learn-context [root] [--group id] [--include-private] [--kind preference,goal]
  agentspine learn-evaluate [root]
  agentspine learn-evaluator-register <id> --principal-digest sha256 --confirm-local-evaluator
  agentspine learn-evaluator-revoke <id> --reason text --confirm-local-evaluator
  agentspine learn-evaluation <id> --learning id --metric name --direction higher|lower --task-digest sha256 --dataset-digest sha256 --protocol-digest sha256 --min-cases n --evaluators id,id --evaluator-roots id=sha256,id=sha256 [--expires-at date] [--retry-trial-failure id --confirm-local-trial-retry] --confirm-local-evaluation --confirm-local-evidence-sources
  agentspine learn-evaluation-revoke <evaluation-id> --reason-code benchmark-invalid|protocol-invalid|scope-invalid|threshold-invalid|duplicate|other --reason text --confirm-local-evaluation-revocation
  agentspine learn-evidence-source-attestation-revoke <evaluation-id> --evidence-digest sha256 --reason-code source-class-invalid|confirmation-invalid|scope-invalid|duplicate|other --reason text --confirm-local-evidence-source-attestation-revocation
  agentspine learn-validation-revoke <validation-lease-id> --reason-code decision-invalid|cohort-invalid|binding-invalid|scope-invalid|duplicate|other --reason text --confirm-local-validation-revocation
  agentspine learn-trial-failure-revoke <trial-failure-id> --reason-code clock-invalid|host-invalid|receipt-invalid|scope-invalid|duplicate|other --reason text --confirm-local-trial-failure-revocation
  agentspine learn-revalidation-start <learning-id> --confirm-local-validation
  agentspine learn-revalidate <learning-id> --measurements id,id --applications id,id --deliveries id,id --confirm-local-validation
  agentspine learn-measurement <id> --learning id --evaluation id --phase before|after --metric name --direction higher|lower --value 0..1 --measurement objective|user-feedback|model-suggestion --evaluator id --run id --source-digest sha256 --dataset-digest sha256 --case-count n --confirm-local-measurement
  agentspine learn-measurement-revoke <measurement-id> --reason-code source-invalid|evaluator-invalid|protocol-invalid|duplicate|other --reason text --confirm-local-measurement-revocation
  agentspine learn-application-revoke <application-id> --reason-code preflight-invalid|scope-invalid|projection-invalid|duplicate|other --reason text --confirm-local-application-revocation
  agentspine learn-delivery-revoke <delivery-id> --reason-code host-invalid|session-invalid|hook-invalid|duplicate|other --reason text --confirm-local-delivery-revocation
  agentspine learn-outcome-revoke <outcome-id> --reason-code binding-invalid|phase-invalid|scope-invalid|duplicate|other --reason text --confirm-local-outcome-revocation
  agentspine learn-outcome <learning-id> --id id --evaluation id --measurement-receipt id [--application id --delivery id]
  agentspine learn-status [root] [--persona id --user id --tenant id --project id --group id --task id]
  agentspine learn-delivery-purge [root] --confirm-local-purge
  agentspine learn-measurement-purge [root] --confirm-local-purge
  agentspine learn-rollback <id> --reason text
  agentspine learn-delete <id>
  agentspine learn-config [root] [--auto-promote true|false] [--min-confidence 0.85] [--min-outcomes 2 --min-improvement 0.05 --canary-receipts 2 --canary-ttl-days 14]
  agentspine continuity-config [root] [--enabled true|false] [--entity id] [--project id] [--confirm-local-opt-in]
  agentspine continuity-status [root]
  agentspine continuity-purge <entity-id> [--root path] --confirm-local-purge
  agentspine preflight-policy <policy.json> --confirm-local-policy
  agentspine preflight-status
  agentspine premortem-recover <predecessor-requirement> [--root path] [--task id] [--json]
  agentspine remember-propose --claim text --user id --tenant id [--project id] [--group id] [--task id]
  agentspine remember-confirm <candidate-id> [--supersedes id] --confirm-local-user
  agentspine remember-rollback <id> --confirm-local-user
  agentspine remember-purge <id> --confirm-local-purge
  agentspine source-status --host claude|codex [--cwd path]
  agentspine doctor --host claude [--cwd path] [--offline-memory-orphans]
  agentspine source-bind <state-root> --host all|claude|codex --scope state-user --project path --host-home path --confirm-local-binding
  agentspine source-rollback <binding-id> --confirm-local-binding
  agentspine source-purge <binding-id> --confirm-local-binding
  agentspine delegation-grant <actor-id> --actions assign,manage --targets agent:id --reason text [--confirm-local-policy]
  agentspine delegation-revoke <grant-id> --reason text [--confirm-local-policy]
  agentspine delegation-check <actor-id> --action assign [--target agent:id]
  agentspine delegation-policy [root]
  agentspine task-create [id] --actor id --title text [--assignee id] [--kind task|open-thread|handoff] [--privacy private|shared|group]
  agentspine task-update <id> --actor id [--status in-progress] [--assignee id|--unassign]
  agentspine tasks [root] [--assignee id] [--project id] [--include-private] [--group id]
  agentspine task-delete <id> [--confirm-local-policy]
  agentspine execution-grant <job-id> --actor id --task task:id --target id --project project:id --host claude|codex --capabilities tool:Write --reason text [--expires date] --confirm-local-execution
  agentspine execution-revoke <grant-id> --reason text --confirm-local-execution
  agentspine execution-policy [root]
  agentspine job-register <job-id> --grant grant:id [--max-retries 3] [--lease-seconds 120] --confirm-local-execution
  agentspine jobs [root] [--actor id] [--project id] [--task id] [--include-terminal]
  agentspine job-cancel <job-id> --reason text --confirm-local-execution
  agentspine job-delete <job-id> --confirm-local-execution
  agentspine channel-bind <binding-id> --provider telegram --tenant id --account id --chat id --senders id,id --agent agent:id --project project:id --session key --secret-env VARIABLE [--outbound-secret-env VARIABLE] --confirm-local-channel
  agentspine channel-revoke <binding-id> --reason text --confirm-local-channel
  agentspine channel-policy [root]
  agentspine channel-events [root] [--agent id] [--project id] [--group id] [--provider telegram] [--include-terminal]
  agentspine persona-sync [root] --roster absolute-path --confirm-local-persona
  agentspine personas [root] [--persona id] [--group id] [--include-inactive]
  agentspine goal-assign <goal-id> --agent id --owner id --project id --success text (--next-step text | --plan plan.json) [--group id] [--deadline date] --confirm-local-goal
  agentspine goal-clarify <goal-id> --gap id --answer text [--source owner-input|objective-observation] [--source-digest sha256] --confirm-local-goal
  agentspine gateway-control [root] [--enabled true|false] [--kill-switch true|false] --confirm-local-gateway
  agentspine gateway-status [root] [--agent id]
  agentspine share-keygen <signer-id> [--public-out signer.json] [--rotate] [--confirm-local-share]
  agentspine share-signers [root]
  agentspine share-trust <signer.json> [--root path] [--confirm-local-share]
  agentspine share-trust-revoke <key-id> --reason text [--root path] [--confirm-local-share]
  agentspine share-trust-list [root] [--include-revoked]
  agentspine share-init <directory> --scope team:id [--adapter adapter:id] [--signer signer:id] [--confirm-local-share]
  agentspine share-publish <directory> --learning id [--id shared:id] [--signer signer:id] [--supersedes shared:id] [--confirm-local-share]
  agentspine share-pull <directory> [--root path] [--require-authenticated]
  agentspine share-snapshot-export <directory> --out snapshot.json [--id snapshot:id] [--confirm-local-share]
  agentspine share-https-publish <directory> --base https://store.example/spine [--id snapshot:id] [--token-env VARIABLE] [--timeout-ms 10000] [--allow-private-network] --confirm-local-share
  agentspine share-https-pull <https-url> [--token-env VARIABLE] [--timeout-ms 10000] [--allow-private-network --confirm-local-share]
  agentspine share-feed-publish <directory> --base https://store.example/spine --feed team:id --signer signer:id [--id snapshot:id] [--token-env VARIABLE] --confirm-local-share
  agentspine share-feed-pull --base https://store.example/spine --feed team:id [--root path] [--token-env VARIABLE] [--allow-private-network --confirm-local-share]
  agentspine share-feed-state [root]
  agentspine share-peer-serve <directory> --root path --signer signer:id [--timeout-ms 10000] --confirm-local-share
  agentspine share-peer-pull --root path --command-json '["ssh","host","agentspine",…]' [--timeout-ms 10000] [--max-bytes n] --confirm-local-share
  agentspine share-sqlite-init <directory> --database path --confirm-local-share
  agentspine share-sqlite-publish <directory> --database path [--id snapshot:id] --confirm-local-share
  agentspine share-sqlite-inspect --database path [--root path]
  agentspine share-sqlite-pull --database path [--root path]
  agentspine share-inbox [root] [--status pending|accepted|rejected|superseded|rolled-back]
  agentspine share-review <id> --decision accept|reject --reason text [--confirmed-by-user]
  agentspine share-context [root] [--scope team:id] [--group group:id] [--kind preference,goal]
  agentspine share-rollback <id> --reason text
  agentspine share-delete <id> [--confirm-local-share]
  agentspine share-config [root] --max-items 12
  agentspine audit [root] [--json]
  agentspine acceptance [--json]
  agentspine doctor [--json]
  agentspine mcp

AgentSpine reads existing Markdown in place. It never rewrites source documents.`;
}

const ROUTES = [
  [coreCommands, runCoreCommand],
  [attentionCommands, runAttentionCommand],
  [learningCommands, runLearningCommand],
  [continuityCommands, runContinuityCommand],
  [agentCommands, runAgentCommand],
  [sharingCommands, runSharingCommand],
  [diagnosticsCommands, runDiagnosticsCommand],
  [premortemCommands, runPremortemCommand]
];

export async function run(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);
  const json = Boolean(flags.json);
  if (["help", "--help", "-h"].includes(command)) return output(help());
  if (["version", "--version", "-v"].includes(command)) return output(VERSION);
  const route = ROUTES.find(([commands]) => commands.has(command));
  if (route) return route[1]({ command, flags, positional, json });
  throw new Error(`Unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`AgentSpine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
