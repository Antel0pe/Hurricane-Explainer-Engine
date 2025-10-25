// TerrainSphereLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { PaneHub } from "./tweaks/PaneHub";

const API_URL = "/api/elevation";   // uint16 grayscale GEBCO PNG (equirect, e.g., 4096x2048)
const IMG_URL = "/api/earthSurface"; // equirectangular color imagery (≥4K recommended)

type Props = {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  enabled?: boolean;
  baseRadius?: number;                 // default 100
  zOffset?: number;                    // meters, default 10
  exaggeration?: number;               // multiplier on meters, default 1
  lonOffset01?: number;                // fraction of 360° (0.25 = +90°), default 0.25
  segments?: { width?: number; height?: number };
  onReady?: (mesh: THREE.Mesh) => void;
};

// ---- WebGL1 shaders ----
const TERRAIN_VERT = /* glsl */`
precision highp float;

uniform sampler2D uHeightTex;
uniform float uBaseRadius;
uniform float uZOffset;
uniform float uExaggeration;
uniform float uMaxMeters;
uniform float uMetersToWorld;
uniform float uLonOffset01;

varying float vHeightMeters;
varying vec2 vUvShifted;
varying vec3 vWorldDir; 

void main() {
  // shift longitude and wrap horizontally
  vUvShifted = vec2(uv.x + uLonOffset01, uv.y);

  // Height in meters (PNG normalized 0..1)
  float h01 = texture2D(uHeightTex, vUvShifted).r;
  float h_m = clamp(h01 * uMaxMeters, 0.0, uMaxMeters);
  float h_world = h_m * uMetersToWorld;

  // Radial displacement from unit sphere
  vec3 dir = normalize(position);
  float R = uBaseRadius + uZOffset + uExaggeration * h_world;
  vec3 displaced = dir * R;

    // send world-space direction for hemi ambient (normalize to be safe)
  vec3 worldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
  vWorldDir = normalize(worldPos);
  vHeightMeters = h_m;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

const TERRAIN_FRAG = /* glsl */`
precision highp float;

varying float vHeightMeters;
varying vec2  vUvShifted;
varying vec3  vWorldDir;

uniform float      uMaxMeters;
uniform sampler2D  uAlbedoTex;
uniform float      uUseAlbedo;

// Levels (operate in linear space)
uniform float uAlbedoGain;   // 1.0–1.6 typically
uniform float uAlbedoGamma;  // <1.0 brightens mids (e.g., 0.85–0.95)
uniform float uAlbedoBias;   // small +ve floor lift (0.0–0.06)

// Ambient & Hemisphere
uniform float uAmbientStrength;   // 0..2 (overall ambient magnitude)
uniform vec3  uAmbientColor;      // linear color, usually vec3(1.0)

uniform float uHemiStrength;      // 0..1 (how much hemisphere contributes)
uniform vec3  uSkyColor;          // slightly cool/neutral, linear
uniform vec3  uGroundColor;       // neutral/warmer, linear

// Helper: linear-space “levels” adjustment
vec3 applyLevels(vec3 c) {
  // Gain & bias first, then gamma (gamma < 1 brightens mids)
  vec3 x = max(c * uAlbedoGain + vec3(uAlbedoBias), vec3(0.0));
  return pow(x, vec3(uAlbedoGamma));
}

