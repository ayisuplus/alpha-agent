import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { ExpertStore } from "./experts";
import { SkillPluginStore } from "../plugins/third-party";
import { searchExpertCandidates } from "./expert-selection";
import type { TaskLedger } from "./task-ledger";

const fields = { name: "string", description: "string", instructions: "string", skillIds: "string[]" } as const;
const createParameters = type(fields);
const updateParameters = type({ id: "string", ...fields });
const deleteParameters = type({ id: "string" });

export function createExpertTools(store: ExpertStore, plugins: SkillPluginStore, ledger: TaskLedger): Array<CustomTool<any>> {
  const check = async (ids: string[], expertId?: string) => {
    const bundled = expertId ? (await store.get(expertId)).package?.skills.map(item => item.id) ?? [] : [];
    const available = new Set([...(await plugins.loadSkills()).map(item => item.name), ...bundled]);
    const missing = ids.find(id => !available.has(id));
    if (missing) throw new Error(`关联 Skill 未安装或未启用：${missing}`);
  };
  const fail = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
  return [
    {
      name: "alpha_expert_search", label: "Search experts", loadMode: "essential",
      description: "Search enabled experts that have a dispatchable Skill package. Choose one only when its specialty fits the task; an empty result means dispatch a neutral scoped worker instead.",
      parameters: type({ query: "string" }),
      async execute(_id, args) {
        try {
          const matches = searchExpertCandidates(args.query, await store.enabled());
          return { content: [{ type: "text", text: JSON.stringify(matches.map(item => ({ id: item.id, name: item.name, description: item.description, skillIds: item.skillIds ?? [], dispatchable: true }))) }] };
        } catch (error) { return fail(error); }
      },
    },
    {
      name: "alpha_expert_create", label: "Propose expert", loadMode: "essential",
      description: "Propose an expert for the library — for a task-local expert worth keeping, or when the user explicitly asks for one. The proposal is recorded and the user approves before it enters the library (§4.3); until then the task keeps using the expert locally.",
      parameters: createParameters,
      async execute(_id, args) {
        try {
          await check(args.skillIds);
          const id = await ledger.proposeTemporaryExpert({ name: args.name, description: args.description, instructions: args.instructions, skillIds: args.skillIds });
          return { content: [{ type: "text", text: `专家提案 ${id} 已记录（${args.name}）；用户批准后才入库，本轮先按任务内专家使用。` }] };
        } catch (error) { return fail(error); }
      },
    },
    {
      name: "alpha_expert_update", label: "Update expert", loadMode: "essential",
      description: "Use only when the user explicitly asks to change an expert. Supply the complete new definition. Running instances keep their prior snapshot.",
      parameters: updateParameters,
      async execute(_id, args) {
        try { await check(args.skillIds, args.id); const expert = await store.update(args.id, args); return { content: [{ type: "text", text: `专家 ${expert.name} 已更新 (${expert.hash.slice(0, 8)})。当前实例保持原快照。` }] }; }
        catch (error) { return fail(error); }
      },
    },
    {
      name: "alpha_expert_delete", label: "Delete expert", loadMode: "essential",
      description: "Use only when the user explicitly asks to delete an expert. Historical task snapshots remain available.",
      parameters: deleteParameters,
      async execute(_id, args) {
        try { await store.delete(args.id); return { content: [{ type: "text", text: `专家 ${args.id} 已删除；历史快照保持不变。` }] }; }
        catch (error) { return fail(error); }
      },
    },
  ];
}
