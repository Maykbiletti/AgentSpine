function parseEvents(buffer, start, eventFromLine) {
  const events = [];
  let cursor = 0;
  while (cursor < buffer.byteLength) {
    const newline = buffer.indexOf(0x0a, cursor);
    const end = newline < 0 ? buffer.byteLength : newline + 1;
    if (end > cursor) {
      const event = eventFromLine(buffer.subarray(cursor, end).toString("utf8"), start + cursor);
      if (event) events.push(event);
    }
    cursor = end;
  }
  return events;
}

async function timestampLineAt({ handle, position, size, last, readRange, extractTimestamp }) {
  const start = Math.max(0, Math.min(position, Math.max(0, size - 1)));
  const bytes = await readRange(handle, start, Math.min(128 * 1024, size - start));
  let cursor = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
  if (cursor >= bytes.byteLength || (start > 0 && cursor <= 0)) return null;
  let result = null;
  while (cursor < bytes.byteLength) {
    const ending = bytes.indexOf(0x0a, cursor);
    const end = ending < 0 ? bytes.byteLength : ending + 1;
    if (end <= cursor) return null;
    try {
      const at = extractTimestamp(JSON.parse(bytes.subarray(cursor, end).toString("utf8")));
      if (at) {
        result = { at, offset: start + cursor };
        if (!last) return result;
      }
    } catch {}
    cursor = end;
  }
  return result;
}

async function seekTimestamp({ handle, size, target, readRange, extractTimestamp }) {
  const lower = await timestampLineAt({ handle, position: 0, size, last: false, readRange, extractTimestamp });
  const upper = await timestampLineAt({ handle, position: Math.max(0, size - 128 * 1024), size, last: true, readRange, extractTimestamp });
  if (!lower || !upper) return { status: "unavailable", reason: "timeline-not-seekable" };
  const lowerAt = new Date(lower.at).getTime();
  const upperAt = new Date(upper.at).getTime();
  const targetAt = target.getTime();
  if (lowerAt > upperAt) return { status: "unavailable", reason: "timeline-not-monotonic" };
  if (targetAt < lowerAt) return { status: "before-start", offset: lower.offset };
  if (targetAt > upperAt) return { status: "out-of-range" };
  let left = lower;
  let right = upper;
  for (let count = 0; count < 24 && right.offset - left.offset > 128 * 1024; count += 1) {
    const probe = await timestampLineAt({ handle, position: Math.floor((left.offset + right.offset) / 2), size,
      last: false, readRange, extractTimestamp });
    if (!probe) return { status: "unavailable", reason: "timeline-not-seekable" };
    const value = new Date(probe.at).getTime();
    if (value < new Date(left.at).getTime() || value > new Date(right.at).getTime()) {
      return { status: "unavailable", reason: "timeline-not-monotonic" };
    }
    if (value <= targetAt) left = probe;
    else right = probe;
  }
  return { status: "found", offset: left.offset };
}

export async function seekTimelineEvidence({ handle, size, target, wanted, windowMs, readRange, eventFromLine,
  extractTimestamp, matches, rank }) {
  const start = await seekTimestamp({ handle, size, target: new Date(target.getTime() - windowMs), readRange, extractTimestamp });
  if (!["found", "before-start"].includes(start.status)) return start;
  const bytes = await readRange(handle, start.offset, Math.min(4 * 1024 * 1024, size - start.offset));
  const ending = bytes.lastIndexOf(0x0a);
  const selected = ending < 0 && start.offset + bytes.byteLength !== size ? -1 : ending < 0 ? bytes.byteLength : ending + 1;
  if (selected < 0) return { status: "unavailable", reason: "timeline-not-seekable" };
  const events = rank(parseEvents(bytes.subarray(0, selected), start.offset, eventFromLine)
    .filter((event) => matches(event, wanted, target, windowMs)), wanted, target).slice(0, 8);
  return { status: "searched", events, budgetExhausted: selected < size - start.offset };
}

export async function verifyTimelineEvent({ handle, event, readRange, digest, eventFromLine }) {
  if (!Number.isSafeInteger(event.offset) || !Number.isSafeInteger(event.bytes) || event.bytes > 1024 * 1024) return null;
  const raw = await readRange(handle, event.offset, event.bytes);
  if (raw.byteLength !== event.bytes || digest(raw) !== event.sha256) return null;
  return eventFromLine(raw.toString("utf8"), event.offset);
}