void main() {
  // base color: albedo or grayscale fallback
  float t = clamp(vHeightMeters / uMaxMeters, 0.0, 1.0);
  vec3 baseGray = vec3(t);

  vec3 albedo = texture2D(uAlbedoTex, vUvShifted).rgb;
  vec3 base   = mix(baseGray, albedo, step(0.5, uUseAlbedo));

  // Apply levels
  vec3 leveled = applyLevels(base);

  // Soft ambient + hemisphere (always-lit look)
  // “Up” is world +Y; map dot to 0..1 for blend
  float hemiFac = clamp(0.5 + 0.5 * dot(normalize(vWorldDir), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
  vec3 hemiCol  = mix(uGroundColor, uSkyColor, hemiFac);

  // Combine: multiplicative lighting in linear space
  vec3 lit = leveled * (uAmbientStrength * uAmbientColor + uHemiStrength * hemiCol);

  gl_FragColor = vec4(lit, 1.0);
}
`;

export default function TerrainSphereLayer({
  renderer,
  scene,
  camera,
  enabled = true,
  baseRadius = 100,
  zOffset = 10,
  exaggeration = 1.0,
  lonOffset01 = 0.25, // tweak until coastlines line up (+90° default)
  segments = { width: 256, height: 128 },
  onReady,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef  = useRef<THREE.ShaderMaterial | null>(null);
  const hTexRef = useRef<THREE.Texture | null>(null);
  const aTexRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!enabled || !renderer || !scene || !camera || !API_URL) return;
    const paneHubDisposeCleanup: Array<() => void> = [];

    let disposed = false;
    const loader = new THREE.TextureLoader();
    // 1) Load HEIGHT texture
    loader.load(
      API_URL,
      (heightTex) => {
        if (disposed) { heightTex.dispose(); return; }

        // Height texture setup (safe while debugging)
        heightTex.flipY = true;
        heightTex.colorSpace = THREE.NoColorSpace;
        heightTex.wrapS = THREE.RepeatWrapping;       // we shift/wrap longitude
        heightTex.wrapT = THREE.ClampToEdgeWrapping;  // clamp at poles
        heightTex.minFilter = THREE.NearestFilter;
        heightTex.magFilter = THREE.NearestFilter;
        heightTex.generateMipmaps = false;
        
        heightTex.needsUpdate = true;

        hTexRef.current = heightTex;

        // Build/attach material + mesh immediately so you can see grayscale relief
        const METERS_TO_WORLD = baseRadius / 6371000.0; // 100 units ~ Earth radius

        const mat = new THREE.ShaderMaterial({
          uniforms: {
            // height
            uHeightTex:     { value: heightTex },
            uBaseRadius:    { value: baseRadius },
            uZOffset:       { value: zOffset },
            uExaggeration:  { value: exaggeration },
            uMaxMeters:     { value: 10000.0 },            // matches your PNG scaling VMAX
            uMetersToWorld: { value: METERS_TO_WORLD },
            uLonOffset01:   { value: lonOffset01 },

            // imagery (hooked up once loaded)
            uAlbedoTex:     { value: null },
            uUseAlbedo:     { value: 0.0 },
            // Levels
uAlbedoGain:   { value: 1.25 },   // gentle lift; tune 1.0–1.6
uAlbedoGamma:  { value: 0.92 },   // brighten mids (lower → brighter)
uAlbedoBias:   { value: 0.02 },   // tiny floor lift (avoid crush)

// Ambient & Hemisphere
uAmbientStrength: { value: 1.15 },               // overall brightness anchor
uAmbientColor:    { value: new THREE.Color(1,1,1) },

uHemiStrength: { value: 0.35 },                  // subtle sky/ground variation
uSkyColor:     { value: [0.95, 0.98, 1.00] },    // linear-ish “sky”
uGroundColor:  { value: [0.98, 0.96, 0.94] },    // linear-ish “ground”
          },
          vertexShader: TERRAIN_VERT,
          fragmentShader: TERRAIN_FRAG,
          side: THREE.FrontSide,
          depthWrite: true,
          transparent: false,
        });

        // Controls for your TERRAIN material (levels + ambient/hemi)
paneHubDisposeCleanup.push(
  PaneHub.bind(
    "Terrain Lighting",
    {
      Albedo_Gain: {
        type: "number",
        uniform: "uAlbedoGain",
        min: 0.5,
        max: 2.0,
        step: 0.01,
      },
      Albedo_Gamma: {
        type: "number",
        uniform: "uAlbedoGamma",
        min: 0.50,
        max: 1.50,
        step: 0.01,
      },
      Albedo_Bias: {
        type: "number",
        uniform: "uAlbedoBias",
        min: 0.0,
        max: 0.10,
        step: 0.001,
      },

      Ambient_Strength: {
        type: "number",
        uniform: "uAmbientStrength",
        min: 0.0,
        max: 2.0,
        step: 0.01,
      },

      Hemi_Strength: {
        type: "number",
        uniform: "uHemiStrength",
        min: 0.0,
        max: 1.0,
        step: 0.01,
      },
    },
    mat
  )
);


        const segW = Math.max(8, segments.width ?? 256);
        const segH = Math.max(8, segments.height ?? 128);
        const geo = new THREE.SphereGeometry(1.0, segW, segH);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false; // displaced bounds unknown to Three

        scene.add(mesh);

        meshRef.current = mesh;
        matRef.current  = mat;

        onReady?.(mesh);
        renderer.render(scene, camera);

        // 2) Load ALBEDO (imagery) texture (async; swaps in when ready)
        if (IMG_URL) {
          loader.load(
            IMG_URL,
            (albedo) => {
              if (disposed) { albedo.dispose(); return; }
              albedo.flipY = true;
              albedo.colorSpace = THREE.SRGBColorSpace;
              albedo.wrapS = THREE.RepeatWrapping;
              albedo.wrapT = THREE.ClampToEdgeWrapping;
              albedo.minFilter = THREE.LinearMipmapLinearFilter;
              albedo.magFilter = THREE.LinearFilter;
              albedo.generateMipmaps = true;
              albedo.anisotropy =
                renderer.capabilities.getMaxAnisotropy?.() ?? 1;

albedo.needsUpdate = true;

              aTexRef.current = albedo;

              if (matRef.current) {
                matRef.current.uniforms.uAlbedoTex.value = albedo;
                matRef.current.uniforms.uUseAlbedo.value = 1.0;
              }
            },
            undefined,
            // imagery load error: keep grayscale fallback
            () => {}
          );
        }
      },
      undefined,
      (err) => {
        console.error("TerrainSphereLayer: failed to load height texture:", err);
      }
    );

    return () => {
      disposed = true;
      for (const d of paneHubDisposeCleanup){
        if (d) d();
      }
      if (meshRef.current && scene) scene.remove(meshRef.current);
      (meshRef.current?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      (meshRef.current?.material as THREE.Material | undefined)?.dispose?.();

      matRef.current = null;

      hTexRef.current?.dispose();
      hTexRef.current = null;

      aTexRef.current?.dispose();
      aTexRef.current = null;
    };
  // only re-run when core params change
  }, [enabled, renderer, scene, camera, baseRadius, zOffset, exaggeration, lonOffset01, segments.width, segments.height]);

  return null;
}
