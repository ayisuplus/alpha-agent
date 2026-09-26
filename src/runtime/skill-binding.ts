import { readFile } from "node:fs/promises";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import type { WorkOrder } from "./work-orders";

function listField(frontmatter: string, key: string): string[] {
  const value = new RegExp(`^${key}:\\s*(.*)$`, "mi").exec(frontmatter)?.[1]?.trim();
  if (!value) return [];
  return value.replace(/^\[|\]$/g, "").split(/[,\s]+/).map(item => item.replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
}

export async function validateSkillBindings(orders: readonly WorkOrder[], available: readonly Skill[]): Promise<void> {
  for (const order of orders) {
    const mode = order.mode ?? "implement";
    const tools = new Set(order.fullAccess ? ["read", "grep", "edit", "write", "alpha_build", "alpha_check", "alpha_command", "alpha_search", "alpha_source", "alpha_crawl", "alpha_site", "alpha_document", "alpha_skill_read", "alpha_browser", "alpha_worker_result"] : mode === "implement" ? ["read", "grep", "edit", "write", "alpha_build", "alpha_check", "alpha_skill_read", "alpha_browser", "alpha_capability_request", "alpha_worker_result"] : ["read", "grep", "alpha_skill_read", "alpha_browser", "alpha_capability_request", "alpha_worker_result"]);
    for (const id of order.skillIds ?? []) {
      const skill = available.find(item => item.name === id);
      if (!skill) throw new Error(`Skill 未安装或未启用：${id}`);
      const text = await readFile(skill.filePath, "utf8");
      const header = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      const requiredTools = listField(header, "requires-tools");
      const missing = requiredTools.find(name => !tools.has(name));
      if (missing && !order.fullAccess) throw new Error(`Skill ${id} 需要 ${missing}，当前 ${mode} 实例未获此工具；请调整执行方式`);
      const services = listField(header, "requires-services");
      if (services.length && !order.fullAccess) throw new Error(`Skill ${id} 需要外部服务 ${services.join(", ")}；worker 不能自行接入，请交由主任务处理`);
      const conflict = listField(header, "conflicts-with").find(other => order.skillIds?.includes(other));
      if (conflict) throw new Error(`Skill 流程冲突：${id} 与 ${conflict}`);
    }
  }
}
