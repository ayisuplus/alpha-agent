import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, CircleDot, Clapperboard, FilePen, FilePlus, FileText, Globe, Hammer, Image, LoaderCircle, Mic, Search, Split, Wrench, X, type LucideIcon } from "lucide-react";
import type { ToolIcon, Tone } from "../state/labels";
import "./ui.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: LucideIcon;
  busy?: boolean;
};

export function Button({ variant = "secondary", size = "md", icon: Icon, busy, className, children, disabled, ...rest }: ButtonProps) {
  return <button {...rest} disabled={disabled || busy} className={["btn", `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(" ")}>
    {busy ? <LoaderCircle className="spin" size={size === "sm" ? 14 : 16} aria-hidden /> : Icon && <Icon size={size === "sm" ? 14 : 16} aria-hidden />}
    {children}
  </button>;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: number };

export function IconButton({ icon: Icon, label, size = 16, className, ...rest }: IconButtonProps) {
  return <button {...rest} aria-label={label} title={label} className={["icon-btn", className].filter(Boolean).join(" ")}>
    <Icon size={size} aria-hidden />
  </button>;
}

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={["badge", `tone-${tone}`, className].filter(Boolean).join(" ")}>{children}</span>;
}

export function StatusDot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={["status-dot", `tone-${tone}`, pulse ? "pulse" : ""].filter(Boolean).join(" ")} aria-hidden />;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden />;
}

export function StateIcon({ state, size = 14 }: { state: "pass" | "fail" | "pending" | "running"; size?: number }) {
  if (state === "running") return <Spinner size={size} />;
  if (state === "pass") return <Check className="tone-text-success" size={size} aria-hidden />;
  if (state === "fail") return <X className="tone-text-danger" size={size} aria-hidden />;
  return <CircleDot className="tone-text-warning" size={size} aria-hidden />;
}

const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  read: FileText, search: Search, edit: FilePen, write: FilePlus, build: Hammer, delegate: Split,
  image: Image, voice: Mic, video: Clapperboard, browser: Globe, tool: Wrench,
};

export function ToolGlyph({ icon, size = 14 }: { icon: ToolIcon; size?: number }) {
  const Icon = TOOL_ICONS[icon];
  return <Icon size={size} aria-hidden />;
}
