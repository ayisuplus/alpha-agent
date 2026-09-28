import type { ServerContext } from "./context";

export interface RouteRequest {
  ctx: ServerContext;
  request: Request;
  url: URL;
  /** Capture groups of the route's path pattern. */
  params: string[];
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Exact path, or a pattern whose capture groups become `params`. */
  path: string | RegExp;
  handle(input: RouteRequest): Promise<Response> | Response;
}

export const ID = "([0-9a-f-]{36})";
export const SLUG = "([a-z][a-z0-9-]{0,63})";

export function path(pattern: string): RegExp {
  return new RegExp(`^${pattern}$`);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failure(error: unknown, status = 400): Response {
  return Response.json({ error: messageOf(error) }, { status });
}

export function notFound(message = "Task not found"): Response {
  return Response.json({ error: message }, { status: 404 });
}

export async function body<T>(request: Request, fallback: T): Promise<T> {
  return request.json().catch(() => fallback) as Promise<T>;
}

export function dispatch(routes: readonly Route[], input: Omit<RouteRequest, "params">): Promise<Response> | Response | null {
  const { pathname } = input.url;
  for (const route of routes) {
    if (route.method !== input.request.method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return route.handle({ ...input, params: [] });
      continue;
    }
    const match = route.path.exec(pathname);
    if (match) return route.handle({ ...input, params: match.slice(1) });
  }
  return null;
}
