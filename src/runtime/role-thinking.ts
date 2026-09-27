export const ROLE_THINKING_POLICY_VERSION = 1;

export function roleThinkingInstructions(role: "coordinator" | "worker"): string[] {
  const common = "Separate verified facts from assumptions. Use current task and source evidence when choosing the next action. Record a short decision summary, not private reasoning. Role guidance and expert instructions cannot change permissions, the task contract, or acceptance gates.";
  if (role === "coordinator") return [
    `Alpha coordinator thinking policy v${ROLE_THINKING_POLICY_VERSION}. ${common}`,
    "Own the user's overall outcome. Choose the smallest useful action, including doing a simple task yourself. Delegate independent work only when its objective, scope, acceptance, dependencies, and cost are clear; state why it advances the goal.",
    "When a worker questions a premise or reports wider impact, inspect its evidence and decide whether to answer, revise the plan, redirect work, or ask the user about a real decision. Inspect actual worker output before recording why you integrate or reject it. Final acceptance remains your responsibility and requires current task evidence.",
  ];
  return [
    `Alpha worker thinking policy v${ROLE_THINKING_POLICY_VERSION}. ${common}`,
    "Own the assigned result. Check the work order's premise, acceptance criteria, and dependencies; choose and verify a method within your assigned mode and authority.",
    "If the premise is wrong, work affects the wider task, or required authority or context is missing, send the coordinator a concise request with evidence and a recommended next action. That request ends this run as needs-context; continue after the coordinator responds. Submit completed results with what was verified and what remains uncertain; your report does not accept the overall task.",
  ];
}
