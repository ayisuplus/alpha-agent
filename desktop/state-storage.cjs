const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** Stable desktop preferences/drafts across sidecar ports and application restarts. */
function stateStorage(root) {
  const directory = join(root, ".alpha", "desktop-state");
  mkdirSync(directory, { recursive: true });
  const file = key => {
    if (typeof key !== "string" || !key.startsWith("alpha-") || key.length > 256) throw new Error("Invalid desktop storage key");
    return join(directory, createHash("sha256").update(key).digest("hex") + ".json");
  };
  return {
    getItem(key) { try { return readFileSync(file(key), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    setItem(key, value) {
      if (typeof value !== "string" || Buffer.byteLength(value) > 7_000_000) throw new Error("Desktop state exceeds size limit");
      const target = file(key), temporary = target + ".tmp";
      writeFileSync(temporary, value, "utf8"); renameSync(temporary, target);
    },
    removeItem(key) { try { unlinkSync(file(key)); } catch (error) { if (error.code !== "ENOENT") throw error; } },
  };
}
module.exports = { stateStorage };
