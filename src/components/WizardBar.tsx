interface Props {
  index: number;
  total: number;
  label: string;
  filled: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
  onHome: () => void;
}

/** 常驻底部的「安装引导」式导航条：永远有一个可点的下一步 */
export function WizardBar({ index, total, label, filled, busy, onPrev, onNext, onFinish, onHome }: Props) {
  const pct = total > 0 ? Math.round(((index + 1) / total) * 100) : 0;
  const isLast = index >= total - 1;

  return (
    <footer className="wizard">
      <div className="wizard-track">
        <div className="wizard-fill" style={{ width: `${pct}%` }} />
      </div>

      <button className="icon" title="回到工程列表" onClick={onHome}>
        ⌂
      </button>

      <div className="wizard-label">
        <span className="wizard-step">
          {index + 1}/{total}
        </span>
        <span className={filled ? "dot ok" : "dot"} />
        <span className="wizard-text">{label}</span>
      </div>

      <div className="wizard-actions">
        <button className="btn" onClick={onPrev} disabled={index === 0}>
          ← 上一步
        </button>
        {!isLast ? (
          <button className="btn btn-primary btn-next" onClick={onNext}>
            下一步 →
          </button>
        ) : (
          <button className="btn btn-primary btn-next" onClick={onFinish} disabled={busy}>
            {busy ? "正在生成…" : "✓ 完成并导出"}
          </button>
        )}
      </div>
    </footer>
  );
}
