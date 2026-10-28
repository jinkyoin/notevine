import { useApp } from "./store";
import { StartScreen } from "./components/StartScreen";
import { MainLayout } from "./components/MainLayout";
import { Toasts } from "./components/Toasts";
import "./App.css";

export default function App() {
  const vault = useApp((s) => s.vault);
  return (
    <>
      {vault ? <MainLayout /> : <StartScreen />}
      <Toasts />
    </>
  );
}
