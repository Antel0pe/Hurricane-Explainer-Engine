// TemperatureShellLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getTemperatureRangesPerPressureLevel } from "./ShadersLib";
import { PaneHub } from "./tweaks/PaneHub";

export const TEMPERATURE_SHELL_VERT = `
  out vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const TEMPERATURE_SHELL_FRAG = `
  ${getTemperatureRangesPerPressureLevel}
  precision highp float;
  in vec3 vWorldPos;
  out vec4 outColor;

  uniform vec3  uCamPos;
  uniform float uInnerR;
  uniform float uOuterR;

  // Single equirectangular temperature slice (2D)
  uniform sampler2D uTemp2D;

  // Fixed look — not exposed as props per request
  uniform float uOpacity;       // e.g., 0.03
  uniform float uPressure;   

  uniform int uSteps;

    uniform vec3  uPalCold;
    uniform vec3  uPalMid;
    uniform vec3  uPalWarm;
    uniform float uPalMidPos; // 0..1
    uniform int   uPalStops;  // 2 or 3

  const float GLOBAL_MIN_TEMP = -80.0;
  const float GLOBAL_MAX_TEMP =  35.0;


// piecewise gradient: cold -> (mid?) -> warm
vec3 paletteColor(float t) {
  t = clamp(t, 0.0, 1.0);

  if (uPalStops <= 2) {
    return mix(uPalCold, uPalWarm, t);
  }

  float m = clamp(uPalMidPos, 0.0, 1.0);
  if (t <= m) {
    float lt = (m > 1e-6) ? (t / m) : 0.0;
    return mix(uPalCold, uPalMid, lt);
  } else {
    float rt = (1.0 - m > 1e-6) ? ((t - m) / (1.0 - m)) : 1.0;
    return mix(uPalMid, uPalWarm, rt);
  }
}

  void worldToLatLonAlt(vec3 p, out float lat, out float lon, out float altFrac) {
    float r = length(p);
    altFrac = clamp((r - uInnerR) / max(1e-6, (uOuterR - uInnerR)), 0.0, 1.0);
    vec3 n = normalize(p);
    lat = asin(n.y);
    lon = atan(n.z, n.x);
  }

  // Convert a per-level normalized sample x01 (0..1) to a global 0..1 using absolute °C
  float convertPerLevelTemperatureRangeToGlobalTemperatureRange(float x01, float pressure) {
    float minT, maxT;
    getTempRange(pressure, minT, maxT);  // per-level °C range
    float tempC = mix(minT, maxT, x01);  // denormalize to °C
    return clamp((tempC - GLOBAL_MIN_TEMP) / (GLOBAL_MAX_TEMP - GLOBAL_MIN_TEMP), 0.0, 1.0);
  }


  float sampleTemperature2D(vec3 p) {
    float lat, lon, altFrac;
    worldToLatLonAlt(p, lat, lon, altFrac);
    float u = (lon + 3.14159265) / (2.0 * 3.14159265);
    float v = (lat + 1.57079633) / 3.14159265;
    return texture(uTemp2D, vec2(u, v)).r;
  }

    vec3 tempToColor(float temp, float pressure) {
    float t = convertPerLevelTemperatureRangeToGlobalTemperatureRange(temp, pressure);
    return paletteColor(t);
    }

  bool raySphere(vec3 ro, vec3 rd, float R, out float t0, out float t1) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R*R;
    float h = b*b - c;
    if (h < 0.0) return false;
    h = sqrt(h);
    t0 = -b - h;
    t1 = -b + h;
    return true;
  }

  void main() {
    vec3 ro = uCamPos;
    vec3 rd = normalize(vWorldPos - uCamPos);

    float tOuter0, tOuter1;
    if (!raySphere(ro, rd, uOuterR, tOuter0, tOuter1)) { discard; }

    float tInner0, tInner1;
    bool hitInner = raySphere(ro, rd, uInnerR, tInner0, tInner1);

    float tEnter = max(tOuter0, 0.0);
    float tExit  = hitInner ? max(tInner0, 0.0) : tOuter1;
    if (tExit <= tEnter) { discard; }

    // modest steps for perf; tweak as needed
    float dt = (tExit - tEnter) / float(uSteps);

    vec3 accum = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < uSteps; ++i) {
      float ti = tEnter + dt * (float(i) + 0.5);
      vec3 pos = ro + rd * ti;

      float temp = sampleTemperature2D(pos);
      vec3  col  = tempToColor(temp, uPressure);

      float a = uOpacity * (1.0 - alpha);
      accum += col * a;
      alpha += a;

      if (alpha > 0.995) break;
    }

    outColor = vec4(accum, alpha);
    if (outColor.a < 0.001) discard;
  }
