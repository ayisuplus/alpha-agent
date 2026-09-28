import type { ExpertSummary, ExpertLine } from "../api/types";
import { expertLineLabel } from "../state/labels";
import { expertForTemplate } from "./ExpertPicker";

interface Starter { line: ExpertLine; title: string; template?: string; prompt: string }

// Examples describe deliverables only; none promises reach, growth or sales.
const STARTERS: Starter[] = [
  { line: "content", title: "小红书种草笔记", template: "xiaohongshu-planner", prompt: "为一款国货护手霜写 3 篇小红书种草笔记：给出标题、封面文案、正文结构和搜索关键词；功效相关说法单独列出，并标注需要核实的来源。" },
  { line: "content", title: "抖音口播脚本", template: "short-video-operator", prompt: "把附件里的公众号文章改写成 60 秒抖音口播脚本：前 3 秒钩子、分镜、字幕要点和发布文案。" },
  { line: "content", title: "发布前合规检查", template: "compliance-reviewer", prompt: "检查附件里的直播带货话术：找出广告法极限词、需要资质的功效表述和需要标注的内容，按风险高低列出修改建议。" },
  { line: "office", title: "销售数据透视", template: "data-sheet-expert", prompt: "把附件中的销售明细整理成按月、按品类的透视表和趋势图，输出 XLSX，并在第一页写三条数据观察。" },
  { line: "development", title: "本地记账网页", prompt: "做一个本地记账网页：可以新增收入和支出、按分类筛选、显示余额，刷新后数据保留，手机宽度也能用。" },
  { line: "game", title: "2D 小游戏策划", template: "game-designer", prompt: "为一个 2D 横版跳跃小游戏设计核心循环、三关的难度曲线和基础数值表，写成可以交给程序实现的文档。" },
];

/** Example briefs for an empty home screen; picking one fills the brief and, when enabled, its expert. */
export function TaskStarters({ experts, onPick }: { experts: ExpertSummary[] | null; onPick(prompt: string, expertId: string): void }) {
  return <section className="task-starters" aria-label="从一个场景开始">
    <h2>从一个场景开始</h2>
    <div className="task-starter-grid">
      {STARTERS.map(starter => {
        const expert = starter.template && experts ? expertForTemplate(experts, starter.template) : undefined;
        return <button key={starter.title} className="task-starter" onClick={() => onPick(starter.prompt, expert?.id ?? "")}>
          <span className="task-starter-line">{expertLineLabel(starter.line)}{expert ? ` · ${expert.name}` : ""}</span>
          <strong>{starter.title}</strong>
          <span className="task-starter-prompt">{starter.prompt}</span>
        </button>;
      })}
    </div>
  </section>;
}
