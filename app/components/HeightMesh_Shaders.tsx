// HeightMesh_Shaders.tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import WindUvLayer from "./WindUVLayer";
import HeightMeshLayer from "./HeightMeshLayer";
import LandMaskLayer from "./LandMaskLayer";
import ThreeGlobe from 'three-globe';

export const min_max_gph_ranges_glsl = `
uniform float uPressure;
void getGphRange(float pressure, out float minRange, out float maxRange) {
    if (pressure == 250.0) {
        minRange = 9600.0;
        maxRange = 11200.0;
    } else if (pressure == 500.0) {
        minRange = 4600.0;
        maxRange = 6000.0;
    } else if (pressure == 850.0) {
        minRange = 1200.0;
        maxRange = 1600.0;
    } else {
        // Default/fallback values
        minRange = 0.0;
        maxRange = 0.0;
    }
}
`;


// Shared GLSL utilities reused by vertex shaders
const get_position_z_shared_glsl = `
  ${min_max_gph_ranges_glsl}

  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }

  float get_position_z(sampler2D tex, vec2 uv, float exaggeration) {
    float minGPHRange, maxGPHRange;
    getGphRange(uPressure, minGPHRange, maxGPHRange);

    float elev = decodeElevation(texture2D(tex, uv).rgb);
    float t = clamp((elev - minGPHRange) / (maxGPHRange - minGPHRange), 0.0, 1.0);
    return exaggeration * t;
  }
`;

const mapUVtoLatLng = `
  float globeRadius = 100.0;
  
  // deg→rad
  float d2r(float d) { return d * 0.017453292519943295; }

  // lat/lon (degrees) -> XYZ in three-globe orientation
    vec3 latLonToXYZ(float latDeg, float lonDeg, float radius) {
      float phi   = d2r(90.0 - latDeg);       // polar
      float theta = d2r(lonDeg + 270.0);      // azimuth
      float x = radius * sin(phi) * cos(theta);
      float z =  -radius * sin(phi) * sin(theta);
      float y =  radius * cos(phi);
      return vec3(x, y, z);
    }
  // get lat/lon from uv
  vec2 getLatLon(vec2 uv){
    return vec2(mix(  90.0, -90.0, uv.y), mix(-180.0, 180.0, uv.x));
  }
`

