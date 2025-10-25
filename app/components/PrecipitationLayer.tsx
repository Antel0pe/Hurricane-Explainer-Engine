// PrecipitationLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { getGlobeRadius } from "../utils/globeInfo";
import { PaneHub } from "./tweaks/PaneHub";

const PRECIP_URL = "/api/precipitation";

export const PRECIP_VERT = `
precision highp float;
precision highp int;

uniform float uRBase;
uniform float uStreakLen;
uniform float uThickness;

uniform sampler2D uPrecip;
uniform float uTexMaxMmPerHr;
uniform float uDensityGain;
uniform float uRefMmPerHr;
uniform int   uMaxPerCell;

// --- NEW uniforms for motion ---
uniform float uTime;           // seconds
uniform float uTopHeight;      // top altitude above globe radius
uniform float uBottomHeight;   // bottom altitude above globe radius (usually 0)
uniform float uFallSpeed;      // world units per second
uniform vec3  uDownWorld;      // normalized world "down" direction (e.g., 0,-1,0)

out float vAlpha;
flat out int vKeep;

// hash for stable per-instance jitter within a cell
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main(){
  // Grid from precipitation texture
  ivec2 texSize = textureSize(uPrecip, 0);
  int cols = texSize.x;
  int rows = texSize.y;

  // Instance id -> (cell, candidate)
  int id = gl_InstanceID;
  int perCell = max(uMaxPerCell, 1);
  int cellIdx = id / perCell;
  int candIdx = id % perCell;

  int row = cellIdx / cols;
  int col = cellIdx - row * cols;
  float fcols = float(cols);
  float frows = float(rows);


  if (row >= rows || col >= cols) {
    vKeep = 0;
    gl_Position = vec4(0.0);
    vAlpha = 0.0;
    return;
  }

  // Sample precip (R: 0..1) -> mm/hr using uTexMaxMmPerHr (e.g., 0.1)
  float r = texelFetch(uPrecip, ivec2(col, row), 0).r;
  float mmph = r * uTexMaxMmPerHr;

  // Stable, time-independent density probability
  float p = clamp((mmph / max(uRefMmPerHr, 1e-6)) * uDensityGain, 0.0, 1.0);
  // Deterministic selection by candidate index (no time dependence)
  vKeep = (float(candIdx) + 0.5 < p * float(perCell)) ? 1 : 0;

  // Cell center lon/lat
  float lon = (float(col) + 0.5) / fcols * 2.0 * 3.141592653589793 - 3.141592653589793;
  float lat = (float(row) + 0.5) / frows * 3.141592653589793 - 1.5707963267948966;

  // Outward unit normal (ECEF)
  float cx = cos(lat), sx = sin(lat);
  float cl = cos(lon), sl = sin(lon);
  vec3 dir = normalize(vec3(cx*cl, sx, cx*sl));   // outward
  vec3 localDown = -dir;                           // radial downward

  // --- Use uDownWorld only to pick the correct "down" sign (optional control)
  // If uDownWorld points opposite to localDown, flip; otherwise keep localDown.
  float sgn = sign(dot(localDown, normalize(uDownWorld)));
  vec3 down = (sgn >= 0.0) ? localDown : -localDown;

  // --- Stateless falling ---
  // corridor endpoints along 'down' from the top to bottom heights
  float topR = uRBase + uTopHeight;
  float botR = uRBase + uBottomHeight;
  vec3 P_top = dir * topR;   // start (higher altitude)
  vec3 P_bot = dir * botR;   // end   (near surface)
  float H = max(length(P_top - P_bot), 1e-4);    // path length
  float T_fall = max(H / max(uFallSpeed, 1e-4), 1e-3);

  // Stable per-drop phase in [0,1)
  float phase = hash13(vec3(float(col), float(row), float(candIdx)));

  // Progress 0..1, wraps via fract
  float u = fract(phase + (uTime / T_fall));

  // Center of the streak along the fall line
  vec3 center = mix(P_top, P_bot, u);

  // Tangent to thicken the streak (same visual behavior as before)
  vec3 up = abs(dir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tangent = normalize(cross(down, up));

  // Instance-local quad coords
  vec2 corner = position.xy;

  // Small stable jitter within cell (unchanged look)
  float j = hash13(vec3(float(col), float(row), float(candIdx) + 7.0));
  vec2 jitter = (j - 0.5) * vec2(0.6, 0.6);

  // Final vertex pos: slide along 'down' for streak length, widen by tangent
  vec3 pos =
      center
    + down    * ((corner.y + jitter.y * 0.2) * uStreakLen)
    + tangent * ((corner.x + jitter.x * 0.2) * uThickness);

  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  vAlpha = 1.0 - abs(corner.y);
}
`;

