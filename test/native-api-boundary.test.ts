import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("local interface rejects missing tokens and foreign hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-boundary-"));
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ALPHA_WORKSPACE_ROOT: root, ALPHA_SERVER_TOKEN: "boundary-test-token" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const errors = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const port = await (async () => {
      let output = "";
      for (;;) {
        // Integration test against a real child process: startup races cannot use fake timers.
        const chunk = await Promise.race([reader.read(), Bun.sleep(30_000).then(() => { throw new Error(`Boundary server timed out: ${output}`); })]);
        if (chunk.done) throw new Error(`Server exited: ${await errors}`);
        output += new TextDecoder().decode(chunk.value);
        const match = /ALPHA_SERVER_READY (\d+)/.exec(output);
        if (match) return Number(match[1]);
      }
    })();
    const call = (init?: RequestInit, path = "sessions") =>
      fetch(`http://127.0.0.1:${port}/api/native/${path}`, init);

    expect((await call()).status).toBe(403);
    expect((await call({ headers: { "x-alpha-token": "wrong-token" } })).status).toBe(403);
    expect((await call({ headers: { "x-alpha-token": "boundary-test-token" } })).status).toBe(200);
    expect((await call({ headers: { "x-alpha-token": "boundary-test-token" } }, "sessions?token=boundary-test-token")).status).toBe(200);

    await writeFile(join(root, "preview.txt"), "authenticated file preview");
    const created = await call({ method: "POST", headers: { "x-alpha-token": "boundary-test-token", "content-type": "application/json" }, body: JSON.stringify({ cwd: root }) });
    const { session } = await created.json() as { session: { id: string } };
    const filePath = `sessions/${session.id}/file?path=preview.txt`;
    expect((await call(undefined, filePath)).status).toBe(403);
    expect((await call(undefined, `${filePath}&raw=1`)).status).toBe(403);
    const file = await call({ headers: { "x-alpha-token": "boundary-test-token" } }, filePath);
    expect(await file.json()).toMatchObject({ kind: "text", text: "authenticated file preview" });
    expect(await (await call(undefined, `${filePath}&raw=1&token=boundary-test-token`)).text()).toBe("authenticated file preview");
    expect((await call({ headers: { "x-alpha-token": "boundary-test-token" } }, `sessions/${session.id}/file?path=..`)).status).toBe(400);
    expect((await call({ headers: { "x-alpha-token": "boundary-test-token" } }, `sessions/${session.id}/file`)).status).toBe(400);

    // Host cannot be overridden through fetch (forbidden header); assert it over a raw socket.
    const rawRequest = (hostHeader: string) => {
      const { promise, resolve: done } = Promise.withResolvers<string>();
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`GET /api/native/sessions HTTP/1.1\r\nHost: ${hostHeader}\r\nx-alpha-token: boundary-test-token\r\nConnection: close\r\n\r\n`);
      });
      let text = "";
      socket.on("data", chunk => { text += chunk.toString(); });
      socket.on("end", () => done(text));
      return promise;
    };
    expect(await rawRequest("evil.example")).toContain("403");
    expect(await rawRequest(`127.0.0.1:${port}`)).toContain("200");
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  } finally {
    if (process.platform === "win32") await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    else child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
