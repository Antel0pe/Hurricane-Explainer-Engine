  // WindUvLayer.tsx
  "use client";
  import * as THREE from "three";
  import { useEffect, useRef } from "react";
import { TRAIL_OVERLAY_FRAG, TRAIL_OVERLAY_VERT, VERT, WindLayerAPI } from "./HeightMesh_Shaders";


  type Props = {
    url: string;
    renderer: THREE.WebGLRenderer | null;
    scene: THREE.Scene | null;
    camera: THREE.Camera | null;
    heightTex: THREE.Texture | null;
    pressureLevel: number;
    exaggeration?: number;
    // your GLSL strings
    UV_POINTS_VERT: string;
    UV_POINTS_FRAG: string;
    SIM_VERT: string;
    SIM_FRAG: string;
    onReady?: (api: WindLayerAPI) => void;
    onRemove?: (api: WindLayerAPI) => void; 
    zOffset?: number;
  };

  export default function WindUvLayer({
    url,
    renderer,
    scene,
    camera,
    heightTex,
    pressureLevel,
    exaggeration,
    UV_POINTS_VERT,
    UV_POINTS_FRAG,
    SIM_VERT,
    SIM_FRAG,
  onReady,
  onRemove,
    zOffset,
  }: Props) {
    // --- per-layer refs (do NOT share across layers)
    const uvPointsRef = useRef<THREE.Points | null>(null);
    const uvGeoRef    = useRef<THREE.BufferGeometry | null>(null);
    const uvMatRef    = useRef<THREE.ShaderMaterial | null>(null);
    const uvTexRef    = useRef<THREE.Texture | null>(null);
    const uvDimsRef   = useRef<{ w: number; h: number } | null>(null);

    const readPositionRTRef  = useRef<THREE.WebGLRenderTarget | null>(null);
    const writePositionRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
    const simDimsRef         = useRef<{ w: number; h: number } | null>(null);
    const simSceneRef        = useRef<THREE.Scene | null>(null);
    const simCameraRef       = useRef<THREE.OrthographicCamera | null>(null);
    const simMatRef          = useRef<THREE.ShaderMaterial | null>(null);

    const outWRef = useRef(0);
    const outHRef = useRef(0);

    const apiRef = useRef<WindLayerAPI | null>(null);

    const trailPointsRef = useRef<THREE.Points | null>(null);
const trailMatRef    = useRef<THREE.ShaderMaterial | null>(null);

const trailReadRTRef  = useRef<THREE.WebGLRenderTarget|null>(null);
const trailWriteRTRef = useRef<THREE.WebGLRenderTarget|null>(null);
const trailOrthoCamRef   = useRef<THREE.OrthographicCamera|null>(null);
const trailDecaySceneRef = useRef<THREE.Scene|null>(null);
const trailDecayMatRef   = useRef<THREE.ShaderMaterial|null>(null);
const trailStampSceneRef = useRef<THREE.Scene|null>(null);
const trailStampMatRef   = useRef<THREE.ShaderMaterial|null>(null);



    useEffect(() => {
      if (!renderer || !scene || !camera || !url) return;

      const loader = new THREE.TextureLoader();
      let disposed = false;

      loader.load(
        url,
        (texture) => {
          if (disposed) { texture.dispose(); return; }

    texture.flipY = false; // <-- IMPORTANT: match the mesh
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;        // <-- longitudinal wrap
    texture.wrapT = THREE.ClampToEdgeWrapping;  
          texture.minFilter = THREE.NearestFilter;
          texture.magFilter = THREE.NearestFilter;
          texture.generateMipmaps = false;
          texture.needsUpdate = true;

          const img = texture.image as unknown as { width?: number; height?: number };
          const texW = typeof img?.width === "number" ? img.width : 0;
          const texH = typeof img?.height === "number" ? img.height : 0;
          if (texW === 0 || texH === 0) {
            uvTexRef.current?.dispose();
            uvTexRef.current = texture;
            return;
          }

          const aspect = texW / texH;
          const dimsChanged = !uvDimsRef.current || uvDimsRef.current.w !== texW || uvDimsRef.current.h !== texH;
          const UV_POINTS_STEP = 10;

          const makeRT = (w: number, h: number) =>
            new THREE.WebGLRenderTarget(w, h, {
              type: THREE.FloatType,
              format: THREE.RGBAFormat,
              minFilter: THREE.NearestFilter,
              magFilter: THREE.NearestFilter,
              wrapS: THREE.ClampToEdgeWrapping,
              wrapT: THREE.ClampToEdgeWrapping,
              depthBuffer: false,
              stencilBuffer: false
            });

          const zeroRT = (rt: THREE.WebGLRenderTarget) => {
            const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const prevClearAlpha = renderer.getClearAlpha();
            renderer.setRenderTarget(rt);
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(null);
            renderer.setClearColor(prevClearColor, prevClearAlpha);
          };

          if (!uvPointsRef.current) {
            // build fresh
            const outW = Math.ceil(texW / UV_POINTS_STEP);
            const outH = Math.ceil(texH / UV_POINTS_STEP);
            outWRef.current = outW;
            outHRef.current = outH;

            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outW * outH * 3), 3));

            const rtRead  = makeRT(outW, outH);
            const rtWrite = makeRT(outW, outH);
            rtRead.texture.generateMipmaps = false;
            rtWrite.texture.generateMipmaps = false;
            zeroRT(rtRead);
            zeroRT(rtWrite);

            readPositionRTRef.current  = rtRead;
            writePositionRTRef.current = rtWrite;
            simDimsRef.current = { w: outW, h: outH };

            const mat = new THREE.ShaderMaterial({
              vertexShader: UV_POINTS_VERT,
              fragmentShader: UV_POINTS_FRAG,
              transparent: true,
              blending: THREE.NormalBlending,
              depthWrite: false,
              glslVersion: THREE.GLSL3,
              side: THREE.DoubleSide,
              uniforms: {
                uTerrainTexture: { value: heightTex },
                uExaggeration:   { value: exaggeration ?? 0.5 },
                uAspect:         { value: aspect },
                uPointSize:      { value: (1.5 * (window.devicePixelRatio || 1)) * 3.0 },
                uGridW:          { value: texW },
                uGridH:          { value: texH },
                uStep:           { value: UV_POINTS_STEP },
                uAboveTerrain:   { value: 0.1 },
                uCurrentPosition:{ value: rtRead.texture },
                uSimSize:        { value: new THREE.Vector2(outW, outH) },
                uPressure:       { value: pressureLevel },
                zOffset: { value: zOffset },
              }
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
                  uPrev:   { value: rtRead.texture },
                  uDt:     { value: 0 },
                  uSpeed:  { value: 0.5 },
                  uSize:   { value: new THREE.Vector2(outW, outH) },
                  uWindTexture: { value: texture }
                }
              });
              simScene.add(new THREE.Mesh(simGeom, simMat));
              simSceneRef.current  = simScene;
              simCameraRef.current = simCam;
              simMatRef.current    = simMat;
            } else {
              simMatRef.current!.uniforms.uPrev.value = writePositionRTRef.current!.texture;
              simMatRef.current!.uniforms.uSize.value = new THREE.Vector2(outW, outH);
            }

            const pts = new THREE.Points(geo, mat);
            // potential performance bottleneck since disables threejs from not rendering things that arent visible
            // in this case makes sense because currently want particles always rendered
            pts.frustumCulled = false;
            scene.add(pts);

            uvPointsRef.current = pts;
            uvGeoRef.current    = geo;
            uvMatRef.current    = mat;
            uvTexRef.current?.dispose();
            uvTexRef.current = texture;
            uvDimsRef.current = { w: texW, h: texH };

            // --- TRAIL LAYER (green) ---
// Reuse SAME vertex shader as moving points, but different fragment shader (green)
// and its own uniforms (esp. uCurrentPosition bound to rtRead.texture)
const trailMat = new THREE.ShaderMaterial({
  vertexShader: UV_POINTS_VERT,         // same placement logic
  fragmentShader: `
    precision highp float;
    out vec4 fragColor;
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      if(dot(d,d) > 0.25) discard;
      fragColor = vec4(0.0, 1.0, 0.0, 0.65); // green
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  glslVersion: THREE.GLSL3,
  side: THREE.DoubleSide,
  uniforms: {
    uTerrainTexture: { value: heightTex },            // same inputs so vertex has what it needs
    uExaggeration:   { value: typeof exaggeration === "number" ? exaggeration : 0.5 },
    uAspect:         { value: aspect },
    // keep trail a tad smaller (independent size per material)
    uPointSize:      { value: (1.5 * (window.devicePixelRatio || 1)) * 2.0 },
    uGridW:          { value: texW },
    uGridH:          { value: texH },
    uStep:           { value: 10 },
    uAboveTerrain:   { value: 0.1 },
    uCurrentPosition:{ value: rtRead.texture },       // <-- IMPORTANT: bind to current readRT
    uSimSize:        { value: new THREE.Vector2(outW, outH) },
    uPressure:       { value: pressureLevel },
    zOffset:         { value: zOffset ?? 0.0 },
  }
});

// reuse the SAME geometry so it draws at the same UV sampling
const trailPts = new THREE.Points(geo, trailMat);
trailPts.frustumCulled = false;
// scene.add(trailPts);

// stash refs
trailMatRef.current = trailMat;
trailPointsRef.current = trailPts;

const makeTrailRT = (w:number,h:number) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false
  });

const trailW = texW; // or Math.floor(texW/2)
const trailH = texH; // or Math.floor(texH/2)

trailReadRTRef.current  = makeTrailRT(trailW, trailH);
trailWriteRTRef.current = makeTrailRT(trailW, trailH);

// clear to black once
renderer.setRenderTarget(trailReadRTRef.current);
renderer.clearColor();
renderer.clear(true,false,false);
renderer.setRenderTarget(null);

// === TRAIL OVERLAY PLANE (covers full UV extent, sits on globe) ===
// was: new THREE.PlaneGeometry(aspect, 1, 1, 1)
const trailOverlayGeo = new THREE.PlaneGeometry(aspect, 1, 256, 128);
const trailOverlayMat = new THREE.ShaderMaterial({
  vertexShader: TRAIL_OVERLAY_VERT,       // your working globe-mapped vertex
  fragmentShader: TRAIL_OVERLAY_FRAG,
  transparent: true,
  depthTest: true,     // draw over everything
  depthWrite: false,
  blending: THREE.NormalBlending, // or AdditiveBlending if you want it to pop more
  side: THREE.DoubleSide,
  // IMPORTANT: leave GLSL1 (default). The shader uses texture2D/varying.
  uniforms: {
  uTrailTex:  { value: trailReadRTRef.current!.texture },
  uColor:     { value: new THREE.Color(0x00ff00) },
  uGain:      { value: 1.0 },
  uThreshold: { value: 0.02 } // tweak
  }
});

const trailOverlayMesh = new THREE.Mesh(trailOverlayGeo, trailOverlayMat);
// trailOverlayMesh.frustumCulled = false;
// trailOverlayMesh.renderOrder = 9999;  // ensure it draws last
// trailOverlayMat.toneMapped = false;   // with ACES renderer, avoid tonemapping the UI overlay
scene.add(trailOverlayMesh);


const decayVS = `
  precision highp float;
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position.xy,0.0,1.0);
  }`;
const decayFS = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrailPrev;
  uniform float uDecay;        // 0.0 = 1-frame trails, 0.94..0.99 = long trails
  void main(){
    vec3 prev = texture2D(uTrailPrev, vUv).rgb;
    gl_FragColor = vec4(prev * uDecay, 1.0);
  }`;

trailOrthoCamRef.current = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
trailDecayMatRef.current = new THREE.ShaderMaterial({
  vertexShader: decayVS,
  fragmentShader: decayFS,
  uniforms: {
    uTrailPrev: { value: trailReadRTRef.current!.texture },
    uDecay:     { value: 0.0 } // start with “1-frame trail” proof
  },
  depthTest:false, depthWrite:false, blending:THREE.NoBlending, transparent:false, toneMapped:false
});
const decayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), trailDecayMatRef.current);
trailDecaySceneRef.current = new THREE.Scene();
trailDecaySceneRef.current.add(decayQuad);
const stampVS = `
precision highp float;
uniform sampler2D uCurrentPosition; // RG = (u,v)
uniform ivec2    uSimSize;          // (outW,outH)
uniform float    uPointSize;        // px in trail RT
void main(){
  int outW = uSimSize.x;
  int id   = gl_VertexID;
  int i    = id % outW;
  int j    = id / outW;
  vec2 st  = (vec2(i,j)+0.5)/vec2(uSimSize);
  vec2 uv  = texture(uCurrentPosition, st).rg;
  vec2 clip= uv*2.0-1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;
const stampFS = `
precision highp float;
out vec4 fragColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d,d);
  if (r2>0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  fragColor = vec4(1.0,1.0,1.0,a); // accumulate intensity; color later on overlay
}`;

trailStampMatRef.current = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: stampVS,
  fragmentShader: stampFS,
  uniforms:{
    uCurrentPosition:{ value: readPositionRTRef.current!.texture },
    uSimSize:        { value: new THREE.Vector2(outW, outH) },
    uPointSize:      { value: 2.0 * (window.devicePixelRatio||1) } // tweak thickness
  },
  depthTest:false, depthWrite:false,
  blending:THREE.AdditiveBlending, transparent:true, toneMapped:false
});
// points need a scene & an ortho cam
trailStampSceneRef.current = new THREE.Scene();
trailStampSceneRef.current.add(new THREE.Points(geo, trailStampMatRef.current));




apiRef.current = {
  simScene: simSceneRef.current!,      // your created sim scene
  simCam:   simCameraRef.current!,     // your ortho cam
  simMat:   simMatRef.current!,        // your sim material
  readRT:   readPositionRTRef.current!,
  writeRT:  writePositionRTRef.current!,
  ptsMat:   uvMatRef.current!,         // the points ShaderMaterial
  outW, outH,
  trailMat: trailMatRef.current!,
    trailReadRT:  trailReadRTRef.current!,
  trailWriteRT: trailWriteRTRef.current!,
  trailW,       trailH,
  trailOrthoCam: trailOrthoCamRef.current!,
  trailDecayScene: trailDecaySceneRef.current!,
  trailDecayMat:   trailDecayMatRef.current!,
  trailStampScene: trailStampSceneRef.current!,
  trailStampMat:   trailStampMatRef.current!,
  trailOverlayMat: trailOverlayMat
};
(apiRef.current as any).trailOverlayMat = trailOverlayMat;
onReady?.(apiRef.current);
} else {
            // update existing
            const mat = uvMatRef.current!;
            const geo = uvGeoRef.current!;
            mat.uniforms.uTerrainTexture.value = heightTex;
            mat.uniforms.uExaggeration.value   = typeof exaggeration === "number" ? exaggeration : 0.5;
            mat.uniforms.uAspect.value         = aspect;
            mat.uniforms.uPointSize.value      = (1.5 * (window.devicePixelRatio || 1)) * 3.0;
            mat.uniforms.uGridW.value          = texW;
            mat.uniforms.uGridH.value          = texH;
            mat.uniforms.uStep.value           = 10;
            mat.uniforms.uAboveTerrain.value   = 0.01;
            mat.uniforms.zOffset.value   = zOffset;

            if (dimsChanged) {
              const outW = Math.ceil(texW / 10);
              const outH = Math.ceil(texH / 10);
              const count = outW * outH;
              geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
              uvDimsRef.current = { w: texW, h: texH };

              readPositionRTRef.current?.dispose();
              writePositionRTRef.current?.dispose();
              const rtRead  = makeRT(outW, outH);
              const rtWrite = makeRT(outW, outH);
              rtRead.texture.generateMipmaps = false;
              rtWrite.texture.generateMipmaps = false;
              zeroRT(rtRead);
              zeroRT(rtWrite);

              readPositionRTRef.current  = rtRead;
              writePositionRTRef.current = rtWrite;
              simDimsRef.current         = { w: outW, h: outH };

              mat.uniforms.uPrev     = mat.uniforms.uPrev || { value: null };
              mat.uniforms.uSimSize  = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
              mat.uniforms.uPrev.value    = readPositionRTRef.current.texture;
              mat.uniforms.uSimSize.value = new THREE.Vector2(outW, outH);

              if (apiRef.current) {
        apiRef.current.readRT  = readPositionRTRef.current!;
        apiRef.current.writeRT = writePositionRTRef.current!;
        apiRef.current.ptsMat  = uvMatRef.current!;
        apiRef.current.outW = outW; apiRef.current.outH = outH;
      }
            } else {
              mat.uniforms.uPrev     = mat.uniforms.uPrev || { value: null };
              mat.uniforms.uSimSize  = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
              mat.uniforms.uPrev.value    = readPositionRTRef.current ? readPositionRTRef.current.texture : null;
              const dims = simDimsRef.current!;
              mat.uniforms.uSimSize.value = new THREE.Vector2(dims.w, dims.h);
            }

            uvTexRef.current?.dispose();
            uvTexRef.current = texture;
          }

          // optional: immediate draw
          renderer.render(scene, camera);
        },
        undefined,
        () => {}
      );

      return () => {
        disposed = true;
          if (apiRef.current && typeof onRemove === "function") {
            try { onRemove(apiRef.current); } catch {}
          }

        // clean up this layer only
        uvPointsRef.current && scene?.remove(uvPointsRef.current);
        uvPointsRef.current?.geometry?.dispose();
        if (uvPointsRef.current?.material instanceof THREE.Material){
          uvPointsRef.current?.material?.dispose?.();
        }
        uvPointsRef.current = null;

        uvGeoRef.current?.dispose(); uvGeoRef.current = null;
        uvMatRef.current?.dispose(); uvMatRef.current = null;
        uvTexRef.current?.dispose(); uvTexRef.current = null;

        readPositionRTRef.current?.dispose();  readPositionRTRef.current = null;
        writePositionRTRef.current?.dispose(); writePositionRTRef.current = null;

        simMatRef.current?.dispose(); simMatRef.current = null;
        simSceneRef.current = null;
        simCameraRef.current = null;
        simDimsRef.current = null;

        apiRef.current = null;
      };
    // re-run when these change for THIS layer only
    }, [url, renderer, scene, camera, heightTex, pressureLevel, exaggeration, UV_POINTS_VERT, UV_POINTS_FRAG, SIM_VERT, SIM_FRAG]);

    return null; // this component only side-effects into the shared scene
  }
