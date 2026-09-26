import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export function OfficePdfPreview({ url, label }: { url: string; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | null = null;
    setDocument(null);
    setPage(1);
    setError(null);
    fetch(url).then(response => {
      if (!response.ok) throw new Error(`预览加载失败：HTTP ${response.status}`);
      return response.arrayBuffer();
    }).then(async bytes => {
      if (!active) return;
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      task = pdfjs.getDocument({ data: bytes });
      return task.promise;
    }).then(value => { if (active && value) setDocument(value); }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; void task?.destroy(); };
  }, [url]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let render: ReturnType<PDFPageProxy["render"]> | null = null;
    document.getPage(page).then(pdfPage => {
      if (!active || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: 1.25 });
      const target = canvas.current;
      target.width = viewport.width;
      target.height = viewport.height;
      const context = target.getContext("2d");
      if (!context) throw new Error("无法创建预览画布");
      render = pdfPage.render({ canvas: target, canvasContext: context, viewport });
      return render.promise;
    }).catch((reason: Error) => { if (active && reason.name !== "RenderingCancelledException") setError(reason.message); });
    return () => { active = false; render?.cancel(); };
  }, [document, page]);

  return <section className="office-pdf-preview" aria-label={label}>
    <strong>{label}</strong>
    {error && <p role="alert">{error}</p>}
    {!error && !document && <p>正在生成页面预览…</p>}
    {document && <>
      <div className="office-pdf-pages"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {document.numPages}</span><button disabled={page >= document.numPages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
      <canvas ref={canvas} aria-label={`${label}第 ${page} 页`} />
    </>}
  </section>;
}