// Vertex shader: displace plane along Z using decoded elevation
export const VERT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uExaggeration;
  uniform float zOffset;

  ${get_position_z_shared_glsl}
  ${mapUVtoLatLng}

  void main() {
    vUv = uv;
    vec2 latlon = getLatLon(uv);
    vec3 pos = position;
    float altitude = get_position_z(uTexture, uv, uExaggeration) + zOffset;
    // altitude = clamp(altitude, -5.0, 5.0);
    pos.z = position.z + altitude;
    pos = latLonToXYZ(latlon.x, latlon.y, globeRadius + pos.z * 10.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = `
  ${min_max_gph_ranges_glsl}

  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform sampler2D uLandTexture;
  uniform float uExaggeration;
  uniform vec2 uTexelSize;    // 1.0 / (texture width, height)
  uniform vec2 uUvToWorld;    // (aspect, 1.0) to scale UV steps to world XY
  uniform vec3 uLightDir;     // normalized light direction

  // Decode RGB24 to meters: elev_m = ((R<<16)|(G<<8)|B)*0.1 - 10000.0
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    float scaled = R * 65536.0 + G * 256.0 + B;
    return scaled * 0.1 - 10000.0;
  }

  vec3 rampRedBlue(float t) {
    return mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), t);
  }

  void main() {
    // Base color from decoded elevation (red-blue ramp)
    float elevC = decodeElevation(texture2D(uTexture, vUv).rgb);
    float minGPHRange, maxGPHRange;
    getGphRange(uPressure, minGPHRange, maxGPHRange);

    float tC = clamp((elevC - minGPHRange) / (maxGPHRange - minGPHRange), 0.0, 1.0);
    vec3 base = rampRedBlue(tC);

    // Per-pixel normal from finite differences on normalized height (same mapping as vertex displacement)
    float elevR = decodeElevation(texture2D(uTexture, vUv + vec2(uTexelSize.x, 0.0)).rgb);
    float elevU = decodeElevation(texture2D(uTexture, vUv + vec2(0.0, uTexelSize.y)).rgb);
    float tR = clamp((elevR - minGPHRange) / (maxGPHRange - minGPHRange), 0.0, 1.0);
    float tU = clamp((elevU - minGPHRange) / (maxGPHRange - minGPHRange), 0.0, 1.0);

    // Build tangent vectors in world units: delta in X/Y and corresponding Z change
    vec3 dX = vec3(uUvToWorld.x * uTexelSize.x, 0.0, (tR - tC) * uExaggeration);
    vec3 dY = vec3(0.0, uUvToWorld.y * uTexelSize.y, (tU - tC) * uExaggeration);
    vec3 N = normalize(cross(dY, dX));

    // Simple Lambert with ambient so it doesn't get too dark
    float lambert = max(dot(N, normalize(uLightDir)), 0.0);
    float ambient = 0.35;
    float diffuse = 0.65 * lambert;
    vec3 color = base * (ambient + diffuse);

    // Land mask: if land texture is black, force black output; if white, keep color
    vec3 landRgb = texture2D(uLandTexture, vUv).rgb;
    float landWhiteLevel = max(max(landRgb.r, landRgb.g), landRgb.b);
    float isLand = step(0.5, 1.0 - landWhiteLevel);
    color = mix(color, vec3(0.0), isLand * 0.0);

    gl_FragColor = vec4(color, 0.5);
  }
`;

// GLSL3 shared helpers for points (GLSL3-compatible texture())
const GET_POSITION_Z_SHARED_GLSL3 = `
  ${min_max_gph_ranges_glsl}
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }
  float get_position_z_glsl3(sampler2D tex, vec2 uv, float exaggeration) {
    float minGPHRange, maxGPHRange;
    getGphRange(uPressure, minGPHRange, maxGPHRange);

    float elev = decodeElevation(texture(tex, uv).rgb);
    float t = clamp((elev - minGPHRange) / (maxGPHRange - minGPHRange), 0.0, 1.0);
    return exaggeration * t;
  }
`;

// GLSL3 shared helpers for deriving XY from gl_VertexID
const GET_POSITION_XY_SHARED_GLSL3 = `
  vec2 plane_xy_from_uv(vec2 uv, float aspect) {
    return vec2((uv.x - 0.5) * aspect, (uv.y - 0.5));
  }
`;

// GLSL3 helper: map gl_VertexID to subsampled UVs using a fixed integer step
const GET_UV_SUBSAMPLED_GLSL3 = `
  vec2 get_uv_from_vertex_id_subsampled(int gridW, int gridH, int step) {
    int outW = (gridW + step - 1) / step;
    int ii = gl_VertexID % outW;
    int jj = gl_VertexID / outW;
    int srcI = min(gridW - 1, ii * step);
    int srcJ = min(gridH - 1, jj * step);
    return vec2(float(srcI) / float(gridW - 1),
                float(srcJ) / float(gridH - 1));
  }
`;

// GLSL3 helper: sample per-particle offset (RG) from a packed texture using gl_VertexID
const GET_OFFSET_FROM_ID_GLSL3 = `
  vec2 get_offset_from_id(sampler2D offsets, vec2 simSize, int vertexId) {
    int outW = int(simSize.x);
    int outH = int(simSize.y);
    int ii = vertexId % outW;
    int jj = vertexId / outW;
    vec2 simUV = vec2((float(ii) + 0.5) / float(outW),
                      (float(jj) + 0.5) / float(outH));
    return texture(offsets, simUV).rg;
  }
`;

// UV wind points shader (GLSL3): derive per-vertex UV/XY from gl_VertexID
const UV_POINTS_VERT = `
  ${GET_POSITION_Z_SHARED_GLSL3}
  ${GET_POSITION_XY_SHARED_GLSL3}
  ${GET_UV_SUBSAMPLED_GLSL3}
  ${GET_OFFSET_FROM_ID_GLSL3}
  ${mapUVtoLatLng}
  uniform sampler2D uTerrainTexture;
  uniform sampler2D uCurrentPosition;
  uniform vec2 uSimSize;
  uniform float uExaggeration;
  uniform float uAspect;
  uniform float uPointSize;
  uniform int uGridW;
  uniform int uGridH;
  uniform int uStep;
  uniform float uAboveTerrain;
  uniform float zOffset;
  flat out int vId;
  out float particleOpacity;
  void main(){
    vec2 uvIdx = get_uv_from_vertex_id_subsampled(uGridW, uGridH, uStep);
    vec2 uv = texture(uCurrentPosition, uvIdx).rg;
    // vec2 xy = plane_xy_from_uv(uv, uAspect);
    vec2 latlon = getLatLon(uv);
    vec3 basePos = latLonToXYZ(latlon.x, latlon.y, globeRadius);
    // 3) sample field height (0..uExaggeration mapped by your get_position_z_glsl3)
    //    and lift along the outward normal
    float hNorm = get_position_z_glsl3(uTerrainTexture, uv, 1.0); // returns t in [0,1] (because we pass 1.0)
    float hWorld = uExaggeration * 50.0 * hNorm + uAboveTerrain;

    vec3 normal = normalize(basePos);
    vec3 worldPos = basePos + normal * hWorld;

    // 4) position
    vId = gl_VertexID;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos + normal * zOffset, 1.0);

    float totalLife = texture(uCurrentPosition, uvIdx).b;
    float lifeExpended = texture(uCurrentPosition, uvIdx).a;
    float p = clamp(lifeExpended / totalLife, 0.0, 1.0);
    // 0→1 from birth to 0.25
    float fadeIn  = smoothstep(0.0, 0.25, p);
    // 1→0 from 0.75 to death
    float fadeOut = 1.0 - smoothstep(0.75, 1.0, p);

    // full curve: up → hold → down
    float fade = fadeIn * fadeOut;
    gl_PointSize = uPointSize * max(fade, 0.001); // shrink away
  }`;
const UV_POINTS_FRAG = `
  precision highp float;
  flat in int vId;
  uniform sampler2D uCurrentPosition;
  uniform vec2 uSimSize;
  out vec4 fragColor;
  in float particleOpacity;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    if(dot(d,d) > 0.25) discard;
    fragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
`;

const LAT_LNG_TO_UV_CONVERSION = `
// --- constants & helpers (put above main) ---
const float PI = 3.14159265358979323846264;
const float EARTH_R = 6371000.0;                // meters
const float M_PER_DEG_LAT = (2.0 * PI * EARTH_R) / 360.0; // ≈ 111320 m/deg

// Plate carrée mapping helpers
float latFromV(float vTex) {
  // vTex: 0 (top) → 1 (bottom) maps to +90° → −90°
  return 90.0 - 180.0 * vTex;                   // degrees
}

// Convert (u,v) in m/s at latitude (deg) over dt seconds → ΔUV on plate carrée
vec2 deltaUV_from_ms(vec2 uv_mps, float lat_deg, float dt) {
  float phi = radians(lat_deg);
  float cosphi = cos(phi);
  // meters per degree of longitude shrinks by cos(lat); avoid blow-ups near poles
  float m_per_deg_lon = max(M_PER_DEG_LAT * max(cosphi, 1e-6), 1e-6);

  // degrees moved this step
  float dlat_deg = (uv_mps.y * dt) / M_PER_DEG_LAT;
  float dlon_deg = (uv_mps.x * dt) / m_per_deg_lon;

  // degrees → normalized texture UV (note: V increases downward ⇒ minus sign on dlat)
  // WHEN MOVING TO GLOBE RATHER THAN RECTANGLE, REMOVE COSPHI
  float du = (dlon_deg / 360.0);
  float dv = -dlat_deg / 180.0;
  return vec2(du, dv);
}

// Wrap only longitude (U); clamp latitude (V) to avoid pole wrap
vec2 wrapClampUV(vec2 uv) {
  uv.x = fract(uv.x);
  uv.y = clamp(uv.y, 0.0, 1.0);
  return uv;
}
`

const SIM_VERT = `
out vec2 vUv;
void main() {
  vUv = uv;                    
  gl_Position = vec4(position.xy, 0.0, 1.0);  
}
`;

  const SIM_FRAG = `
    ${LAT_LNG_TO_UV_CONVERSION}
    precision highp float;
    in vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D uPrev;
    uniform float uDt, uSpeed;
    uniform vec2  uSize;
    uniform sampler2D uWindTexture;

    const float WIND_GAIN = 5.0;
    const float L_TARGET = 10.0;
    const float DIST_MIN = 0.05;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
    vec2 jitter(vec2 st){
      float a = 6.2831853*hash(st+0.37);
      float r = 0.003 + 0.004*hash(st+0.91); // tune radius
      return vec2(cos(a), sin(a))*r;
    }

    vec2 sampleWindUV(vec2 uv) {
      // wrap so we can step past edges cleanly
      uv = fract(uv);
      vec2 rg = texture(uWindTexture, uv).rg;
      // decode to signed and flip Y like before
      return vec2(rg.r * 2.0 - 1.0, -(rg.g * 2.0 - 1.0));
    }

    void main() {
      vec2 st = (gl_FragCoord.xy - 0.5) / uSize;

      vec4 prev = texture(uPrev, st);
      vec2 position = prev.rg;
      float totalLifeThreshold = prev.b;

      // --- RK2 with physical advection ---
      // Step 1: sample wind at current pos (assumed m/s), convert to ΔUV over (0.5*dt)
      vec2 wind1_ms = sampleWindUV(position) * WIND_GAIN;                // m/s
      float lat1_deg = latFromV(position.y);
      vec2 duv1 = deltaUV_from_ms(wind1_ms, lat1_deg, 0.5 * uDt);

      // Midpoint position
      vec2 midPos = wrapClampUV(position + duv1);

      // Step 2: sample at midpoint and advance full dt with midpoint slope
      vec2 wind2_ms = sampleWindUV(midPos) * WIND_GAIN;                  // m/s
      // wind2_ms = vec2(-1,-1);
      float lat2_deg = latFromV(midPos.y);
      vec2 duv2 = deltaUV_from_ms(wind2_ms, lat2_deg, uDt);

      vec2 newPos = wrapClampUV(position + duv2);
      float lifeExpended = prev.a;
      float movedUV  = length(newPos - position);
      float distanceParticleMoved = max(movedUV, DIST_MIN);
      lifeExpended += distanceParticleMoved / L_TARGET;

      bool particleIsDead = (totalLifeThreshold <= lifeExpended);

      if (particleIsDead) {
        newPos =  st;
        lifeExpended = 0.0;
        totalLifeThreshold = hash(newPos + st) + 1.0;
      }

      fragColor = vec4(newPos, totalLifeThreshold, lifeExpended);
  }
  `
// COPY_VERT (GLSL3)
export const COPY_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// COPY_FRAG (GLSL3)
export const COPY_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;      // readRT texture
uniform vec2 uSrcSize;       // (outW, outH)
uniform vec2 uDstSize;       // (trailRT.width, trailRT.height)

// Map each destination pixel to the corresponding source pixel (nearest)
void main() {
  vec2 dstPix  = gl_FragCoord.xy - vec2(0.5);
  vec2 srcPix  = dstPix * (uSrcSize / uDstSize) + vec2(0.5);
  vec2 srcUV   = srcPix / uSrcSize;
  fragColor    = texture(uSrc, srcUV);
}
`;
// PREVIEW_VERT (GLSL3)
export const PREVIEW_VERT = /* glsl */`
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// PREVIEW_FRAG (GLSL3)
export const PREVIEW_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex; // trailRT texture

void main(){
  vec4 c = texture(uTex, vUv);
  float exists = step(0.0001, max(max(c.r, c.g), max(c.b, c.a)));
  fragColor = vec4(0.0, exists,0.0, 1.0);
}
`;

// OVERLAY (screen-space) quad to composite trailRT onto the main canvas
export const TRAIL_OVERLAY_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const TRAIL_OVERLAY_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTrail;
void main() {
  // trailRT is black (0) with white dots; additive blending ignores black
  vec3 c = texture(uTrail, vUv).rgb;
  fragColor = vec4(c, 1.0);
}
`;

export const TRAIL_STAMP_MIN_VERT = /* glsl */`
${GET_UV_SUBSAMPLED_GLSL3}         // you already have this chunk
uniform sampler2D uCurrentPosition; // RG = (u,v)
uniform int   uGridW, uGridH, uStep;
uniform float uPointSize;

void main() {
  vec2 uvIdx = get_uv_from_vertex_id_subsampled(uGridW, uGridH, uStep);
  vec2 uv    = texture(uCurrentPosition, uvIdx).rg;

  // map (u,v in 0..1) → clip-space (-1..+1), flip V so v=0 is top row
  vec2 ndc = vec2(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
`;

export const TRAIL_GLOBE_VERT = /* glsl */`
out vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_PointSize = 1.0;
}
`;

export const TRAIL_GLOBE_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld; out vec4 fragColor;
uniform sampler2D uTrailTex;
uniform float uOpacity;
uniform vec3  uTint;
uniform float uLonOffset;  // seam shift; +270° → 0.75
uniform bool  uFlipV;

// world → equirect UV (match your latLonToXYZ that used z = -sin(theta))
vec2 worldToUV(vec3 p){
  vec3 n = normalize(p);
  float lat = asin(clamp(n.y, -1.0, 1.0));    // [-pi/2, pi/2]
  float lon = atan(-n.z, n.x);                 // NOTE the minus on z
  float u = fract(lon / (2.0*3.14159265) + 0.5 + uLonOffset);
  float v = 0.5 - lat / 3.14159265;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

void main(){
  vec2 uv = worldToUV(vWorld);
  vec3 t  = texture(uTrailTex, uv).rgb;
  float I = clamp(max(max(t.r, t.g), t.b), 0.0, 1.0);
  vec3  C = uTint * I;
  fragColor = vec4(C, I * uOpacity);
}
`;

export const TRAIL_DECAY_VERT = `
// COPY_MIN_VERT (GLSL3)
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const TRAIL_DECAY_FRAG = `
// COPY_MIN_FRAG (GLSL3)
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  vec4 original = texture(uSrc, vUv);
  // fragColor = vec4(0.0, original.g * 0.5, 0.0, 1.0);
  fragColor = original * 0.99;
}
`;

export type WindLayerAPI = {
  simScene: THREE.Scene;
  simCam: THREE.OrthographicCamera;
  simMat: THREE.ShaderMaterial;
  readRT: THREE.WebGLRenderTarget;
  writeRT: THREE.WebGLRenderTarget;
  ptsMat: THREE.ShaderMaterial;
  outW: number;
  outH: number;
  trailReadRT: THREE.WebGLRenderTarget;
  trailWriteRT: THREE.WebGLRenderTarget;
  trailScene: THREE.Scene;
trailPtsMat: THREE.ShaderMaterial;
trailStampScene: THREE.Scene;
trailStampCam: THREE.OrthographicCamera;
trailStampMat: THREE.ShaderMaterial;
trailOverlayMesh: THREE.Mesh;
trailOverlayMat: THREE.ShaderMaterial;
decayScene:THREE.Scene;
decayCam: THREE.OrthographicCamera;
decayMat: THREE.ShaderMaterial;
};

type Props = { pngUrl: string; landUrl?: string; uvUrl?: string; exaggeration?: number, pressureLevel?: number, datehour?: string };

export default function HeightMesh_Shaders({ pngUrl, landUrl, uvUrl, exaggeration, pressureLevel, datehour }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const meshRef2 = useRef<THREE.Mesh | null>(null);
  const meshRef3 = useRef<THREE.Mesh | null>(null);
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const landTexRef = useRef<THREE.Texture | null>(null);
  const [landTexVersion, setLandTexVersion] = useState(0);
  const [heightTexVersion, setHeightTexVersion] = useState(0);
  const [heightTexVersion2, setHeightTexVersion2] = useState(0);
  const [heightTexVersion3, setHeightTexVersion3] = useState(0);
  const heightTexRef = useRef<THREE.Texture | null>(null);
  const heightTexRef2 = useRef<THREE.Texture | null>(null);
  const heightTexRef3 = useRef<THREE.Texture | null>(null);
  const uvTexRef = useRef<THREE.Texture | null>(null);
  const uvPointsRef = useRef<THREE.Points | null>(null);
  const uvGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const uvMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const uvDimsRef = useRef<{ w: number; h: number } | null>(null);
  const readPositionRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const writePositionRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const simDimsRef = useRef<{ w: number; h: number } | null>(null);
  const windLayersSetRef = useRef<Set<WindLayerAPI>>(new Set());
  const [engineReady, setEngineReady] = useState(false);

  useEffect(() => {
  const host = hostRef.current!;
  const getSize = () => {
    const r = host.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };
  const { w, h } = getSize();

  // --- renderer / scene / camera ---
  const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2 });
  renderer.autoClear = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f9fc);

  const globe = new ThreeGlobe()
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-day.jpg');
  scene.add(globe);

  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1e9);
  camera.up.set(0, 1, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // let three globe load in
  camera.position.set(0, -300, 150);  // any non-zero radius > 100 works
controls.target.set(0, 0, 0);
controls.update();
renderer.render(scene, camera);    

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(1.5, 1.0, 2.0).multiplyScalar(1000);
  scene.add(sun);

  let stopped = false;

  // --- render-on-demand (guarded; no recursive re-entry) ---
  let rafId: number | null = null;
  let animating = false;

  const render = () => renderer.render(scene, camera);

  const startDampedRAF = () => {
    if (stopped || animating) return; // start only once
    animating = true;

    const tick = () => {
      if (stopped) return;
      const needsUpdate = controls.update(); // may emit 'change'
      render();
      if (needsUpdate) {
        rafId = requestAnimationFrame(tick);
      } else {
        animating = false;
        rafId = null;
      }
    };

    tick();
  };

  const renderOnce = () => {
    if (stopped) return;
    render();
  };

  controls.addEventListener("start", startDampedRAF);
  controls.addEventListener("end", renderOnce);
  controls.addEventListener("change", () => {
    // If damping loop isn't running, at least render this change once.
    if (!animating) renderOnce();
  });

    // ===== Hover-to-rotate (no mousedown) with light inertia =====
  controls.enableRotate = false; // avoid built-in drag rotation (we'll do it)

  // pull bounds from controls so your existing settings still apply
  // const minAz = controls.minAzimuthAngle ?? -Infinity;
  // const maxAz = controls.maxAzimuthAngle ??  Infinity;
  // const minPh = controls.minPolarAngle   ??  0;
  // const maxPh = controls.maxPolarAngle   ??  Math.PI;

  // const elem = renderer.domElement;
  // const up   = camera.up.clone().normalize();

  // // Map camera.up -> +Y like OrbitControls does
  // const quat = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  // const quatInv = quat.clone().invert();

  // const spherical = new THREE.Spherical();
  // const offset    = new THREE.Vector3();

  // // mouse→angle scaling similar to OrbitControls
  // const ROTATE_SPEED = controls.rotateSpeed; // default 1.0
  // const scale = (px: number) => (2 * Math.PI * px / elem.clientHeight) * ROTATE_SPEED;

  // // simple inertia to mimic damping
  // let vTheta = 0, vPhi = 0;           // angular velocity
  // const INERTIA = 0.10;               // 0..1 (higher = more glide)
  // const GAIN    = 0.5;               // 0..1 (how much new mouse delta feeds in)

  // const onMouseMove = (e: MouseEvent) => {
  //   if (e.target !== elem) return;
  //   const dx = (e.movementX ?? 0);
  //   const dy = (e.movementY ?? 0);

  //   // accumulate desired angular velocity from mouse deltas
  //   vTheta += -scale(dx) * GAIN; // azimuth (left/right)
  //   vPhi   += -scale(dy) * GAIN; // polar   (up/down)

  //   startDampedRAF(); // use your existing RAF kicker
  // };

  // apply the velocity each frame, decay with inertia, clamp, and reposition camera
  // const applyOrbitStep = () => {
  //   // 1) current offset in Y-up space
  //   offset.copy(camera.position).sub(controls.target).applyQuaternion(quat);
  //   spherical.setFromVector3(offset);

  //   // 2) integrate velocity
  //   spherical.theta += vTheta;
  //   spherical.phi   += vPhi;

  //   // 3) clamp to OrbitControls-style limits
  //   spherical.theta = Math.max(minAz, Math.min(maxAz, spherical.theta));
  //   spherical.phi   = Math.max(minPh, Math.min(maxPh, spherical.phi));

  //   // 4) write back position (preserve radius)
  //   offset.setFromSpherical(spherical).applyQuaternion(quatInv);
  //   camera.position.copy(controls.target).add(offset);
  //   camera.lookAt(controls.target);

  //   // 5) decay velocity (inertia)
  //   vTheta *= INERTIA;
  //   vPhi   *= INERTIA;

  //   // let OrbitControls dispatch 'change' listeners (your render loop listens to controls.update())
  //   controls.dispatchEvent({ type: 'change' });
  // };

  // hook our step into your damped RAF loop
  // const _origUpdate = controls.update.bind(controls) as () => boolean;
  // controls.update = (): boolean => {
  //   // first, apply our orbit step so camera is up-to-date
  //   applyOrbitStep();
  //   // then run the normal OrbitControls update (handles zoom limits, etc.)
  //   return _origUpdate();
  // };

  // elem.addEventListener('mousemove', onMouseMove);

  // keep wheel zoom & pan working, avoid double-rotate on drag
  // controls.mouseButtons = {
  //   LEFT: THREE.MOUSE.PAN,
  //   MIDDLE: THREE.MOUSE.DOLLY,
  //   RIGHT: THREE.MOUSE.PAN,
  // };

  // // Request pointer lock when clicking the canvas
  // elem.addEventListener("click", () => {
  //   if (document.pointerLockElement !== elem) {
  //     elem.requestPointerLock({ unadjustedMovement: true });
  //   }
  // });

  controls.minPolarAngle = 0.0001;
controls.maxPolarAngle = Math.PI - 0.0001;
controls.minAzimuthAngle = -Infinity;
controls.maxAzimuthAngle =  Infinity;

// ------------------ WASD: walk by camera heading on the globe ------------------
const CENTER = new THREE.Vector3(0, 0, 0);
const pressed = new Set<string>();
let moving = false;
let lastT = performance.now();

const SURFACE_SPEED = 200; // world units/sec along the surface

// scratch
const n = new THREE.Vector3();
const screenUp = new THREE.Vector3();
const screenRight = new THREE.Vector3();
const fwdT = new THREE.Vector3();
const rightT = new THREE.Vector3();
const axis = new THREE.Vector3();
const q = new THREE.Quaternion();

function onKeyDown(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if ([" "].includes(k)) e.preventDefault();
  pressed.add(k);
  startMoveLoop();
}
function onKeyUp(e: KeyboardEvent) {
  pressed.delete(e.key.toLowerCase());
}

function startMoveLoop() {
  if (moving) return;
  moving = true;
  lastT = performance.now();

  const step = () => {
    if (!moving) return;
    if (pressed.size === 0) { moving = false; return; }

    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    // local radial up at current spot
    n.copy(camera.position).sub(CENTER).normalize();

    // camera’s screen axes in world space
    screenUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    screenRight.set(1, 0, 0).applyQuaternion(camera.quaternion);

    // project them onto the tangent plane (remove vertical component along n)
    fwdT.copy(screenUp).addScaledVector(n, -screenUp.dot(n)).normalize();
    rightT.copy(screenRight).addScaledVector(n, -screenRight.dot(n)).normalize();

    // if fwdT got tiny (rare, e.g. extreme roll), fall back to right vector
    if (fwdT.lengthSq() < 1e-8) {
      fwdT.copy(rightT);
      rightT.crossVectors(fwdT, n).normalize();
    }

    // combine keys into tangent direction
    const dir = new THREE.Vector3();
    if (pressed.has("w"))    dir.add(fwdT);
    if (pressed.has("s"))  dir.sub(fwdT);
    if (pressed.has("d")) dir.add(rightT);
    if (pressed.has("a"))  dir.sub(rightT);

    // optional altitude: space up, shift down (purely radial)
    const radial = (pressed.has(" ") ? +1 : 0) + (pressed.has("shift") ? -1 : 0);

    let didMove = false;

    // walk the surface by rotating around axis = n × dir
    if (dir.lengthSq() > 1e-10) {
      dir.normalize();
      const R = camera.position.distanceTo(CENTER);
      const angle = (SURFACE_SPEED / Math.max(1e-6, R)) * dt; // radians = arc/R
      axis.crossVectors(n, dir).normalize();
      q.setFromAxisAngle(axis, angle);
      camera.position.sub(CENTER).applyQuaternion(q).add(CENTER);
      didMove = true;
    }

    // altitude change (optional)
    if (radial !== 0) {
      const climb = (SURFACE_SPEED * 0.5) * dt * radial;
      camera.position.add(n.clone().multiplyScalar(climb));
      didMove = true;
    }

    if (didMove) {
      controls.target.copy(CENTER); // keep pivot at center
      camera.lookAt(controls.target);
      startDampedRAF();
    }

    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

window.addEventListener("keydown", onKeyDown, { passive: false });
window.addEventListener("keyup", onKeyUp);
// ---------------- end WASD ----------------


  // Initial render (no mesh yet)
  renderOnce();

  // Resize to parent
  const ro = new ResizeObserver(() => {
    const { w, h } = getSize();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderOnce();
  });
  ro.observe(host);

  // Stash refs for reuse
  rendererRef.current = renderer;
  sceneRef.current = scene;
  cameraRef.current = camera;
  controlsRef.current = controls;
  sunRef.current = sun;
  roRef.current = ro;

  setEngineReady(true);


  // Cleanup
  return () => {
    setEngineReady(false); 
    stopped = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    ro.disconnect();
    controls.dispose();

    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);

    if (meshRef.current) {
      (meshRef.current.geometry as THREE.BufferGeometry).dispose();
      const m = meshRef.current.material as THREE.ShaderMaterial;
      const tex = m.uniforms?.uTexture?.value as THREE.Texture | undefined;
      if (tex) tex.dispose();
      m.dispose();
      meshRef.current = null;
    }
    if (meshRef2.current) {
      (meshRef2.current.geometry as THREE.BufferGeometry).dispose();
      const m2 = meshRef2.current.material as THREE.ShaderMaterial;
      const tex2 = m2.uniforms?.uTexture?.value as THREE.Texture | undefined;
      if (tex2) tex2.dispose();
      m2.dispose();
      meshRef2.current = null;
    }
    if (meshRef3.current) {
      (meshRef3.current.geometry as THREE.BufferGeometry).dispose();
      const m3 = meshRef3.current.material as THREE.ShaderMaterial;
      const tex3 = m3.uniforms?.uTexture?.value as THREE.Texture | undefined;
      if (tex3) tex3.dispose();
      m3.dispose();
      meshRef3.current = null;
    }
    if (uvPointsRef.current) {
      if (uvGeoRef.current) uvGeoRef.current.dispose();
      if (uvMatRef.current) uvMatRef.current.dispose();
      if (uvTexRef.current) uvTexRef.current.dispose();
      uvPointsRef.current = null;
      uvGeoRef.current = null;
      uvMatRef.current = null;
      uvTexRef.current = null;
      uvDimsRef.current = null;
      if (readPositionRTRef.current) {
        readPositionRTRef.current.dispose();
        readPositionRTRef.current = null;
      }
      if (writePositionRTRef.current) {
        writePositionRTRef.current.dispose();
        writePositionRTRef.current = null;
      }
      simDimsRef.current = null;
    }
    renderer.dispose();
    if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
  
    // elem.removeEventListener('mousemove', onMouseMove);
    // restore controls.update if you like (optional in most apps)
    // controls.update = _origUpdate;
  };
}, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const scene    = sceneRef.current;
    const camera   = cameraRef.current;
    const controls = controlsRef.current;
    
    if (!renderer || !scene || !camera || !controls) return;
  
    const clock = new THREE.Clock();
    let running = true;
    const simTimeElapsed = 0;
    const simTimeStep = 3000;
    const simTimeLimit = 1_000_000_000_000;
  


    // IMPLEMENT TIMING LOGIC AS SHOWN HERE FOR THE SIMS!
  //   const loop = () => {
  //     if (!running) return;
  //     const dt = clock.getDelta();

  //     // 0) stash current viewport/scissor state
  //     const prevViewport = new THREE.Vector4();
  //     const prevScissor  = new THREE.Vector4();
  //     const prevScissorTest = renderer.getScissorTest();
  //     renderer.getViewport(prevViewport);   // x,y,w,h
  //     renderer.getScissor(prevScissor);     // x,y,w,h

  //     // --- SIM UPDATE: render into small RT (no feedback-loop) ---
  //     simMat.uniforms.uPrev.value = readPositionRTRef.current!.texture;
  //     if (simTimeElapsed < simTimeLimit){
  //       simMat.uniforms.uDt.value   = simTimeStep;
  //       simTimeElapsed += simTimeStep;
  //     } else {
  //       simMat.uniforms.uDt.value = 0;
  //     }
      
  //     const rt = writePositionRTRef.current!;
  //     renderer.setRenderTarget(writePositionRTRef.current!);
  //     renderer.setViewport(0, 0, outWRef.current, outHRef.current);
  //     renderer.clear();
  //     renderer.setScissorTest(false);
  //     renderer.render(simScene, simCam);
  //     renderer.setRenderTarget(null);

  //     // 1) restore viewport/scissor EXACTLY as they were
  //     renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
  //     renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
  //     renderer.setScissorTest(prevScissorTest);

  //     // --- SWAP ---
  //     const tmp = readPositionRTRef.current!;
  //     readPositionRTRef.current = writePositionRTRef.current!;
  //     writePositionRTRef.current = tmp;

  //     // make points sample the latest
  //     ptsMat.uniforms.uCurrentPosition.value = readPositionRTRef.current.texture;

  //     // --- render your visible scene as usual ---
  //     controls.update();
  //     renderer.render(scene, camera);

  //     requestAnimationFrame(loop);
  //   };
  
  //   requestAnimationFrame(loop);
  //   return () => { running = false; };

function debugTrailRT(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget) {
  const w = rt.width, h = rt.height;
  const buf = new Uint8Array(w * h * 4);

  // read pixels
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);

  let zeroCount = 0;
  const total = w * h;

  for (let i = 0; i < total; i++) {
    const r = buf[i * 4 + 0];
    const g = buf[i * 4 + 1];
    const b = buf[i * 4 + 2];
    const a = buf[i * 4 + 3];
    if (r === 1 && g === 1 && b === 1 && a === 1) {
      zeroCount++;
    }
  }

  const pct = (zeroCount / total * 100).toFixed(2);
  console.log(`trailRT zeros: ${zeroCount}/${total} (${pct}%)`);
}

  const loop = () => {
  if (!running) return;

  // stash viewport/scissor once
  const prevViewport = new THREE.Vector4();
  const prevScissor  = new THREE.Vector4();
  const prevScissorTest = renderer.getScissorTest();
  renderer.getViewport(prevViewport);
  renderer.getScissor(prevScissor);

  for (const L of windLayersSetRef.current) {
    // advance each sim
    L.simMat.uniforms.uPrev.value = L.readRT.texture;
    L.simMat.uniforms.uDt.value   = simTimeStep; // or your timing logic
    renderer.setRenderTarget(L.writeRT);
    renderer.setViewport(0, 0, L.outW, L.outH);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.render(L.simScene, L.simCam);
    renderer.setRenderTarget(null);

    // swap
    const tmp = L.readRT;
    L.readRT = L.writeRT;
    L.writeRT = tmp;

    // points sample the latest
    L.ptsMat.uniforms.uCurrentPosition.value = L.readRT.texture;

    // -- copy + stamp into the SAME RT without clearing between them
// const prevAC = renderer.autoClear;
// renderer.autoClear = false;

    // copy pass
    L.decayMat.uniforms.uSrc.value = L.trailReadRT.texture;
    renderer.setRenderTarget(L.trailWriteRT);
// renderer.setViewport(0, 0, L.trailWriteRT.width, L.trailWriteRT.height);
// renderer.setScissorTest(false);
renderer.clear();
renderer.render(L.decayScene, L.decayCam);

        // swap
    // const t1 = L.trailReadRT;
    // L.trailReadRT = L.trailWriteRT;
    // L.trailWriteRT = t1;

// --- draw particles into trailRT as white dots ---
renderer.setRenderTarget(L.trailWriteRT);
renderer.setViewport(0, 0, L.trailWriteRT.width, L.trailWriteRT.height);
renderer.setScissorTest(false);

// keep both materials sampling the latest positions texture
L.ptsMat.uniforms.uCurrentPosition.value = L.readRT.texture;
L.trailPtsMat.uniforms.uCurrentPosition.value = L.readRT.texture;

renderer.setRenderTarget(L.trailWriteRT);
renderer.setScissorTest(false);
L.trailStampMat.uniforms.uCurrentPosition.value = L.readRT.texture;
renderer.render(L.trailStampScene, L.trailStampCam); // ✅ UV-space

// renderer.autoClear = prevAC;

    // swap
    const t = L.trailReadRT;
    L.trailReadRT = L.trailWriteRT;
    L.trailWriteRT = t;

    L.trailOverlayMat.uniforms.uTrailTex.value = L.trailReadRT.texture;

// return to default framebuffer
  renderer.setRenderTarget(null);
  }

  // restore viewport/scissor exactly
  renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
  renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
  renderer.setScissorTest(prevScissorTest);

  controls.update();
  renderer.render(scene, camera);

  requestAnimationFrame(loop);
  };

      requestAnimationFrame(loop);
    return () => { running = false; };

    }, [
    // restart the loop if these change materially
    heightTexVersion,
    uvDimsRef.current?.w,
    uvDimsRef.current?.h,
  ]);

  const handleLandTex = useCallback((tex: THREE.Texture) => {
  landTexRef.current = tex;
  // optionally bump a version if you *need* to react elsewhere
  // setLandTexVersion(v => v + 1);
}, []);

