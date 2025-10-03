// CloudCoverLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Swap this to your endpoint (PNG of the global fBm look field, R in [0..1])
const FBM_NOISE_API = "/api/cloud_cover/noise";

function colorChannelFromPressure(p: number): 0|1|2 {
  if (p === 850) return 0; // R
  if (p === 500) return 2; // B
  if (p === 250) return 1; // G
  return 0;                // default to R
}


// -------------------------- Small in-file pipeline manager --------------------------
class CloudPipelineManager {
  constructor(
    private renderer: THREE.WebGLRenderer,
    private w: number,
    private h: number,
    private tile: number
  ) {
    this.setup();
  }

  // Render targets
  private covBlurH!: THREE.WebGLRenderTarget;
  private covBlurV!: THREE.WebGLRenderTarget; // mip-capable
  private maskRT!: THREE.WebGLRenderTarget;   // mip-capable
  private tauRT!: THREE.WebGLRenderTarget;    // full-res τ
  private tauLoRT!: THREE.WebGLRenderTarget;  // full-res lo
  private tauHiRT!: THREE.WebGLRenderTarget;  // full-res hi
  private tauTileRT!: THREE.WebGLRenderTarget;// tile-res packed (tau,lo,hi,_)
  private tauBlurH!: THREE.WebGLRenderTarget;
private tauBlurV!: THREE.WebGLRenderTarget;
private singleRedChannelForPressureLevelTarget!: THREE.WebGLRenderTarget; // single-channel (R) selected from RGB
private copyPressureLevelChannelToRed!: THREE.ShaderMaterial;   // copies chosen channel -> R



  // Fullscreen quad scene
  private quad!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private scene = new THREE.Scene();
  private cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Materials
  private blurHMat!: THREE.ShaderMaterial;
  private blurVMat!: THREE.ShaderMaterial;
  private maskMat!:  THREE.ShaderMaterial;
  private updateMat!:THREE.ShaderMaterial;
  private upsampleMat!: THREE.ShaderMaterial;

  private setup() {
    const rNoMip: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType,
      format: THREE.RedFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    };
    const rMip: THREE.RenderTargetOptions = {
      ...rNoMip,
      generateMipmaps: true,                       // needed for mip LOD sampling
      minFilter: THREE.LinearMipmapLinearFilter,
    };

    this.covBlurH = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.covBlurV = new THREE.WebGLRenderTarget(this.w, this.h, rMip);
    this.maskRT   = new THREE.WebGLRenderTarget(this.w, this.h, rMip);
    this.tauRT    = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauLoRT  = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauHiRT  = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauBlurH = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauBlurV = new THREE.WebGLRenderTarget(this.w, this.h, {
      ...rNoMip,
      generateMipmaps: true,                    // allow LOD sampling if desired
      minFilter: THREE.LinearMipmapLinearFilter
    } as THREE.RenderTargetOptions);
this.singleRedChannelForPressureLevelTarget = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);

