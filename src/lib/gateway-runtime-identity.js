import { personaRuntimeFindings } from "./persona-runtime.js";

export function currentLane(runtime, agentId) {
  return runtime.lanes.find((item) => item.agentId === agentId && item.status === "leased") || null;
}

export function assertActivePersona(personaPolicy, personaRuntime, agentId, projectId, groupId) {
  const findings = personaRuntimeFindings(personaPolicy, personaRuntime);
  if (findings.length) throw new Error("persona runtime is unhealthy: " + findings.join(", "));
  const persona = personaRuntime.personas.find((item) => item.personaId === agentId && item.status === "active");
  if (!persona || !["agent", "bot"].includes(persona.kind)) {
    throw new Error("gateway work requires an active authenticated agent or bot");
  }
  if (groupId !== null && persona.groupId !== groupId) {
    throw new Error("gateway work group does not match authenticated persona membership");
  }
  const binding = personaPolicy.bindings.find((item) => item.id === persona.bindingId && item.active);
  if (!binding || !binding.tenantId || !binding.profileId || !projectId) {
    throw new Error("gateway work lacks an active authenticated identity binding");
  }
  return { persona, binding };
}

export function exactReplyBinding(channelPolicy, event) {
  const binding = channelPolicy.bindings.find((item) => item.id === event.bindingId && item.status === "active"
    && item.agentId === event.agentId && item.projectId === event.projectId && item.groupId === event.groupId
    && item.provider === event.provider && item.tenantId === event.tenantId && item.accountId === event.accountId
    && item.chatId === event.chatId && item.threadId === event.threadId && item.capabilities.includes("reply"));
  if (!binding) throw new Error("current exact channel reply capability is unavailable");
  return binding;
}
