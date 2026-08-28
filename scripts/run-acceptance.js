#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAcceptanceReport, runVisibleAcceptance } from "../src/lib/acceptance.js";

export async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((item) => item !== "--json");
  if (unknown.length) throw new Error(`unknown acceptance argument: ${unknown[0]}`);
  const report = await runVisibleAcceptance();
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderAcceptanceReport(report));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine acceptance failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
