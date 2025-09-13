// app/api/_lib/shared.ts
import path from "node:path";

export const NX = 1440; // 0.25° global ERA5
export const NY = 721;
export const BOUNDS: [number, number, number, number] = [-180.0, -90.0, 179.75, 90.0];

// read from .env or fallback to "data"
const DATA_FOLDER = process.env.DATA_FOLDER ?? "data";

export function boundsHeaders() {
  return {
    "X-Bounds": BOUNDS.join(","),
    "X-Size": `${NX}x${NY}`,
  };
}

function repoRoot() {
  return process.cwd();
}

export function gphDir(pressureLevel: string) {
  return path.join(repoRoot(), DATA_FOLDER, "gphImages", String(pressureLevel));
}

export function uvDir() {
  return path.join(repoRoot(), DATA_FOLDER, "uv_images", "250");
}

export function landMaskPath() {
  return path.join(repoRoot(), DATA_FOLDER, "landMask.png");
}

export function parseDatehour(value: string): Date {
  const v = value.trim();
  // YYYYMMDDHH or YYYYMMDDHHMM
  if (/^\d{10}$/.test(v)) return new Date(
    Date.UTC(+v.slice(0,4), +v.slice(4,6)-1, +v.slice(6,8), +v.slice(8,10))
  );
  if (/^\d{12}$/.test(v)) return new Date(
    Date.UTC(+v.slice(0,4), +v.slice(4,6)-1, +v.slice(6,8), +v.slice(8,10), +v.slice(10,12))
  );
  // ISO-like: YYYY-MM-DDTHH[:MM][Z]
  const iso = v.replace(/Z$/,"");
  const tryFormats = [
    "%Y-%m-%dT%H", "%Y-%m-%d %H", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M",
  ];
  for (const fmt of tryFormats) {
    const m = matchFormat(iso, fmt);
    if (m) return new Date(Date.UTC(m.y, m.M-1, m.d, m.h, m.min ?? 0));
  }
  throw new Error("Unsupported datehour format");
}

function matchFormat(s: string, fmt: string) {
  const re = fmt
    .replace("%Y","(?<y>\\d{4})")
    .replace("%m","(?<M>\\d{2})")
    .replace("%d","(?<d>\\d{2})")
    .replace("%H","(?<h>\\d{2})")
    .replace("%M","(?<min>\\d{2})")
    .replace(" ","[ ]");
  const m = new RegExp(`^${re}$`).exec(s)?.groups as
    | { y:string; M:string; d:string; h:string; min?:string }
    | undefined;
  if (!m) return null;
  return { y:+m.y, M:+m.M, d:+m.d, h:+m.h, min: m.min ? +m.min : undefined };
}
