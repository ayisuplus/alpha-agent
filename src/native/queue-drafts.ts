import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { isUserQueuedMessage, toRestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/queued-messages";

interface SavedQueueDraft { id: string; sessionId: string; createdAt: string; text: string; paths: string[]; imageCount: number; path: string }
const directory = (session: AgentSession) => join(session.sessionManager.getSessionDir(), "alpha-queue-drafts");
const queues = (session: AgentSession) => JSON.stringify({ steering: session.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(toRestoredQueuedMessage), followUp: session.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(toRestoredQueuedMessage) });
export async function queueDrafts(session: AgentSession) {
  const root = directory(session), names = await readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const rows: SavedQueueDraft[] = [];
  for (const name of names.filter(name => /^[0-9a-f-]{36}$/.test(name))) {
    const value = await readFile(join(root, name, "draft.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (value) rows.push(value);
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Uses native dequeue. A durable native queue checkpoint is written before removing any message. */
export async function popQueueDraft(session: AgentSession) {
  if (!session.agent.peekSteeringQueue().length && !session.agent.peekFollowUpQueue().length) return { empty: true };
  const id = randomUUID(), root = join(directory(session), id), before = queues(session);
  await mkdir(root, { recursive: true });
  const checkpoint = join(root, "native-queue.json"); await writeFile(checkpoint, before, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (queues(session) !== before) throw new Error("Queue changed during backup. Refresh and try again; no message was removed");
  const item = session.popLastQueuedMessage(); if (!item) return { empty: true };
  try {
    const path = join(root, "message.json"); await writeFile(path, JSON.stringify(item), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const paths: string[] = [];
    for (const [index, image] of (item.images ?? []).entries()) {
      const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[image.mimeType] ?? "bin";
      const path = join(root, `image-${index + 1}.${extension}`); await writeFile(path, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 }); paths.push(path);
    }
    const draft: SavedQueueDraft = { id, path, sessionId: session.sessionManager.getSessionId(), createdAt: new Date().toISOString(), text: item.text, paths, imageCount: paths.length };
    await writeFile(join(root, "draft.json"), JSON.stringify(draft), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const inline = (item.images?.length ?? 0) <= 8 && (item.images ?? []).reduce((size, image) => size + image.data.length, 0) <= 6_000_000;
    return { ...draft, savedPaths: paths, ...(inline ? { images: item.images, paths: [] } : {}), referencedImages: !inline };
  } catch (error) {
    // The native checkpoint retains every original queued image even if later disk writes fail.
    return { text: item.text, images: item.images, paths: [], checkpoint, error: String(error) };
  }
}
