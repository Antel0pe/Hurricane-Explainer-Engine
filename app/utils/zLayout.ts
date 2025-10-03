// utils/zLayout.ts
export function clamp(x: number, min: number, max: number) {
  return Math.min(max, Math.max(min, x));
}

// Classic smoothstep: 0..1 easing with zero slope at boundaries
export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Default z layout: clamp pressure to [0, 1000] hPa and
 * smoothly map to [0, 2].
 *
 * Current mapping: 0 hPa -> 0.0  , 1000 hPa -> 2.0
 * If you want the opposite direction (higher altitude on top):
 *  return 2.0 * (1.0 - t);
 */
export function defaultZOffsetForPressure(pressureHpa: number): number {
  const p = clamp(pressureHpa, 0, 1000);
  const t = smoothstep(0, 1000, p);  // t in [0,1] increasing with pressure
  return 2.0 * (1.0 - t);                    // maps to [0,2]
}
