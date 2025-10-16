// HeightMesh_Shaders.tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import WindUvLayer from "./WindUVLayer";
import HeightMeshLayer from "./HeightMeshLayer";
import LandMaskLayer from "./LandMaskLayer";
import ThreeGlobe from 'three-globe';
import CloudCoverLayer from "./CloudCoverLayer";
import { Features } from "./tweaks/FeatureBus";
import { FEAT } from "./tweaks/Features";
import { PaneHub } from "./tweaks/PaneHub";
import { useFeatureFlag } from "./tweaks/FeatureBusHook";
import { GET_POSITION_Z_SHARED_GLSL3, min_max_gph_ranges_glsl, get_position_z_shared_glsl, getWindMotionRangesPerPressureLevel } from "./ShadersLib";
import TemperatureShellLayer from "./TemperatureShellLayer";
import TerrainSphereLayer from "./ElevationLayer";




const mapUVtoLatLng = `
  float globeRadius = 110.0;
  
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
  uniform float uUseLandMask;  

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

    // Land mask (only if enabled)
    if (uUseLandMask > 0.5) {
      vec3 landRgb = texture2D(uLandTexture, vUv).rgb;
      float landWhiteLevel = max(max(landRgb.r, landRgb.g), landRgb.b);
      float isLand = step(0.5, 1.0 - landWhiteLevel);  // black=land, white=ocean
      color = mix(color, vec3(0.0), isLand);
    }

    gl_FragColor = vec4(color, 0.5);
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
    fragColor = vec4(0.2, 0.9, 0.9, 1.0);
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
    ${getWindMotionRangesPerPressureLevel}
    precision highp float;
    in vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D uPrev;
    uniform float uDt;
    uniform vec2  uSize;
    uniform sampler2D uWindTexture;
    uniform float uPressure;

    uniform float uWindGain;
    uniform float uLifetimeTarget;
    uniform float uMinDistancePerTimeStep;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
    vec2 jitter(vec2 st){
      float a = 6.2831853*hash(st+0.37);
      float r = 0.003 + 0.004*hash(st+0.91); // tune radius
      return vec2(cos(a), sin(a))*r;
    }

    vec2 sampleWindUV(vec2 uv) {
      uv = fract(uv);

      // Read packed wind from texture
      vec2 rg = texture(uWindTexture, uv).rg;

      // Pressure-aware ranges
      float uMin, uMax, vMin, vMax;
      getUVRange(uPressure, uMin, uMax, vMin, vMax);

      // Decode to physical units (m/s)
      float u_ms = mix(uMin, uMax, rg.r);
      float v_ms = mix(vMin, vMax, rg.g);

      // Plate-carrée convention used elsewhere: +V should be northward
      // Your previous code had a minus on V (image-space vs geo). Keep that if needed:
      v_ms = -v_ms;

      return vec2(u_ms, v_ms);
    }

    void main() {
      vec2 st = (gl_FragCoord.xy - 0.5) / uSize;

      vec4 prev = texture(uPrev, st);
      vec2 position = prev.rg;
      float totalLifeThreshold = prev.b;

      // --- RK2 with physical advection ---
      // Step 1: sample wind at current pos (assumed m/s), convert to ΔUV over (0.5*dt)
      vec2 wind1_ms = sampleWindUV(position) * uWindGain;                // m/s
      float lat1_deg = latFromV(position.y);
      vec2 duv1 = deltaUV_from_ms(wind1_ms, lat1_deg, 0.5 * uDt);

      // Midpoint position
      vec2 midPos = wrapClampUV(position + duv1);

      // Step 2: sample at midpoint and advance full dt with midpoint slope
      vec2 wind2_ms = sampleWindUV(midPos) * uWindGain;                  // m/s
      // wind2_ms = vec2(-1,-1);
      float lat2_deg = latFromV(midPos.y);
      vec2 duv2 = deltaUV_from_ms(wind2_ms, lat2_deg, uDt);

      vec2 newPos = wrapClampUV(position + duv2);
      float lifeExpended = prev.a;
      float movedUV  = length(newPos - position);
      float distanceParticleMoved = max(movedUV, uMinDistancePerTimeStep);
      lifeExpended += distanceParticleMoved / uLifetimeTarget;

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
uniform float uLonOffset;  // seam shift; +270° → 0.75
uniform bool  uFlipV;
uniform vec3 trailColor;

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
  fragColor = vec4(trailColor, I * uOpacity);
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

// 1) lat/lon -> world position on your globe (origin-centered)
function latLonToVec3(latDeg: number, lonDeg: number, radius: number, lonOffsetDeg = 270, latOffsetDeg = 0) {
  const lat = THREE.MathUtils.degToRad(latDeg + latOffsetDeg);
  const lon = THREE.MathUtils.degToRad(-(lonDeg + lonOffsetDeg)); // inverting for threejs coord system
  const x = radius * Math.cos(lat) * Math.cos(lon);
  const y = radius * Math.sin(lat);
  const z = radius * Math.cos(lat) * Math.sin(lon);
  return new THREE.Vector3(x, y, z);
}

// 2) compute globe radius from the ThreeGlobe mesh
function getGlobeRadius(globe: THREE.Object3D) {
  const sphere = new THREE.Sphere();
  new THREE.Box3().setFromObject(globe).getBoundingSphere(sphere);
  return sphere.radius;
}

// 3) fly the camera to a given lat/lon
function lookAtLatLon(
  lat: number,
  lon: number,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  globe: THREE.Object3D,
  altitude = 0 // extra distance above surface, in world units
) {
  const R = getGlobeRadius(globe);
  const target = latLonToVec3(lat, lon, R);      // point on surface
  const normal = target.clone().normalize();

  // keep roughly the same viewing distance unless you specify altitude
  const keepDist = camera.position.distanceTo(controls.target);
  const dist = altitude > 0 ? altitude : keepDist;

  const newPos = normal.clone().multiplyScalar(R + dist);

  // snap (or tween if you prefer)
  controls.target.copy(target);
  camera.position.copy(newPos);
  camera.lookAt(controls.target);
  controls.update();
}


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
  decayScene: THREE.Scene;
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
  const [wind250Tex, setWind250Tex] = useState<THREE.Texture | null>(null);

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
    scene.background = new THREE.Color(0x0b0c10);

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

    lookAtLatLon(25, -65, camera, controls, globe, 100);

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
controls.minPolarAngle = 0.0001;
controls.maxPolarAngle = Math.PI - 0.0001;
controls.minAzimuthAngle = -Infinity;
controls.maxAzimuthAngle = Infinity;

// Helper: recompute local frame, build F/R, make quaternion, and log
function previewCameraOrientationFromYawPitch(yaw: number, pitch: number) {
// 1) Local frame at current camera position
const U = new THREE.Vector3().copy(camera.position).sub(CENTER).normalize();
const ref = Math.abs(U.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
const E = new THREE.Vector3().crossVectors(ref, U).normalize();
const N = new THREE.Vector3().crossVectors(U, E).normalize();

// (a) pre-tilt base forward to effective band
const N_p  = new THREE.Vector3().copy(N).applyAxisAngle(E, pitch);

// (b) yaw around gravity at that band
const F = new THREE.Vector3().copy(N_p).applyAxisAngle(U, yaw);

// 3) Build a no-roll basis *around* the pitched F (keep F as-is)
const G = U; // gravity (local radial up)
const R = new THREE.Vector3().copy(F).cross(G).normalize();     // sideways, level w.r.t gravity
const U_cam = new THREE.Vector3().copy(R).cross(F).normalize(); // camera up, orthogonal to F & R

// 4) Convert {R, U_cam, F} -> quaternion (camera looks down -Z, so Z = -F)
const Z = new THREE.Vector3().copy(F).negate();
const rot = new THREE.Matrix4().makeBasis(R, U_cam, Z);
const qCam = new THREE.Quaternion().setFromRotationMatrix(rot);

  return { U, E, N, F, R, U_cam, qCam };
}


// ---- add this block: preview yaw/pitch from mouse, no camera change ----
const elem = renderer.domElement;

// --- pointer lock helpers ---
function onPointerLockChange() {
  const locked = document.pointerLockElement === elem;

  // Visual hint
  elem.style.cursor = locked ? "none" : "grab";

  // Only track mouse when locked
  if (locked) {
    elem.addEventListener("mousemove", onMouseMove);
    // kick render loop in case user locked while standing still
    startDampedRAF();
  } else {
    elem.removeEventListener("mousemove", onMouseMove);
  }
}

function onPointerLockError() {
  console.warn("[PointerLock] request failed (browser/permission)");
}

// Click to lock (or right after a key press if you prefer)
function onCanvasClick(e: MouseEvent) {
  // optional: left button only
  if (e.button === 0) {
    // Required by some browsers: must be in a user gesture handler
    elem.requestPointerLock();
  }
}

// Optional: provide a manual release shortcut in addition to Esc
function onReleaseKey(e: KeyboardEvent) {
  // Esc already works automatically; this is just a manual override on 'q'
  if (e.key.toLowerCase() === "q" && document.pointerLockElement === elem) {
    document.exitPointerLock();
  }
}

// Hook up events
elem.addEventListener("click", onCanvasClick);
document.addEventListener("pointerlockchange", onPointerLockChange);
document.addEventListener("pointerlockerror", onPointerLockError);
window.addEventListener("keydown", onReleaseKey);

function onMouseMove(e: MouseEvent) {
  // 1) integrate yaw/pitch from mouse deltas (no frame-time scaling on purpose)
  const dx = e.movementX || 0;
  const dy = e.movementY || 0;
  yaw -= dx * MOUSE_SENS;
  pitch = THREE.MathUtils.clamp(pitch - dy * MOUSE_SENS, -PITCH_MAX, PITCH_MAX);

    // Build camera basis & quaternion from current yaw/pitch at THIS position
  const { F, U_cam, qCam } = previewCameraOrientationFromYawPitch(yaw, pitch);
 camera.up.copy(U_cam);
  // 1) Apply orientation
  camera.quaternion.copy(qCam);

  // 2) Keep OrbitControls happy: aim its target where we're looking
  controls.target.copy(camera.position).add(F);

  // 3) Kick your on-demand render/damping loop
  startDampedRAF();
}

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

// ---- add these: local tangent frame scratch ----
const east = new THREE.Vector3();   // +longitude tangent
const north = new THREE.Vector3();  // +latitude (toward N pole)
const refAxis = new THREE.Vector3();// degeneracy helper near poles

// ---- add these: mouse-look "state" and preview scratch ----
let yaw = 0;                        // radians
const PITCH_MAX = THREE.MathUtils.degToRad(89.99); // clamp so we never flip
let pitch = -(PITCH_MAX - 1e-4);                      // radians
const MOUSE_SENS = 0.002;           // radians per pixel (tune later)

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
        if (pressed.has("w")) dir.add(fwdT);
        if (pressed.has("s")) dir.sub(fwdT);
        if (pressed.has("d")) dir.add(rightT);
        if (pressed.has("a")) dir.sub(rightT);

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
  // --- recompute local UP at the NEW position ---
  n.copy(camera.position).sub(CENTER).normalize();

  // --- build local tangent frame (EAST/NORTH) at this spot ---
  // pick a stable reference axis to cross with UP; swap near poles to avoid tiny cross products
  if (Math.abs(n.y) > 0.99) {
    refAxis.set(1, 0, 0);  // near poles, use world X as reference
  } else {
    refAxis.set(0, 1, 0);  // otherwise, use world Y as reference
  }
  east.crossVectors(refAxis, n).normalize();   // E = normalize(ref × U)
  north.crossVectors(n, east).normalize();     // N = normalize(U × E)


  // Rebuild view from the SAME yaw/pitch at the NEW position
const { F, U_cam, qCam } = previewCameraOrientationFromYawPitch(yaw, pitch);
camera.up.copy(U_cam);
  // 1) Apply orientation
  camera.quaternion.copy(qCam);

  // 2) Sync OrbitControls to this new forward
  controls.target.copy(camera.position).add(F);

  // 3) Kick the render/damping loop
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

      // If still locked, release
  if (document.pointerLockElement === elem) document.exitPointerLock();

  elem.removeEventListener("click", onCanvasClick);
  document.removeEventListener("pointerlockchange", onPointerLockChange);
  document.removeEventListener("pointerlockerror", onPointerLockError);
  window.removeEventListener("keydown", onReleaseKey);
  // onMouseMove is removed by pointerlockchange when unlocked,
  // but remove defensively anyway:
  elem.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
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
    }

    const loop = () => {
      if (!running) return;

      // stash viewport/scissor once
      const prevViewport = new THREE.Vector4();
      const prevScissor = new THREE.Vector4();
      const prevScissorTest = renderer.getScissorTest();
      renderer.getViewport(prevViewport);
      renderer.getScissor(prevScissor);

      for (const L of windLayersSetRef.current) {
        // advance each sim
        L.simMat.uniforms.uPrev.value = L.readRT.texture;
        L.simMat.uniforms.uDt.value = simTimeStep; // or your timing logic
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
    setLandTexVersion(v => v + 1);
  }, []);

  useEffect(() => {
    // Seed only missing keys (does not overwrite user/persisted choices)
    Features.seed({
      [FEAT.CLOUD_850]: true,
      [FEAT.WIND_850]: true,
      // add any other first-load “on” defaults here
      // [FEAT.GPH_500]: true,
    });
  }, []);

  useEffect(() => {
    if (!engineReady) return;
    const disposers: Array<() => void> = [];

    // PaneHub registration
    disposers.push(
      // Clouds
      PaneHub.bindFlag("Cloud Layers", "250 hPa", FEAT.CLOUD_250, false),
      PaneHub.bindFlag("Cloud Layers", "500 hPa", FEAT.CLOUD_500, false),
      PaneHub.bindFlag("Cloud Layers", "850 hPa", FEAT.CLOUD_850, false),

      // Geopotential Height Mesh
      PaneHub.bindFlag("Geopotential Height Mesh", "250 hPa", FEAT.GPH_250, false),
      PaneHub.bindFlag("Geopotential Height Mesh", "500 hPa", FEAT.GPH_500, false),
      PaneHub.bindFlag("Geopotential Height Mesh", "850 hPa", FEAT.GPH_850, false),

      // Wind Particles
      PaneHub.bindFlag("Wind Particles", "250 hPa", FEAT.WIND_250, false),
      PaneHub.bindFlag("Wind Particles", "500 hPa", FEAT.WIND_500, false),
      PaneHub.bindFlag("Wind Particles", "850 hPa", FEAT.WIND_850, false),

      // Temperature
      PaneHub.bindFlag("Temperature", "250 hPa", FEAT.TEMP_250, false),
      PaneHub.bindFlag("Temperature", "500 hPa", FEAT.TEMP_500, false),
      PaneHub.bindFlag("Temperature", "850 hPa", FEAT.TEMP_850, false),

      PaneHub.bindFlag("Base Layers", "Land Mask", FEAT.LAND_MASK, false),
    );


    return () => disposers.forEach((d) => d());
  }, [engineReady]);


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

  // Feature flag hooks
  const cloud250On = useFeatureFlag<boolean>(FEAT.CLOUD_250, false);
  const cloud500On = useFeatureFlag<boolean>(FEAT.CLOUD_500, false);
  const cloud850On = useFeatureFlag<boolean>(FEAT.CLOUD_850, false);

  const gph250On = useFeatureFlag<boolean>(FEAT.GPH_250, false);
  const gph500On = useFeatureFlag<boolean>(FEAT.GPH_500, false);
  const gph850On = useFeatureFlag<boolean>(FEAT.GPH_850, false);

  const wind250On = useFeatureFlag<boolean>(FEAT.WIND_250, false);
  const wind500On = useFeatureFlag<boolean>(FEAT.WIND_500, false);
  const wind850On = useFeatureFlag<boolean>(FEAT.WIND_850, false);

  const landMaskOn = useFeatureFlag<boolean>(FEAT.LAND_MASK, false);
  
  const temp250On = useFeatureFlag<boolean>(FEAT.TEMP_250, false);
  const temp500On = useFeatureFlag<boolean>(FEAT.TEMP_500, false);
  const temp850On = useFeatureFlag<boolean>(FEAT.TEMP_850, false);

  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
    {engineReady && (
      <>

        {landMaskOn && (<LandMaskLayer
          landUrl={`/api/landmask`}
          renderer={rendererRef.current}
          scene={sceneRef.current}
          camera={cameraRef.current}
          // targets={[meshRef.current!, meshRef2.current!, meshRef3.current!]}
          onTexture={handleLandTex}
        />)}

        {wind250On && (<WindUvLayer
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
          setWindTex={setWind250Tex}
        // zOffset={0}
        />)}

        {wind500On && (<WindUvLayer
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
        // zOffset={0.5}
        />)}

        {wind850On && (<WindUvLayer
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
        // zOffset={1.0}
        />)}


        {gph250On && (<HeightMeshLayer
          key={"gph-250"}
          url={`/api/gph/250/${datehour}`}
          renderer={rendererRef.current}
          scene={sceneRef.current}
          camera={cameraRef.current}
          controls={controlsRef.current}
          sun={sunRef.current}
          VERT={VERT}
          FRAG={FRAG}
          landTexture={landTexRef.current}
          useLandMask={landMaskOn} 
          pressureLevel={250}
          exaggeration={exaggeration}
          zOffset={1.5}
          onTextureChange={handleGph250}
        />)}

        {gph500On && (<HeightMeshLayer
          key={"gph-500"}
          url={`/api/gph/500/${datehour}`}
          renderer={rendererRef.current}
          scene={sceneRef.current}
          camera={cameraRef.current}
          controls={controlsRef.current}
          sun={sunRef.current}
          VERT={VERT}
          FRAG={FRAG}
          landTexture={landTexRef.current}
          useLandMask={landMaskOn} 
          pressureLevel={500}
          exaggeration={exaggeration}
          zOffset={1.0}
          onTextureChange={handleGph500}
        />)}

        {gph850On && (<HeightMeshLayer
          key={"gph-850"}
          url={`/api/gph/850/${datehour}`}
          renderer={rendererRef.current}
          scene={sceneRef.current}
          camera={cameraRef.current}
          controls={controlsRef.current}
          sun={sunRef.current}
          VERT={VERT}
          FRAG={FRAG}
          landTexture={landTexRef.current}
          useLandMask={landMaskOn} 
          pressureLevel={850}
          exaggeration={exaggeration}
          zOffset={0.5}
          onTextureChange={handleGph850}
        />)}
      </>
    )}

    {cloud250On && (
      <CloudCoverLayer
        key={`cloud-250-${datehour}`}
        url={`/api/cloud_cover/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        controls={controlsRef.current}
        gphTex={heightTexRef.current}
        pressureLevel={250}     // if your component accepts it
        windTex={wind250Tex}
      />
    )}

    {cloud500On && (
      <CloudCoverLayer
        key={`cloud-500-${datehour}`}
        url={`/api/cloud_cover/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        controls={controlsRef.current}
        gphTex={heightTexRef2.current}
        pressureLevel={500}     // if your component accepts it
      />
    )}

    {cloud850On && (
      <CloudCoverLayer
        key={`cloud-850-${datehour}`}
        url={`/api/cloud_cover/${datehour}`}
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        controls={controlsRef.current}
        gphTex={heightTexRef3.current}
        pressureLevel={850}     // if your component accepts it
      />
    )}

    {temp250On && (<TemperatureShellLayer
      key={`temp-shell-250-${datehour}`}
      textureUrl={`/api/temperature/250/${datehour}`}  // the endpoint that returns your texture
      pressure={250}                                         // single pressure level number
      renderer={rendererRef.current}
      scene={sceneRef.current}
      camera={cameraRef.current}
      controls={controlsRef.current}
      sun={sunRef.current}                                   
      enabled={true}
      autoFrameOnce={true}
    />)}
    {temp500On && (<TemperatureShellLayer
      key={`temp-shell-500-${datehour}`}
      textureUrl={`/api/temperature/500/${datehour}`}  // the endpoint that returns your texture
      pressure={500}                                         // single pressure level number
      renderer={rendererRef.current}
      scene={sceneRef.current}
      camera={cameraRef.current}
      controls={controlsRef.current}
      sun={sunRef.current}                                   
      enabled={true}
      autoFrameOnce={true}
    />)}
    {temp850On && (<TemperatureShellLayer
      key={`temp-shell-850-${datehour}`}
      textureUrl={`/api/temperature/850/${datehour}`}  // the endpoint that returns your texture
      pressure={850}                                         // single pressure level number
      renderer={rendererRef.current}
      scene={sceneRef.current}
      camera={cameraRef.current}
      controls={controlsRef.current}
      sun={sunRef.current}                                   
      enabled={true}
      autoFrameOnce={true}
    />)}

    <TerrainSphereLayer
        renderer={rendererRef.current}
        scene={sceneRef.current}
        camera={cameraRef.current}
        baseRadius={100}
        zOffset={10}
        exaggeration={50.0}
        enabled={true}
        onReady={(mesh) => {
          console.log("Terrain sphere ready:", mesh);
        }}
      />


  </div>;
}
