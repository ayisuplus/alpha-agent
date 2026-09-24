/** A local build remains trusted code, but it does not inherit model/API credentials by default. */
export function buildChildEnv(): Record<string, string> {
  const allowed = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  return Object.fromEntries(allowed.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}
