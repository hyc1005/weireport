import { useRef, useState } from "react";
import type { ProjectSummary } from "../storage";
import { coverStyleLabel } from "../cover";
import { deadlineChip, deadlineTone, planDeadline } from "../wizard";

interface Props {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onCreateFrom: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onExportJson: (id: string) => void;
  onImportJson: (file: File) => void;
  onImportDocx?: (file: File) => void;
  resumeProject?: ProjectSummary;
  onResume?: () => void;
}

function rel(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function Home({
  projects,
  onOpen,
  onNew,
  onCreateFrom,
  onDuplicate,
  onDelete,
  onRename,
  onExportJson,
  onImportJson,
  onImportDocx,
  resumeProject,
  onResume,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const docxRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 打开「⋯」菜单的工程 id，同一时刻只开一个 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const visibleProjects = projects.filter((p) => `${p.name} ${p.topic}`.toLowerCase().includes(query.toLowerCase()));

  function pickMenuItem(run: () => void) {
    setMenuFor(null);
    run();
  }

  return (
    <div className="home">
      <div className="workspace-brand">
        <span className="brand-mark">W</span>
        <strong>WebGIS <span>报告工作台</span></strong>
        <span className="local-badge"><i /> 本地保存</span>
      </div>

      <div className="home-actions">
        <button className="btn btn-primary" onClick={onNew}>＋ 新建工程</button>
        <button className="btn" onClick={() => docxRef.current?.click()}>从 Word 导入结构</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>导入 JSON 备份</button>
        <span className="muted">从 Word 导入会先给一份层级预览，确认后才建工程</span>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportJson(f);
            e.target.value = "";
          }}
        />
        <input
          ref={docxRef}
          type="file"
          accept="application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportDocx?.(f);
            e.target.value = "";
          }}
        />
      </div>

      {resumeProject && onResume && (
        <div className="resume-banner">
          <div><strong>继续上次的报告</strong><span>{resumeProject.name} · 已自动保存 {resumeProject.done}/{resumeProject.total} 项</span></div>
          <button className="btn btn-primary btn-sm" onClick={onResume}>继续编辑</button>
        </div>
      )}

      <div className="library-head">
        <div>
          <h2>我的实验报告 <span>{projects.length}</span></h2>
          <p className="muted">双击卡片打开，或从已有报告复用结构</p>
        </div>
        <input className="project-search" aria-label="搜索报告" placeholder="搜索报告名称或主题…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {projects.length === 0 ? (
        <div className="home-empty">
          <h2>还没有任何工程</h2>
          <p className="muted">从课程模板开始，依次记录实验目的、操作步骤和总结。</p>
          <button className="btn btn-primary" onClick={onNew}>＋ 新建第一个工程</button>
        </div>
      ) : (
        <div className="project-grid">
          {visibleProjects.map((p) => {
            const due = planDeadline(p.due, p.total - p.done);
            return (
            <div
              className="project-card"
              key={p.id}
              onDoubleClick={(e) => {
                // 双击只在卡体生效：改名输入框里连点选词、脚部菜单里连点，都不该顺手把工程打开
                if ((e.target as HTMLElement).closest("input, .project-card-foot")) return;
                onOpen(p.id);
              }}
            >
              <div className="project-card-top">
                <span className="project-order">{p.order ? `实验${p.order}` : "未命名"}</span>
                <span className="project-cover">{coverStyleLabel(p.coverStyle)}</span>
              </div>

              {renaming === p.id ? (
                <input
                  className="project-rename"
                  autoFocus
                  defaultValue={p.name}
                  onBlur={(e) => {
                    onRename(p.id, e.target.value.trim() || p.name);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <h3 className="project-name" onClick={() => onOpen(p.id)} title="点击打开">
                  {p.name}
                </h3>
              )}

              <p className="project-topic muted">{p.topic || "（未填主题）"}</p>

              <div className="project-progress">
                <div className="project-track">
                  <div
                    className="project-fill"
                    style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }}
                  />
                </div>
                <span className="muted">
                  {p.done}/{p.total} 项
                </span>
                {due && (
                  <span className={`deadline-chip ${deadlineTone(due)}`} title={`截止日期 ${p.due}`}>
                    {deadlineChip(due)}
                  </span>
                )}
              </div>

              <div className="project-card-foot" onKeyDown={(e) => e.key === "Escape" && setMenuFor(null)}>
                <span className="muted">{rel(p.updatedAt)}</span>
                <span className="spacer" />
                <button className="btn btn-sm" onClick={() => onOpen(p.id)}>
                  打开
                </button>
                <button
                  className="icon"
                  title="更多操作"
                  aria-expanded={menuFor === p.id}
                  onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}
                >
                  ⋯
                </button>
                {menuFor === p.id && (
                  <>
                    <span className="project-menu-mask" onClick={() => setMenuFor(null)} />
                    <div className="project-menu">
                      <button onClick={() => pickMenuItem(() => setRenaming(p.id))}>重命名</button>
                      <button onClick={() => pickMenuItem(() => onDuplicate(p.id))}>复制一份</button>
                      <button onClick={() => pickMenuItem(() => onCreateFrom(p.id))}>只抄结构新建</button>
                      <button onClick={() => pickMenuItem(() => onExportJson(p.id))}>导出 JSON</button>
                      <button
                        className="danger"
                        onClick={() =>
                          pickMenuItem(() => {
                            if (confirm(`删除工程「${p.name}」？不可恢复。`)) onDelete(p.id);
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
      {projects.length > 0 && visibleProjects.length === 0 && <div className="home-empty">没有找到匹配的报告，请换个关键词。</div>}
      <footer className="home-foot"><span>WEBGIS REPORT STUDIO</span><span>数据保存在当前浏览器 · 重要报告建议导出备份</span></footer>
    </div>
  );
}
