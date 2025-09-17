"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import WindUvLayer from "./WindUVLayer";

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

// Vertex shader: displace plane along Z using decoded elevation
const VERT = `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uExaggeration;
  uniform float zOffset;

  ${get_position_z_shared_glsl}

  void main() {
    vUv = uv;
    vec3 pos = position;
    pos.z = position.z + get_position_z(uTexture, uv, uExaggeration) + zOffset;
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
    color = mix(color, vec3(0.0), isLand * 0.25);

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
    vec2 xy = plane_xy_from_uv(uv, uAspect);
    float z = get_position_z_glsl3(uTerrainTexture, uv, uExaggeration);
    vId = gl_VertexID;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(xy.x, xy.y, z + uAboveTerrain + zOffset, 1.0);

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
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
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
  float du = (dlon_deg / 360.0) * cosphi;
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

type WindLayerAPI = {
  simScene: THREE.Scene;
  simCam: THREE.OrthographicCamera;
  simMat: THREE.ShaderMaterial;
  readRT: THREE.WebGLRenderTarget;
  writeRT: THREE.WebGLRenderTarget;
  ptsMat: THREE.ShaderMaterial;
  outW: number;
  outH: number;
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
  const simSceneRef = useRef<THREE.Scene|null>(null);
  const simCameraRef = useRef<THREE.OrthographicCamera|null>(null);
  const simMatRef   = useRef<THREE.ShaderMaterial|null>(null);
  const outWRef = useRef<number>(0);
  const outHRef = useRef<number>(0);
  const hasSetCameraPosition = useRef(false);
  const hasSetCameraPosition2 = useRef(false);
  const hasSetCameraPosition3 = useRef(false);
  const windLayersRef = useRef<WindLayerAPI[]>([]);

  useEffect(() => {
  const host = hostRef.current!;
  const getSize = () => {
    const r = host.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };
  const { w, h } = getSize();

  // --- renderer / scene / camera ---
  const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2 });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f9fc);

  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1e9);
  camera.up.set(0, 0, 1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

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

  // ------------------ keyboard movement (WASD/Arrows on XY, Q/E on Z) ------------------
  const pressed = new Set<string>();
  let moving = false;
  let lastT = performance.now();
  const SPEED = 2; // world units/sec; adjust to taste

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    pressed.add(k);
    startMoveLoop();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    pressed.delete(e.key.toLowerCase());
  };

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

      // Forward relative to camera facing, clamped to XY (Z is up)
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      fwd.z = 0;
      if (fwd.lengthSq() > 0) fwd.normalize();

      // Right = 90° about +Z
      const right = new THREE.Vector3(fwd.y, -fwd.x, 0).normalize();

      const move = new THREE.Vector3();
      if (pressed.has('w')) move.add(fwd);
      if (pressed.has('s')) move.sub(fwd);
      if (pressed.has('d')) move.add(right);
      if (pressed.has('a')) move.sub(right);
      if (pressed.has('q')) move.z += 1;
      if (pressed.has('e')) move.z -= 1;
      if (pressed.has(' ')) move.z += 1;
      if (pressed.has('shift')) move.z -= 1;

      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(SPEED * dt);
        camera.position.add(move);
        controls.target.add(move); // keep orbit pivot with the camera
        startDampedRAF(); // keep your damped render loop alive while moving
      }

      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // ---------------- end keyboard movement ----------------

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

  // Cleanup
  return () => {
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
  };
}, []);


  // Load/replace texture and update or create the mesh when pngUrl changes
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const sun = sunRef.current;
    if (!renderer || !scene || !camera || !controls || !sun) return;
    if (landTexVersion == 0) return;

    // const pressureLevel = 250;
    const zOffset = 0;

    const loader = new THREE.TextureLoader();
    loader.load(
      pngUrl,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const imageData = texture.image as unknown;
        let texWidth = 1;
        let texHeight = 1;
        if (
          imageData &&
          typeof (imageData as { width?: number }).width === "number" &&
          typeof (imageData as { height?: number }).height === "number"
        ) {
          texWidth = (imageData as { width: number }).width;
          texHeight = (imageData as { height: number }).height;
        }
        const aspect = texHeight !== 0 ? texWidth / texHeight : 1.0;
        const texelSize = new THREE.Vector2(1 / Math.max(1, texWidth), 1 / Math.max(1, texHeight));
        const uvToWorld = new THREE.Vector2(aspect, 1.0);
        const lightDir = sun.position.clone().normalize().negate();

        if (!meshRef.current) {
          const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          const mat = new THREE.ShaderMaterial({
            uniforms: {
              uTexture: { value: texture },
              uExaggeration: { value: exaggeration ?? 0.5 },
              uTexelSize: { value: texelSize },
              uUvToWorld: { value: uvToWorld },
              uLightDir: { value: lightDir },
              uLandTexture: { value: landTexRef.current },
              uPressure: { value: pressureLevel },
              zOffset: { value: zOffset }
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending,
          });
          const mesh = new THREE.Mesh(geo, mat);
          scene.add(mesh);
          meshRef.current = mesh;
          heightTexRef.current = texture;
          setHeightTexVersion((v) => v + 1);
        } else {
          const mesh = meshRef.current;
          const mat = mesh.material as THREE.ShaderMaterial;
          const prevTex = mat.uniforms?.uTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uTexture.value = texture;
          mat.uniforms.uTexelSize.value = texelSize;
          mat.uniforms.uUvToWorld.value = uvToWorld;
          mat.uniforms.uLightDir.value = lightDir;
          mat.uniforms.uPressure.value = pressureLevel;
          mat.uniforms.zOffset.value = zOffset;
          if (prevTex) prevTex.dispose();
          heightTexRef.current = texture;
          setHeightTexVersion((v) => v + 1);

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh.geometry as THREE.BufferGeometry).dispose();
          mesh.geometry = newGeo;
        }
        if (!hasSetCameraPosition.current) {
            const sphere = new THREE.Sphere();
            new THREE.Box3().setFromObject(meshRef.current!).getBoundingSphere(sphere);
            const fov = THREE.MathUtils.degToRad(camera.fov);
            const dist = sphere.radius / Math.sin(fov / 2);
            camera.position.set(
            sphere.center.x,
            sphere.center.y - dist * 0.2,
            sphere.center.z + sphere.radius * 2
            );
            camera.near = Math.max(0.1, dist * 0.001);
            camera.far = dist * 10;
            camera.updateProjectionMatrix();
            camera.lookAt(sphere.center);
            controls.target.copy(sphere.center);
            controls.update();

            hasSetCameraPosition.current = true;
        }

        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("Texture load error", err);
      }
    );
  }, [pngUrl, exaggeration, landTexVersion]);

  // Second pressure mesh: hardcode URL here
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const sun = sunRef.current;
    if (!renderer || !scene || !camera || !controls || !sun) return;
    if (landTexVersion == 0) return;

    const pressureLevel = 500;
    const zOffset = 2.5;
    const pngUrl2 = `/api/gph/500/${datehour}`; 
    if (!pngUrl2) return;

    const loader = new THREE.TextureLoader();
    loader.load(
      pngUrl2,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const imageData = texture.image as unknown;
        let texWidth = 1;
        let texHeight = 1;
        if (
          imageData &&
          typeof (imageData as { width?: number }).width === "number" &&
          typeof (imageData as { height?: number }).height === "number"
        ) {
          texWidth = (imageData as { width: number }).width;
          texHeight = (imageData as { height: number }).height;
        }
        const aspect = texHeight !== 0 ? texWidth / texHeight : 1.0;
        const texelSize = new THREE.Vector2(1 / Math.max(1, texWidth), 1 / Math.max(1, texHeight));
        const uvToWorld = new THREE.Vector2(aspect, 1.0);
        const lightDir = sun.position.clone().normalize().negate();

        if (!meshRef2.current) {
          const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          const mat = new THREE.ShaderMaterial({
            uniforms: {
              uTexture: { value: texture },
              uExaggeration: { value: exaggeration ?? 0.5 },
              uTexelSize: { value: texelSize },
              uUvToWorld: { value: uvToWorld },
              uLightDir: { value: lightDir },
              uLandTexture: { value: landTexRef.current },
              uPressure: { value: pressureLevel },
              zOffset: { value: zOffset }
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            side: THREE.DoubleSide,
              transparent: true,
  depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z += 0.002; // slight offset
          scene.add(mesh);
          meshRef2.current = mesh;
          heightTexRef2.current = texture;
          setHeightTexVersion2(v => v + 1)
        } else {
          const mesh = meshRef2.current;
          const mat = mesh!.material as THREE.ShaderMaterial;
          const prevTex = mat.uniforms?.uTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uTexture.value = texture;
          mat.uniforms.uTexelSize.value = texelSize;
          mat.uniforms.uUvToWorld.value = uvToWorld;
          mat.uniforms.uLightDir.value = lightDir;
          mat.uniforms.uPressure.value = pressureLevel;
          mat.uniforms.zOffset.value = zOffset;
          if (prevTex) prevTex.dispose();
          heightTexRef2.current = texture;

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh!.geometry as THREE.BufferGeometry).dispose();
          mesh!.geometry = newGeo;
        }

        if (!hasSetCameraPosition2.current && meshRef2.current) {
          const sphere = new THREE.Sphere();
          new THREE.Box3().setFromObject(meshRef2.current).getBoundingSphere(sphere);
          const fov = THREE.MathUtils.degToRad(camera.fov);
          const dist = sphere.radius / Math.sin(fov / 2);
          camera.position.set(
            sphere.center.x,
            sphere.center.y - dist * 0.2,
            sphere.center.z + sphere.radius * 2
          );
          camera.near = Math.max(0.1, dist * 0.001);
          camera.far = dist * 10;
          camera.updateProjectionMatrix();
          camera.lookAt(sphere.center);
          controls.target.copy(sphere.center);
          controls.update();
          hasSetCameraPosition2.current = true;
        }

        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("Texture load error (mesh2)", err);
      }
    );
  }, [exaggeration, landTexVersion, datehour]);

  // Third pressure mesh: hardcode URL here
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const sun = sunRef.current;
    if (!renderer || !scene || !camera || !controls || !sun) return;
    if (landTexVersion == 0) return;

    const pressureLevel = 850;
    const zOffset = 5;
    const pngUrl3 = `/api/gph/850/${datehour}`; 
    if (!pngUrl3) return;

    const loader = new THREE.TextureLoader();
    loader.load(
      pngUrl3,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const imageData = texture.image as unknown;
        let texWidth = 1;
        let texHeight = 1;
        if (
          imageData &&
          typeof (imageData as { width?: number }).width === "number" &&
          typeof (imageData as { height?: number }).height === "number"
        ) {
          texWidth = (imageData as { width: number }).width;
          texHeight = (imageData as { height: number }).height;
        }
        const aspect = texHeight !== 0 ? texWidth / texHeight : 1.0;
        const texelSize = new THREE.Vector2(1 / Math.max(1, texWidth), 1 / Math.max(1, texHeight));
        const uvToWorld = new THREE.Vector2(aspect, 1.0);
        const lightDir = sun.position.clone().normalize().negate();

        if (!meshRef3.current) {
          const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          const mat = new THREE.ShaderMaterial({
            uniforms: {
              uTexture: { value: texture },
              uExaggeration: { value: exaggeration ?? 0.5 },
              uTexelSize: { value: texelSize },
              uUvToWorld: { value: uvToWorld },
              uLightDir: { value: lightDir },
              uLandTexture: { value: landTexRef.current },
              uPressure: { value: pressureLevel },
              zOffset: { value: zOffset }
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            side: THREE.DoubleSide,
              transparent: true,
  depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z += 0.004; // slight offset
          scene.add(mesh);
          meshRef3.current = mesh;
          heightTexRef3.current = texture;
        } else {
          const mesh = meshRef3.current;
          const mat = mesh!.material as THREE.ShaderMaterial;
          const prevTex = mat.uniforms?.uTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uTexture.value = texture;
          mat.uniforms.uTexelSize.value = texelSize;
          mat.uniforms.uUvToWorld.value = uvToWorld;
          mat.uniforms.uLightDir.value = lightDir;
          mat.uniforms.uPressure.value = pressureLevel;
          mat.uniforms.zOffset.value = zOffset;
          if (prevTex) prevTex.dispose();
          heightTexRef3.current = texture;

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh!.geometry as THREE.BufferGeometry).dispose();
          mesh!.geometry = newGeo;
        }

        if (!hasSetCameraPosition3.current && meshRef3.current) {
          const sphere = new THREE.Sphere();
          new THREE.Box3().setFromObject(meshRef3.current).getBoundingSphere(sphere);
          const fov = THREE.MathUtils.degToRad(camera.fov);
          const dist = sphere.radius / Math.sin(fov / 2);
          camera.position.set(
            sphere.center.x,
            sphere.center.y - dist * 0.2,
            sphere.center.z + sphere.radius * 2
          );
          camera.near = Math.max(0.1, dist * 0.001);
          camera.far = dist * 10;
          camera.updateProjectionMatrix();
          camera.lookAt(sphere.center);
          controls.target.copy(sphere.center);
          controls.update();
          hasSetCameraPosition3.current = true;
        }

        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("Texture load error (mesh3)", err);
      }
    );
  }, [exaggeration, landTexVersion, datehour]);

  // Load/replace UV wind texture and create/update a persistent point cloud
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera || !uvUrl) return;

    const loader = new THREE.TextureLoader();
    let disposed = false;
    loader.load(
      uvUrl,
      (texture) => {
        if (disposed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        // Read texture size
        const img = texture.image as unknown as { width?: number; height?: number };
        const texW = typeof img?.width === "number" ? img.width : 0;
        const texH = typeof img?.height === "number" ? img.height : 0;
        if (texW === 0 || texH === 0) {
          // can't build point cloud without dims
          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
          return;
        }

        const aspect = texH !== 0 ? texW / texH : 1.0;
        const dimsChanged = !uvDimsRef.current || uvDimsRef.current.w !== texW || uvDimsRef.current.h !== texH;
        const UV_POINTS_STEP = 25; // subsampling step for UV points grid
        // Build or update geometry (positions on a centered grid of size aspect x 1)
        if (!uvPointsRef.current) {
          // Create geometry with a minimal position attribute (count=W*H) required by Three/WebGL
          const geo = new THREE.BufferGeometry();
          const outW = Math.ceil(texW / UV_POINTS_STEP);
          const outH = Math.ceil(texH / UV_POINTS_STEP);
          outWRef.current = outW;
          outHRef.current = outH;
          const count = outW * outH;
          geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));

          // Create zero-initialized RG float render targets for offsets (prev/curr)
          const rtOptions: THREE.RenderTargetOptions = {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false,
          };
          const rtRead = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
          const rtWrite = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
          rtRead.texture.generateMipmaps = false;
          rtWrite.texture.generateMipmaps = false;

          // Clear both to zeros
          const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
          const prevClearAlpha = renderer.getClearAlpha();
          renderer.setRenderTarget(rtRead);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, false, false);
          renderer.setRenderTarget(rtWrite);
          renderer.clear(true, false, false);
          renderer.setRenderTarget(null);
          renderer.setClearColor(prevClearColor, prevClearAlpha);

          // Stash and expose via uniforms
          readPositionRTRef.current?.dispose();
          writePositionRTRef.current?.dispose();
          readPositionRTRef.current = rtRead;
          writePositionRTRef.current = rtWrite;
          simDimsRef.current = { w: outW, h: outH };

          // Create material with required uniforms
          const mat = new THREE.ShaderMaterial({
            vertexShader: UV_POINTS_VERT,
            fragmentShader: UV_POINTS_FRAG,
            transparent: true,
            blending: THREE.NormalBlending,
            depthTest: true,
            glslVersion: THREE.GLSL3,
            uniforms: {
              uTerrainTexture: { value: heightTexRef.current },
              uExaggeration: { value: exaggeration ?? 0.5 },
              uAspect: { value: aspect },
              uPointSize: { value: (1.5 * (window.devicePixelRatio || 1)) * 3.0 },
              uGridW: { value: texW },
              uGridH: { value: texH },
              uStep: { value: UV_POINTS_STEP },
              uAboveTerrain: { value: 0.1 },
              uCurrentPosition: { value: rtRead.texture },
              uSimSize: { value: new THREE.Vector2(outW, outH) },
              uPressure: { value: pressureLevel },
              zOffset: { value: 0 }
            },
          });

          if (!simSceneRef.current) {
            const simScene = new THREE.Scene();
            const simCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            const simGeom  = new THREE.PlaneGeometry(2, 2);
            const simMat   = new THREE.ShaderMaterial({
              glslVersion: THREE.GLSL3,
              vertexShader: SIM_VERT,
              fragmentShader: SIM_FRAG,
              uniforms: {
                uPrev:   { value: readPositionRTRef.current.texture },
                uDt:     { value: 0 },
                uSpeed:  { value: 0.5 },        // NDC units per second
                uSize:   { value: new THREE.Vector2(outW, outH) }, // will bind as ivec2
                uWindTexture: { value: texture }
              },
            });
            simScene.add(new THREE.Mesh(simGeom, simMat));
            simSceneRef.current  = simScene;
            simCameraRef.current = simCam;
            simMatRef.current    = simMat;
          } else {
            // If somehow already present, at least sync uniforms
            simMatRef.current!.uniforms.uPrev.value = writePositionRTRef.current.texture;
            simMatRef.current!.uniforms.uSize.value = new THREE.Vector2(outW, outH);
          }

          const pts = new THREE.Points(geo, mat);
          scene.add(pts);
          uvPointsRef.current = pts;
          uvGeoRef.current = geo;
          uvMatRef.current = mat;
          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
          uvDimsRef.current = { w: texW, h: texH };
        } else {
          // Update existing
          const mat = uvMatRef.current as (THREE.ShaderMaterial & { uniforms: Record<string, { value: unknown }> });
          const geo = uvGeoRef.current!;
          mat.uniforms.uTerrainTexture.value = heightTexRef.current;
          mat.uniforms.uExaggeration.value = typeof exaggeration === 'number' ? exaggeration : 0.5;
          mat.uniforms.uAspect.value = aspect;
          mat.uniforms.uPointSize.value = (1.5 * (window.devicePixelRatio || 1)) * 3.0;
          mat.uniforms.uGridW.value = texW;
          mat.uniforms.uGridH.value = texH;
          mat.uniforms.uStep.value = UV_POINTS_STEP;
          mat.uniforms.uAboveTerrain.value = 0.01;
          mat.uniforms.zOffset.value = 0;
          if (dimsChanged) {
            // Rebuild position attribute to update vertex count
            const outW = Math.ceil(texW / UV_POINTS_STEP);
            const outH = Math.ceil(texH / UV_POINTS_STEP);
            const count = outW * outH;
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
            uvDimsRef.current = { w: texW, h: texH };

            // Recreate and zero-initialize offset render targets for new size
            readPositionRTRef.current?.dispose();
            writePositionRTRef.current?.dispose();
            const rtOptions: THREE.RenderTargetOptions = {
              type: THREE.FloatType,
              format: THREE.RGBAFormat,
              minFilter: THREE.NearestFilter,
              magFilter: THREE.NearestFilter,
              wrapS: THREE.ClampToEdgeWrapping,
              wrapT: THREE.ClampToEdgeWrapping,
              depthBuffer: false,
              stencilBuffer: false,
            };
            const rtRead = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
            const rtWrite = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
            rtRead.texture.generateMipmaps = false;
            rtWrite.texture.generateMipmaps = false;

            const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const prevClearAlpha = renderer.getClearAlpha();
            renderer.setRenderTarget(rtRead);
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(rtWrite);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(null);
            renderer.setClearColor(prevClearColor, prevClearAlpha);

            readPositionRTRef.current = rtRead;
            writePositionRTRef.current = rtWrite;
            simDimsRef.current = { w: outW, h: outH };

            mat.uniforms.uPrev = mat.uniforms.uPrev || { value: null };
            mat.uniforms.uSimSize = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
            mat.uniforms.uPrev.value = readPositionRTRef.current.texture;
            mat.uniforms.uSimSize.value = new THREE.Vector2(outW, outH);
          } else {
            // Keep uniforms in sync
            mat.uniforms.uPrev = mat.uniforms.uPrev || { value: null };
            mat.uniforms.uSimSize = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
            mat.uniforms.uPrev.value = readPositionRTRef.current ? readPositionRTRef.current.texture : null;
            const dims = simDimsRef.current || { w: Math.ceil(texW / UV_POINTS_STEP), h: Math.ceil(texH / UV_POINTS_STEP) };
            mat.uniforms.uSimSize.value = new THREE.Vector2(dims.w, dims.h);
          }
          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
        }

        renderer.render(scene, camera);
      },
      undefined,
      () => {}
    );

    return () => {
      disposed = true;
    };
  }, [uvUrl, exaggeration, heightTexVersion]);

  // Load/replace land mask texture when landUrl changes
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!scene || !landUrl) return;

    const loader = new THREE.TextureLoader();
    let disposed = false;
    loader.load(
      landUrl,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        landTexRef.current = tex;
        setLandTexVersion((v) => v + 1);
        const mesh = meshRef.current;
        if (mesh) {
          const mat = mesh.material as THREE.ShaderMaterial;
          const prevLand = mat.uniforms?.uLandTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uLandTexture = mat.uniforms.uLandTexture || { value: null };
          mat.uniforms.uLandTexture.value = tex;
          if (prevLand) prevLand.dispose();
        }
        const mesh2 = meshRef2.current;
        if (mesh2) {
          const mat2 = mesh2.material as THREE.ShaderMaterial;
          const prevLand2 = mat2.uniforms?.uLandTexture?.value as THREE.Texture | undefined;
          mat2.uniforms.uLandTexture = mat2.uniforms.uLandTexture || { value: null };
          mat2.uniforms.uLandTexture.value = tex;
          if (prevLand2) prevLand2.dispose();
        }
        const mesh3 = meshRef3.current;
        if (mesh3) {
          const mat3 = mesh3.material as THREE.ShaderMaterial;
          const prevLand3 = mat3.uniforms?.uLandTexture?.value as THREE.Texture | undefined;
          mat3.uniforms.uLandTexture = mat3.uniforms.uLandTexture || { value: null };
          mat3.uniforms.uLandTexture.value = tex;
          if (prevLand3) prevLand3.dispose();
        }
        if (renderer && camera && (meshRef.current || meshRef2.current || meshRef3.current)) {
          renderer.render(scene, camera);
        }
      },
      undefined,
      () => {}
    );

    return () => {
      disposed = true;
    };
  }, [landUrl]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const scene    = sceneRef.current;
    const camera   = cameraRef.current;
    const controls = controlsRef.current;
    const simScene = simSceneRef.current;
    const simCam   = simCameraRef.current;
    const simMat   = simMatRef.current;
    const ptsMat   = uvMatRef.current;
    const dims     = simDimsRef.current;
  
    if (!renderer || !scene || !camera || !controls || !simScene || !simCam || !simMat || !ptsMat || !dims) return;
  
    const clock = new THREE.Clock();
    let running = true;
    let simTimeElapsed = 0;
    const simTimeStep = 3000;
    const simTimeLimit = 1_000_000_000_000;
  
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


  const loop = () => {
  if (!running) return;

  // stash viewport/scissor once
  const prevViewport = new THREE.Vector4();
  const prevScissor  = new THREE.Vector4();
  const prevScissorTest = renderer.getScissorTest();
  renderer.getViewport(prevViewport);
  renderer.getScissor(prevScissor);

  for (const L of windLayersRef.current) {
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


  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
          <WindUvLayer
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
        onReady={(api) => { windLayersRef.current.push(api); }}
        zOffset={2.5}
      />
      <WindUvLayer
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
        onReady={(api) => { windLayersRef.current.push(api); }}
        zOffset={0.0}
      />
    </div>;
}
