function escapeWorkflowData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function githubErrorCommand(title, message) {
  return `::error title=${escapeWorkflowProperty(title)}::${escapeWorkflowData(message)}`;
}
