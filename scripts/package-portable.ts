import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = join(root, "release", `alpha-portable-${stamp}`);
await mkdir(join(root, "release"), { recursive: true });
await mkdir(output, { recursive: false });

for (const source of ["src", "templates", "presets", "desktop/dist"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target, { recursive: true });
}
for (const source of ["desktop/main.cjs", "desktop/preload.cjs", "scripts/start-desktop.ts", "scripts/verify-inventory.ts", "scripts/run-worker.ts", "package.json", "package-lock.json"]) {
  const target = join(output, source);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(root, source), target);
}

const npm = Bun.spawn(["npm.cmd", "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: output, stdout: "inherit", stderr: "inherit" });
if (await npm.exited !== 0) throw new Error(`Production dependency install failed in ${output}`);

await mkdir(join(output, "node_modules", "electron"), { recursive: true });
await cp(join(root, "node_modules", "electron", "dist"), join(output, "node_modules", "electron", "dist"), { recursive: true });
await cp(join(root, "node_modules", "electron", "LICENSE"), join(output, "node_modules", "electron", "LICENSE"));
await mkdir(join(output, "runtime"), { recursive: true });
await cp(process.execPath, join(output, "runtime", "bun.exe"));

const launcher = '@echo off\r\nsetlocal\r\nset "ALPHA_WORKSPACE_ROOT=%~dp0.."\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\bun.exe" run scripts\\start-desktop.ts\r\n';
await writeFile(join(output, "Alpha.cmd"), launcher);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
await writeFile(join(output, "release.json"), JSON.stringify({
  builtAt: new Date().toISOString(),
  bun: Bun.version,
  electron: packageJson.devDependencies.electron,
  omp: packageJson.dependencies["@oh-my-pi/pi-coding-agent"],
  launch: "Alpha.cmd",
  localData: ["../.alpha", "../products"],
}, null, 2));
await writeFile(join(output, "README.txt"), [
  "Alpha 本机可携带版",
  "",
  "双击 Alpha.cmd 启动桌面工作台。首次运行会在上一级目录创建共享的 products 和 .alpha，供同一 release 目录下的版本使用。",
  "模型凭据沿用当前 Windows 用户的已配置存储；本包不包含凭据、既有产品或任务数据。",
  "本包只在本机启动预览，不上传部署。关闭工作台后预览服务停止；重新打开可在任务中重新发布并复验。",
  "第三方许可证保存在 node_modules 对应包及 node_modules/electron/LICENSE。",
  "",
].join("\r\n"));
console.log(JSON.stringify({ output, launcher: join(output, "Alpha.cmd"), runtime: basename(process.execPath) }));
