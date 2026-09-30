const STREAM_LIMIT = 4 * 1024;
const DIAGNOSTIC_LIMIT = 12 * 1024;

function redactCredentials(value) {
  return value
    .replace(/((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/?#@\s]+@/g, "$1<redacted>@")
    .replace(/(^|[\r\n])[^\r\n]{0,256}\b(?:authorization|proxy-authorization)\b[^\r\n]*/gi,
      "$1<redacted-authorization-line>")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "<redacted-authorization>")
    .replace(/\b(?:sk[-_](?:proj[-_])?|gh[opusu]_)[A-Za-z0-9_-]{12,}\b/gi, "<redacted-token>")
    .replace(/\b(?:xox[bapcrs]-|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{12,}\b/gi, "<redacted-token>")
    .replace(/((?:^|[\s?&])(?:_?auth[-_]?token|api[-_]?key|access[-_]?token|token|secret|password|credential)\s*[:=]\s*)[^\s&#]+/gi,
      "$1<redacted>")
    .replace(/([?&](?:api(?:[-_]?key)?|access[-_]?token|token|secret|password|credential)=)[^&#\s]*/gi,
      "$1<redacted>");
}

function bounded(value, maximum) {
  const text = redactCredentials(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximum) return text;
  return `${bytes.subarray(0, maximum - 3).toString("utf8")}...`;
}

export function formatPackedInstallFailure(error) {
  const parts = [bounded(error?.stack || error?.message || error, STREAM_LIMIT)];
  for (const stream of ["stdout", "stderr"]) {
    const value = error?.[stream];
    if (value !== undefined && value !== null && String(value).trim()) {
      parts.push(`${stream}:\n${bounded(value, STREAM_LIMIT)}`);
    }
  }
  return bounded(parts.join("\n"), DIAGNOSTIC_LIMIT);
}
