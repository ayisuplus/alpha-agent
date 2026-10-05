import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeOfficeView, getOfficeView, openOfficeView, renderOfficeView, selectOfficeView } from "../../../src/native/capabilities/office/office-view";
import { officeRuntimeStatus } from "../../../src/native/capabilities/office/office-runtime";

const output = join(import.meta.dir, "backend-evidence");
await mkdir(output, { recursive: true });
const observations = [];
for (const name of ["native-tracked.docx", "native-comments.docx", "native-structure.xlsx", "native-notes-deck.pptx",
  "native-tracked.odt", "native-tracked.rtf", "native-structure.ods", "native-notes-deck.odp"]) {
  const path = join(import.meta.dir, "fixtures", name);
  const hash = async () => createHash("sha256").update(await readFile(path)).digest("hex");
  const before = await hash(), started = Date.now();
  let view;
  try {
    view = await openOfficeView(path);
    const tile = await renderOfficeView(view.id, { width: 800, height: 600 });
    const image = Buffer.from(tile.image, "base64");
    if (image.readUInt32BE(16) !== 800 || image.readUInt32BE(20) !== 600) throw new Error("native tile pixel contract failed");
    if (["native-tracked.docx", "native-comments.docx", "native-structure.xlsx", "native-notes-deck.pptx", "native-structure.ods", "native-notes-deck.odp"].includes(name)) {
      await writeFile(join(output, `${name}.png`), image);
    }
    let selection;
    if (view.kind === "spreadsheet") {
      selection = await selectOfficeView(view.id, { x: 4000, y: 400 });
      const scrolled = await renderOfficeView(view.id, { x: 0, y: 5800, width: 700, height: 150 });
      if (name.endsWith("xlsx")) await writeFile(join(output, "sheet-scroll.png"), Buffer.from(scrolled.image, "base64"));
      const zoomed = await renderOfficeView(view.id, { x: 3770, y: 340, width: 300, height: 100, scale: 2 });
      if (name.endsWith("xlsx")) await writeFile(join(output, "sheet-zoom2.png"), Buffer.from(zoomed.image, "base64"));
      const second = await renderOfficeView(view.id, { part: 2, width: 800, height: 600 });
      if (name.endsWith("xlsx")) await writeFile(join(output, "sheet-second.png"), Buffer.from(second.image, "base64"));
    } else if (view.kind === "presentation") {
      selection = await selectOfficeView(view.id, { x: 4000, y: 2400 });
      const second = await renderOfficeView(view.id, { part: 1, width: 800, height: 600, scale: 2 });
      if (name.endsWith("pptx")) await writeFile(join(output, "slide-second-zoom2.png"), Buffer.from(second.image, "base64"));
    } else {
      selection = await selectOfficeView(view.id, { x: 2500, y: 1840, count: 2 });
    }
    observations.push({ file: name, originalSha256: before, originalUnchanged: await hash() === before,
      loaded: view, selected: selection, final: await getOfficeView(view.id), pngWidth: 800, pngHeight: 600,
      pngSha256: createHash("sha256").update(image).digest("hex"), elapsedMs: Date.now() - started });
    console.log(`${name}: ${view.kind} native tile, ${Date.now() - started} ms`);
  } catch (error) {
    observations.push({ file: name, originalSha256: before, originalUnchanged: await hash() === before,
      unavailable: String(error), elapsedMs: Date.now() - started });
    console.log(`${name}: ${String(error)}`);
  } finally {
    if (view) await closeOfficeView(view.id);
  }
}
await writeFile(join(output, "observations.json"), JSON.stringify({ date: "2026-10-01", platform: process.platform,
  bun: Bun.version, runtime: await officeRuntimeStatus(), observations }, null, 2));
