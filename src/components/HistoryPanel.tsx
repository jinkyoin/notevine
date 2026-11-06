// SCR-09 히스토리 패널: 현재 노트의 버전을 날짜별로 묶어 최신순으로 보여 준다 (FR-HIS-04).
import { useEffect, useState } from "react";
import { api, type VersionMeta } from "../api";
import { useApp } from "../store";

import { dateLocale, tx } from "../i18n";
export const ORIGIN_LABEL: Record<VersionMeta["origin"], string> = { app: tx("저장"), external: tx("외부 변경"), restore: tx("복원") };

export function sizeDelta(cur: number, prev: number | undefined): string {
  if (prev === undefined) return tx("처음");
  const d = cur - prev;
  if (d === 0) return "±0";
  const abs = Math.abs(d);
  const txt = abs >= 1024 ? `${(abs / 1024).toFixed(1)}KB` : `${abs}B`;
  return (d > 0 ? "+" : "−") + txt;
}

function HistoryNote() {
  const onThisPc = useApp((s) => !!s.vault?.store_on_this_pc);
  return (
    <p className="muted small pad hist-note">
      {onThisPc
        ? tx("드라이브 폴더의 이전 버전은 이 PC에 따로 보관됩니다. 다른 PC에서 고친 내용의 이전 버전은 그 PC에 쌓입니다.")
        : tx("이전 버전은 이 노트 폴더 안의 숨은 .app 폴더에 보관됩니다. 노트를 백업할 때 함께 백업하세요.")}
    </p>
  );
}

export function useVersions(path: string | null): VersionMeta[] {
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  useEffect(() => {
    if (!path) return setVersions([]);
    let stale = false;
    api
      .listVersions(path)
      .then((v) => !stale && setVersions(v))
      .catch(() => !stale && setVersions([]));
    return () => {
      stale = true;
    };
  }, [path, savedSeq, externalSeq]);
  return versions;
}

export function HistoryPanel() {
  const openPath = useApp((s) => s.openPath);
  const setVersionView = useApp((s) => s.setVersionView);
  const versions = useVersions(openPath);
  if (!openPath) return null;

  const groups = new Map<string, { v: VersionMeta; prev?: VersionMeta }[]>();
  versions.forEach((v, i) => {
    const day = new Date(v.saved_at).toLocaleDateString(dateLocale(), { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    groups.set(day, [...(groups.get(day) ?? []), { v, prev: versions[i + 1] }]);
  });

  return (
    <section className="panel-section">
      <h3 className="panel-heading">
        {tx("히스토리")}{" "} <span className="count">{versions.length}</span>
      </h3>
      {versions.length === 0 && <p className="muted small pad">{tx("아직 저장된 버전이 없습니다.")}</p>}
      {[...groups].map(([day, items]) => (
        <div key={day} className="hist-day">
          <div className="hist-date">{day}</div>
          {items.map(({ v, prev }) => (
            <button key={v.id} className="hist-item" onClick={() => setVersionView({ path: openPath, id: v.id })}>
              <span>{new Date(v.saved_at).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}</span>
              <span className={prev ? `hist-tag o-${v.origin}` : "hist-tag"}>{prev ? ORIGIN_LABEL[v.origin] : tx("처음 생성")}</span>
              <span className="muted small">{sizeDelta(v.size, prev?.size)}</span>
            </button>
          ))}
        </div>
      ))}
      <HistoryNote />
    </section>
  );
}
