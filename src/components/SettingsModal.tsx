import { useState } from "react";
import { DEFAULT_OPTIONS, clearAuthorPrefs } from "../template";
import { HEAD_GLYPHS, HEAD_GLYPH_LABEL, sectionsWithContinuedSteps } from "../headings";
import { sizeLabel, type HeadGlyph, type HeadRestart, type Report, type ReportOptions } from "../types";
import { formatBytes } from "../capture";
import type { BackupInfo, StorageUsage } from "../storage";

interface Props {
  report: Report;
  usage: StorageUsage | null;
  backups: BackupInfo[];
  onClose: () => void;
  onOptions: (patch: Partial<ReportOptions>) => void;
  onRename: (name: string) => void;
  onExportJson: () => void;
  onExportMarkdown: () => void;
  onExportAll: () => void;
  onExportPdfAndClearBackups: () => void;
  onCleanupAssets: () => void;
  onRestoreBackup: (backupId: string) => void;
  onReset: () => void;
}

const SIZE_CHOICES = [21, 24, 28, 32, 36, 44];

function when(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SettingsModal({
  report,
  usage,
  backups,
  onClose,
  onOptions,
  onRename,
  onExportJson,
  onExportMarkdown,
  onExportAll,
  onExportPdfAndClearBackups,
  onCleanupAssets,
  onRestoreBackup,
  onReset,
}: Props) {
  const o = report.options;
  const continued = sectionsWithContinuedSteps(report);
  const [authorForgotten, setAuthorForgotten] = useState(false);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>设置</span>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-group">
            <div className="modal-group-title">工程</div>
            <label className="field wide">
              工程名
              <input value={report.name} onChange={(e) => onRename(e.target.value)} />
            </label>
            <label className="field wide" style={{ marginTop: 12 }}>
              Word 默认文件名
              <input
                value={o.fileNamePattern}
                onChange={(e) => onOptions({ fileNamePattern: e.target.value })}
                placeholder="实验{order}_{studentId}_{name}_{topic}"
              />
            </label>
            <p className="muted">可用变量：&#123;order&#125; 实验序号、&#123;studentId&#125; 学号、&#123;name&#125; 姓名、&#123;topic&#125; 实验标题、&#123;title&#125; 自定义标题、&#123;date&#125; 日期。</p>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={onExportJson}>
                导出本工程 JSON
              </button>
            </div>
          </div>

          <div className="modal-group">
            <div className="modal-group-title">标题编号</div>
            <div className="grid-2">
              <label className="field">
                步骤编号字形
                <select value={o.stepGlyph} onChange={(e) => onOptions({ stepGlyph: e.target.value as HeadGlyph })}>
                  {HEAD_GLYPHS.map((g) => (
                    <option key={g} value={g}>
                      {HEAD_GLYPH_LABEL[g]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                步骤编号在哪重计
                <select value={o.stepRestart} onChange={(e) => onOptions({ stepRestart: e.target.value as HeadRestart })}>
                  <option value="document">全文连续</option>
                  <option value="section">每小节重新</option>
                </select>
              </label>
              <label className="field">
                小节编号字形
                <select value={o.sectionGlyph} onChange={(e) => onOptions({ sectionGlyph: e.target.value as HeadGlyph })}>
                  {HEAD_GLYPHS.map((g) => (
                    <option key={g} value={g}>
                      {HEAD_GLYPH_LABEL[g]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted">
              编号只算一次，左侧目录、纸面、打印、Markdown、导出 Word 显示的是同一套结果；空标题又没内容的占位步骤不占号，所以不会出现 A、B、D 这种空洞。
              标题自己写了编号（如「1. 添加图层」）时系统编号让位给它，纸面上标「沿用原编号」，但该步仍占号。
              小节编号默认「无」，因为预设骨架的小节标题里已经手写了「一、二、三」。
            </p>
            <p className="muted">
              两种重计范围的区别：全文连续 = 三 1. 2. → 四 3.（步骤号跨小节接着数）；每小节重新 = 三 1. 2. → 四 1.（每个小节都从 1. 起）。
            </p>
            {o.stepRestart !== "section" && continued > 0 && (
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => onOptions({ stepRestart: "section" })}>
                  按小节重排编号（{continued} 个小节的第一条不是 1.）
                </button>
              </div>
            )}
          </div>

          <div className="modal-group">
            <div className="modal-group-title">标题字号</div>
            <div className="grid-2">
              <label className="field">
                报告大标题
                <select value={o.titleSize} onChange={(e) => onOptions({ titleSize: Number(e.target.value) })}>
                  {SIZE_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {sizeLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                一、二、三 小节
                <select value={o.subHeadSize} onChange={(e) => onOptions({ subHeadSize: Number(e.target.value) })}>
                  {SIZE_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {sizeLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                1. 2. 3. 步骤
                <select value={o.stepHeadSize} onChange={(e) => onOptions({ stepHeadSize: Number(e.target.value) })}>
                  {SIZE_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {sizeLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                正文
                <select value={o.bodySize} onChange={(e) => onOptions({ bodySize: Number(e.target.value) })}>
                  {SIZE_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {sizeLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted">
              建议保持递减：大标题 {sizeLabel(o.titleSize)} &gt; 小节 {sizeLabel(o.subHeadSize)} &gt; 步骤{" "}
              {sizeLabel(o.stepHeadSize)} &gt; 正文 {sizeLabel(o.bodySize)}
            </p>
          </div>

          <div className="modal-group">
            <div className="modal-group-title">字体与段落</div>
            <div className="grid-2">
              <label className="field">
                标题字体
                <input value={o.headFont} onChange={(e) => onOptions({ headFont: e.target.value })} />
              </label>
              <label className="field">
                正文字体
                <input value={o.bodyFont} onChange={(e) => onOptions({ bodyFont: e.target.value })} />
              </label>
            </div>
            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={o.firstLineIndent}
                  onChange={(e) => onOptions({ firstLineIndent: e.target.checked })}
                />
                正文首行缩进 2 字符
              </label>
              <label className="check">
                <input type="checkbox" checked={o.justify} onChange={(e) => onOptions({ justify: e.target.checked })} />
                正文两端对齐
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={o.pageNumber}
                  onChange={(e) => onOptions({ pageNumber: e.target.checked })}
                />
                页脚显示页码
              </label>
              <label className="check">
                <input type="checkbox" checked={o.toc} onChange={(e) => onOptions({ toc: e.target.checked })} />
                生成目录页（Word 打开后按提示刷新域）
              </label>
            </div>
            <label className="field">
              行距
              <select value={o.lineSpacing} onChange={(e) => onOptions({ lineSpacing: Number(e.target.value) })}>
                <option value={1}>单倍</option>
                <option value={1.25}>1.25 倍</option>
                <option value={1.5}>1.5 倍</option>
                <option value={1.75}>1.75 倍</option>
                <option value={2}>2 倍</option>
              </select>
            </label>
          </div>

          <div className="modal-group">
            <div className="modal-group-title">历史快照（可回滚）</div>
            {backups.length === 0 ? (
              <p className="muted">还没有快照。改一会儿之后会自动留下最近 3 版。</p>
            ) : (
              <div className="backup-list">
                {backups.map((b) => (
                  <div className="backup-row" key={b.id}>
                    <span>{when(b.at)}</span>
                    <span className="muted">
                      {b.name} · {b.done}/{b.total} 项
                    </span>
                    <span className="spacer" />
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        if (confirm(`恢复到 ${when(b.at)} 的快照？当前内容会被这份覆盖（仍会留在快照里）。`)) {
                          onRestoreBackup(b.id);
                        }
                      }}
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="modal-group modal-advanced">
            <summary className="modal-group-title">高级 · 存储 / 备份 / 其他导出</summary>

            <div className="usage-grid">
              <div>
                <span className="muted">浏览器已用</span>
                <b>{usage ? formatBytes(usage.usage) : "读取中…"}</b>
              </div>
              <div>
                <span className="muted">可用额度</span>
                <b>{usage && usage.quota ? formatBytes(usage.quota) : "未知"}</b>
              </div>
              <div>
                <span className="muted">图片</span>
                <b>
                  {usage ? `${usage.images} 张 · ${formatBytes(usage.imageBytes)}` : "…"}
                </b>
              </div>
              <div>
                <span className="muted">工程 / 快照</span>
                <b>{usage ? `${usage.projects} / ${usage.backups}` : "…"}</b>
              </div>
            </div>
            <p className="muted">
              内容存在浏览器本地数据库（IndexedDB）里，图片按内容单独存放，容量通常是几百 MB 到几个 GB。
            </p>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={onCleanupAssets}>
                清理未引用的图片
              </button>
              <button className="btn btn-sm" onClick={onExportAll}>
                导出全部工程（JSON 备份）
              </button>
              <button className="btn btn-sm" onClick={onExportMarkdown}>
                导出 Markdown
              </button>
            </div>
            <p className="muted">
              打印窗口里选「另存为 PDF」并确认已保存后，可以清掉本工程的 3 份 JSON 快照腾空间；清理后仍能继续编辑和导出 Word。
            </p>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={onExportPdfAndClearBackups}>
                导出 PDF 后清理 JSON 快照
              </button>
            </div>
            <div className="btn-row danger-row">
              <button className="btn btn-sm" onClick={() => onOptions({ ...DEFAULT_OPTIONS })}>
                恢复默认排版
              </button>
              <button
                className="btn btn-sm"
                title="只影响新建工程时自动填写，不会清掉已写进工程里的学号姓名"
                onClick={() => {
                  clearAuthorPrefs();
                  setAuthorForgotten(true);
                }}
              >
                {authorForgotten ? "已忘掉记住的学号姓名" : "忘掉记住的学号姓名"}
              </button>
              <button className="btn btn-sm danger" onClick={onReset}>
                清空所有内容（保留小节结构）
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
