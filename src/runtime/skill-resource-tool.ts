import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool, Skill } from "@oh-my-pi/pi-coding-agent";

const parameters = type({ id: "string", path: "string" });

export function createSkillResourceTool(skills: readonly Skill[], resolveShared?: (id: string) => Promise<Skill>): CustomTool<typeof parameters> {
  return {
    name: "alpha_skill_read", label: "Read bound Skill", loadMode: "essential", parameters,
    description: "Read one selected or enabled shared Skill by catalog ID, or its relative resource. Use path SKILL.md for the entrypoint. Files remain read-only and cannot escape that Skill directory.",
    async execute(_id, args) {
      try {
        const skill = skills.find(item => item.name === args.id) ?? await resolveShared?.(args.id);
        if (!skill || !args.path || isAbsolute(args.path) || args.path.includes("\\") || args.path.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Skill 或资源路径无效");
        const root = await realpath(skill.baseDir);
        const target = await realpath(join(root, args.path));
        const rest = relative(root, target);
        if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new Error("Skill 资源超出已选目录");
        const text = await readFile(target, "utf8");
        if (text.length > 256_000) throw new Error("Skill 资源过大");
        return { content: [{ type: "text", text }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
