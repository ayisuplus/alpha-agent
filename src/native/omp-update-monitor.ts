import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const packages = ["pi-coding-agent", "pi-agent-core", "pi-natives", "omptype"] as const;
type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`Unsupported OMP version: ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parts(left), b = parts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i]! - b[i]!);
  return 0;
}

export async function latestOmpVersion(fetcher: RegistryFetch = fetch): Promise<string> {
  const versions = await Promise.all(packages.map(async name => {
    const response = await fetcher(`https://registry.npmjs.org/@oh-my-pi%2F${name}/latest`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`${name}: npm registry HTTP ${response.status}`);
    const data = await response.json() as { version?: string };
    if (typeof data.version !== "string") throw new Error(`${name}: npm registry omitted version`);
    return data.version;
  }));
  if (!versions.every(version => version === versions[0])) throw new Error(`OMP packages are still publishing: ${versions.join(", ")}`);
  return versions[0]!;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  checkedAt: string | null;
  available: boolean;
  notifiedVersion: string | null;
  dismissedVersion: string | null;
  error: string | null;
}

export class OmpUpdateMonitor {
  readonly current: string;
  readonly file: string;
  #status: UpdateStatus;
  #running: Promise<UpdateStatus> | null = null;
  #saveQueue = Promise.resolve();

  constructor(current: string, dataRoot: string, private readonly fetcher: RegistryFetch = fetch) {
    this.current = current;
    this.file = join(dataRoot, "native", "omp-update.json");
    this.#status = { current, latest: null, checkedAt: null, available: false, notifiedVersion: null, dismissedVersion: null, error: null };
  }

  async start(): Promise<void> {
    const saved = await readFile(this.file, "utf8").then(text => JSON.parse(text) as Partial<UpdateStatus>, () => null).catch(() => null);
    if (saved) this.#status = { ...this.#status, latest: saved.latest ?? null, checkedAt: saved.checkedAt ?? null,
      notifiedVersion: saved.notifiedVersion ?? null, dismissedVersion: saved.dismissedVersion ?? null, available: saved.latest ? compareVersions(saved.latest, this.current) > 0 : false };
    await this.check();
  }

  status(): UpdateStatus { return { ...this.#status }; }

  check(): Promise<UpdateStatus> {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      try {
        const latest = await latestOmpVersion(this.fetcher);
        this.#status = { ...this.#status, latest, checkedAt: new Date().toISOString(), available: compareVersions(latest, this.current) > 0, error: null };
      } catch (error) {
        this.#status = { ...this.#status, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      }
      await this.#persist();
      return this.status();
    })().finally(() => { this.#running = null; });
    return this.#running;
  }

  async markNotified(version: string): Promise<void> {
    if (!this.#status.available || version !== this.#status.latest) throw new Error("No matching OMP update to acknowledge");
    this.#status.notifiedVersion = version;
    await this.#persist();
  }

  async dismiss(version: string): Promise<void> {
    if (!this.#status.available || version !== this.#status.latest) throw new Error("No matching OMP update to dismiss");
    this.#status.dismissedVersion = version;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const value = JSON.stringify(this.#status, null, 2);
    this.#saveQueue = this.#saveQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, value);
      await rename(temp, this.file);
    });
    await this.#saveQueue;
  }
}
