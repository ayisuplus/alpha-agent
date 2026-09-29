import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import ts from "typescript";
import { uiHashes, verifyUiHashes } from "./portable-ui";

const root = resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const releaseRoot = join(root, "release");
const finalOutput = join(releaseRoot, `alpha-portable-${stamp}`);
const output = join(releaseRoot, `.alpha-portable-${stamp}-${randomUUID().slice(0, 8)}.staging`);
await mkdir(releaseRoot, { recursive: true });

const uiBuild = Bun.spawn([process.execPath, "run", "build:desktop-ui"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await uiBuild.exited !== 0) throw new Error("Desktop UI build failed; no release was published");
const ui = await uiHashes(join(root, "desktop", "dist"));
await mkdir(output, { recursive: false });

// Ship the native host and only its reachable source modules; the retired Alpha
// planner, scheduler, sandbox wrapper and old web server are not part of this app.
const activeSource = new Set<string>();
async function collectSource(file: string): Promise<void> {
  if (activeSource.has(file)) return;
  activeSource.add(file);
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  source.forEachChild(node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) imports.push(node.moduleSpecifier.text);
  });
  for (const specifier of imports.filter(value => value.startsWith("."))) {
    const base = resolve(file, "..", specifier);
    const target = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(candidate => Bun.file(candidate).size > 0);
    if (!target) throw new Error(`Missing active source import: ${file} → ${specifier}`);
    await collectSource(target);
  }
}
for (const entry of ["server.ts", "tianshu-extension.ts", "capabilities-extension.ts"]) await collectSource(join(root, "src", "native", entry));
for (const file of activeSource) {
  const target = join(output, file.slice(root.length + 1));
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(file, target);
}
for (const source of ["desktop/dist", "licenses"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target, { recursive: true });
}
await mkdir(join(output, "presets"), { recursive: true });
for (const name of ["flux2-image.api.json", "voxcpm2-voice.api.json", "h3-video.api.json"]) await cp(join(root, "presets", name), join(output, "presets", name));
for (const source of ["desktop/main.cjs", "desktop/preload.cjs", "scripts/start-desktop.ts", "scripts/probe-portable.ts", "scripts/portable-ui.ts", "scripts/office-worker.py", "scripts/probe-office-runtime.ts", "package.json", "package-lock.json"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target);
}
await verifyUiHashes(join(output, "desktop", "dist"), ui);
await mkdir(join(output, "test", "fixtures"), { recursive: true });
for (const source of ["office-deck.pptx", "office-replacement.png"]) await cp(join(root, "test", "fixtures", source), join(output, "test", "fixtures", source));

