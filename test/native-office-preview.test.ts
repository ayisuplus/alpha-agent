import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Document, Packer, Paragraph } from "docx";

test("Office preview routes bind original views to a session and preserve the source", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-office-api-"));
  const profile = join(temp, "profile"), project = join(temp, "project"); await mkdir(profile); await mkdir(project);
  await writeFile(join(profile, "config.yml"), "startup:\n  checkUpdate: false\n");
  const source = join(project, "source.docx"), outside = join(temp, "outside.docx");
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Original preview proof")] }] }));
  await writeFile(source, bytes); await writeFile(outside, bytes);
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, PI_CODING_AGENT_DIR: profile, ALPHA_WORKSPACE_ROOT: temp, ALPHA_SERVER_TOKEN: "office-api-proof", ALPHA_BROWSER_CDP_URL: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  let port = 0;
  const request = (path: string, data?: unknown, authenticated = true) => fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-alpha-token": "office-api-proof" } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); let output = "";
    while (!port) { const chunk = await reader.read(); if (chunk.done) throw Error("Office API server failed to start"); output += new TextDecoder().decode(chunk.value); port = Number(/ALPHA_SERVER_READY (\d+)/.exec(output)?.[1] ?? 0); }
    const a = (await (await request("sessions", { cwd: project })).json() as { session: { id: string } }).session.id;
    const b = (await (await request("sessions", { cwd: project })).json() as { session: { id: string } }).session.id;
    expect((await request(`sessions/${a}/office-view`, { path: "source.docx" }, false)).status).toBe(403);
    const opened = await request(`sessions/${a}/office-view`, { path: "source.docx" });
    expect(opened.status).toBe(200);
    const info = await opened.json() as { id: string; readOnly: boolean; width: number };
    expect(info.readOnly).toBe(true); expect(info.width).toBeGreaterThan(0);
    const foreign = await request(`sessions/${b}/office-view`, { action: "render", viewId: info.id, width: 640, height: 480 });
    expect(foreign.status).toBe(400);
    const rendered = await request(`sessions/${a}/office-view`, { action: "render", viewId: info.id, width: 640, height: 480 });
    expect(rendered.status).toBe(200);
    const tile = await rendered.json() as { image: string; mimeType: string };
    expect(tile.mimeType).toBe("image/png"); expect(tile.image.length).toBeGreaterThan(1000);
    expect((await request(`sessions/${a}/office-view`, { path: outside })).status).toBe(400);
    expect((await request(`sessions/${a}/office-view`, { action: "close", viewId: info.id })).status).toBe(200);
    expect((await request(`sessions/${a}/office-view`, { action: "render", viewId: info.id })).status).toBe(400);
    expect(new Uint8Array(await readFile(source))).toEqual(new Uint8Array(bytes));
  } finally {
    await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited; await child.exited;
    const actual = await realpath(temp); if (!actual.startsWith(resolve(tmpdir()) + sep)) throw Error("Preview test cleanup escaped temporary workspace");
    await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 45_000);
