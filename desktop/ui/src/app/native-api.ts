/**
 * Alpha 桌面 ↔ 本机服务（src/native/server.ts）接口层。
 *
 * 服务端契约：所有 /api 请求必须带每次启动的令牌（`x-alpha-token`；EventSource 无法带请求头，
 * 用 `?token=` 查询参数）；Host 只能是 127.0.0.1:<端口>。GET 不拉起 OMP 进程：
 * `state|messages|models` 在进程未打开时返回 409，需先 `POST sessions/<id>/open`。
 */

/** Alpha 发行版本；随发版更新（方案 10.1：本轮重构发版 0.2.0）。 */
import packageInfo from "../../../../package.json";
export const ALPHA_VERSION = packageInfo.version;

export type NativeModel = { selector: string; provider: string; id: string; name: string; available: boolean; reasoning: boolean; contextWindow: number; input?: string[] };
export type NativeCatalog = { models: NativeModel[]; roleModels?: NativeModel[]; roles?: Array<{ id: string; name: string; candidates: string[] }>; providers: Array<{ id: string; origin: string | null; storedKey: boolean; oauth: boolean; available: number; login?: boolean }>; error: string | null };
export type NativeSetting = { id: string; type: string; value: unknown; label: string; description: string; tab: string; group: string; values?: string[]; provenance: string };
export type NativeConfig = { agentDir: string; modelRoles: Record<string, string>; settings: NativeSetting[]; cwd?: string; projectRevision?: string; roles?: Array<{ id: string; name: string; provenance: string }> };

export interface SessionItem {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  legacyTaskId?: string;
  /** OMP 显式 --resume 恢复用的会话 ID。 */
  ompSessionId?: string;
  archived?: boolean;
  tags?: string[];
  status?: string;
  notice?: string;
}

export interface LegacyTask { id: string; title: string; status: string; objective: string }

export interface MessagePart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  /** ImageContent */
  data?: string;
  mimeType?: string;
}

export interface RetryRecoveryNote { kind?: string; status?: string; attempt?: number; note?: string }

/** OMP AgentMessage 的最小结构镜像（get_messages 返回）。 */
export interface NativeMessage {
  role: string;
  content?: string | MessagePart[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  customType?: string;
  display?: boolean;
  /** compactionSummary */
  summary?: string;
  shortSummary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  method?: string;
  model?: string;
  timestamp?: number;
  duration?: number;
  retryRecovery?: RetryRecoveryNote;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  errorId?: number;
}

export interface NativeState {
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  queuedMessageCount?: number;
  todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
  isSettled: boolean;
  hasPendingAsyncWork: boolean;
  sessionName?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent?: number };
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  checkedAt: string | null;
  available: boolean;
  notifiedVersion: string | null;
  dismissedVersion: string | null;
  error: string | null;
}

export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  url?: string;
  launchUrl?: string;
}

/** C4/C5 产物形状（alpha_office 与媒体工具统一返回）。 */
export interface Artifact {
  path: string;
  kind: string;
  sha256: string;
  preview?: string;
  before?: string;
}

export interface ToolPayload {
  summary?: string;
  artifacts?: Artifact[];
  unsupported?: string[];
}

export class NativeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 一次读齐内核配置与模型目录（设置页与首页共用）。 */
export interface ConfigurationBundle {
  config: NativeConfig;
  catalog: NativeCatalog;
}

export async function loadConfiguration(): Promise<ConfigurationBundle> {
  const [config, catalog] = await Promise.all([nativeApi<NativeConfig>("configuration"), nativeApi<NativeCatalog>("models")]);
  return { config, catalog };
}

export function modelPreference(models: NativeModel[], configured: string) {
  if (models.some(model => model.selector === configured)) return { selector: configured, thinking: "" };
  const match = /:(off|minimal|low|medium|high|xhigh|max|auto)$/.exec(configured);
  const selector = match ? configured.slice(0, -match[0].length) : configured;
  return { selector, thinking: match?.[1] ?? "" };
}

let tokenCache: Promise<string> | null = null;

/** 每次启动一个令牌：优先取 preload 桥，浏览器调试时退回地址栏 `?token=`。 */
export function serverToken(): Promise<string> {
  if (!tokenCache) {
    const bridge = typeof window !== "undefined" ? window.alpha?.serverToken?.() : undefined;
    const fallback = () => (typeof location !== "undefined" ? new URLSearchParams(location.search).get("token") ?? "" : "");
    tokenCache = bridge ? bridge.then(token => token || fallback(), fallback) : Promise.resolve(fallback());
  }
  return tokenCache;
}

async function withToken(init?: RequestInit): Promise<RequestInit> {
  const token = await serverToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-alpha-token", token);
  return { ...init, headers };
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new NativeApiError(typeof body.error === "string" && body.error ? body.error : `HTTP ${response.status}`, response.status);
  return body as T;
}

/** 任意本机服务路径（含 /api 前缀），自动带令牌。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, await withToken(init));
  } catch {
    throw new NativeApiError("无法连接 Alpha 本机服务", 0);
  }
  return parse<T>(response);
}

export async function nativeApi<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(`/api/native/${path}`, data === undefined
    ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}

export async function nativeDelete<T>(path: string): Promise<T> {
  return request<T>(`/api/native/${path}`, { method: "DELETE" });
}

/** 会话动作（GET 或 POST），自动带令牌。 */
export async function sessionRequest<T>(id: string, action: string, data?: unknown): Promise<T> {
  return request<T>(`/api/native/sessions/${encodeURIComponent(id)}/${action}`, data === undefined
    ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}

/** SSE 事件流地址（EventSource 无法带请求头，令牌走查询参数）。 */
export async function sessionEventsUrl(id: string): Promise<string> {
  const token = await serverToken();
  return `/api/native/sessions/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token)}`;
}

/** 拉起（或复用）会话的 OMP 进程：GET state/messages/models 之前必须先走这一步（方案 8.2 生命周期）。 */
export async function openSession(id: string): Promise<{ open: true; ompSessionId?: string; title?: string }> {
  return sessionRequest(id, "open", {});
}

/** 消息正文（文本部分拼接）。 */
export function plain(message: NativeMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}

/** 消息携带的内嵌图片（base64 data URL）；alpha_office/媒体工具用它附产物预览。 */
export function contentImages(message: NativeMessage): Array<{ dataUrl: string; mimeType: string }> {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter(part => part.type === "image" && typeof part.data === "string" && part.data)
    .map(part => {
      const mimeType = part.mimeType || "image/png";
      return { dataUrl: `data:${mimeType};base64,${part.data}`, mimeType };
    });
}

/** 工具结果里的 C4 产物负载（alpha_office / 媒体工具把 { summary, artifacts } 以 JSON 文本返回）。 */
export function toolPayload(message: NativeMessage): ToolPayload | null {
  const text = plain(message).trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as ToolPayload;
    return value && typeof value === "object" && Array.isArray(value.artifacts) ? value : null;
  } catch {
    return null;
  }
}
