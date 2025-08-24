"use client";

import {useMemo, useState} from "react";
import dynamic from "next/dynamic";

// const CesiumMap = dynamic(() => import("./components/cesium_map"), { ssr: false });
const TimeSlider = dynamic(() => import("./components/time_slider"), { ssr: false });
const HeightMesh = dynamic(() => import("./components/HeightMesh"), { ssr: false });
const HeightMeshRGB24 = dynamic(() => import("./components/HeightMeshRGB24"), { ssr: false });
const HeightMesh_Shaders = dynamic(() => import("./components/HeightMesh_Shaders"), { ssr: false });

export default function Home() {
  const initial = useMemo(() => "2017080100", []);
  const [datehour, setDatehour] = useState<string>(initial);

  return (
    <div style={{display: "flex", flexDirection: "column", width: "100%", height: "100vh"}}>
      <div style={{flex: "0 0 80%", position: "relative"}}>
        {/* <CesiumMap datehour={datehour} /> */}
        {/* <HeightMesh datehour={datehour} /> */}
        {/* <HeightMeshRGB24 pngUrl={`http://localhost:8001/gph/${datehour}`} exaggeration={0.25} />; */}
        <HeightMesh_Shaders pngUrl={`http://localhost:8001/gph/${datehour}`} landUrl={`http://localhost:8001/landMask`} uvUrl={`http://localhost:8001/uv/${datehour}`} exaggeration={0.25} />;
      </div>
      <div style={{flex: "0 0 20%", borderTop: "1px solid rgba(0,0,0,0.1)"}}>
        <TimeSlider value={datehour} onChange={setDatehour} />
      </div>
    </div>
  );
}
