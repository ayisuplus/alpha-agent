import { Tokenizer } from "@oh-my-pi/pi-agent-core";

/** The fixed part of every request in a session: the composed system prompt and the tool definitions. */
export interface PromptFootprint {
  /** Tokens of the composed system prompt (OMP's prompt, context files and Alpha's contract). */
  systemTokens: number;
  /** Tokens of the tool names, descriptions and parameter schemas sent with every request. */
  toolTokens: number;
  tools: number;
  /** Share of the model's context window the fixed part takes; null when the window is unknown. */
  contextShare: number | null;
  /** True when the count comes from the model's own tokenizer rather than an estimate. */
  exact: boolean;
}

/**
 * Above this share of the context window the fixed prompt crowds out task context, which smaller models feel first.
 * Runs over it are recorded and reported rather than refused.
 */
export const PROMPT_SHARE_LIMIT = 0.2;

type SessionState = { systemPrompt: readonly string[]; tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }> };
type ModelInfo = ConstructorParameters<typeof Tokenizer>[0] & { contextWindow?: number | null };

export function promptFootprint(state: SessionState, model: ModelInfo): PromptFootprint {
  const tokenizer = new Tokenizer(model);
  const systemTokens = tokenizer.countTokens(state.systemPrompt.join("\n\n"));
  const toolTokens = tokenizer.countTokens(state.tools.map(tool => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`));
  const window = model?.contextWindow;
  return {
    systemTokens, toolTokens, tools: state.tools.length,
    contextShare: window && window > 0 ? Math.round(((systemTokens + toolTokens) / window) * 1_000) / 1_000 : null,
    exact: tokenizer.encoding !== null,
  };
}

export function overPromptBudget(footprint: PromptFootprint): boolean {
  return footprint.contextShare !== null && footprint.contextShare > PROMPT_SHARE_LIMIT;
}
