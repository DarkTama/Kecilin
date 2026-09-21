import { useEffect, useRef } from "react";
import { useT } from "./i18n";

/**
 * Explains the editor in plain words — the trim rail, the fast-forward rail,
 * and what actually ends up in the rendered file.
 *
 * A modal rather than a tooltip: there is enough here to read, and the editor
 * behind it is what the text describes.
 */
export function HelpPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the panel so Escape works without the user clicking inside first.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("helpTitle")}
        onClick={(e) => e.stopPropagation()}
        className="my-8 w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">{t("helpTitle")}</h2>
          <button
            onClick={onClose}
            aria-label={t("helpTitle")}
            className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-5 px-5 py-4 text-sm leading-relaxed text-slate-300">
          <Section title={t("helpTrimTitle")}>
            <p>{t("helpTrimBody")}</p>
            <Legend />
          </Section>

          <Section title={t("helpFfTitle")}>
            <p>{t("helpFfBody")}</p>
            <ul className="ml-4 list-disc space-y-1 text-slate-400">
              <li>{t("helpFfModes")}</li>
              <li>{t("helpFfMulti")}</li>
              <li>{t("helpFfOverlap")}</li>
            </ul>
          </Section>

          <Section title={t("helpPreviewTitle")}>
            <p>{t("helpPreviewBody")}</p>
            <ul className="ml-4 list-disc space-y-1 text-slate-400">
              <li>{t("helpPreviewStrip")}</li>
              <li>{t("helpPreviewCap")}</li>
              <li>{t("helpPreviewAudio")}</li>
            </ul>
          </Section>

          <Section title={t("helpKeysTitle")}>
            <ul className="ml-4 list-disc space-y-1 text-slate-400">
              <li>{t("helpKeysSpace")}</li>
              <li>{t("helpKeysArrows")}</li>
              <li>{t("helpKeysEsc")}</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-400">{title}</h3>
      {children}
    </section>
  );
}

/** The three timeline colours, shown rather than described. */
function Legend() {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-4 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-sm bg-[#10b981]" />
        {t("helpLegendTrim")}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-3 w-3 rounded-sm bg-[#f59e0b]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)",
          }}
        />
        {t("helpLegendSpeed")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-0.5 bg-[#38bdf8]" />
        {t("helpLegendPlayhead")}
      </span>
    </div>
  );
}
