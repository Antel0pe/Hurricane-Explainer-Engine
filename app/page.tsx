"use client";

import {useMemo, useState} from "react";
import dynamic from "next/dynamic";

const CesiumMap = dynamic(() => import("./components/cesium_map"), { ssr: false });
const TimeSlider = dynamic(() => import("./components/time_slider"), { ssr: false });

export default function Home() {
  const initial = useMemo(() => "2017080100", []);
  const [datehour, setDatehour] = useState<string>(initial);

  return (
    <div style={{display: "flex", flexDirection: "column", width: "100%", height: "100vh"}}>
      <div style={{flex: "0 0 80%", position: "relative"}}>
        <CesiumMap datehour={datehour} />
      </div>
      <div style={{flex: "0 0 20%", borderTop: "1px solid rgba(0,0,0,0.1)"}}>
        <TimeSlider value={datehour} onChange={setDatehour} />
      </div>
    </div>
  );
}
