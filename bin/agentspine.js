#!/usr/bin/env node
import { run } from "../src/cli.js";

run().catch((error) => {
  process.stderr.write(`AgentSpine: ${error.message}\n`);
  process.exitCode = 1;
});
