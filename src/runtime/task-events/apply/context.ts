import type { FamilyReducers } from "../types";

/** Context family: what the model saw in each step, kept as a compact summary with the text in the blob store. */

export const contextReducers: FamilyReducers = {
  "step/context": (state, event) => {
    const { stage, model, promptHash, taskContextHash, taskContextBytes, systemTokens, toolTokens, contextShare, toolNames, recordedAt } = event.payload;
    (state.stepContexts ??= []).push({ stage, model, promptHash, taskContextHash, taskContextBytes, systemTokens, toolTokens, contextShare, tools: toolNames.length, recordedAt });
  },
};
