// Shared prompt builders — used by BOTH background.js (auto mode)
// and popup.js (manual mode), so the two modes always debate identically.

const DEBATE_SYSTEM_PREAMBLE =
  "You are participating in a structured multi-model debate. " +
  "Another AI has produced the answer below. Critique it honestly: find " +
  "errors, hallucinations, missing requirements, and weak reasoning. Then " +
  "give your own improved answer. Be concrete. Answer in English.\n" +
  "RULE: for every component or step you propose, add one line " +
  "'Why needed: ...' so the reasoning can be cross-verified.\n\n";

const ADVERSARIAL_PREAMBLE =
  "You are the ADVERSARY in a multi-model debate. Your job is to assume the " +
  "answer below is WRONG until proven otherwise. Attack every claim: demand " +
  "evidence, hunt for hallucinated facts, invented APIs, and hidden " +
  "assumptions. Only concede a point if it survives your attack. Then give " +
  "your own answer. Answer in English.\n" +
  "RULE: for every component or step you propose, add one line " +
  "'Why needed: ...'.\n\n";

const JUDGE_AGREE_PROMPT =
  "Two AI models were asked the same question. Do they substantively agree " +
  "on the core approach and key decisions (ignoring wording differences)? " +
  "Reply with ONLY the single word AGREE or DISAGREE on the first line, " +
  "then one short sentence why.\n\n";

const JUDGE_FINAL_PROMPT =
  "You are the judge of a multi-model debate. Below are the final answers " +
  "from each model (one may have been adversarial — weigh evidence, not " +
  "politeness). Produce the definitive project framework. Use EXACTLY " +
  "this structure in English:\n\n" +
  "## VERDICT\n(one-paragraph summary of the winning approach)\n\n" +
  "## AGREED POINTS\n- ...\n\n" +
  "## DISAGREEMENTS RESOLVED\n- point -> decision + reason\n\n" +
  "## REJECTED IDEAS\n- idea + why rejected\n\n" +
  "## FRAMEWORK\n(the full idea flow and project framework: goal, components " +
  "with a 'Why needed:' line each, data/step flow, milestones)\n\n" +
  "## FLOWCHART\n(a Mermaid flowchart of the idea flow, in a ```mermaid " +
  "code block — keep it under 15 nodes)\n\n" +
  "## OPEN QUESTIONS\n- ...(unresolved items)\n\n" +
  "Do not invent facts neither model supported.\n\n";

function buildDebatePrompt(round, idea, othersText, adversarial) {
  if (round === 1) return idea;
  const preamble = adversarial ? ADVERSARIAL_PREAMBLE : DEBATE_SYSTEM_PREAMBLE;
  return preamble + othersText;
}

function othersBlock(debaters, answers, excludeTabId) {
  return debaters
    .filter(o => o.tabId !== excludeTabId && answers[o.tabId])
    .map(o => `--- Answer from ${o.name}${o.adversarial ? " (adversary)" : ""} ---\n${answers[o.tabId]}`)
    .join("\n\n");
}

function judgeTranscript(debaters, answers) {
  return debaters
    .map(d => `===== FINAL ANSWER — ${d.name}${d.adversarial ? " (adversary)" : ""} =====\n${answers[d.tabId]}`)
    .join("\n\n\n");
}
