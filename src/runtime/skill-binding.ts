import { readFile } from "node:fs/promises";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { frontmatterList } from "./skill-manifest";
import { orderKind, type WorkOrder } from "./work-orders";

export async function validateSkillBindings(orders: readonly WorkOrder[], available: readonly Skill[]): Promise<void> {
  for (const order of orders) {
    const kind = orderKind(order);
    const tools = new Set(order.fullAccess ? ["read", "grep", "edit", "write", "alpha_build", "alpha_check", "alpha_command", "alpha_search", "alpha_source", "alpha_crawl", "alpha_site", "alpha_document", "alpha_skill_read", "alpha_browser", "alpha_worker_result"] : kind === "execute" ? ["read", "grep", "edit", "write", "alpha_build", "alpha_check", "alpha_skill_read", "alpha_browser", "alpha_capability_request", "alpha_worker_result"] : ["read", "grep", "alpha_skill_read", "alpha_browser", "alpha_capability_request", "alpha_worker_result"]);
    for (const id of order.skillIds ?? []) {
      const skill = available.find(item => item.name === id);
      if (!skill) throw new Error(`Skill 未安装或未启用：${id}`);
      const text = await readFile(skill.filePath, "utf8");
      const requiredTools = frontmatterList(text, "requires-tools");
      const missing = requiredTools.find(name => !tools.has(name));
      if (missing && !order.fullAccess) throw new Error(`Skill ${id} 需要 ${missing}，当前 ${kind} 节点未获此工具；请调整执行方式`);
      const services = frontmatterList(text, "requires-services");
      if (services.length && !order.fullAccess) throw new Error(`Skill ${id} 需要外部服务 ${services.join(", ")}；worker 不能自行接入，请交由主任务处理`);
      const conflict = frontmatterList(text, "conflicts-with").find(other => order.skillIds?.includes(other));
      if (conflict) throw new Error(`Skill 流程冲突：${id} 与 ${conflict}`);
    }
  }
}
