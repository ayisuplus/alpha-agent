import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface ProjectMount { id: string; path: string }
export interface ProjectRecord {
  id: string;
  name: string;
  version: number;
  mounts: ProjectMount[];
  permissionMode?: "ask" | "auto" | "full";
  createdAt: string;
  updatedAt: string;
}

function contains(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Reject reparse-point components as well as paths that change identity after mounting. */
export async function canonicalLocalDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !/^[A-Za-z]:[\\/]/.test(input)) throw new Error("Choose an absolute local Windows directory");
  const path = resolve(input);
  const root = parse(path).root;
  if (path === root) throw new Error("A drive root cannot be mounted");
  let cursor = root;
  for (const part of relative(root, path).split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("A mounted directory cannot contain a junction or symbolic link");
  }
  if (!(await stat(path)).isDirectory()) throw new Error("Mount must be a directory");
  const canonical = await realpath(path);
  if (canonical.toLowerCase() !== path.toLowerCase()) throw new Error("Mounted directory changed during validation");
  return canonical;
}

export class ProjectStore {
  private readonly file: string;
  private readonly dataRoot: string;
  private readonly applicationRoot = resolve(import.meta.dir, "../..");
  private queue: Promise<void> = Promise.resolve();
  constructor(dataRoot: string) { this.dataRoot = resolve(dataRoot); this.file = join(this.dataRoot, "projects.json"); }

  private async read(): Promise<ProjectRecord[]> {
    const raw = await readFile(this.file, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]";
      throw error;
    });
    const projects = JSON.parse(raw) as unknown;
    if (!Array.isArray(projects)) throw new Error("Project store is invalid");
    return projects as ProjectRecord[];
  }

  private async save(projects: ProjectRecord[]): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(projects, null, 2));
    await rename(temporary, this.file);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  list(): Promise<ProjectRecord[]> { return this.serial(() => this.read()); }
  get(id: string): Promise<ProjectRecord | null> { return this.serial(async () => (await this.read()).find(item => item.id === id) ?? null); }

  create(name: string): Promise<ProjectRecord> {
    const clean = name?.trim();
    if (!clean || clean.length > 100) throw new Error("Project name must be 1–100 characters");
    return this.serial(async () => {
      const projects = await this.read();
      const now = new Date().toISOString();
      const project: ProjectRecord = { id: randomUUID(), name: clean, version: 1, mounts: [], permissionMode: "ask", createdAt: now, updatedAt: now };
      projects.push(project);
      await this.save(projects);
      return project;
    });
  }

  mount(id: string, sourcePath: string): Promise<ProjectRecord> {
    return this.serial(async () => {
      const path = await canonicalLocalDirectory(sourcePath);
      if (contains(path, this.applicationRoot) || contains(this.applicationRoot, path)) throw new Error("Alpha's own executable directory cannot be mounted");
      if (contains(path, this.dataRoot) || contains(this.dataRoot, path)) throw new Error("Alpha's task data directory cannot be mounted");
      const projects = await this.read();
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error("Project not found");
      if (project.mounts.some(item => contains(item.path, path) || contains(path, item.path))) throw new Error("Mounted folders cannot overlap");
      project.mounts.push({ id: randomUUID(), path });
      project.version++;
      project.updatedAt = new Date().toISOString();
      await this.save(projects);
      return project;
    });
  }

  unmount(id: string, mountId: string): Promise<ProjectRecord> {
    return this.serial(async () => {
      const projects = await this.read();
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error("Project not found");
      const before = project.mounts.length;
      project.mounts = project.mounts.filter(item => item.id !== mountId);
      if (project.mounts.length === before) throw new Error("Mount not found");
      project.version++;
      project.updatedAt = new Date().toISOString();
      await this.save(projects);
      return project;
    });
  }

  setPermission(id: string, permissionMode: "ask" | "auto" | "full"): Promise<ProjectRecord> {
    if (!["ask", "auto", "full"].includes(permissionMode)) throw new Error("Invalid project permission mode");
    return this.serial(async () => {
      const projects = await this.read();
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error("Project not found");
      project.permissionMode = permissionMode;
      project.updatedAt = new Date().toISOString();
      await this.save(projects);
      return project;
    });
  }

  async roots(id: string, version: number): Promise<string[]> {
    const project = await this.get(id);
    if (!project || project.version !== version) throw new Error("Project mounts changed; stop and review this task");
    for (const mount of project.mounts) {
      if ((await canonicalLocalDirectory(mount.path)).toLowerCase() !== mount.path.toLowerCase()) throw new Error("Mounted folder changed identity");
    }
    return project.mounts.map(item => item.path);
  }
}
