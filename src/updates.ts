// 앱 업데이트. 받은 파일은 서명을 확인한 뒤에만 설치된다(공개키는 tauri.conf.json).
// 인터넷에 접속하는 기능이므로 사용자가 누르거나 켰을 때만 확인한다(NFR-SEC-02).
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "./api";
import { useApp } from "./store";
import { tx } from "./i18n";

/** Looks for a new version and offers it. `quiet`: at start-up, says nothing unless there is one. */
export async function checkForUpdate(quiet: boolean): Promise<void> {
  const { toast, ask, flushEditor } = useApp.getState();
  try {
    const update = await check();
    if (!update) {
      if (!quiet) toast(tx("최신 버전입니다"));
      return;
    }
    const notes = update.body?.trim() ? `\n\n${update.body.trim()}` : "";
    const ok = await ask(tx("새 버전 {0}", update.version), tx("지금 받아 설치하고 Notevine을 다시 시작할까요?{0}", notes), tx("설치"));
    if (!ok) return;
    await flushEditor();
    toast(tx("업데이트를 받는 중입니다…"));
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    if (!quiet) toast(tx("업데이트를 확인하지 못했습니다: {0}", errorMessage(e)), "error");
  }
}