`;

function zOffsetPerPressureLevel(pressure: number){
    if (pressure === 250){
        return 15;
    } else if (pressure === 500){
        return 10;
    } else if (pressure === 850){
        return 5;
    } else {
        return 0;
    }
}

function applyPalettePreset(name: string, mat: THREE.ShaderMaterial) {
  const c = (hex: string) => new THREE.Color(hex); // if you prefer sRGB->linear: .convertSRGBToLinear()

  switch (name) {
    case "Blue–Red":
      mat.uniforms.uPalStops.value  = 2;
      mat.uniforms.uPalCold.value.set(c("#3A66FF"));
      mat.uniforms.uPalWarm.value.set(c("#FF4A3A"));
      break;

    case "Ice–Fire":
      mat.uniforms.uPalStops.value  = 3;
      mat.uniforms.uPalCold.value.set(c("#00B3FF"));
      mat.uniforms.uPalMid.value.set(c("#FFE28A"));
      mat.uniforms.uPalWarm.value.set(c("#FF3B1A"));
      mat.uniforms.uPalMidPos.value = 0.45;
      break;

    case "Viridis-ish":
      mat.uniforms.uPalStops.value  = 3;
      mat.uniforms.uPalCold.value.set(c("#440154"));
      mat.uniforms.uPalMid.value.set(c("#2A9D8F"));
      mat.uniforms.uPalWarm.value.set(c("#FDE725"));
      mat.uniforms.uPalMidPos.value = 0.65;
      break;

    case "Magma-ish":
      mat.uniforms.uPalStops.value  = 3;
      mat.uniforms.uPalCold.value.set(c("#000004"));
      mat.uniforms.uPalMid.value.set(c("#B53679"));
      mat.uniforms.uPalWarm.value.set(c("#FCFDBF"));
      mat.uniforms.uPalMidPos.value = 0.55;
      break;

    case "Custom":
    default:
      // leave current colors as-is
      break;
  }

  // optional: force material update; not required for Color uniforms, harmless if set
  mat.needsUpdate = true;
}


type Props = {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  controls: OrbitControls | null; // respected, not required here
  sun: THREE.Object3D | null;     // not used by this shader but kept for API parity

  textureUrl: string; // equirect temperature slice (single pressure level)
  pressure: number;      // single pressure level number (passed to material if you want to branch by level)

  // behavior
  enabled?: boolean;
  autoFrameOnce?: boolean;

  onReady?: (mesh: THREE.Mesh, material: THREE.ShaderMaterial) => void;
};

export default function TemperatureShellLayer({
  renderer,
  scene,
  camera,
  controls,
  sun,
  textureUrl,
  pressure,
  enabled,
  autoFrameOnce,
  onReady,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!renderer || !scene || !camera) return;
    if (!textureUrl) return;

    let disposed = false;

    // fixed radii inside component (no prop defaults per request)
    const globeR = 100.0;
    const shellThickness = zOffsetPerPressureLevel(pressure); // internal constant
    const innerR = globeR;
    const outerR = globeR + shellThickness;

    const paneHubDisposeCleanup: Array<() => void> = [];

    // load 2D texture from URL
    const loader = new THREE.TextureLoader();
    loader.load(
      textureUrl,
      (tex) => {
        if (disposed) { tex.dispose(); return; }

        tex.flipY = false;
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        const geom = new THREE.SphereGeometry(outerR, 128, 64);

        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: TEMPERATURE_SHELL_VERT,
          fragmentShader: TEMPERATURE_SHELL_FRAG,
          uniforms: {
            uCamPos:    { value: new THREE.Vector3() },
            uInnerR:    { value: innerR },
            uOuterR:    { value: outerR },
            uTemp2D:    { value: tex },
            // fixed look (not props)
            uOpacity:   { value: 0.03 },
            uPressure:  { value: pressure },
            uSteps: { value: 40 },
            uPalCold:   { value: new THREE.Color(0.2, 0.4, 1.0) }, // current "cold"
            uPalMid:    { value: new THREE.Color(0.9, 0.9, 0.9) }, // only used if uPalStops=3
            uPalWarm:   { value: new THREE.Color(1.0, 0.3, 0.2) }, // current "warm"
            uPalMidPos: { value: 0.5 },
            uPalStops:  { value: 2 }, // start with 2-stop (cold->warm)

          },
          side: THREE.FrontSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });

        paneHubDisposeCleanup.push(
  PaneHub.bind(
    `Temperature (${pressure} hPa)`,
    {
      Opacity: { type: "number", uniform: "uOpacity", min: 0, max: 1, step: 0.01 },
      Steps:   { type: "number", uniform: "uSteps",   min: 0, max: 100, step: 1 },

      // --- palette controls ---
      Palette: {
        type: "select",
        options: { "Blue–Red": "Blue–Red", "Ice–Fire": "Ice–Fire", "Viridis-ish": "Viridis-ish", "Magma-ish": "Magma-ish", "Custom": "Custom" },
        onChange: (name) => applyPalettePreset(String(name), mat),
        value: "Blue–Red",
      },
      Stops:   { type: "number", uniform: "uPalStops",  min: 2, max: 3, step: 1, value: 2 },
      MidPos:  { type: "number", uniform: "uPalMidPos", min: 0, max: 1, step: 0.01, value: 0.5 },

      Cold: { type: "color", uniform: "uPalCold", value: "#3366FF" },
      Mid:  { type: "color", uniform: "uPalMid",  value: "#EEEEEE" },
      Warm: { type: "color", uniform: "uPalWarm", value: "#FF5533" },
    },
    mat
  )
);


        const mesh = new THREE.Mesh(geom, mat);

        // keep uCamPos synced without a RAF; piggyback on the render cycle
        mesh.onBeforeRender = () => {
          mat.uniforms.uCamPos.value.copy(camera.position);
        };

        scene.add(mesh);
        meshRef.current = mesh;
        matRef.current = mat;

        onReady?.(mesh, mat);
      },
      undefined,
      (err) => {
        console.error("TemperatureShellLayer: texture load error", err);
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
      (matRef.current?.uniforms?.uTemp2D?.value as THREE.Texture | undefined)?.dispose?.();
      meshRef.current = null;
      matRef.current = null;
      
    };
  }, [enabled, renderer, scene, camera, controls, sun, textureUrl, pressure, autoFrameOnce]);

  return null;
}
