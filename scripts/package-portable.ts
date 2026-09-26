import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = join(root, "release", `alpha-portable-${stamp}`);
await mkdir(join(root, "release"), { recursive: true });
await mkdir(output, { recursive: false });

for (const source of ["src", "templates", "presets", "desktop/dist", "docs"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target, { recursive: true });
}
for (const source of ["desktop/main.cjs", "desktop/preload.cjs", "scripts/start-desktop.ts", "scripts/verify-inventory.ts", "scripts/run-worker.ts", "scripts/probe-portable-sandbox.ts", "scripts/office-worker.py", "scripts/probe-office-runtime.ts", "package.json", "package-lock.json"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target);
}
await mkdir(join(output, "test", "fixtures"), { recursive: true });
for (const source of ["office-deck.pptx", "office-replacement.png"]) await cp(join(root, "test", "fixtures", source), join(output, "test", "fixtures", source));

const npm = Bun.spawn(["npm.cmd", "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: output, stdout: "inherit", stderr: "inherit" });
if (await npm.exited !== 0) throw new Error(`Production dependency install failed in ${output}`);

const sandboxBin = join(output, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const sandboxSetup = join(output, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "codex-resources", "codex-windows-sandbox-setup.exe");
for (const file of [sandboxBin, sandboxSetup]) if (!(await stat(file)).isFile()) throw new Error(`Portable sandbox component missing: ${file}`);
const sandboxProbe = Bun.spawn([sandboxBin, "sandbox", "--help"], { cwd: output, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, stdout: "pipe", stderr: "pipe" });
if (await sandboxProbe.exited !== 0) throw new Error("Portable sandbox runner did not start independently");

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
  builtAt: new Date().toISOString(),
  bun: Bun.version,
  electron: packageJson.devDependencies.electron,
  omp: packageJson.dependencies["@oh-my-pi/pi-coding-agent"],
  sandboxRunner: packageJson.dependencies["@openai/codex"],
  office: { version: "26.2.5.2", buildId: "cd7284b4cbbfeb507e630c1aac019f4157393acb", sofficeSha256: officeHash, location: "runtime/libreoffice" },
  launch: "Alpha.cmd",
  localData: ["../.alpha", "../products"],
}, null, 2));
await writeFile(join(output, "README.txt"), [
  "Alpha 本机可携带版",
  "",
  "双击 Alpha.cmd 启动桌面工作台。首次运行会在上一级目录创建共享的 products 和 .alpha，供同一 release 目录下的版本使用。",
  "模型凭据沿用当前 Windows 用户的已配置存储；本包不包含凭据、既有产品或任务数据。",
  "本包只在本机启动预览，不上传部署。关闭工作台后预览服务停止；重新打开可在任务中重新发布并复验。",
  "新项目的受限任务使用包内 Windows 沙箱执行器。首次使用需要管理员完成本机初始化；失败时任务暂停，不会改用普通进程执行。",
  "第三方许可证保存在 node_modules 对应包及 node_modules/electron/LICENSE。",
  "离线办公引擎及其许可证保存在 runtime/libreoffice；通过任务附件读取与修改 DOCX、XLSX、PPTX 和 PDF。",
  "",
].join("\r\n"));
const officeProbe = Bun.spawn([join(output, "runtime", "bun.exe"), "run", "scripts/probe-office-runtime.ts"], { cwd: output, env: { ...process.env, ProgramFiles: "C:\\OfficeNotInstalled" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
const [probeOutput, probeError, probeExit] = await Promise.all([new Response(officeProbe.stdout).text(), new Response(officeProbe.stderr).text(), officeProbe.exited]);
if (probeExit !== 0 || !probeOutput.includes('"status":"pass"')) throw new Error(`Bundled Office smoke failed: ${probeError || probeOutput}`);
console.log(JSON.stringify({ output, launcher: join(output, "Alpha.cmd"), runtime: basename(process.execPath) }));
