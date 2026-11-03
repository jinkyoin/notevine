// 플러그인 패널 (FR-EXT-02): 플러그인이 notevine.panel로 보여 주는 내용을 오른쪽 패널 아래에 그린다.
// 내용은 정리된 HTML(스크립트·링크·그림 없음)이고, data-action 단추를 누르면 그 플러그인에 알린다.
import { panelAction, usePlugins } from "../plugins";

import { tx } from "../i18n";
export function PluginPanels() {
  const panels = usePlugins((s) => s.panels);
  return (
    <>
      {Object.entries(panels).map(([id, p]) => (
        <section key={id} className="panel-section plugin-panel" data-plugin={id}>
          <h3 className="panel-heading" title={tx("플러그인")}>
            {p.title}
          </h3>
          <div
            className="plugin-body"
            onClick={(e) => {
              const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
              if (!el) return;
              e.preventDefault();
              const values: Record<string, string | boolean> = {};
              e.currentTarget.querySelectorAll<HTMLInputElement>("input[name], textarea[name], select[name]").forEach((f) => {
                values[f.name] = f.type === "checkbox" ? f.checked : f.value;
              });
              panelAction(id, el.dataset.action!, el.dataset.arg, values);
            }}
            dangerouslySetInnerHTML={{ __html: p.html }}
          />
        </section>
      ))}
    </>
  );
}
