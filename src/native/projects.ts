import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export type Project = { id: string; cwd: string; source?: string; branch?: string; managed?: boolean; createdAt: string };
export class Projects {
  private file: string;
  private queue = Promise.resolve();
  constructor(dataRoot: string) { this.file = join(dataRoot, "native", "projects.json"); }
  async list(): Promise<Project[]> { return readFile(this.file, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; }); }
  private async save(items: Project[]) { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file + ".tmp", JSON.stringify(items)); await rename(this.file + ".tmp", this.file); }
  remember(cwd: string, extra: Partial<Pick<Project, "source" | "branch" | "managed">> = {}) {
    let result: Project;
    const work = this.queue.then(async () => {
      cwd = await realpath(cwd); if (!(await stat(cwd)).isDirectory()) throw new Error("Project directory unavailable");
      const projects = await this.list(); result = projects.find(project => project.cwd.toLowerCase() === cwd.toLowerCase()) ?? { id: randomUUID(), cwd, createdAt: new Date().toISOString() };
      Object.assign(result, extra); if (!projects.includes(result)) projects.push(result); await this.save(projects);
    }); this.queue = work.catch(() => undefined); return work.then(() => result!);
  }
  remove(id: string) { const work = this.queue.then(async () => { const projects = await this.list(); await this.save(projects.filter(project => project.id !== id)); }); this.queue = work.catch(() => undefined); return work; }
}
