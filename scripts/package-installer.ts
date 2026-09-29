import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { verifyUiHashes } from "./portable-ui";

const root = resolve(import.meta.dir, "..");
const portable = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) throw new Error("Usage: bun run scripts/package-installer.ts <verified-portable-directory>");
const manifest = JSON.parse(await readFile(join(portable, "release.json"), "utf8"));
if (manifest.format !== 2 || !manifest.ui?.files) throw new Error("Installer requires a verified format-2 portable release");
await verifyUiHashes(join(portable, "desktop", "dist"), manifest.ui.files);
for (const file of ["desktop/main.cjs", "desktop/preload.cjs", "runtime/bun.exe", "runtime/libreoffice/program/soffice.bin", "src/native/server.ts", "node_modules/@oh-my-pi/pi-coding-agent/package.json", "node_modules/@oh-my-pi/pi-natives/package.json"]) {
  if (!(await stat(join(portable, file))).isFile()) throw new Error(`Portable component missing: ${file}`);
}

const releaseRoot = join(root, "release");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = join(releaseRoot, `.alpha-installer-${stamp}-${randomUUID().slice(0, 8)}.staging`);
const finalOutput = join(releaseRoot, `alpha-installer-${stamp}`);
await mkdir(output, { recursive: true });
const builder = join(root, "installer", "node_modules", ".bin", "electron-builder.cmd");
const command = Bun.spawn([builder, "--win", "nsis", "--x64", "--config", join(root, "installer", "electron-builder.cjs")], {
  cwd: join(root, "installer"),
  env: { ...process.env, ALPHA_PORTABLE_DIR: portable, ALPHA_INSTALLER_OUTPUT: output },
  stdout: "inherit", stderr: "inherit",
});
if (await command.exited !== 0) throw new Error("Windows installer build failed");
const bundled = join(output, "win-unpacked", "resources", "alpha");
await verifyUiHashes(join(bundled, "desktop", "dist"), manifest.ui.files);
for (const file of ["src/native/server.ts", "runtime/bun.exe", "node_modules/@oh-my-pi/pi-coding-agent/package.json", "node_modules/@oh-my-pi/pi-natives/package.json"]) {
  if (!(await stat(join(bundled, file))).isFile()) throw new Error(`Installer component missing: ${file}`);
}
const bundledOffice = createHash("sha256").update(await readFile(join(bundled, "runtime", "libreoffice", "program", "soffice.bin"))).digest("hex");
if (bundledOffice !== manifest.office?.sofficeSha256) throw new Error("Installer Office runtime differs from the portable release");
const probe = Bun.spawn([join(bundled, "runtime", "bun.exe"), "run", "scripts/probe-portable.ts", bundled], {
  cwd: bundled, stdout: "pipe", stderr: "pipe", windowsHide: true,
});
const [probeOutput, probeError, probeExit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
if (probeExit !== 0) throw new Error(`Installer payload smoke failed: ${probeError || probeOutput}`);

const version = JSON.parse(await readFile(join(root, "installer", "package.json"), "utf8")).version;
const filename = `Alpha-Setup-${version}-x64.exe`;
const executable = join(output, filename);
if ((await stat(executable)).size < 1_000_000) throw new Error("Installer executable is incomplete");
const hash = createHash("sha256");
for await (const chunk of createReadStream(executable)) hash.update(chunk);
await mkdir(finalOutput, { recursive: false });
await rename(executable, join(finalOutput, filename));
await writeFile(join(finalOutput, "SHA256SUMS.txt"), `${hash.digest("hex")}  ${filename}\r\n`);
await writeFile(join(finalOutput, "build.json"), JSON.stringify({ portable, builtAt: new Date().toISOString(), version, electron: manifest.electron, uiFiles: Object.keys(manifest.ui.files).length, payloadSmoke: "passed", signing: "unsigned" }, null, 2));
const actual = await realpath(output);
if (!actual.startsWith(await realpath(releaseRoot) + sep) || !basename(actual).startsWith(".alpha-installer-")) throw new Error(`Refusing to remove unexpected staging directory: ${actual}`);
await rm(actual, { recursive: true, force: true });
console.log(JSON.stringify({ portable, output: finalOutput, installer: join(finalOutput, filename), sha256: await readFile(join(finalOutput, "SHA256SUMS.txt"), "utf8") }));
