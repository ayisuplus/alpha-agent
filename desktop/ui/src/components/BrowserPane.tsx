import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Globe, X } from "lucide-react";
import { api } from "../api/client";
import type { WebTab } from "../api/types";
import { useStore } from "../state/store";
import { closeWorkspace, notify, selectBrowserTab, store } from "../state/workbench";
import { PreviewPane } from "./PreviewPane";
import "./BrowserPane.css";

const hidden = { x: 0, y: 0, width: 0, height: 0, visible: false };

function WebPage({ tabId, layoutKey }: { tabId: string; layoutKey: string }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bridge = window.alpha;
    const element = slot.current;
    if (!bridge?.setWebBounds || !element) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const root = element.closest(".workbench")?.getBoundingClientRect();
        const factor = root && root.width > 0 ? window.innerWidth / root.width : 1;
        bridge.setWebBounds!(tabId, { x: rect.left * factor, y: rect.top * factor, width: rect.width * factor, height: rect.height * factor, visible: true });
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", report);
      bridge.setWebBounds?.(tabId, hidden);
    };
  }, [tabId, layoutKey]);
  return <div className="web-native-slot" ref={slot} data-testid="web-native-slot">
    {!window.alpha?.setWebBounds && <p>内置网页仅在 Alpha 桌面版中显示。</p>}
  </div>;
}

export function BrowserPane({ layoutKey, locked }: { layoutKey: string; locked: boolean }) {
  const taskId = useStore(store, state => state.selectedId);
  const tabId = useStore(store, state => state.browserTabId);
  const [tabs, setTabs] = useState<WebTab[]>([]);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTabs([]);
    if (!taskId) return;
    let current = true;
    const refresh = () => void api.webTabs(taskId).then(value => { if (current) setTabs(value); }).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { current = false; clearInterval(timer); };
  }, [taskId]);

  const open = async () => {
    if (!taskId || !address.trim()) return;
    setBusy(true);
    try {
      const tab = await api.openWebTab(taskId, address.trim());
      selectBrowserTab(tab.tabId);
      setTabs(await api.webTabs(taskId));
      setAddress("");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const close = async (id: string) => {
    if (!taskId) return;
    try { await api.webTabAction(taskId, id, "close"); setTabs(await api.webTabs(taskId)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };

  return <section className="browser-pane" aria-label="内置浏览器">
    <nav className="browser-pages" aria-label="浏览器页面">
      <button className={!tabId ? "active" : ""} onClick={() => selectBrowserTab(null)}>产品预览</button>
      {tabs.map(tab => <span className={`browser-page ${tabId === tab.tabId ? "active" : ""}`} key={tab.tabId}>
        <button title={tab.url} onClick={() => selectBrowserTab(tab.tabId)}>{tab.title || tab.url}</button>
        <button className="browser-page-close" aria-label={`关闭 ${tab.title || tab.url}`} onClick={() => void close(tab.tabId)}><X size={12} aria-hidden /></button>
      </span>)}
      {tabId && !tabs.some(tab => tab.tabId === tabId) && <span className="browser-page active">正在打开网页…</span>}
    </nav>
    <form className="browser-address" onSubmit={event => { event.preventDefault(); void open(); }}>
      <Globe size={14} aria-hidden />
      <input aria-label="在内置浏览器打开网页" type="url" value={address} onChange={event => setAddress(event.target.value)} placeholder="https://example.com" disabled={!taskId || busy} />
      <button type="submit" disabled={!taskId || busy || !address.trim()}>打开</button>
    </form>
    <div className="browser-page-body">
      {tabId ? <WebPage tabId={tabId} layoutKey={layoutKey} />
        : <PreviewPane collapsed={false} locked={locked} onToggle={closeWorkspace} showClose={false} layoutKey={layoutKey} />}
    </div>
  </section>;
}
