"use client";

import {useMemo, useEffect, useRef, useCallback} from "react";

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

function safeParseEnvDateHour(envVal: string | undefined, fallback: string): string {
  const v = (envVal ?? "").trim();
  if (/^\d{10}$/.test(v)) return v;
  return fallback;
}

export default function TimeSlider({value, onChange}: TimeSliderProps) {
  // Read public envs (compile-time substitution in Next.js)
  const START_STR = safeParseEnvDateHour(process.env.NEXT_PUBLIC_TIME_START, "2017080100");
  const END_STR   = safeParseEnvDateHour(process.env.NEXT_PUBLIC_TIME_END,   "2017080123");

  const start = useMemo(() => toDate(START_STR), [START_STR]);
  const endRaw = useMemo(() => toDate(END_STR), [END_STR]);

  // Ensure end is not before start; if so, collapse to start
  const end = useMemo(() => (endRaw.getTime() < start.getTime() ? new Date(start) : endRaw), [endRaw, start]);

  const totalHours = useMemo(
    () => Math.max(0, Math.floor((end.getTime() - start.getTime()) / 3600000)),
    [start, end]
  );

  const currentHours = useMemo(() => {
    const curMs = toDate(value).getTime();
    const clampedMs = Math.max(start.getTime(), Math.min(end.getTime(), curMs));
    return Math.max(0, Math.min(totalHours, Math.floor((clampedMs - start.getTime()) / 3600000)));
  }, [value, start, end, totalHours]);

  const currentHoursRef = useRef<number>(currentHours);
  useEffect(() => { currentHoursRef.current = currentHours; }, [currentHours]);

  const totalHoursRef = useRef<number>(totalHours);
  useEffect(() => { totalHoursRef.current = totalHours; }, [totalHours]);

  const step = useCallback((delta: -1 | 1) => {
    const nextHours = Math.max(0, Math.min(totalHoursRef.current, currentHoursRef.current + delta));
    if (nextHours === currentHoursRef.current) return;
    const dt = new Date(start.getTime() + nextHours * 3600000);
    onChange(fromDate(dt));
  }, [onChange, start]);

  useEffect(() => {
    const held = {left: false, right: false};
    let timer: number | null = null;

    const startTimer = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        const dir = held.right && !held.left ? 1 : held.left && !held.right ? -1 : 0;
        if (dir === 0) {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
          return;
        }
        step(dir as -1 | 1);
      }, 100);
    };

    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const isTypingTarget = (el: Element | null) => {
      if (!el) return false;
      const tag = (el as HTMLElement).tagName;
      const editable = (el as HTMLElement).isContentEditable;
      return tag === "INPUT" || tag === "TEXTAREA" || editable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      if (e.key === "ArrowLeft") {
        if (!held.left) {
          held.left = true;
          step(-1);
        }
        startTimer();
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        if (!held.right) {
          held.right = true;
          step(1);
        }
        startTimer();
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "a" || e.key === "ArrowLeft") {
        held.left = false;
      } else if (e.key === "d" || e.key === "ArrowRight") {
        held.right = false;
      }
      if (!held.left && !held.right) stopTimer();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stopTimer();
    };
  }, [step]);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const hours = Number(e.target.value);
    const dt = new Date(start.getTime() + hours * 3600000);
    onChange(fromDate(dt));
  }

  // Labels from env-backed start/end
  const startLabel = `${START_STR.slice(0,4)}-${START_STR.slice(4,6)}-${START_STR.slice(6,8)} ${START_STR.slice(8,10)}Z`;
  const endLabel   = `${END_STR.slice(0,4)}-${END_STR.slice(4,6)}-${END_STR.slice(6,8)} ${END_STR.slice(8,10)}Z`;

  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8, padding: 12, width: "100%", height: "100%"}}>
      <div style={{display: "flex", justifyContent: "space-between", fontSize: 12}}>
        <span>{startLabel}</span>
        <span>{endLabel}</span>
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
