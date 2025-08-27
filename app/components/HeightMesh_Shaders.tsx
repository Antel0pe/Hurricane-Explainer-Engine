"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Shared GLSL utilities reused by vertex shaders
const get_position_z_shared_glsl = `
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }

  float get_position_z(sampler2D tex, vec2 uv, float exaggeration) {
    float elev = decodeElevation(texture2D(tex, uv).rgb);
    float t = clamp((elev - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    return exaggeration * t;
  }
`;

// Vertex shader: displace plane along Z using decoded elevation
const VERT = `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uExaggeration;

  ${get_position_z_shared_glsl}

  void main() {
    vUv = uv;
    vec3 pos = position;
    pos.z = position.z + get_position_z(uTexture, uv, uExaggeration);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = `
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
    float tC = clamp((elevC - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    vec3 base = rampRedBlue(tC);

    // Per-pixel normal from finite differences on normalized height (same mapping as vertex displacement)
    float elevR = decodeElevation(texture2D(uTexture, vUv + vec2(uTexelSize.x, 0.0)).rgb);
    float elevU = decodeElevation(texture2D(uTexture, vUv + vec2(0.0, uTexelSize.y)).rgb);
    float tR = clamp((elevR - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    float tU = clamp((elevU - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);

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

    gl_FragColor = vec4(color, 1.0);
  }
`;

// GLSL3 shared helpers for points (GLSL3-compatible texture())
const GET_POSITION_Z_SHARED_GLSL3 = `
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }
  float get_position_z_glsl3(sampler2D tex, vec2 uv, float exaggeration) {
    float elev = decodeElevation(texture(tex, uv).rgb);
    float t = clamp((elev - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    return exaggeration * t;
  }
`;

// GLSL3 shared helpers for deriving XY from gl_VertexID
const GET_POSITION_XY_SHARED_GLSL3 = `

  vec2 plane_xy_from_uv(vec2 uv, float aspect) {
    return vec2((uv.x - 0.5) * aspect, (uv.y - 0.5));
  }

`;

// GLSL3 helper: map gl_VertexID to simulation texture UV using explicit dimensions
const GET_SIM_UV_FROM_VERTEX_ID_GLSL3 = `
  vec2 get_sim_uv_from_vertex_id(int vertexId, int texWidth, int texHeight) {
    int ix = vertexId % texWidth;
    int iy = vertexId / texWidth;
    return vec2(
        (float(ix) + 0.5) / float(texWidth),
        (float(iy) + 0.5) / float(texHeight)
    );
  }
`;

// GLSL3 helper: compute seed UV from linear index for subsampled grid
const GET_SEED_UV_FROM_INDEX_GLSL3 = `
  vec2 get_seed_uv_from_index(int index, int gridW, int gridH, int step) {
    int outW = (gridW + step - 1) / step;
    int ii = index % outW;
    int jj = index / outW;
    int srcI = min(gridW - 1, ii * step);
    int srcJ = min(gridH - 1, jj * step);
    return vec2(float(srcI) / float(gridW - 1),
                float(srcJ) / float(gridH - 1));
  }
`;

// UV wind points shader (GLSL3): read per-vertex current (u,v) from simulation texture and position above terrain
const UV_POINTS_VERT = `
  ${GET_POSITION_Z_SHARED_GLSL3}
  ${GET_POSITION_XY_SHARED_GLSL3}
  ${GET_SIM_UV_FROM_VERTEX_ID_GLSL3}
  uniform sampler2D uTerrainTexture;
  uniform sampler2D uPositions; // RG = current (u, v)
  uniform float uExaggeration;
  uniform float uAspect;
  uniform float uPointSize;
  uniform int uGridW;
  uniform int uGridH;
  uniform int uStep;
  uniform int uTexWidth;  // sim texture width
  uniform int uTexHeight; // sim texture height
  uniform float uAboveTerrain;
  flat out int vId;
  void main(){
    // Look up this particle's current (u, v) from the simulation texture
    vec2 simUV = get_sim_uv_from_vertex_id(gl_VertexID, uTexWidth, uTexHeight);
    vec2 particleUV = texture(uPositions, simUV).rg;

    // Convert UV to plane XY for positioning above terrain
    vec2 xy = plane_xy_from_uv(particleUV, uAspect);

    // For Z, sample terrain height at the current UV
    float z = get_position_z_glsl3(uTerrainTexture, particleUV, uExaggeration);

    vId = gl_VertexID;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(xy.x, xy.y, z + uAboveTerrain, 1.0);
    gl_PointSize = uPointSize;
  }`;
const UV_POINTS_FRAG = `
  precision highp float;
  flat in int vId;
  out vec4 fragColor;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    if(dot(d,d) > 0.25) discard;
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

const SIM_VERT = `
out vec2 vUv;
void main() {
  vUv = uv;                    
  gl_Position = vec4(position.xy, 0.0, 1.0);  
}
`;

const SIM_FRAG = `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

// Previous positions texture (RG = (u, v))
uniform sampler2D uPrevPositions;
// Simulation parameters
uniform float uDt, uSpeed, uMargin;
uniform vec2  uSize;    // (width, height) as floats
uniform int   uMode;    // 0 = initialize, 1+ = update

// Grid info for seeding positions (subsampled uv grid)
uniform int uGridW;
uniform int uGridH;
uniform int uStep;

${GET_SEED_UV_FROM_INDEX_GLSL3}

void main() {
  // Snap to texel centers in the simulation texture
  vec2 whf = uSize;
  vec2 st = (floor(vUv * whf) + 0.5) / whf;

  // Compute linear index for this texel
  int ix = int(floor(vUv.x * whf.x));
  int iy = int(floor(vUv.y * whf.y));
  int idx = iy * int(whf.x) + ix;

  if (uMode == 0) {
    // Initialize positions from subsampled UV grid
    vec2 seedUV = get_seed_uv_from_index(idx, uGridW, uGridH, uStep);
    fragColor = vec4(seedUV, 0.0, 1.0);
    return;
  }

  // Update: advance in +V by speed*dt, wrap with margin
  vec2 pos = texture(uPrevPositions, st).rg;
  pos.y += uSpeed * uDt;
  float range = 1.0 + 2.0 * uMargin;
  pos.y = mod(pos.y + uMargin, range) - uMargin;

  fragColor = vec4(pos, 0.0, 1.0);
}
`;


type Props = { pngUrl: string; landUrl?: string; uvUrl?: string; exaggeration?: number };

export default function HeightMesh_Shaders({ pngUrl, landUrl, uvUrl, exaggeration }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const landTexRef = useRef<THREE.Texture | null>(null);
  const [landTexVersion, setLandTexVersion] = useState(0);
  const [heightTexVersion, setHeightTexVersion] = useState(0);
  const heightTexRef = useRef<THREE.Texture | null>(null);
  const uvTexRef = useRef<THREE.Texture | null>(null);
  const uvPointsRef = useRef<THREE.Points | null>(null);
  const uvGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const uvMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const uvDimsRef = useRef<{ w: number; h: number } | null>(null);
  const prevPosRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const currPosRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const simDimsRef = useRef<{ w: number; h: number } | null>(null);
  const simSceneRef = useRef<THREE.Scene|null>(null);
  const simCameraRef = useRef<THREE.OrthographicCamera|null>(null);
  const simMatRef   = useRef<THREE.ShaderMaterial|null>(null);

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
      if (meshRef.current) {
        (meshRef.current.geometry as THREE.BufferGeometry).dispose();
        const m = meshRef.current.material as THREE.ShaderMaterial;
        const tex = m.uniforms?.uTexture?.value as THREE.Texture | undefined;
        if (tex) tex.dispose();
        m.dispose();
        meshRef.current = null;
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
        if (prevPosRTRef.current) {
          prevPosRTRef.current.dispose();
          prevPosRTRef.current = null;
        }
        if (currPosRTRef.current) {
          currPosRTRef.current.dispose();
          currPosRTRef.current = null;
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
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
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
          if (prevTex) prevTex.dispose();
          heightTexRef.current = texture;
          setHeightTexVersion((v) => v + 1);

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh.geometry as THREE.BufferGeometry).dispose();
          mesh.geometry = newGeo;
        }

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

        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("Texture load error", err);
      }
    );
  }, [pngUrl, exaggeration, landTexVersion]);

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
          const count = outW * outH;
          geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));

          // Create zero-initialized RG float render targets for positions (prev/curr)
          const rtOptions: THREE.RenderTargetOptions = {
            type: THREE.FloatType,
            format: THREE.RGFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false,
          };
          const rtPrev = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
          const rtCurr = new THREE.WebGLRenderTarget(outW, outH, rtOptions);

          // Clear both to zeros
          const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
          const prevClearAlpha = renderer.getClearAlpha();
          renderer.setRenderTarget(rtPrev);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, false, false);
          renderer.setRenderTarget(rtCurr);
          renderer.clear(true, false, false);
          renderer.setRenderTarget(null);
          renderer.setClearColor(prevClearColor, prevClearAlpha);

          // Stash and expose via uniforms
          prevPosRTRef.current?.dispose();
          currPosRTRef.current?.dispose();
          prevPosRTRef.current = rtPrev;
          currPosRTRef.current = rtCurr;
          simDimsRef.current = { w: outW, h: outH };

          // Create material with required uniforms
          const mat = new THREE.ShaderMaterial({
            vertexShader: UV_POINTS_VERT,
            fragmentShader: UV_POINTS_FRAG,
            transparent: false,
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
              uPositions: { value: rtPrev.texture },
              uTexWidth: { value: outW },
              uTexHeight: { value: outH },
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
                uPrevPositions: { value: prevPosRTRef.current.texture },
                uDt:     { value: 0.25 },
                uSpeed:  { value: 0.01 },
                uMargin: { value: 0.02 },
                uSize:   { value: new THREE.Vector2(outW, outH) },
                uMode:   { value: 0 },
                uGridW:  { value: texW },
                uGridH:  { value: texH },
                uStep:   { value: UV_POINTS_STEP },
              },
            });
            simScene.add(new THREE.Mesh(simGeom, simMat));
            simSceneRef.current  = simScene;
            simCameraRef.current = simCam;
            simMatRef.current    = simMat;
            // Run one-time initialization pass to seed positions
            const prevViewport = new THREE.Vector4();
            const prevScissor  = new THREE.Vector4();
            const prevScissorTest = renderer.getScissorTest();
            renderer.getViewport(prevViewport);
            renderer.getScissor(prevScissor);
            simMat.uniforms.uMode.value = 0;
            simMat.uniforms.uPrevPositions.value = prevPosRTRef.current.texture;
            renderer.setRenderTarget(currPosRTRef.current);
            renderer.setViewport(0, 0, outW, outH);
            renderer.render(simScene, simCam);
            renderer.setRenderTarget(null);
            renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
            renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
            renderer.setScissorTest(prevScissorTest);
            // Swap so prev holds latest seeded positions; set mode to 1 for updates
            const tmpInit = prevPosRTRef.current!;
            prevPosRTRef.current = currPosRTRef.current!;
            currPosRTRef.current = tmpInit;
            simMat.uniforms.uMode.value = 1;
            // Ensure points sample the seeded positions
            mat.uniforms.uPositions.value = prevPosRTRef.current.texture;
            mat.uniforms.uTexWidth.value = outW;
            mat.uniforms.uTexHeight.value = outH;
          } else {
            // If somehow already present, at least sync uniforms
            simMatRef.current!.uniforms.uPrevPositions.value = prevPosRTRef.current.texture;
            simMatRef.current!.uniforms.uSize.value = new THREE.Vector2(outW, outH);
            simMatRef.current!.uniforms.uGridW.value = texW;
            simMatRef.current!.uniforms.uGridH.value = texH;
            simMatRef.current!.uniforms.uStep.value = UV_POINTS_STEP;
            // One-time (re)initialization after dimensions change
            const prevViewport = new THREE.Vector4();
            const prevScissor  = new THREE.Vector4();
            const prevScissorTest = renderer.getScissorTest();
            renderer.getViewport(prevViewport);
            renderer.getScissor(prevScissor);
            simMatRef.current!.uniforms.uMode.value = 0;
            simMatRef.current!.uniforms.uPrevPositions.value = prevPosRTRef.current.texture;
            renderer.setRenderTarget(currPosRTRef.current);
            renderer.setViewport(0, 0, outW, outH);
            renderer.setScissorTest(false);  
            renderer.render(simSceneRef.current!, simCameraRef.current!);
            renderer.setRenderTarget(null);
            renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
            renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
            renderer.setScissorTest(prevScissorTest);
            const tmpInit2 = prevPosRTRef.current!;
            prevPosRTRef.current = currPosRTRef.current!;
            currPosRTRef.current = tmpInit2;
            simMatRef.current!.uniforms.uMode.value = 1;
            mat.uniforms.uPositions.value = prevPosRTRef.current.texture;
            mat.uniforms.uTexWidth.value = outW;
            mat.uniforms.uTexHeight.value = outH;
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
          if (dimsChanged) {
            // Rebuild position attribute to update vertex count
            const outW = Math.ceil(texW / UV_POINTS_STEP);
            const outH = Math.ceil(texH / UV_POINTS_STEP);
            const count = outW * outH;
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
            uvDimsRef.current = { w: texW, h: texH };

            // Recreate and zero-initialize position render targets for new size
            prevPosRTRef.current?.dispose();
            currPosRTRef.current?.dispose();
            const rtOptions: THREE.RenderTargetOptions = {
              type: THREE.FloatType,
              format: THREE.RGFormat,
              minFilter: THREE.NearestFilter,
              magFilter: THREE.NearestFilter,
              wrapS: THREE.ClampToEdgeWrapping,
              wrapT: THREE.ClampToEdgeWrapping,
              depthBuffer: false,
              stencilBuffer: false,
            };
            const rtPrev = new THREE.WebGLRenderTarget(outW, outH, rtOptions);
            const rtCurr = new THREE.WebGLRenderTarget(outW, outH, rtOptions);

            const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const prevClearAlpha = renderer.getClearAlpha();
            renderer.setRenderTarget(rtPrev);
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(rtCurr);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(null);
            renderer.setClearColor(prevClearColor, prevClearAlpha);

            prevPosRTRef.current = rtPrev;
            currPosRTRef.current = rtCurr;
            simDimsRef.current = { w: outW, h: outH };
            mat.uniforms.uPositions.value = rtPrev.texture;
            mat.uniforms.uTexWidth.value = outW;
            mat.uniforms.uTexHeight.value = outH;
          } else {
            // Keep uniforms in sync
            mat.uniforms.uPositions = mat.uniforms.uPositions || { value: null };
            const dims = simDimsRef.current || { w: Math.ceil(texW / UV_POINTS_STEP), h: Math.ceil(texH / UV_POINTS_STEP) };
            mat.uniforms.uPositions.value = prevPosRTRef.current ? prevPosRTRef.current.texture : null;
            mat.uniforms.uTexWidth.value = dims.w;
            mat.uniforms.uTexHeight.value = dims.h;
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
        if (renderer && camera && meshRef.current) {
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
    const rtPrev   = prevPosRTRef.current;
    const rtCurr   = currPosRTRef.current;
    const dims     = simDimsRef.current;
  
    if (!renderer || !scene || !camera || !controls || !simScene || !simCam || !simMat || !ptsMat || !rtPrev || !rtCurr || !dims) return;
  
    // Use constant dt in shader; no clock needed
    let running = true;
  
    const loop = () => {
      if (!running) return;
      // advance with constant dt via shader uniform; we still tick the clock for consistency if needed elsewhere

      // 0) stash current viewport/scissor state
      const prevViewport = new THREE.Vector4();
      const prevScissor  = new THREE.Vector4();
      const prevScissorTest = renderer.getScissorTest();
      renderer.getViewport(prevViewport);   // x,y,w,h
      renderer.getScissor(prevScissor);     // x,y,w,h

      // --- SIM UPDATE: render into small RT (no feedback-loop) ---
      simMat.uniforms.uPrevPositions.value = prevPosRTRef.current!.texture;
      // Use constant dt = 1.0 as requested
      simMat.uniforms.uDt.value   = 0.25;
      // One-time initialization: if mode==0, run once then set to 1
      if ((simMat.uniforms.uMode.value as number) === 0) {
        simMat.uniforms.uMode.value = 0;
      } else {
        simMat.uniforms.uMode.value = 1;
      }

      renderer.setRenderTarget(currPosRTRef.current!);
      renderer.setViewport(0, 0, dims.w, dims.h);
      // if you had scissor enabled elsewhere, either disable it or set it to match the SIM viewport
      // renderer.setScissorTest(false);
      renderer.render(simScene, simCam);
      renderer.setRenderTarget(null);

      // 1) restore viewport/scissor EXACTLY as they were
      renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
      renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
      renderer.setScissorTest(prevScissorTest);

      // --- SWAP ---
      const tmp = prevPosRTRef.current!;
      prevPosRTRef.current = currPosRTRef.current!;
      currPosRTRef.current = tmp;

      console.log('tmp', tmp);

      // make points sample the latest
      ptsMat.uniforms.uPositions.value = prevPosRTRef.current.texture;

      // --- render your visible scene as usual ---
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
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
