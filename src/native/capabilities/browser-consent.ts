/**
 * Alpha 浏览器授权（统一约定 C7：边界在运行时）——在 `tool_call` 上拦截 OMP 原生 `browser` 工具，
 * 按 Alpha 会话做“仅这次 / 本会话 / 拒绝”三选一授权；令牌和调试端口不进入模型进程。
 *
 * 接线方式（由 src/native/capabilities/extension.ts 负责接线；本文件不改 extension.ts）：
 *
 *   import { attachBrowserConsent } from "./browser-consent";
 *
 *   // alphaCapabilities 里读到会话身份（ALPHA_NATIVE_SESSION_ID / ALPHA_DATA_ROOT）之后：
 *   attachBrowserConsent(pi, { sessionId: id, dataRoot });
 *
 * 行为：
 * - `tool_call` 早于审批门触发（OMP 契约 §7.3），返回 `{ block: true, reason }` 即拦截该次调用并把
 *   reason 交还给模型；返回 void 则放行。
 * - 每个 Alpha 会话（key = sessionId）首次 browser 调用时询问
 *   “允许 Alpha 在本会话中操作浏览器？仅这次 / 本会话 / 拒绝”。
 * - 提示优先用 OMP 原生按工具审批机制（契约 §7.2：审批提示即 `ctx.ui.select`，与工具审批同一原语。
 *   `tool_approval_*` 事件仅通知、不能代答审批；`tools.approval` 配置只能 allow/deny/prompt，无法表达
 *   “本会话”授权，故由扩展在 tool_call 上发起同款提示）。不支持时依次降级：
 *   `ctx.ui.askDialog` 三选一 → `ctx.ui.confirm` 两步三选（“否”＝拒绝并记住）→ 无 UI 直接拒绝（fail-closed）。
 * - 授权状态存 `<dataRoot>/native/browser-consent.json`（JSON 对象，key = Alpha sessionId）：
 *   `once` 仅覆盖被批准的那一次调用，下一次调用过期并重新询问；`session` 放行本会话后续调用；
 *   `denied` 拦截所有后续调用。撤销 = 删除该会话条目，下次调用重新询问。
 * - 提示限时 25s（tool_call 处理器预算默认 30s：extensionHandlers.toolCallTimeoutMs，超时同样
 *   fail-closed 拦截）；取消、超时、无应答均拦截该次调用且不写状态（下次再问）。
 */

import type { ExtensionContext, ExtensionAPI, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BrowserConsentContext {
  /** Alpha 会话 ID（授权状态的存储键）。 */
  sessionId: string;
  /** Alpha 数据根（状态存 `<dataRoot>/native/browser-consent.json`）。 */
  dataRoot: string;
}

type Consent = "once" | "session" | "denied";
type Choice = "once" | "session" | "deny";

const ASK_TIMEOUT_MS = 25_000;
const CHOICE_ONCE = "仅这次";
const CHOICE_SESSION = "本会话";
const CHOICE_DENY = "拒绝";
const CHOICES = [
  { label: CHOICE_ONCE, description: "只允许当前这一次浏览器调用" },
  { label: CHOICE_SESSION, description: "放行本会话后续的浏览器操作（可在“本机能力”页撤销）" },
  { label: CHOICE_DENY, description: "拦截本次调用并记住拒绝（撤销后才会再问）" },
];

function toChoice(answer: string | undefined): Choice | null {
  if (answer === CHOICE_ONCE) return "once";
  if (answer === CHOICE_SESSION) return "session";
  if (answer === CHOICE_DENY) return "deny";
  return null;
}

/** 三选一提示：原生审批同款 select → askDialog → confirm 两步；拿不到答案返回 null（不视为授权）。 */
async function askConsent(ui: ExtensionContext["ui"]): Promise<Choice | null> {
  const timeout = { timeout: ASK_TIMEOUT_MS };
  if (typeof ui.select === "function") {
    return toChoice(await ui.select("允许 Alpha 在本会话中操作浏览器？", CHOICES, { ...timeout, initialIndex: 0 }));
  }
  if (typeof ui.askDialog === "function") {
    const result = await ui.askDialog(
      [{ id: "browser-consent", question: "允许 Alpha 在本会话中操作浏览器？", options: CHOICES, multi: false, recommended: 0 }],
      timeout,
    );
    const item = result?.kind === "submit" ? result.results[0] : undefined;
    return toChoice(item?.selectedOptions[0]);
  }
  if (typeof ui.confirm === "function") {
    // confirm 取消/超时返回 false，故不再另设限时：无应答由 tool_call 处理器预算拦截，不写状态。
    const allowed = await ui.confirm("浏览器操作授权", "允许 Alpha 在本会话中操作浏览器？（否＝拒绝并记住）");
    if (!allowed) return "deny";
    return (await ui.confirm("授权范围", "对整个会话持续授权？（否＝仅这一次）")) ? "session" : "once";
  }
  return null;
}

/**
 * 挂接浏览器授权拦截。只应挂接一次：重复调用会叠加处理器（拦截语义不变，但提示可能重复）。
 * 非 `browser` 工具的调用原样放行。
 */
export function attachBrowserConsent(pi: ExtensionAPI, ctx: BrowserConsentContext): void {
  const file = join(ctx.dataRoot, "native", "browser-consent.json");
  let queue: Promise<unknown> = Promise.resolve();
  /** 读—改—写串行化，避免并发 tool_call 互相覆盖授权状态。 */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  const load = async (): Promise<Record<string, Consent>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Consent>) : {};
    } catch {
      return {};
    }
  };
  const save = async (state: Record<string, Consent>): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, file);
  };

  pi.on("tool_call", (event, runtime) => {
    if (event.toolName !== "browser") return;
    return enqueue(async (): Promise<ToolCallEventResult | undefined> => {
      const state = await load();
      const current = state[ctx.sessionId];
      if (current === "once") {
        // “仅这次”已被上一次调用用掉：过期删除，本次重新询问。
        delete state[ctx.sessionId];
        await save(state);
      } else if (current === "session") {
        return;
      } else if (current === "denied") {
        return { block: true, reason: `用户已拒绝 Alpha 在本会话中操作浏览器。撤销方式：删除 ${file} 中本会话的条目，下次调用会重新询问。` };
      }
      const choice = await askConsent(runtime.ui);
      if (choice === null) {
        return { block: true, reason: "Alpha 浏览器授权未获得（提示被取消、超时或界面不可用），本次调用被拦截；下次调用会重新询问。" };
      }
      if (choice === "deny") {
        state[ctx.sessionId] = "denied";
        await save(state);
        return { block: true, reason: `用户拒绝 Alpha 在本会话中操作浏览器。撤销方式：删除 ${file} 中本会话的条目，下次调用会重新询问。` };
      }
      state[ctx.sessionId] = choice;
      await save(state);
      return;
    });
  });
}
