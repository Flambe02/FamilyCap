import { AuthShell } from "./auth-shell";
import "./family.css";

export default function Home() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "local";
  return <div className="version-shell"><AuthShell /><span className="app-version" title={`Commit Git ${version}`}>Version {version}</span></div>;
}
