"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import SidebarPane from "./components/SidebarPane";

const TimeSlider = dynamic(() => import("./components/time_slider"), { ssr: false });
const HeightMesh_Shaders = dynamic(() => import("./components/HeightMesh_Shaders"), { ssr: false });

export default function Home() {
  const initial = useMemo(() => "2017080100", []);
  const [datehour, setDatehour] = useState<string>(initial);

  return (
    <div style={{ display: "flex", flexDirection: "row", width: "100vw", height: "100vh", overflow: "hidden",  }}>
      {/* Main content column (80% width) */}
      <div style={{ flex: "0 0 75%", display: "flex", flexDirection: "column", minWidth: 0,  }}>
        <div style={{ flex: "0 0 80%", position: "relative" }}>
          <HeightMesh_Shaders
            pressureLevel={250}
            datehour={datehour}
            pngUrl={`/api/gph/250/${datehour}`}
            landUrl={`/api/landmask`}
            uvUrl={`/api/uv/250/${datehour}`}
            exaggeration={0.25}
          />
        </div>
        <div style={{ flex: "0 0 20%", borderTop: "1px solid rgba(0,0,0,0.1)" }}>
          <TimeSlider value={datehour} onChange={setDatehour} />
        </div>
      </div>

      {/* Sidebar (20% width) */}
      <div style={{
          flex: "0 0 320px",                 // fixed basis
          width: 320,
          maxWidth: 320,
          minWidth: 0,                        // allow flexbox to constrain it
          height: "100%",
          borderLeft: "1px solid rgba(255,255,255,0.1)",
          overflow: "hidden",                 // host inside will scroll
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "rgba(18,18,20,0.55)",
          // zIndex: 1000,
        }}>
        <SidebarPane />
      </div>
    </div>
  );
}
