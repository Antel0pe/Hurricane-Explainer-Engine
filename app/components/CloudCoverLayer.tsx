// CloudCoverLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Props = {
  url: string;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  controls: OrbitControls | null;
  enabled?: boolean;
  opacity?: number;    // 0..1 (default 0.85)
  threshold?: number;  // 0..1 (default 0.5)
};

const CLOUD_GLOBE_VERT = /* glsl */`
out vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_GLOBE_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld;
out vec4 fragColor;

uniform sampler2D cloudCoverSource; // equirect RGBA or R in [0,1]
uniform float uOpacity;             // overall opacity
uniform float uThreshold;           // 0..1 cutoff
uniform float uLonOffset;           // seam shift to match your latLonToXYZ
uniform bool  uFlipV;               // flip V if needed

// world → equirect UV (matches your trail mapping: note -z in atan)
vec2 worldToUV(vec3 p){
  vec3 n = normalize(p);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
  float v = 0.5 - lat / 3.141592653589793;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

uniform float uRound;   // 0.0..0.5   (fraction of the shorter side to round; try 0.25)
uniform float uFeather; // 0.0..0.1   (edge softness in cell units; try 0.02)

// choose your tiling resolution in UV (e.g., 256x128 "cells")
uniform vec2 uCellCount;   // e.g., vec2(256.0, 128.0)
uniform float uEdge;       // e.g., 0.02 (edge softness in cell units)

// PI helper
const float PI = 3.141592653589793;

// rounded box SDF: half-size b, corner radius r
float sdRoundBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) - r + min(max(q.x, q.y), 0.0);
}

// --- signed distance to axis-aligned box of half-size b (centered at origin)
float sdBox(vec2 p, vec2 b){
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  vec2 uv = worldToUV(vWorld);
  float c = texture(cloudCoverSource, uv).r; // desired coverage 0..1
  if (c <= 0.0) discard;

  // map to a discrete cell in equirect space
  vec2 cellUV = uv * uCellCount;     // e.g., [0..256) x [0..128)
  vec2 cellId = floor(cellUV);
  vec2 local  = fract(cellUV);       // [0,1)^2 coords within the cell

vec2 center = vec2(0.5); // start centered

// --- neighbor-aware center bias and stretching ---
vec2 texel = 1.0 / uCellCount;

// sample coverage at cell centers (discrete neighbors)
vec2 thisCenterUV = (cellId + 0.5) * texel;
float cL = texture(cloudCoverSource, thisCenterUV + vec2(-texel.x, 0.0)).r;
float cR = texture(cloudCoverSource, thisCenterUV + vec2( texel.x, 0.0)).r;
float cD = texture(cloudCoverSource, thisCenterUV + vec2(0.0, -texel.y)).r;
float cU = texture(cloudCoverSource, thisCenterUV + vec2(0.0,  texel.y)).r;

// pull toward cloudier sides
vec2 pull = vec2(cR - cL, cU - cD);         // “gradient” of coverage
float pullAmt = 1.0;                        // how far we let centers shift
center += pullAmt * pull;                    // shift within the cell
center = clamp(center, vec2(0.2), vec2(0.8)); // keep safely inside

// base square area = c  => side length:
float side = sqrt(clamp(c, 0.0, 1.0));

// stretch toward neighbors so shapes meet
float stretchAmt = 1.0; // 0..1
float sx = 1.0 + stretchAmt * max(cL, cR);
float sy = 1.0 + stretchAmt * max(cD, cU);

// renormalize rectangular area back toward c (pre-rounding)
float preNorm = inversesqrt(max(sx * sy, 1e-4));
vec2 halfSize = 0.5 * side * vec2(sx, sy) * preNorm;

// --- ROUNDING + exact-ish area preservation ---
vec2 size = halfSize * 2.0;                 // w,h of the (pre-round) box
float r0   = uRound * 0.5 * min(size.x, size.y);  // initial corner radius
// area of the rounded rect with r0 (before scaling)
float A0 = size.x * size.y - (4.0 - PI) * r0 * r0;
float Atarget = clamp(c, 0.0, 1.0);         // target cell area fraction

// scale factor to match area (uniform scale keeps aspect & roundness)
float s = (A0 > 1e-6) ? sqrt(Atarget / A0) : 1.0;

// apply scale to half-size and radius
halfSize *= s;
float r = r0 * s;

// SDF and feathered edge
float sdf = sdRoundBox(local - center, halfSize, r);
// inside -> sdf < 0; feather outward by uFeather
float a   = smoothstep(uFeather, 0.0, sdf);

if (a <= 0.0) discard;
fragColor = vec4(1.0, 1.0, 1.0, uOpacity * a);

}


`;

export default function CloudCoverLayer({
  url,
  renderer,
  scene,
  camera,
  controls,
  enabled = true,
  opacity = 0.85,
  threshold = 0.01,
}: Props) {
  const texRef = useRef<THREE.Texture | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef  = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!renderer || !scene || !camera) return;

    let disposed = false;
    const loader = new THREE.TextureLoader();

    loader.load(
      url,
      (texture) => {
        if (disposed) { texture.dispose(); return; }

        // data/atlas texture defaults
        texture.flipY = true;
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.RepeatWrapping;      // longitude wrap
        texture.wrapT = THREE.ClampToEdgeWrapping; // no pole wrap
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const globeRadius = 100;     // match ThreeGlobe default
        const overlayR    = globeRadius + 0.2; // float above the surface

        if (!meshRef.current) {
          // geometry: sphere that matches the globe
          const geom = new THREE.SphereGeometry(overlayR, 256, 128);

          const mat = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader:   CLOUD_GLOBE_VERT,
            fragmentShader: CLOUD_GLOBE_FRAG,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.NormalBlending, // clouds “on top” but not additive
            uniforms: {
              cloudCoverSource: { value: texture },   
              uOpacity:   { value: opacity },
              uThreshold: { value: 0.01 },
              // latLonToXYZ used lon+270° → +0.75; trail used 0.25
              // pick the one that lines up with your globe; try 0.75 first:
              uLonOffset: { value: 0.25 },
              // Your trail layer uses uFlipV = true; match that if needed:
              uFlipV:     { value: true },
              uCellCount: { value: new THREE.Vector2(256, 256)}, // e.g., vec2(256.0, 128.0)
              uEdge: { value: 0.02 },
              uRound: { value: 0.5 },
              uFeather: { value: 0.1 }
            }
          });
          mat.toneMapped = false; 

          const mesh = new THREE.Mesh(geom, mat);
          mesh.frustumCulled = false;
          mesh.renderOrder = 10;
          scene.add(mesh);

          meshRef.current = mesh;
          matRef.current  = mat;
          texRef.current  = texture;
        } else {
          const mat = matRef.current!;
          mat.uniforms.cloudCoverSource.value = texture;

          const prev = texRef.current;
          if (prev && prev !== texture) prev.dispose();
          texRef.current = texture;
        }

        // quick draw
        renderer.render(scene, camera);
      },
      undefined,
      (err) => console.error("CloudCoverLayer texture load error", err)
    );

    return () => {
      disposed = true;
      if (meshRef.current && scene) scene.remove(meshRef.current);
      (meshRef.current?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      (meshRef.current?.material as THREE.Material | undefined)?.dispose?.();
      meshRef.current = null;
      matRef.current  = null;
      texRef.current?.dispose(); texRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera]);

  // live-update simple params without recreating
  useEffect(() => {
    if (!matRef.current) return;
    matRef.current.uniforms.uOpacity.value   = opacity;
    matRef.current.uniforms.uThreshold.value = threshold;
  }, [opacity, threshold]);

  return null;
}
