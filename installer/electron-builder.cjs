const portable = process.env.ALPHA_PORTABLE_DIR;
const output = process.env.ALPHA_INSTALLER_OUTPUT;
if (!portable || !output) throw new Error("ALPHA_PORTABLE_DIR and ALPHA_INSTALLER_OUTPUT are required");

module.exports = {
  appId: "ai.alpha.desktop",
  productName: "Alpha",
  artifactName: "Alpha-Setup-${version}-${arch}.${ext}",
  directories: { output, buildResources: __dirname },
  electronVersion: "41.2.2",
  electronDist: `${portable}/node_modules/electron/dist`,
  files: ["main.cjs", "package.json"],
  extraResources: [
    { from: portable, to: "alpha", filter: ["**/*", "!node_modules/**", "!Alpha.cmd"] },
    { from: `${portable}/node_modules`, to: "alpha/node_modules", filter: ["**/*", "!electron/**"] },
  ],
  win: { target: ["nsis"], icon: "icon.ico", signExecutable: false },
  nsis: { oneClick: true, perMachine: false, installerIcon: "icon.ico", deleteAppDataOnUninstall: false, runAfterFinish: false },
};