const npm = Bun.spawn(["npm.cmd", "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: output, stdout: "inherit", stderr: "inherit" });
if (await npm.exited !== 0) throw new Error(`Production dependency install failed in ${output}`);

await mkdir(join(output, "node_modules", "electron"), { recursive: true });
await cp(join(root, "node_modules", "electron", "dist"), join(output, "node_modules", "electron", "dist"), { recursive: true });
await cp(join(root, "node_modules", "electron", "LICENSE"), join(output, "node_modules", "electron", "LICENSE"));
await mkdir(join(output, "runtime"), { recursive: true });
await cp(process.execPath, join(output, "runtime", "bun.exe"));
const officeSource = join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice");
const officeHash = createHash("sha256").update(await readFile(join(officeSource, "program", "soffice.bin"))).digest("hex");
if (officeHash !== "30078f5fdfad18195e4333561d2440bf8a05af9e7a8aaf2cdf76776c737335de") throw new Error("LibreOffice 26.2.5.2 baseline is unavailable; do not package an unverified Office version");
for (const notice of ["license.txt", "LICENSE.html", "NOTICE"]) if (!(await stat(join(officeSource, notice))).isFile()) throw new Error(`LibreOffice notice missing: ${notice}`);
const officeTarget = join(output, "runtime", "libreoffice");
await mkdir(officeTarget, { recursive: true });
const officeCopy = Bun.spawn(["robocopy.exe", officeSource, officeTarget, "/E", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
const [copyOutput, copyError, copyExit] = await Promise.all([new Response(officeCopy.stdout).text(), new Response(officeCopy.stderr).text(), officeCopy.exited]);
if (copyExit >= 8) throw new Error(`LibreOffice runtime copy failed: ${copyError || copyOutput}`);
const bundledOfficeHash = createHash("sha256").update(await readFile(join(output, "runtime", "libreoffice", "program", "soffice.bin"))).digest("hex");
if (bundledOfficeHash !== officeHash) throw new Error("Bundled LibreOffice differs from the checked source");

const launcher = '@echo off\r\nsetlocal\r\nset "ALPHA_WORKSPACE_ROOT=%~dp0.."\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\bun.exe" run scripts\\start-desktop.ts\r\n';
await writeFile(join(output, "Alpha.cmd"), launcher);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
await writeFile(join(output, "release.json"), JSON.stringify({
  format: 2,
  builtAt: new Date().toISOString(),
  bun: Bun.version,
  electron: packageJson.devDependencies.electron,
  omp: packageJson.dependencies["@oh-my-pi/pi-coding-agent"],
  nativeSourceFiles: activeSource.size,
  ui: { files: ui },
  office: { version: "26.2.5.2", buildId: "cd7284b4cbbfeb507e630c1aac019f4157393acb", sofficeSha256: officeHash, location: "runtime/libreoffice" },
  launch: "Alpha.cmd",
  localData: ["../.alpha", "../products"],
}, null, 2));
await writeFile(join(output, "README.txt"), [
  "Alpha 本机可携带版",
  "",
  "双击 Alpha.cmd 启动桌面工作台。会话和更新检测记录保存在上一级目录的 .alpha，供同一 release 目录下的版本使用。",
  "模型凭据沿用当前 Windows 用户的已配置存储；本包不包含凭据、既有产品或任务数据。",
  "本包在本机运行，不自动上传或部署。每次启动时检查一次 OMP 更新，运行期间不定时复查。",
  "会话、模型、工具与终端由 OMP 18.4.3 原生内核执行；Alpha 提供桌面界面和天枢认知扩展。",
  "第三方许可证保存在 node_modules 对应包及 node_modules/electron/LICENSE。",
  "天枢认知改编代码的 Apache-2.0 许可证在 licenses/Tianshu-APACHE-2.0.txt。",
  "离线办公引擎及其许可证保存在 runtime/libreoffice；通过任务附件读取与修改 DOCX、XLSX、PPTX 和 PDF。",
  "",
].join("\r\n"));
const officeProbe = Bun.spawn([join(output, "runtime", "bun.exe"), "run", "scripts/probe-office-runtime.ts"], { cwd: output, env: { ...process.env, ProgramFiles: "C:\\OfficeNotInstalled" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
const [probeOutput, probeError, probeExit] = await Promise.all([new Response(officeProbe.stdout).text(), new Response(officeProbe.stderr).text(), officeProbe.exited]);
if (probeExit !== 0 || !probeOutput.includes('"status":"pass"')) throw new Error(`Bundled Office smoke failed: ${probeError || probeOutput}`);
const portableProbe = Bun.spawn([join(output, "runtime", "bun.exe"), "run", "scripts/probe-portable.ts", output], { cwd: output, stdout: "pipe", stderr: "pipe", windowsHide: true });
const [portableOutput, portableError, portableExit] = await Promise.all([new Response(portableProbe.stdout).text(), new Response(portableProbe.stderr).text(), portableProbe.exited]);
if (portableExit !== 0) throw new Error(`Bundled desktop server smoke failed: ${portableError || portableOutput}`);
await rename(output, finalOutput);
console.log(JSON.stringify({ output: finalOutput, launcher: join(finalOutput, "Alpha.cmd"), runtime: basename(process.execPath), uiFiles: Object.keys(ui).length }));
