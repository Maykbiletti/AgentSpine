import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import {
  readAuthenticatedTimelineState, recordSessionTimelineHead, sealSessionTimelineState,
  sessionTimelineHeadExists, verifySessionTimelineHead, verifySessionTimelineState
} from "./session-timeline-auth.js";

export async function readTimelineState({ path, root, maximumBytes, empty, validate, assertStable = null }) {
  try {
    const content = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
    const state = await verifySessionTimelineState(validate(JSON.parse(content), root));
    await verifySessionTimelineHead({ root, stateSignature: state.signature });
    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      if (await sessionTimelineHeadExists({ root })) throw new Error("session timeline state is missing after a signed head");
      return empty(root);
    }
    throw error;
  }
}

export async function saveTimelineState({ state, path, root, maximumBytes, assertOwned, assertStable = null }) {
  const assertWritable = async () => {
    await assertStable?.();
    await assertOwned?.();
  };
  await assertWritable();
  await sealSessionTimelineState(state);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("session timeline state exceeds 16 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertWritable });
    await assertWritable();
  }
  catch (error) {
    await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") error.cleanupError = cleanup; });
    throw error;
  }
  await recordSessionTimelineHead({ root, stateSignature: state.signature, assertOwned: assertWritable });
  await assertStable?.();
}
