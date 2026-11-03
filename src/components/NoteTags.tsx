// 노트 맨 아래 태그 줄: 본문 #태그와 속성 tags를 모아 보이고, 누르면 그 태그로 검색한다.
import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";

import { tx } from "../i18n";
export function NoteTags({ path }: { path: string }) {
  // The index catches up on each save, so reload then.
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    api
      .noteTags(path)
      .then((t) => live && setTags(t))
      .catch(() => live && setTags([]));
    return () => {
      live = false;
    };
  }, [path, savedSeq, externalSeq]);

  if (!tags.length) return null;
  return (
    <div className="note-tags" aria-label={tx("이 노트의 태그")}>
      <span className="label">{tx("태그")}</span>
      {tags.map((t) => (
        <button key={t} title={tx("#{0} 태그로 검색", t)} onClick={() => useApp.getState().searchTag(t)}>
          #{t}
        </button>
      ))}
    </div>
  );
}
