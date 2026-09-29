# Windows desktop releases

Alpha ships two forms of the same verified desktop payload:

1. Run `bun run package:portable` from the repository root. The command builds a fresh UI, stages the runtime, checks the bundled Office and server/UI, and publishes `release/alpha-portable-*/Alpha.cmd` only after those checks pass.
2. Run `npm ci` in `installer/` once, then `bun run package:exe <absolute portable release directory>` from the repository root. The installer builder copies that exact native OMP payload, checks its UI hashes, Office runtime, and server/UI again, then publishes `release/alpha-installer-*/Alpha-Setup-<version>-x64.exe` with `SHA256SUMS.txt`. The version comes from `installer/package.json`.

The portable launcher stores `.alpha` and `products` beside the release directory. The installer stores them in `%LOCALAPPDATA%\Alpha`; uninstall leaves that user data in place. It installs per user without requesting administrator access for installation. OMP updates are checked once at each startup and only announced, never installed automatically.

The installer is currently unsigned. Windows may show a SmartScreen warning. A production distribution needs a signing certificate and a signing step; a successful local build does not establish code-signing trust.

The installer entry point and Electron Builder dependency are isolated under `installer/`. Both outputs use the same Electron version and the same portable application files. The icon reuses the α mark, Georgia italic typography, and colors already present in the workbench.
