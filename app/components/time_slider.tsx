"use client";

import {useMemo} from "react";

export interface TimeSliderProps {
  value: string; // YYYYMMDDHH
  onChange: (next: string) => void;
}

function toDate(value: string): Date {
  // Expect YYYYMMDDHH
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(4, 6)) - 1;
  const d = Number(value.slice(6, 8));
  const h = Number(value.slice(8, 10));
  return new Date(Date.UTC(y, m, d, h, 0, 0));
}

function fromDate(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const h = String(dt.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}`;
}

export default function TimeSlider({value, onChange}: TimeSliderProps) {
  const start = useMemo(() => new Date(Date.UTC(2017, 7, 1, 0, 0, 0)), []); // 2017-08-01 00Z
  const end = useMemo(() => new Date(Date.UTC(2017, 8, 30, 23, 0, 0)), []);  // 2017-09-30 23Z

  const totalHours = useMemo(() => Math.floor((end.getTime() - start.getTime()) / 3600000), [start, end]);
  const currentHours = useMemo(() => Math.max(0, Math.min(totalHours, Math.floor((toDate(value).getTime() - start.getTime()) / 3600000))), [value, start, totalHours]);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const hours = Number(e.target.value);
    const dt = new Date(start.getTime() + hours * 3600000);
    onChange(fromDate(dt));
  }

  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8, padding: 12, width: "100%", height: "100%"}}>
      <div style={{display: "flex", justifyContent: "space-between", fontSize: 12}}>
        <span>2017-08-01 00Z</span>
        <span>2017-09-30 23Z</span>
      </div>
      <input
        type="range"
        min={0}
        max={totalHours}
        step={1}
        value={currentHours}
        onChange={handleInput}
        style={{width: "100%"}}
      />
      <div style={{textAlign: "center", fontSize: 12}}>
        {value.slice(0,4)}-{value.slice(4,6)}-{value.slice(6,8)} {value.slice(8,10)}Z
      </div>
    </div>
  );
}


