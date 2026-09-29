import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { PermissionMode } from "../api/types";
import { newTaskDraft } from "../state/new-task-draft";
import { useStore } from "../state/store";
import { refreshProjects, store } from "../state/workbench";
import "./NewTaskSetup.css";

export function NewTaskSetup() {
  const draft = useStore(newTaskDraft, state => state);
  const projects = useStore(store, state => state.projects);
  const [projectName, setProjectName] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [addingMount, setAddingMount] = useState(false);
  const [checkingSandbox, setCheckingSandbox] = useState(false);
  const [sandboxReady, setSandboxReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProject = projects.find(project => project.id === draft.projectId);

  useEffect(() => { void refreshProjects(); }, []);

  const createProject = async () => {
    try {
      const project = await api.createProject(projectName);
      await refreshProjects();
      newTaskDraft.set({ projectId: project.id, mountId: "" });
      setProjectName(""); setCreatingProject(false); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const addMount = async () => {
    if (!draft.projectId) return;
    try {
      const project = await api.mountProjectFolder(draft.projectId, mountPath);
      await refreshProjects();
      newTaskDraft.set({ mountId: project.mounts.at(-1)?.id ?? "" });
      setMountPath(""); setAddingMount(false); setSandboxReady(false); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const removeMount = async () => {
    if (!draft.projectId || !draft.mountId) return;
    try {
      await api.unmountProjectFolder(draft.projectId, draft.mountId);
      await refreshProjects(); newTaskDraft.set({ mountId: "" }); setSandboxReady(false); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const setPermission = async (permissionMode: PermissionMode) => {
    if (!draft.projectId) return;
    try { await api.setProjectPermission(draft.projectId, permissionMode); await refreshProjects(); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const checkSandbox = async () => {
    if (!draft.projectId || !draft.mountId || checkingSandbox) return;
    setCheckingSandbox(true); setSandboxReady(false);
    try { await api.checkProjectSandbox(draft.projectId, draft.mountId); setSandboxReady(true); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCheckingSandbox(false); }
  };

  return <section className="new-task-setup" aria-label="项目与工作目录">
    <h2>项目与工作目录</h2>
    <label className="setup-field">当前项目
      <select value={draft.projectId} onChange={event => { newTaskDraft.set({ projectId: event.target.value, mountId: "" }); setSandboxReady(false); }}>
        <option value="">临时工作区</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </label>
    <button className="setup-link" type="button" onClick={() => setCreatingProject(value => !value)}>＋ 新建项目</button>
    {creatingProject && <div className="setup-inline"><input value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="项目名称" aria-label="新项目名称" /><button type="button" disabled={!projectName.trim()} onClick={() => void createProject()}>创建</button></div>}
    {selectedProject && <div className="setup-fields">
      <p className="setup-note">{selectedProject.mounts.length ? `已挂载 ${selectedProject.mounts.length} 个文件夹；任务可使用这些目录。` : "此项目使用 Alpha 管理的工作区。"}</p>
      {!!selectedProject.mounts.length && <label className="setup-field">主工作目录
        <select value={draft.mountId} onChange={event => { newTaskDraft.set({ mountId: event.target.value }); setSandboxReady(false); }}>
          <option value="">选择主工作目录</option>{selectedProject.mounts.map(mount => <option key={mount.id} value={mount.id}>{mount.path}</option>)}
        </select>
      </label>}
      <button className="setup-link" type="button" onClick={() => setAddingMount(value => !value)}>＋ 挂载本机文件夹</button>
      {addingMount && <div className="setup-inline"><input value={mountPath} onChange={event => setMountPath(event.target.value)} placeholder="E:\\projects\\my-project" aria-label="要挂载的本机文件夹" /><button type="button" disabled={!mountPath.trim()} onClick={() => void addMount()}>挂载</button></div>}
      {!!draft.mountId && <button className="setup-link muted" type="button" onClick={() => void removeMount()}>卸载所选目录</button>}
      <label className="setup-field">项目默认权限
        <select value={selectedProject.permissionMode ?? "ask"} onChange={event => void setPermission(event.target.value as PermissionMode)}>
          <option value="ask">请求批准</option><option value="auto">帮我批准</option><option value="full">完全放开</option>
        </select>
      </label>
      {!!draft.mountId && <><button className="setup-check" type="button" disabled={checkingSandbox} onClick={() => void checkSandbox()}>{checkingSandbox ? "正在检查沙箱…" : "检查本机沙箱"}</button>
        {sandboxReady && <p className="setup-ready">越界写入、凭据读取、联网和子进程拒绝探针已通过</p>}
        <p className="setup-note">直接操作本机目录前还会重新检查；失败则暂停任务。</p></>}
    </div>}
    <details className="setup-more"><summary>运行方式</summary>
      <label className="setup-field">开始
        <select value={draft.startMode} onChange={event => newTaskDraft.set({ startMode: event.target.value as "plan" | "execute" })}>
          <option value="execute">自动批准计划</option><option value="plan">先规划，审阅后执行</option>
        </select>
      </label>
      <p className="setup-note">两种模式都会先规划：先记录计划，才能执行。自动批准计划在计划记录后立即执行；先规划模式会停下等你审阅。</p>
      <label className="setup-continuation"><input type="checkbox" checked={draft.continueUntilAccepted} onChange={event => newTaskDraft.set({ continueUntilAccepted: event.target.checked })} /> 持续推进至验收或停止条件</label>
    </details>
    {error && <p className="setup-error" role="alert">{error}</p>}
  </section>;
}
