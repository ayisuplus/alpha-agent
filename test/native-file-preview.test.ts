import { expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PDFDocument } from "pdf-lib";
import { projectFile, projectFileContent, projectFilePreview } from "../src/native/project-file";
import { officeRuntimeStatus } from "../src/native/capabilities/office/office-runtime";

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "alpha-file-preview-"));
  try { await fn(root); } finally {
    const actual = await realpath(root);
    if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("File preview fixture escaped temp root");
    await rm(actual, { recursive: true, force: true });
  }
}

test("file preview reads text, Markdown, HTML, UTF-16 and bounded UTF-8 without rewriting sources", async () => {
  await fixture(async root => {
    await writeFile(join(root, "测试.md"), "# 文件预览\n\n|功能|状态|\n|---|---|\n|只读|通过|");
    await writeFile(join(root, "page.html"), "<script>parent.alert('unsafe')</script><h1>Preview</h1>");
    await writeFile(join(root, "utf16.txt"), Buffer.concat([Buffer.from([255, 254]), Buffer.from("中文内容", "utf16le")]));
    await writeFile(join(root, "large.txt"), "中".repeat(400_000));
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "literal.txt"), "A literal � symbol");
    await writeFile(join(root, "encoding.txt"), Buffer.from([0x81, 0x81]));
    expect(await projectFilePreview(root, "测试.md")).toMatchObject({ kind: "markdown", text: "# 文件预览\n\n|功能|状态|\n|---|---|\n|只读|通过|", truncated: false });
    expect(await projectFilePreview(root, "page.html")).toMatchObject({ kind: "html" });
    expect(await projectFilePreview(root, "utf16.txt")).toMatchObject({ kind: "text", text: "中文内容" });
    const large = await projectFilePreview(root, "large.txt");
    expect(large).toMatchObject({ kind: "text", truncated: true });
    expect("text" in large && large.text?.length).toBe(349525);
    expect(await projectFilePreview(root, "empty.txt")).toMatchObject({ text: "" });
    expect(await projectFilePreview(root, "literal.txt")).toMatchObject({ kind: "text", text: "A literal � symbol" });
    expect(await projectFilePreview(root, "encoding.txt")).toMatchObject({ kind: "unsupported" });
    expect(await readFile(join(root, "utf16.txt"))).toEqual(Buffer.concat([Buffer.from([255, 254]), Buffer.from("中文内容", "utf16le")]));
  });
});

test("file preview rejects directories, missing files, traversal and directory links outside the project", async () => {
  await fixture(async outer => {
    const root = join(outer, "project");
    const outside = join(outer, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(projectFile(root, "..")).rejects.toThrow("只能预览");
    await expect(projectFile(root, join(outside, "secret.txt"))).rejects.toThrow("只能预览");
    await expect(projectFile(root, "link/secret.txt")).rejects.toThrow("只能预览");
    await expect(projectFile(root, ".")).rejects.toThrow("请选择文件");
    await expect(projectFile(root, "missing.txt")).rejects.toThrow();
  });
});

test("oversized documents and images offer download instead of loading into the renderer", async () => {
  await fixture(async root => {
    for (const name of ["large.pdf", "large.docx", "large.png"]) {
      const file = await open(join(root, name), "w");
      try { await file.truncate(50 * 1024 * 1024 + 1); } finally { await file.close(); }
      expect(await projectFilePreview(root, name)).toMatchObject({ kind: "unsupported" });
    }
    await expect(projectFileContent(root, "large.docx", new Request("http://127.0.0.1/file"), true)).rejects.toThrow("超过 50 MB");
  });
});

test("media/download responses preserve bytes, support ranges and keep executable files out of the app origin", async () => {
  await fixture(async root => {
    await writeFile(join(root, "clip.mp4"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    await writeFile(join(root, "unknown.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "page.html"), "<script>alert(1)</script>");
    expect(await projectFilePreview(root, "clip.mp4")).toMatchObject({ kind: "video" });
    expect(await projectFilePreview(root, "unknown.bin")).toMatchObject({ kind: "unsupported" });
    const request = (range?: string) => new Request("http://127.0.0.1/file", { headers: range ? { range } : {} });
    const partial = await projectFileContent(root, "clip.mp4", request("bytes=2-4"));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-4/8");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));
    const suffix = await projectFileContent(root, "clip.mp4", request("bytes=-2"));
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([6, 7]));
    expect((await projectFileContent(root, "clip.mp4", request("bytes=2-"))).headers.get("content-length")).toBe("6");
    for (const range of ["bytes=8-", "bytes=4-2", "bytes=-0", "bytes=", "bytes=0-1,4-5", "invalid"]) expect((await projectFileContent(root, "clip.mp4", request(range))).status).toBe(416);
    const html = await projectFileContent(root, "page.html", request());
    expect(html.headers.get("content-disposition")).toContain("attachment");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    const download = await projectFileContent(root, "clip.mp4", new Request("http://127.0.0.1/file?download=1"));
    expect(download.headers.get("content-disposition")).toContain("attachment");
  });
});

test("Office preview reuses the installed converter and leaves the project and source unchanged", async () => {
  await fixture(async root => {
    const source = resolve(import.meta.dir, "fixtures", "office-deck.pptx");
    const original = await readFile(source);
    await writeFile(join(root, "deck.pptx"), original);
    expect(await projectFilePreview(root, "deck.pptx")).toMatchObject({ kind: "office" });
    if ((await officeRuntimeStatus()).available) {
      const response = await projectFileContent(root, "deck.pptx", new Request("http://127.0.0.1/file"), true);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      const pdf = await PDFDocument.load(await response.arrayBuffer());
      expect(pdf.getPageCount()).toBeGreaterThan(0);
    } else {
      await expect(projectFileContent(root, "deck.pptx", new Request("http://127.0.0.1/file"), true)).rejects.toThrow("LibreOffice");
    }
    expect(await readdir(root)).toEqual(["deck.pptx"]);
    expect(await readFile(join(root, "deck.pptx"))).toEqual(original);
  });
}, 150_000);
