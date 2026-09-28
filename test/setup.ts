import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandboxed commands fail closed instead of provisioning the real Windows sandbox, and verification slots and sandbox
// profiles live in temporary folders rather than the machine-wide ones. Child processes (test servers, workers) inherit both.
process.env.ALPHA_WINDOWS_SANDBOX = "off";
process.env.ALPHA_VERIFICATION_SLOTS ??= mkdtempSync(join(tmpdir(), "alpha-test-slots-"));
process.env.ALPHA_SANDBOX_PROFILES ??= mkdtempSync(join(tmpdir(), "alpha-test-sandbox-profiles-"));
