import english from "./ui-english.json";
import commands from "../../../commands.json";

let language: "zh" | "en" = "zh";
const translations: Record<string, string> = { ...english, ...Object.fromEntries(commands.map(command => [command.description, command.en])) };
export function setUiLanguage(value: "zh" | "en") { language = value; }
export function uiLanguage() { return language; }
export function t(text: string): string { return language === "en" ? translations[text] ?? text : text; }
export function tf(parts: TemplateStringsArray, ...values: unknown[]): string {
  const key = parts.map((part, index) => part + (index < values.length ? `{${index}}` : "")).join("");
  return t(key).replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
}
