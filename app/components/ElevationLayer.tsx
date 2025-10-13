// TerrainSphereLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";

const API_URL = "/api/elevation"; // ← fill with your uint16 grayscale GEBCO PNG (equirect 4096x2048 etc.)

type Props = {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  sun?: THREE.Object3D | null;  // optional, not required for this POC
  enabled?: boolean;
  baseRadius?: number;  // base radius for globe, default 100
  zOffset?: number;     // meters to lift whole terrain, default 10
  exaggeration?: number; // vertical exaggeration (meters multiplier), default 1.0
  segments?: { width?: number; height?: number }; // sphere segment density
  onReady?: (mesh: THREE.Mesh) => void;
};

// --- Minimal vertex & fragment shaders (POC) ---
// Assumes the height texture is a grayscale PNG with values scaled 0..65535 → normalized to 0..1 by the browser.
// We reconstruct meters by multiplying by uMaxMeters (e.g., 10000 m).
const TERRAIN_VERT = /* glsl */`
precision highp float;

uniform sampler2D uHeightTex;
uniform float uBaseRadius;   // e.g., 100.0
uniform float uZOffset;      // e.g., 10.0
uniform float uExaggeration; // e.g., 1.0
uniform float uMaxMeters;    // e.g., 10000.0
uniform float uMetersToWorld; 
uniform float uLonOffset;

varying float vHeightMeters;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec2 uvShifted = vec2(fract(vUv.x + uLonOffset), vUv.y);

  // Sample height (browser normalizes PNG to 0..1)
  float h01 = texture2D(uHeightTex, uvShifted).r;
  float h_m = clamp(h01 * uMaxMeters, 0.0, uMaxMeters);
    float h_world = h_m * uMetersToWorld;         

  // Radial displacement from unit sphere
  vec3 dir = normalize(position);
  float R = uBaseRadius + uZOffset + uExaggeration * h_world;
  vec3 displaced = dir * R;

  vHeightMeters = h_m;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

const TERRAIN_FRAG = /* glsl */`
precision highp float;

varying float vHeightMeters;
varying vec2 vUv;

uniform float uMaxMeters;

void main() {
  float t = clamp(vHeightMeters / uMaxMeters, 0.0, 1.0);
  gl_FragColor = vec4(vec3(t), 1.0);
}
`;


export default function TerrainSphereLayer({
  renderer,
  scene,
  camera,
  sun = null,
  enabled = true,
  baseRadius = 100,
  zOffset = 10,
  exaggeration = 1.0,
  segments = { width: 256, height: 128 },
  onReady,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  const texRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!enabled || !renderer || !scene || !camera || !API_URL) return;

    let disposed = false;
    const loader = new THREE.TextureLoader();

    loader.load(
      API_URL,
      (tex) => {
        if (disposed) { tex.dispose(); return; }

        // Texture params for an equirect height map
        // Note: Browsers decode PNGs to 8-bit per channel; that's OK for this POC.
        tex.flipY = true; // SphereGeometry UVs expect v=0 at top
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;       // wrap horizontally across 180/-180 seam
        tex.wrapT = THREE.ClampToEdgeWrapping;  // clamp at poles
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        const METERS_TO_WORLD = 100.0 / 6371000.0;

        // Build material
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uHeightTex:    { value: tex },
            uBaseRadius:   { value: baseRadius },
            uZOffset:      { value: zOffset },
            uExaggeration: { value: exaggeration },
            uMaxMeters:    { value: 10000.0 }, // match your PNG scaling (VMAX in your script)
            uMetersToWorld:{ value: METERS_TO_WORLD }, // NEW
            uLonOffset:  { value: 0.25 },
          },
          vertexShader: TERRAIN_VERT,
          fragmentShader: TERRAIN_FRAG,
          transparent: false,
          depthWrite: true,
          side: THREE.FrontSide,
        });

        // Unit sphere; vertex shader sets actual radius via displacement
        const segW = Math.max(8, segments.width ?? 256);
        const segH = Math.max(8, segments.height ?? 128);
        const geo = new THREE.SphereGeometry(1.0, segW, segH);

        const mesh = new THREE.Mesh(geo, mat);
        // Important: Keep object-space radius = 1. Displacement uses dir = normalize(position).
        mesh.frustumCulled = false;

        scene.add(mesh);

        meshRef.current = mesh;
        matRef.current = mat;
        texRef.current = tex;

        onReady?.(mesh);

        // Draw once (your main render loop likely exists elsewhere)
        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("TerrainSphereLayer: failed to load height texture:", err);
      }
    );

    return () => {
      disposed = true;
      if (meshRef.current && scene) scene.remove(meshRef.current);
      (meshRef.current?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      (meshRef.current?.material as THREE.Material | undefined)?.dispose?.();
      meshRef.current = null;

      matRef.current = null;

      texRef.current?.dispose();
      texRef.current = null;
    };
  }, [enabled, renderer, scene, camera, baseRadius, zOffset, exaggeration, segments.width, segments.height]);

  return null;
}
