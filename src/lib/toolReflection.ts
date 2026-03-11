// ── Tool Reflection ──────────────────────────────────────────────────────────
//
// Evaluates tool results using a lightweight LLM call.
// Helps the agent understand if a tool succeeded and what to do next.
//

export async function reflectOnToolResult(
  toolName: string,
  toolOutput: string,
  llmCall: (messages: any[]) => Promise<string>
) {
  const prompt = [
    {
      role: "system",
      content:
        "You are evaluating the result of a tool execution. Be concise and analytical."
    },
    {
      role: "user",
      content: `
Tool executed: ${toolName}

Tool output:
${toolOutput}

Analyze this result.

1. Did the tool succeed?
2. Does this result answer the user's request?
3. If not, what should the next step be?

Answer in 2-3 sentences.
`
    }
  ];

  try {
    const reflection = await llmCall(prompt);
    return reflection;
  } catch (err) {
    console.warn("[reflection] failed", err);
    return "";
  }
}
