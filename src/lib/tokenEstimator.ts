// ── Token Estimator ───────────────────────────────────────────────────────────
//
// Estimates token counts when Ollama does not provide eval_count.
// Uses the standard approximation: 1 token ≈ 4 characters.
//

/**
 * Estimates tokens from a text string using character count.
 * Formula: ceil(length / 4)
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimates prompt and completion tokens separately.
 */
export function estimateTokens(prompt: string, completion: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const promptTokens = estimateTokensFromText(prompt);
  const completionTokens = estimateTokensFromText(completion);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