// Swizzle shader: pick uChan = 0 (R), 1 (G), 2 (B)
this.copyPressureLevelChannelToRed = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: `
    out vec2 vUv;
    void main(){ vUv = 0.5*(position.xy+1.0); gl_Position = vec4(position,1.0); }
  `,
  fragmentShader: `
    precision highp float; in vec2 vUv; out vec4 fragColor;
    uniform sampler2D uSrc;
    uniform int uChan;
    void main(){
      vec3 c = texture(uSrc, vUv).rgb;
      float v = (uChan == 0) ? c.r : ((uChan == 1) ? c.g : c.b);
      fragColor = vec4(v, 0.0, 0.0, 1.0); // write selected channel into .r
    }
  `,
  uniforms: { uSrc: { value: null }, uChan: { value: 0 } }
});


    const tilesX = Math.ceil(this.w / this.tile);
    const tilesY = Math.ceil(this.h / this.tile);
    this.tauTileRT = new THREE.WebGLRenderTarget(tilesX, tilesY, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });

    // Fullscreen quad
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial()
    );
    this.scene.add(this.quad);

    // Shaders
    const vs = `
    out vec2 vUv;
    void main(){ vUv = 0.5*(position.xy+1.0); gl_Position=vec4(position,1.0); }`;

    const fsHead = `
    precision highp float; in vec2 vUv; out vec4 fragColor;`;

    // 5-tap separable Gaussian (H)
    this.blurHMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vs,
      fragmentShader: fsHead + `
        uniform sampler2D uSrc; uniform float uTexel; 
        void main(){
          float w0=0.204164, w1=0.304005;
          float s=0.0;
          s += w0*texture(uSrc, vUv + vec2(-2.0*uTexel,0)).r;
          s += w1*texture(uSrc, vUv + vec2(-1.0*uTexel,0)).r;
          s += (1.0-2.0*(w1+w0))*texture(uSrc, vUv).r;
          s += w1*texture(uSrc, vUv + vec2(+1.0*uTexel,0)).r;
          s += w0*texture(uSrc, vUv + vec2(+2.0*uTexel,0)).r;
          fragColor = vec4(s,0,0,1);
        }`,
      uniforms: { uSrc: { value: null }, uTexel: { value: 1 / this.w } }
    });

    // 5-tap separable Gaussian (V)
    this.blurVMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vs,
      fragmentShader: fsHead + `
        uniform sampler2D uSrc; uniform float uTexel; 
        void main(){
          float w0=0.204164, w1=0.304005;
          float s=0.0;
          s += w0*texture(uSrc, vUv + vec2(0,-2.0*uTexel)).r;
          s += w1*texture(uSrc, vUv + vec2(0,-1.0*uTexel)).r;
          s += (1.0-2.0*(w1+w0))*texture(uSrc, vUv).r;
          s += w1*texture(uSrc, vUv + vec2(0,+1.0*uTexel)).r;
          s += w0*texture(uSrc, vUv + vec2(0,+2.0*uTexel)).r;
          fragColor = vec4(s,0,0,1);
        }`,
      uniforms: { uSrc: { value: null }, uTexel: { value: 1 / this.h } }
    });

    // Mask pass: M = step(T, L)
    this.maskMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vs,
      fragmentShader: fsHead + `
        uniform sampler2D uLook, uTau;
        void main(){
          float L = texture(uLook, vUv).r;
          float T = texture(uTau,  vUv).r;
          fragColor = vec4(step(T, L), 0.0, 0.0, 1.0);
        }`,
      uniforms: { uLook: { value: null }, uTau: { value: null } }
    });

    // Tile update at LOD = log2(tile)
    this.updateMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vs,
      fragmentShader: fsHead + `
        uniform sampler2D uTau, uTauLo, uTauHi, uMask, uCov;
        uniform float uLod;
        void main(){
          float meanM = textureLod(uMask, vUv, uLod).r;
          float meanC = textureLod(uCov,  vUv, uLod).r;
          float lo = textureLod(uTauLo, vUv, uLod).r;
          float hi = textureLod(uTauHi, vUv, uLod).r;
          float t  = textureLod(uTau,   vUv, uLod).r;
          if (meanM > meanC) lo = t; else hi = t;
          t = 0.5*(lo+hi);
          fragColor = vec4(t, lo, hi, 1.0);
        }`,
      uniforms: {
        uTau: { value: null }, uTauLo: { value: null }, uTauHi: { value: null },
        uMask:{ value: null }, uCov:   { value: null },
        uLod: { value: Math.log2(this.tile) }
      }
    });

    // Upsample tile → full res (pack .r=.t)
    this.upsampleMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vs,
      fragmentShader: fsHead + `uniform sampler2D uSrc; void main(){ fragColor=texture(uSrc, vUv);} `,
      uniforms: { uSrc: { value: null } }
    });
  }

  dispose() {
    [this.covBlurH, this.covBlurV, this.maskRT, this.tauRT, this.tauLoRT, this.tauHiRT, this.tauTileRT]
      .forEach(rt => rt.dispose());
    this.quad.geometry.dispose();
    this.quad.material.dispose();
    [this.covBlurH, this.covBlurV, this.maskRT, this.tauRT, this.tauLoRT, this.tauHiRT, this.tauTileRT, this.tauBlurH, this.tauBlurV]
  .forEach(rt => rt.dispose());
  this.singleRedChannelForPressureLevelTarget.dispose();
this.copyPressureLevelChannelToRed.dispose();


  }

  private draw(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, viewport?: {w:number,h:number}) {
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevVP = new THREE.Vector4(); r.getViewport(prevVP);
    const prevSc = new THREE.Vector4(); r.getScissor(prevSc);
    const prevST = r.getScissorTest();

    r.setScissorTest(false);
    if (viewport) r.setViewport(0, 0, viewport.w, viewport.h); else r.setViewport(0,0,this.w,this.h);

    this.quad.material = mat;
    r.setRenderTarget(target);
    r.clear();
    r.render(this.scene, this.cam);

    r.setRenderTarget(prevRT);
    r.setViewport(prevVP);
    r.setScissor(prevSc);
    r.setScissorTest(prevST);
  }

  runOnce(params: {
    covRawTex: THREE.Texture;    // ERA5 red channel texture (R in [0..1])
    lookTex:   THREE.Texture;    // fBm look texture (R in [0..1])
    iterations?: number;         // 8..12 typical
    colorChannel?: 0 | 1 | 2;   // 0=R, 1=G, 2=B  
  }) {
    const { covRawTex, lookTex, iterations = 10, colorChannel = 0 } = params;

    // Init τ/lo/hi (0.5/0/1) in one small helper
    const initMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `out vec2 vUv; void main(){ vUv=0.5*(position.xy+1.0); gl_Position=vec4(position,1.0); }`,
      fragmentShader: `precision highp float; in vec2 vUv; out vec4 fragColor; uniform vec3 uInit; void main(){ fragColor=vec4(uInit,1.0);} `,
      uniforms: { uInit: { value: new THREE.Vector3() } }
    });

    // 0) Swizzle desired RGB -> R (so downstream shaders keep reading .r)
    this.copyPressureLevelChannelToRed.uniforms.uSrc.value  = covRawTex;
    this.copyPressureLevelChannelToRed.uniforms.uChan.value = colorChannel;
    this.draw(this.copyPressureLevelChannelToRed, this.singleRedChannelForPressureLevelTarget);

    // 1) Blur coverage H→V into covBlurV (mips enabled)
    this.blurHMat.uniforms.uSrc.value = this.singleRedChannelForPressureLevelTarget.texture;
    this.draw(this.blurHMat, this.covBlurH);

    this.blurVMat.uniforms.uSrc.value = this.covBlurH.texture;
    this.draw(this.blurVMat, this.covBlurV);
    this.covBlurV.texture.generateMipmaps = true;

    // 2) Init τ fields
    initMat.uniforms.uInit.value.set(0.5, 0.0, 0.0); this.draw(initMat, this.tauRT);
    initMat.uniforms.uInit.value.set(0.0, 0.0, 0.0); this.draw(initMat, this.tauLoRT);
    initMat.uniforms.uInit.value.set(1.0, 0.0, 0.0); this.draw(initMat, this.tauHiRT);
    initMat.dispose();

    // 3) Iterate K times
    this.maskMat.uniforms.uLook.value = lookTex;

    for (let k = 0; k < iterations; k++) {
      // Mask at full res
      this.maskMat.uniforms.uTau.value = this.tauRT.texture;
      this.draw(this.maskMat, this.maskRT);

      // mipmaps for mask & coverage
      this.maskRT.texture.generateMipmaps = true;

      // Tile update (render to tile RT size)
      this.updateMat.uniforms.uTau.value   = this.tauRT.texture;
      this.updateMat.uniforms.uTauLo.value = this.tauLoRT.texture;
      this.updateMat.uniforms.uTauHi.value = this.tauHiRT.texture;
      this.updateMat.uniforms.uMask.value  = this.maskRT.texture;
      this.updateMat.uniforms.uCov.value   = this.covBlurV.texture;

      this.draw(this.updateMat, this.tauTileRT, { w: this.tauTileRT.width, h: this.tauTileRT.height });

      // Upsample τ/lo/hi back to full res (nearest/bilinear)
      this.upsampleMat.uniforms.uSrc.value = this.tauTileRT.texture;
      this.draw(this.upsampleMat, this.tauRT);
      this.draw(this.upsampleMat, this.tauLoRT);
      this.draw(this.upsampleMat, this.tauHiRT);
    }
    // --- τ blur for Option E ---
