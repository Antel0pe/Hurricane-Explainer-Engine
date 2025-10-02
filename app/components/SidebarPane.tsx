"use client";
import { useEffect, useRef } from "react";
import { PaneHub } from "./tweaks/PaneHub";
import ControlsHelp from "./ControlsHelp";

export default function SidebarPane() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (hostRef.current) PaneHub.attach(hostRef.current); }, []);

  return (
    <aside
      style={{
        position: "relative",
        top: 0,
        right: 0,
        height: "100vh",
        // width: 320,
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(6px)",
        background: "rgba(18,18,20,0.55)",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        zIndex: 1000,
        overflow: "hidden",
      }}
    >
      {/* Your header (optional if you use Tweakpane's title) */}
      {/* <div style={{ padding: 8, color: "#fff", font: "600 12px system-ui" }}>Control Panel</div> */}

      {/* Help card */}
      <ControlsHelp />

      {/* Tweakpane host */}
      <div ref={hostRef} style={{ flex: 1, overflow: "auto", padding: 8 }} />
    </aside>
  );
}
