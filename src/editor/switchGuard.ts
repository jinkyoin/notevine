// While a note folder switch is under way (FR-VLT-07), the editor takes no changes: its text
// was saved when the switch began, and anything typed after it could only be saved once the
// other folder is open, into a note there with the same path.
import { EditorState } from "@codemirror/state";
import { useApp } from "../store";

export const switchGuard = EditorState.transactionFilter.of((tr) => (tr.docChanged && useApp.getState().switchLocked ? [] : tr));