this.blurHMat.uniforms.uSrc.value = this.tauRT.texture;
this.draw(this.blurHMat, this.tauBlurH);

this.blurVMat.uniforms.uSrc.value = this.tauBlurH.texture;
this.draw(this.blurVMat, this.tauBlurV);
this.tauBlurV.texture.generateMipmaps = true;

return { covBlur: this.covBlurV.texture, tau: this.tauRT.texture, tauBlur: this.tauBlurV.texture };


  }
}

// ------------------------------- Display shaders -------------------------------
const CLOUD_VERT = /* glsl */`
out vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// Final lightweight compose: feathered mask × coverage
const CLOUD_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld; out vec4 fragColor;
uniform sampler2D uLook;   // fBm look tex
uniform sampler2D uTau;    // solved thresholds
uniform sampler2D uCov;    // blurred coverage
uniform float uOpacity;
uniform float uEps;        // feather width in look-space
uniform float uLonOffset;
uniform bool  uFlipV;
uniform sampler2D uTauBlur; // blurred tau
uniform bool  uUseTauBlur;  // toggle
uniform float uK;           // reuse blend factor


vec2 worldToUV(vec3 p){
  vec3 n = normalize(p);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
  float v = 0.5 - lat / 3.141592653589793;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

void main(){
  vec2 uv = worldToUV(vWorld);
  float L = texture(uLook, uv).r;
  float T = texture(uTau,  uv).r;
  float C = texture(uCov,  uv).r;

  // Feathered binary (keeps edges soft)
  // float mask = smoothstep(T - uEps, T + uEps, L);
  // float alpha = 1.0 * C;

    // Option C: coverage floor blend
  // float mask = smoothstep(T - uEps, T + uEps, L);
  // float alpha = mix(C, mask * C, uK); // (1-k)*C + k*(mask*C)

    // Option E: soft + floor + blurred tau
  float T_used = uUseTauBlur ? texture(uTauBlur, uv).r : T;
  float mask   = smoothstep(T_used - uEps, T_used + uEps, L);
  float alpha  = mix(C, mask * C, uK);



  if (alpha <= 0.001) discard;
  fragColor = vec4(vec3(alpha), alpha * uOpacity);
}
`;

