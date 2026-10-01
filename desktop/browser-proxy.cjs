// Session-owned CDP endpoints. The workbench sees all pages; each OMP connection sees its own.
const { createServer } = require("node:http");
const { readFileSync, writeFileSync } = require("node:fs");
const { WebSocket, WebSocketServer } = require("ws");

async function createBrowserProxy({ rawPort, port, registryFile, pages, resolveTarget, createPage, closePage, activate, checkInput, manual }) {
  const raw = `http://127.0.0.1:${rawPort}`;
  const version = await (await fetch(`${raw}/json/version`)).json();
  const sessions = new Map();
  const creating = new Map();
  const creatingPages = new Map();
  let inputTarget = null, pressed = false;
  const inputWaiters = [];
  async function acquire(target) {
    if (inputTarget && inputTarget !== target) await new Promise(resolve => inputWaiters.push(resolve));
    // Recheck after waking: only one target can own Chromium's native mouse at once.
    if (inputTarget && inputTarget !== target) return acquire(target);
    inputTarget = target;
  }
  function release() {
    inputTarget = null; pressed = false;
    for (const resolve of inputWaiters.splice(0)) resolve();
  }
  function owns(owner, id) { return !owner || resolveTarget(id)?.owner === owner; }
  function save() { writeFileSync(registryFile, JSON.stringify(Object.fromEntries([...sessions].map(([id, server]) => [id, server.address().port])))); }
  function endpoint(server) { return `http://127.0.0.1:${server.address().port}`; }
  async function ensure(owner, preferredPort = 0) {
    if (sessions.has(owner)) return endpoint(sessions.get(owner));
    if (creating.has(owner)) return creating.get(owner);
    const pending = (async () => {
      const server = makeServer(owner);
      await listen(server, preferredPort);
      sessions.set(owner, server); save();
      return endpoint(server);
    })();
    creating.set(owner, pending);
    try { return await pending; } finally { creating.delete(owner); }
  }
  async function ensurePage(owner) {
    if (!owner || pages().some(page => page.owner === owner)) return;
    if (!creatingPages.has(owner)) creatingPages.set(owner, createPage(owner, "about:blank").finally(() => creatingPages.delete(owner)));
    await creatingPages.get(owner);
  }
  function makeServer(owner) {
    const server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const allocation = !owner && /^\/sessions\/([a-zA-Z0-9_-]{1,100})$/.exec(pathname);
        let result;
        if (allocation && request.method === "POST") result = { cdpUrl: await ensure(allocation[1]) };
        else if (pathname === "/json/version") { await ensurePage(owner); result = { ...version, webSocketDebuggerUrl: `${endpoint(server).replace("http:", "ws:")}/devtools/browser/alpha` }; }
        else if (pathname === "/json" || pathname === "/json/list") {
          await ensurePage(owner);
          const targets = await (await fetch(`${raw}/json/list`)).json();
          result = targets.filter(target => target.type === "page" && owns(owner, target.id)).map(target => {
            const websocket = `${endpoint(server).replace("http:", "ws:")}/devtools/page/${target.id}`;
            return { ...target, devtoolsFrontendUrl: `/devtools/inspector.html?ws=${websocket.slice(5)}`, webSocketDebuggerUrl: websocket };
          });
        } else { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(result));
      } catch (error) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
    });
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const page = /^\/devtools\/page\/([^/]+)$/.exec(pathname);
      if (!(page ? owns(owner, page[1]) : pathname === "/devtools/browser/alpha")) { socket.destroy(); return; }
      websocket.handleUpgrade(request, socket, head, client => bridge(client, owner, page?.[1]));
    });
    return server;
  }
  function bridge(client, owner, pageId) {
    const destination = pageId ? `ws://127.0.0.1:${rawPort}/devtools/page/${pageId}` : version.webSocketDebuggerUrl;
    const upstream = new WebSocket(destination);
    const opened = new Promise((resolve, reject) => { upstream.once("open", resolve); upstream.once("error", reject); });
    const attached = new Map();
    const pending = new Map();
    const queues = new Map();
    const childOwners = new Map();
    const knownTargets = new Set();
    const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const error = (message, reason) => send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: reason } });
    function viewFor(message) { return pageId || attached.get(message.sessionId); }
    function allowedInfo(info, parent) {
      if (!info) return true;
      if (info.type === "browser") return true;
      if (owns(owner, info.targetId)) { knownTargets.add(info.targetId); return true; }
      if (info.type === "page" && info.openerId && owns(owner, info.openerId)) { knownTargets.add(info.targetId); return true; }
      // Cross-origin iframe/worker targets inherit only an already-owned parent CDP session.
      if (info.type !== "page" && parent && owns(owner, parentView(parent))) { childOwners.set(info.targetId, parentView(parent)); return true; }
      return childOwners.has(info.targetId);
    }
    function parentView(id) { return childOwners.get(id) || id; }
    upstream.on("message", data => {
      let message; try { message = JSON.parse(String(data)); } catch { return; }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (request.message.method === "Target.attachToTarget" && message.result?.sessionId) attached.set(message.result.sessionId, request.message.params.targetId);
        if (message.result?.targetInfos) message.result.targetInfos = message.result.targetInfos.filter(info => allowedInfo(info));
        if (message.result?.targetInfo && !allowedInfo(message.result.targetInfo, viewFor(request.message))) { error(request.message, "Target belongs to another session owner"); request.resolve(); return; }
        send(message); request.resolve(message); return;
      }
      if (message.method === "Target.attachedToTarget") {
        const info = message.params.targetInfo;
        const parent = attached.get(message.sessionId) || pageId;
        if (!allowedInfo(info, parent)) {
          // A foreign target must never remain paused by this session's auto-attach request.
          upstream.send(JSON.stringify({ id: --internalId, method: "Runtime.runIfWaitingForDebugger", sessionId: message.params.sessionId }));
          upstream.send(JSON.stringify({ id: --internalId, method: "Target.detachFromTarget", params: { sessionId: message.params.sessionId } }));
          return;
        }
        attached.set(message.params.sessionId, info.targetId);
      }
      if (message.id < 0) return;
      if (message.params?.targetInfo && !allowedInfo(message.params.targetInfo)) return;
      if (message.params?.targetId && !owns(owner, message.params.targetId) && !childOwners.has(message.params.targetId) && !knownTargets.has(message.params.targetId)) return;
      if (message.sessionId && !pageId && !attached.has(message.sessionId)) return;
      send(message);
      if (message.method === "Target.detachedFromTarget") {
        if (parentView(attached.get(message.params.sessionId)) === inputTarget) release();
        attached.delete(message.params.sessionId);
      }
      if (message.method === "Target.targetDestroyed") { knownTargets.delete(message.params.targetId); if (parentView(message.params.targetId) === inputTarget) release(); }
    });
    let internalId = 0;
    async function forward(message) {
      await opened;
      return new Promise(resolve => { pending.set(message.id, { message, resolve }); upstream.send(JSON.stringify(message)); });
    }
    async function dispatch(message) {
      let acquired = false;
      try {
        await opened;
        const method = message.method, params = message.params || {};
        // Electron exposes page views directly; don't let Chromium's synthetic tab targets
        // auto-attach another session's page before ownership can be checked.
        if (method === "Target.setAutoAttach" && !message.sessionId && !pageId) message.params = { ...params, filter: [{ type: "page", exclude: false }, { exclude: true }] };
        const target = params.targetId || viewFor(message);
        if (params.targetId && !owns(owner, params.targetId) && !childOwners.has(params.targetId)) throw Error("Target belongs to another session owner");
        if (message.sessionId && !pageId && !attached.has(message.sessionId)) throw Error("Unknown session target");
        if (method === "Target.createTarget") {
          if (!owner) throw Error("A session owner is required to create a page");
          const created = await createPage(owner, params.url || "about:blank");
          send({ id: message.id, result: { targetId: created.targetId } }); return;
        }
        if (method === "Target.closeTarget") { send({ id: message.id, result: { success: closePage(params.targetId) } }); return; }
        if (method === "Browser.close") throw Error("Cannot close the shared browser host from one session");
        if (method === "Target.createBrowserContext" || method === "Target.disposeBrowserContext") throw Error("Session pages share the managed login profile");
        const view = parentView(target);
        if (method.startsWith("Input.")) {
          if (!view || !owns(owner, view)) throw Error("Input requires an owned page target");
          if (manual()) throw Error("Browser is under manual takeover; automated input is paused");
          await acquire(view); acquired = true;
          if (manual()) throw Error("Browser is under manual takeover; automated input is paused");
          activate(view);
          if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") await checkInput(view, params.x, params.y);
          const reply = await forward(message);
          if (reply?.error) { release(); return; }
          if (method === "Input.dispatchMouseEvent") {
            if (params.type === "mousePressed") pressed = true;
            else if (params.type === "mouseReleased") pressed = false;
          }
          if (!pressed) release();
          return;
        }
        // Puppeteer's DOM preparation can wait for an IntersectionObserver frame before
        // sending Input. Covered native views need to be raised for that preparation too.
        if (!manual() && view && (method === "Page.bringToFront" || method === "Target.activateTarget"
          || method === "Runtime.callFunctionOn" || method === "Runtime.evaluate")) {
          await acquire(view); acquired = true;
          activate(view);
          await forward(message);
          if (!pressed) release();
          return;
        }
        await forward(message);
      } catch (failure) { error(message, failure.message); if (acquired) release(); }
    }
    client.on("message", data => {
      let message; try { message = JSON.parse(String(data)); } catch { return; }
      if (!Number.isInteger(message.id) || typeof message.method !== "string") return;
      // Keep each CDP target ordered without blocking another target's mouse-release behind its waiter.
      const key = message.sessionId || pageId || "browser";
      const next = (queues.get(key) || Promise.resolve()).then(() => dispatch(message));
      queues.set(key, next);
    });
    const closed = () => {
      if ([...attached.values(), pageId].includes(inputTarget)) release();
      for (const request of pending.values()) request.resolve(); pending.clear();
      upstream.close(); client.close();
    };
    client.on("close", closed); client.on("error", closed); upstream.on("close", closed); upstream.on("error", closed);
  }
  function listen(server, value) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(value, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
  const publicServer = makeServer(null);
  await listen(publicServer, port);
  let previous = {}; try { previous = JSON.parse(readFileSync(registryFile, "utf8")); } catch {}
  for (const [owner, value] of Object.entries(previous)) if (/^[a-zA-Z0-9_-]{1,100}$/.test(owner) && Number.isInteger(value)) await ensure(owner, value);
  return { port: publicServer.address().port };
}

module.exports = { createBrowserProxy };