const handleGph250 = useCallback((tex: THREE.Texture) => {
  heightTexRef.current = tex;
  setHeightTexVersion(v => v + 1);
}, []);

const handleGph500 = useCallback((tex: THREE.Texture) => {
  heightTexRef2.current = tex;
  setHeightTexVersion2(v => v + 1);
}, []);

const handleGph850 = useCallback((tex: THREE.Texture) => {
  heightTexRef3.current = tex;
  setHeightTexVersion3(v => v + 1);
}, []);


const handleWindReady = useCallback((api: WindLayerAPI) => {
  windLayersSetRef.current.add(api);
}, []);

const handleWindRemove = useCallback((api: WindLayerAPI) => {
  windLayersSetRef.current.delete(api);
}, []);



  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
{engineReady && (
  <>
  
    <LandMaskLayer
  landUrl={`/api/landmask`}
  renderer={rendererRef.current}
  scene={sceneRef.current}
  camera={cameraRef.current}
  // targets={[meshRef.current!, meshRef2.current!, meshRef3.current!]}
  onTexture={handleLandTex}
/>

          {/* <WindUvLayer
        key={`uv-250-${datehour}-${heightTexVersion}`}
        url={`/api/uv/250/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        heightTex={heightTexRef.current}
        pressureLevel={250}
        exaggeration={exaggeration}
        UV_POINTS_VERT={UV_POINTS_VERT}
        UV_POINTS_FRAG={UV_POINTS_FRAG}
        SIM_VERT={SIM_VERT}
        SIM_FRAG={SIM_FRAG}
  onReady={handleWindReady}
  onRemove={handleWindRemove}
        zOffset={0}
        /> */}

          {/* <WindUvLayer
        key={`uv-500-${datehour}-${heightTexVersion2}`}
        url={`/api/uv/500/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        heightTex={heightTexRef2.current}
        pressureLevel={500}
        exaggeration={exaggeration}
        UV_POINTS_VERT={UV_POINTS_VERT}
        UV_POINTS_FRAG={UV_POINTS_FRAG}
        SIM_VERT={SIM_VERT}
        SIM_FRAG={SIM_FRAG}
  onReady={handleWindReady}
  onRemove={handleWindRemove}
        zOffset={0.5}
        /> */}

            <WindUvLayer
        key={`uv-850-${datehour}-${heightTexVersion3}`}
        url={`/api/uv/850/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        heightTex={heightTexRef3.current}
        pressureLevel={850}
        exaggeration={exaggeration}
        UV_POINTS_VERT={UV_POINTS_VERT}
        UV_POINTS_FRAG={UV_POINTS_FRAG}
        SIM_VERT={SIM_VERT}
        SIM_FRAG={SIM_FRAG}
  onReady={handleWindReady}
  onRemove={handleWindRemove}
        zOffset={1.0}
        />


      {/* <HeightMeshLayer
  url={`/api/gph/250/${datehour}`}
  renderer={rendererRef.current}
  scene={sceneRef.current}
  camera={cameraRef.current}
  controls={controlsRef.current}
  sun={sunRef.current}
  VERT={VERT}
  FRAG={FRAG}
  landTexture={landTexRef.current}
  pressureLevel={250}
  exaggeration={exaggeration}
  zOffset={0}
  onTextureChange={handleGph250}
/> */}

      {/* <HeightMeshLayer
  url={`/api/gph/500/${datehour}`}
  renderer={rendererRef.current}
  scene={sceneRef.current}
  camera={cameraRef.current}
  controls={controlsRef.current}
  sun={sunRef.current}
  VERT={VERT}
  FRAG={FRAG}
  landTexture={landTexRef.current}
  pressureLevel={500}
  exaggeration={exaggeration}
  zOffset={0.5}
  onTextureChange={handleGph500}
/> */}

    {/* <HeightMeshLayer
  url={`/api/gph/850/${datehour}`}
  renderer={rendererRef.current}
  scene={sceneRef.current}
  camera={cameraRef.current}
  controls={controlsRef.current}
  sun={sunRef.current}
  VERT={VERT}
  FRAG={FRAG}
  landTexture={landTexRef.current}
  pressureLevel={850}
  exaggeration={exaggeration}
  zOffset={1}
  onTextureChange={handleGph850}
/> */}
</>
)}
    </div>;
}