// -------------------------------- React component --------------------------------
type Props = {
  url: string;                               // ERA5 coverage (red channel)
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  controls?: OrbitControls | null;
  enabled?: boolean;
  opacity?: number;                          // final cloud opacity scaler
  feather?: number;                          // look-space feather width, e.g. 0.02
  eraSize?: { w: number; h: number };        // defaults 1440x721
  tilePx?: number;                           // per-tile solver size (e.g., 32)
  iterations?: number;                       // threshold iterations (e.g., 10)
  pressureLevel: number;
};

export default function CloudCoverLayer({
  url,
  renderer,
  scene,
  camera,
  pressureLevel,
  enabled = true,
  opacity = 0.85,
  feather = 0.02,
  eraSize = { w: 1440, h: 721 },
  tilePx = 32,
  iterations = 10,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef  = useRef<THREE.ShaderMaterial | null>(null);
  const pipelineRef = useRef<CloudPipelineManager | null>(null);
  const lookTexRef  = useRef<THREE.Texture | null>(null);
  const era5CoverageRawRef   = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!enabled || !renderer || !scene || !camera) return;
    let disposed = false;

    // Create/refresh pipeline if dims/renderer changed
    pipelineRef.current?.dispose();
    pipelineRef.current = new CloudPipelineManager(renderer, eraSize.w, eraSize.h, tilePx);

    const loader = new THREE.TextureLoader();

    // Load ERA5 coverage (red channel)
    loader.load(
      url,
      t => {
        if (disposed) { t.dispose(); return; }
        t.flipY = true;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.colorSpace = THREE.NoColorSpace;
        era5CoverageRawRef.current = t;
        tryRunPipelineAndAttach();
      },
      undefined,
      err => console.error("CloudCover: ERA5 load error", err)
    );

    // Load fBm look texture
    loader.load(
      FBM_NOISE_API,
      t => {
        if (disposed) { t.dispose(); return; }
        t.flipY = true;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.colorSpace = THREE.NoColorSpace;
        lookTexRef.current = t;
        tryRunPipelineAndAttach();
      },
      undefined,
      err => console.error("CloudCover: FBM look load error", err)
    );

    function tryRunPipelineAndAttach() {
      if (!pipelineRef.current || !era5CoverageRawRef.current || !lookTexRef.current) return;
      const colorChannel = colorChannelFromPressure(pressureLevel);
      // ---- Run full pipeline (blur + per-tile threshold iterations) ----
      const { covBlur, tau, tauBlur } = pipelineRef.current.runOnce({
        covRawTex: era5CoverageRawRef.current,
        lookTex:   lookTexRef.current,
        iterations,
        colorChannel: colorChannel
      });

      // ---- Build/refresh the visible cloud mesh ----
      const globeRadius = 100;
      const overlayR = globeRadius + 0.25;
      if (!meshRef.current) {
        const geom = new THREE.SphereGeometry(overlayR, 256, 128);
        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader:   CLOUD_VERT,
          fragmentShader: CLOUD_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.NormalBlending,
          uniforms: {
            uLook:   { value: lookTexRef.current },
            uTau:    { value: tau },
            uCov:    { value: covBlur },
            uOpacity:{ value: opacity },
            uEps:    { value: feather },
            uLonOffset: { value: 0.25 },
            uFlipV:     { value: true },
uTauBlur: { value: tauBlur },     // blurred tau (Option E)
uUseTauBlur: { value: true },     // toggle for Option E
uK: { value: 0.7 },               // keep the floor blend from Option C

          }
        });
        mat.toneMapped = false;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder   = 15;
        scene!.add(mesh);
        meshRef.current = mesh;
        matRef.current  = mat;
      } else {
        const mat = matRef.current!;
        mat.uniforms.uLook.value = lookTexRef.current;
        mat.uniforms.uTau.value  = tau;
        mat.uniforms.uCov.value  = covBlur;
        mat.uniforms.uTau.value     = tau;
mat.uniforms.uCov.value     = covBlur;
mat.uniforms.uTauBlur.value = tauBlur;

      }

      renderer!.render(scene!, camera!);
    }

    return () => {
      disposed = true;
      pipelineRef.current?.dispose(); pipelineRef.current = null;
      if (meshRef.current && scene) scene.remove(meshRef.current);
      meshRef.current?.geometry.dispose();
      (meshRef.current?.material as THREE.ShaderMaterial | undefined)?.dispose?.();
      meshRef.current = null;
      matRef.current  = null;
      era5CoverageRawRef.current?.dispose();  era5CoverageRawRef.current  = null;
      lookTexRef.current?.dispose(); lookTexRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera, opacity, feather, eraSize.w, eraSize.h, tilePx, iterations]);

  // Live param updates
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uOpacity.value = opacity; }, [opacity]);
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uEps.value     = feather; }, [feather]);

  return null;
}
