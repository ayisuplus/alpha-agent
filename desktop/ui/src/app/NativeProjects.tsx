import { useEffect, useState } from "react";
import { nativeApi, sessionRequest } from "./native-api";
import { NativeModal } from "./NativeModal";
import type { SessionController } from "./useSession";
type Project = { id: string; cwd: string; managed?: boolean; branch?: string; source?: string };
type Worktree = { path: string; branch?: string; detached?: boolean };
export function NativeProjects({ session, onClose }: { session: SessionController; onClose(): void }) {
  const [projects, setProjects] = useState<Project[]>([]), [trees, setTrees] = useState<Worktree[]>([]), [path, setPath] = useState(""), [branch, setBranch] = useState("");
  const [remove, setRemove] = useState<Project | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const load = async () => { const value = await nativeApi<{ projects: Project[] }>("projects"); setProjects(value.projects); if (session.selected && session.opened) try { setTrees(await sessionRequest(session.selected, "host/worktree", { action: "list" })); } catch (cause) { setNotice(String(cause)); } };
  useEffect(() => { void load().catch(cause => setError(String(cause))); }, [session.selected, session.opened]);
  const run = async (action: "add" | "create" | "remove") => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (action === "create") { const result = await sessionRequest<{ path: string; cloneError?: string }>(session.selected!, "host/worktree", { action: "create", branch }); setBranch(""); if (result.cloneError) setNotice(`工作树已创建；原生复制回退：${result.cloneError}`); }
      else { await nativeApi("projects", action === "add" ? { action, cwd: path } : { action, id: remove!.id }); if (action === "add") setPath(""); else setRemove(null); }
      await load();
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  return <NativeModal title="项目与工作树" onCancel={() => { if (!busy) onClose(); }}>
    <label>项目路径<input value={path} onChange={event => setPath(event.target.value)} placeholder="选择本机文件夹" /></label><div className="native-file-actions"><button disabled={busy} onClick={() => void window.alpha?.choosePaths?.("directory").then(value => { if (value[0]) setPath(value[0]); }).catch(cause => setError(String(cause)))}>选择文件夹</button><button disabled={busy || !path.trim()} onClick={() => void run("add")}>添加项目</button></div>
    {projects.map(project => <div className="native-project-item" key={project.id}><strong>{project.cwd.split(/[\\/]/).at(-1)}</strong><small>{project.cwd}{project.branch ? ` · ${project.branch}` : ""}</small><div className="native-file-actions"><button disabled={busy} onClick={() => void session.create(project.cwd).then(ok => { if (ok) onClose(); })}>在此新建任务</button><button disabled={busy} onClick={() => setRemove(project)}>{project.managed ? "清理工作树" : "移出列表"}</button></div></div>)}
    {remove && <div className="native-project-item"><p>{remove.managed ? "确认清理这个 Alpha 工作树？有未提交改动或运行中的任务时会拒绝清理。" : "确认将项目移出列表？项目文件保留。"}</p><code>{remove.cwd}</code><div className="native-file-actions"><button disabled={busy} onClick={() => setRemove(null)}>取消</button><button disabled={busy} onClick={() => void run("remove")}>确认</button></div></div>}
    <h3>当前项目工作树</h3><p className="native-muted">基于当前会话项目创建，沿用原生 OMP 复制规则，保留源项目已有改动。</p>
    {trees.map(tree => <p key={tree.path}><button disabled={busy} onClick={() => void session.create(tree.path).then(ok => { if (ok) onClose(); })}>{tree.branch || "Detached HEAD"}</button> <small>{tree.path}</small></p>)}
    <label>新分支名<input value={branch} onChange={event => setBranch(event.target.value)} placeholder="alpha/my-task" /></label><button disabled={busy || !branch.trim() || !session.selected || !session.opened || session.busy} onClick={() => void run("create")}>创建工作树</button>
    {notice && <p className="native-muted">{notice}</p>}{error && <p role="alert">{error}</p>}<div className="native-dialog-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
  </NativeModal>;
}
