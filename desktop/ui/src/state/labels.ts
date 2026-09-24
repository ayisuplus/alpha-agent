import type { Criterion, GuidanceStatus, TaskSummary } from "../api/types";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export const TERMINAL_PHASES = new Set(["待验收", "已验收", "用户接管", "已停止", "失败"]);

/** The instruction the server substitutes when "continue repair" is sent without text. */
export const DEFAULT_RESUME_INSTRUCTION = "Repair the pending acceptance checks while preserving the original objective.";

// Briefs usually open with the same boilerplate ("制作一个本地可用的…", "Build a small…"); the distinguishing noun follows it.
const LEADING_BOILERPLATE = [
  /^(请|帮我|请帮我)?(把当前空白\s*Web\s*模板)?(继续完善|构建|制作|做|创建|开发|实现|生成|写)(为|成)?(一个|一款|一份|一套|这个|个)?(本机|本地)?(可用|运行)?的?/,
  /^(please\s+)?(build|create|make|write|develop)\s+(me\s+)?(a|an)\s+((small|tiny|simple|minimal|single)[\s-]+)*/i,
];

export function titleOf(objective: string): string {
  const text = objective.trim().replace(/\s+/g, " ");
  const first = text.split(/[：:。；;！!？?\n，,]|\.\s/)[0].trim();
  let title = first.length >= 4 ? first : text;
  for (const pattern of LEADING_BOILERPLATE) {
    const stripped = title.replace(pattern, "").trim();
    if (stripped.length >= 2 && stripped !== title && /^[\p{L}\p{N}]/u.test(stripped)) {
      title = /^[a-z]/.test(stripped) ? stripped[0].toUpperCase() + stripped.slice(1) : stripped;
      break;
    }
  }
  return title.length > 48 ? `${title.slice(0, 48)}…` : title;
}

export function taskTitle(task: Pick<TaskSummary, "objective" | "originalObjective" | "meta">): string {
  return task.meta?.title ?? titleOf(task.originalObjective ?? task.objective);
}

export function taskStatus(task: Pick<TaskSummary, "running" | "status">): { label: string; tone: Tone } {
  if (task.running) return { label: "运行中", tone: "accent" };
  if (task.status === "complete") return { label: "已验收", tone: "success" };
  if (task.status === "stopped") return { label: "已停止", tone: "neutral" };
  return { label: "待验收", tone: "warning" };
}

const CRITERIA: Record<string, string> = {
  build: "产品构建",
  "user-path": "浏览器关键路径",
  "local-preview": "本机预览",
};

export function criterionLabel(id: string, criteria: Criterion[] = []): string {
  return CRITERIA[id] ?? criteria.find(item => item.id === id)?.description ?? id;
}

export type ToolIcon = "read" | "search" | "edit" | "write" | "build" | "delegate" | "image" | "voice" | "video" | "browser" | "tool";

const TOOLS: Record<string, { label: string; icon: ToolIcon }> = {
  read: { label: "读取", icon: "read" },
  grep: { label: "搜索", icon: "search" },
  edit: { label: "编辑", icon: "edit" },
  write: { label: "写入", icon: "write" },
  alpha_build: { label: "构建", icon: "build" },
  alpha_delegate: { label: "分派工单", icon: "delegate" },
  alpha_generate_image: { label: "生成图片", icon: "image" },
  alpha_generate_voice: { label: "生成语音", icon: "voice" },
  alpha_generate_video: { label: "生成视频", icon: "video" },
  alpha_browser: { label: "操作浏览器", icon: "browser" },
  build: { label: "构建检查", icon: "build" },
  browser: { label: "浏览器验收", icon: "browser" },
};

export function toolInfo(name: string): { label: string; icon: ToolIcon } {
  return TOOLS[name] ?? { label: name, icon: "tool" };
}

export function phaseInfo(phase: string): { label: string; tone: Tone } {
  if (phase.startsWith("本机预览：")) return { label: "预览已发布", tone: "neutral" };
  if (phase.startsWith("目标修订至")) return { label: phase, tone: "accent" };
  switch (phase) {
    case "已验收": return { label: "已验收", tone: "success" };
    case "待验收": return { label: "待验收", tone: "warning" };
    case "用户接管": return { label: "你接管了预览", tone: "warning" };
    case "已停止": return { label: "已停止", tone: "neutral" };
    case "失败": return { label: "失败", tone: "danger" };
    case "修复中": return { label: "根据验收失败自动修复", tone: "warning" };
    default: return { label: phase, tone: "neutral" };
  }
}

export function guidanceLabel(status: GuidanceStatus | undefined): string | null {
  return status === "processed" ? "已处理" : status === "delivered" ? "已投递" : status === "recorded" ? "已记录" : null;
}

export function guidanceText(instruction: string): string {
  return instruction === DEFAULT_RESUME_INSTRUCTION ? "按当前验收问题继续修复" : instruction;
}

const REOPEN_REASONS: Record<string, string> = {
  "User revised the task objective": "你修订了目标，需要重新构建并验收",
  "Local preview was republished and needs browser verification": "预览已重新发布，需要重新进行浏览器验收",
};

export function reopenText(reason: string): string {
  return REOPEN_REASONS[reason] ?? guidanceText(reason);
}

/** A short Chinese headline for the runtime's (English) failure reasons; the raw text stays available as detail. */
export function failureHeadline(reason: string): string {
  if (/^Verification step \d+\/\d+/.test(reason)) return "浏览器验收未通过";
  if (/^Verification plan/i.test(reason)) return "验收计划无效";
  if (/no response within/i.test(reason)) return "模型没有响应，请检查网络或模型服务";
  const tools = /exceeded (\d+) tool calls/i.exec(reason);
  if (tools) return `单轮工具调用超过上限（${tools[1]} 次）`;
  if (/Model run exceeded \d+ ms/i.test(reason)) return "单轮运行超过时间上限";
  if (/Authenticated model is unavailable/i.test(reason)) return "找不到已认证的模型";
  if (/Desktop browser debugging port is unavailable/i.test(reason)) return "桌面浏览器不可用，无法进行浏览器验收";
  if (/Preview has console, network or broken image errors/i.test(reason)) return "预览加载时出现脚本、网络或图片错误";
  if (/cancel|stopped/i.test(reason)) return "已手动停止";
  return "最近一次运行出现问题";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export type DayGroup = "今天" | "昨天" | "更早";

export function dayGroup(iso: string, now = new Date()): DayGroup {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = new Date(iso).getTime();
  if (time >= start) return "今天";
  if (time >= start - 86_400_000) return "昨天";
  return "更早";
}
