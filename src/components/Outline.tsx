import { useState } from "react";
import { stepHasContent, type Report } from "../types";
import { computeHeadings } from "../headings";
import { PRESET_SECTIONS } from "../template";
import { COVER_PAGE_KEY } from "../wizard";

interface Props {
  report: Report;
  currentKey: string;
  onJump: (pageKey: string) => void;
  onAddStep: (sectionId: string) => void;
  onRemoveStep: (sectionId: string, stepId: string) => void;
  onMoveStep: (sectionId: string, stepId: string, delta: -1 | 1) => void;
  onMoveSection: (sectionId: string, delta: -1 | 1) => void;
  onAddSection: () => void;
  onRemoveSection: (sectionId: string) => void;
  onRenameSection: (sectionId: string, title: string) => void;
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`dot${ok ? " ok" : ""}`} />;
}

export function Outline({
  report,
  currentKey,
  onJump,
  onAddStep,
  onRemoveStep,
  onMoveStep,
  onMoveSection,
  onAddSection,
  onRemoveSection,
  onRenameSection,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const headings = computeHeadings(report);

  return (
    <nav className="nav">
      <div className="nav-heading"><span>文档目录</span><span>OUTLINE</span></div>
      <button
        className={`nav-item nav-cover${currentKey === COVER_PAGE_KEY ? " active" : ""}`}
        onClick={() => onJump(COVER_PAGE_KEY)}
      >
        <Dot ok />
        <span>封面</span>
      </button>

      {report.sections.map((section) => (
        <div className="nav-section" key={section.id}>
          <div className="nav-section-head">
            {section.mode === "plain" ? (
              <button
                className={`nav-item${currentKey === `${section.id}:${section.steps[0].id}` ? " active" : ""}`}
                onClick={() => onJump(`${section.id}:${section.steps[0].id}`)}
              >
                <Dot ok={stepHasContent(section.steps[0])} />
                <span className="nav-text" data-head="section" data-no={headings.section(section.id)?.no ?? ""}>{headings.section(section.id)?.text ?? ""}{section.title}</span>
              </button>
            ) : (
              <button className="nav-item nav-plain" onClick={() => setEditing(section.id)}>
                <Dot ok={section.steps.some(stepHasContent)} />
                <span className="nav-text" data-head="section" data-no={headings.section(section.id)?.no ?? ""}>{headings.section(section.id)?.text ?? ""}{section.title}</span>
              </button>
            )}

            <span className="nav-tools">
              <button className="icon" title="重命名小节" onClick={() => setEditing(section.id)}>
                ✎
              </button>
              <button className="icon" title="上移小节" onClick={() => onMoveSection(section.id, -1)}>
                ↑
              </button>
              <button className="icon" title="下移小节" onClick={() => onMoveSection(section.id, 1)}>
                ↓
              </button>
              <button
                className="icon danger"
                title="删除小节"
                disabled={report.sections.length <= 1}
                onClick={() => onRemoveSection(section.id)}
              >
                ✕
              </button>
            </span>
          </div>

          {editing === section.id && (
            <input
              className="nav-rename"
              autoFocus
              list="preset-sections"
              defaultValue={section.title}
              onBlur={(e) => {
                onRenameSection(section.id, e.target.value.trim() || section.title);
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          )}

          {section.mode === "steps" && (
            <>
              {section.steps.map((step, i) => {
                const key = `${section.id}:${step.id}`;
                const label = headings.step(key);
                return (
                  <div className={`nav-step${currentKey === key ? " active" : ""}`} key={step.id}>
                    <button className="nav-item" onClick={() => onJump(key)}>
                      <Dot ok={stepHasContent(step)} />
                      <span className="nav-text" data-head="step" data-no={label?.no ?? ""}>
                        {label?.text ?? ""}
                        {step.title.trim() || <i key={i} className="muted">未命名</i>}
                      </span>
                    </button>
                    <span className="nav-tools">
                      <button className="icon" onClick={() => onMoveStep(section.id, step.id, -1)}>
                        ↑
                      </button>
                      <button className="icon" onClick={() => onMoveStep(section.id, step.id, 1)}>
                        ↓
                      </button>
                      <button
                        className="icon danger"
                        disabled={section.steps.length <= 1}
                        onClick={() => onRemoveStep(section.id, step.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                );
              })}
              <button className="nav-add" onClick={() => onAddStep(section.id)}>
                ＋ 加一步
              </button>
            </>
          )}
        </div>
      ))}

      <button className="nav-add nav-add-section" onClick={onAddSection}>
        ＋ 加一个小节
      </button>

      <datalist id="preset-sections">
        {PRESET_SECTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </nav>
  );
}