export const PRECIP_FRAG = `
precision highp float;
precision highp int;

in float vAlpha;
flat in int vKeep;
out vec4 outColor;

void main(){
  if (vKeep == 0) { discard; }
  outColor = vec4(vec3(1.0), vAlpha);
}
`;


type Props = {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  datehour?: string | null;
  onReady?: (mesh: THREE.Mesh, mat: THREE.ShaderMaterial) => void;
};

export default function PrecipitationLayer({
  renderer,
  scene,
  camera,
  datehour,
  onReady,
}: Props) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    if (!renderer || !scene || !camera || !datehour) return;
    let disposed = false;
    const globeR = getGlobeRadius();
    // PaneHub controls
    const disposers: Array<() => void> = [];

    const loader = new THREE.TextureLoader();
    loader.load(
      `${PRECIP_URL}/${datehour}`,
      (t) => {
        if (disposed) { t.dispose(); return; }

        // Texture setup
        t.flipY = false; // using texelFetch, we keep native orientation
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.NearestFilter;
        t.magFilter = THREE.NearestFilter;
        t.colorSpace = THREE.NoColorSpace;
        t.generateMipmaps = false;

        const width = (t.image as HTMLImageElement).width;
        const height = (t.image as HTMLImageElement).height;

        // Choose how many candidates per cell to allow (fixed)
        const maxPerCell = 4; // tweakable in shader via uniform; mesh count uses this fixed value
        const count = width * height * maxPerCell;

        // Geometry: vertical quad
        const geom = new THREE.PlaneGeometry(1, 1);

        // ... inside the TextureLoader onLoad callback, where you create mat/mesh:

        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: PRECIP_VERT,
          fragmentShader: PRECIP_FRAG,
          uniforms: {
            uRBase: { value: globeR },
            uStreakLen: { value: 2.0 },
            uThickness: { value: 0.003 },

            uPrecip: { value: t },
            uTexMaxMmPerHr: { value: 0.1 },
            uDensityGain: { value: 1.0 },
            uRefMmPerHr: { value: 0.02 },
            uMaxPerCell: { value: maxPerCell },

            // --- NEW motion uniforms ---
            uTime: { value: 0.0 },
            uTopHeight: { value: 10.0 },        // top of fall corridor
            uBottomHeight: { value: 2.0 },         // near-surface
            uFallSpeed: { value: 20.0 },        // world units / second
            uDownWorld: { value: new THREE.Vector3(0, -1, 0).normalize() },
          },
          transparent: false,
          depthTest: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide, // keep front only for performance; flip if you need both
        });

        // PaneHub controls (only ones that make sense)
        disposers.push(
          PaneHub.bind(
            "Precipitation",
            {
              uThickness: { type: "number", uniform: "uThickness", min: 0.001, max: 0.2, step: 0.001 },
              uDensityGain: { type: "number", uniform: "uDensityGain", min: 0.0, max: 8.0, step: 0.1 },
              uTopHeight: { type: "number", uniform: "uTopHeight", min: 0, max: 200, step: 1 },
              uBottomHeight: { type: "number", uniform: "uBottomHeight", min: 0, max: 100, step: 1 },
              uFallSpeed: { type: "number", uniform: "uFallSpeed", min: 1, max: 400, step: 1 },
            },
            mat
          )
        );

        // Instanced mesh as before
        const mesh = new THREE.InstancedMesh(geom, mat, count);
        mesh.frustumCulled = false;   // keep your current setting
        mesh.renderOrder = 20;

        // --- NEW: feed uTime every frame (GPU-only animation)
        mesh.onBeforeRender = (_renderer, _scene, _camera) => {
          if (!mat.uniforms) return;
          mat.uniforms.uTime.value = performance.now() * 0.001; // seconds
        };


        scene.add(mesh);
        meshRef.current = mesh;
        matRef.current = mat;
        onReady?.(mesh, mat);

      },
      undefined,
      (err) => console.error("ERA5 Precip load error:", err)
    );

    return () => {
      disposed = true;
      scene.remove(meshRef.current!);

      for (const d of disposers) {
        if (d) d();
      }
      meshRef.current = null;
      matRef.current = null;
    };
  }, [renderer, scene, camera, datehour]);

  return null;
}
