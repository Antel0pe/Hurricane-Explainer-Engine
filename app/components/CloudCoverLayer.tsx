// CloudCoverLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PaneHub } from "./tweaks/PaneHub";
import { GET_POSITION_Z_SHARED_GLSL3 } from "./ShadersLib";
import { getGlobeRadius } from "../utils/globeInfo";

// Swap this to your endpoint (PNG of the global fBm look field, R in [0..1])
const FBM_NOISE_API = "/api/cloud_cover/noise";

function colorChannelFromPressure(p: number): 0|1|2 {
  if (p === 850) return 0; // R
  if (p === 500) return 1; // G
  if (p === 250) return 2; // B
  return 0;                // default to R
}

function zOffsetForPressure(p: number): number {
  if (p === 850) return 0.5;
  if (p === 500) return 1.0;
  if (p === 250) return 1.5;
  return 0.5;
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
    // this.singleRedChannelForPressureLevelTarget.texture.generateMipmaps = true;

    // 1) Blur coverage H→V into covBlurV (mips enabled)
    // this.blurHMat.uniforms.uSrc.value = this.singleRedChannelForPressureLevelTarget.texture;
    // this.draw(this.blurHMat, this.covBlurH);

    // this.blurVMat.uniforms.uSrc.value = this.covBlurH.texture;
    // this.draw(this.blurVMat, this.covBlurV);
    // this.covBlurV.texture.generateMipmaps = true;

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
      this.updateMat.uniforms.uCov.value   = this.singleRedChannelForPressureLevelTarget.texture;

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

return { singleChannelRawEra5: this.singleRedChannelForPressureLevelTarget.texture, tau: this.tauRT.texture, tauBlur: this.tauBlurV.texture };


  }
}

const CLOUD_SHELL_VERT = `
// bring in your GLSL3 decoder & ranges
${GET_POSITION_Z_SHARED_GLSL3}

const float PI = 3.14159265358979323846;
out vec3 vWorld;
flat out int vShell;

uniform float uBaseR;           // meters/world units
uniform float uDz;              // per-shell spacing
uniform int   uShellCount;

uniform float uZOffset;         // per-layer vertical offset (meters/world units)

// terrain sampling
uniform bool       uUseTerrain;
uniform sampler2D  uTerrainTexture;
uniform float      uExaggeration;   // SAME semantics as winds (before *50)
uniform float      uAboveTerrain;   // meters/world units to add

// mapping parity with fragment shader
uniform float uLonOffset;
uniform bool  uFlipV;

vec2 worldToUV_dir(vec3 dirW){
  vec3 n = normalize(dirW);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  float u = fract(lon / (2.0*PI) + 0.5 + uLonOffset);
  float v = 0.5 - lat / PI;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

void main(){
  float idx = float(gl_InstanceID);

  // object-space unit vector from sphere mesh
  vec3 dir_obj = normalize(position);

  // rotate to WORLD space (ignore translation; w=0)
  vec3 dir_world = normalize((modelMatrix * vec4(dir_obj, 0.0)).xyz);

  // ---- sample terrain in world-UV space, using SAME decoder as winds ----
  float terrainMeters = 0.0;
  if (uUseTerrain) {
    vec2 uv = worldToUV_dir(dir_world);
    // returns t in [0,1] when exaggeration==1.0 (your helper)
    float hNorm = get_position_z_glsl3(uTerrainTexture, uv, 1.0);
    // match winds: uExaggeration * 50.0 * t + uAboveTerrain
    terrainMeters = uExaggeration * hNorm + uAboveTerrain;
  }

  // final radius: base + shell + terrain + per-layer z offset
  float radius = uBaseR + idx * uDz + terrainMeters + uZOffset;

  vec3 shellPos_world = dir_world * radius;
  vec4 wp = vec4(shellPos_world, 1.0);

  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  vShell = gl_InstanceID;
}
`

const CLOUD_FRAG = /* glsl */`
// CLOUD_FRAG — accurate per-pixel quantile + cloud styling
precision highp float;

flat in int vShell;
in vec3 vWorld;
out vec4 fragColor;

uniform sampler2D uLook;      // correlated carrier (tileable fBm / warped noise), linear
uniform sampler2D uCov;       // ERA5 coverage (0..1) as DATA texture (linear, nearest, no mips)

uniform float uOpacity;       // final alpha scaler
uniform float uEps;           // feather width around threshold (e.g. 0.02)
uniform float uK;             // coverage floor vs mask blend (0..1), e.g. 0.7

uniform float uLonOffset;     // your equirect wrap shift
uniform bool  uFlipV;

uniform int   uShellCount;    // number of stacked shells
uniform float uLayerFalloff;  // 0..1: fade outer shells (e.g. 0.2..0.6)
uniform float uDensityJitterAmp; // 0..0.5: ± jitter on alpha (e.g. 0.1)
uniform float uFeatherJitterAmp; // extra feather per shell (e.g. 0.003)

uniform float uShellOffsetScale; // per-shell offset scale (was hardcoded 0.0015)

uniform sampler2D uWind;     // RG = (U, V) wind components (normalized 0..1)
uniform float uClumpiness;

// tiny, cheap hash → [0,1)
float hash31(vec3 p){
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

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
  // --- UV on globe + small per-shell offset to avoid Z-fighting banding ---
  vec2 uv = worldToUV(vWorld);
  float shellF = float(vShell);
  float offs   = uShellOffsetScale * shellF;  
  uv += vec2(sin(123.45*shellF), cos(456.78*shellF)) * offs;

  // --- Get local wind direction (−1..1 range) ---
vec2 windRG = texture(uWind, uv).rg;
vec2 wind = normalize(windRG * 2.0 - 1.0);


  // --- Data + carrier ---
  float cov = texture(uCov,  uv).r;     // ERA5 coverage 0..1 (raw, no gamma/mips)
  float L   = texture(uLook, uv).r; // correlated field ~ U(0,1) (or remapped)

  // --- Per-pixel quantile threshold: preserves hurricane ring/location ---
  float t = 1.0 - cov;                  // inverse CDF for U(0,1)
  float epsShell = uEps + uFeatherJitterAmp * shellF;
  float mask = smoothstep(t - epsShell, t + epsShell, L);

  // --- Coverage floor + mask: reads as clouds, not fog ---
  float alpha = mix(cov, mask * cov, uK);   // uK ~ 0.6–0.8

  // --- Layer shaping ---
  float shellN  = float(max(uShellCount - 1, 1));
  float s       = shellF / shellN;                   // 0 inner → 1 outer
  float falloff = mix(1.0, 1.0 - uLayerFalloff, s);  // fade outer shells
  float jitter  = mix(1.0 - uDensityJitterAmp,
                      1.0 + uDensityJitterAmp,
                      hash31(vec3(uv * 1024.0, shellF*13.0)));

  alpha *= falloff * jitter;

  if (alpha <= 0.001) discard;
  fragColor = vec4(vec3(alpha), alpha * uOpacity);
}
`

// --- Single-volume proxy shaders (segments only, no marching) -------------
const CLOUD_PROXY_VERT = /* glsl */`
  precision highp float;
  out vec3 vWorld;
  
  void main(){
    vec3 unit = normalize(position);      // keep sphere coordinates stable
    vec4 wp   = modelMatrix * vec4(unit, 1.0);
    vWorld    = wp.xyz;                   // world position on proxy surface
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CLOUD_PROXY_FRAG = `
uniform vec3  uCamPos;
uniform float uRBase;          // inner radius (world units)
uniform float uRTop;           // outer radius (world units)
uniform float uWorldToKm;      // world->km (e.g., 0.001 if world = meters; 1.0 if world = km)

uniform float uNoiseL0Km;      // base wavelength (km), e.g., 1.2
uniform float uNoiseL1Km;      // 2nd octave (km), e.g., 0.4
uniform float uNoiseL2Km;      // 3rd octave (km), e.g., 0.15
uniform float uNoiseAmp0;      // weights for octaves, e.g., 1.0
uniform float uNoiseAmp1;      // e.g., 0.6
uniform float uNoiseAmp2;      // e.g., 0.35

uniform float uVertSquash;     // vertical squash (0.3–0.9), e.g., 0.6
uniform float uClumpLKm;       // low-freq clump wavelength (km), e.g., 8.0
uniform float uClumpAmp;       // mix factor for clump (0–1), e.g., 0.5

uniform float uDensityGain;    // overall gain, e.g., 1.0
uniform float uSeed;           // randomization seed, e.g., 13.0

uniform sampler2D uCov;       // ERA5 cloud cover (0..1), NEAREST, no mips
uniform sampler2D uLook;      // correlated carrier in UV (0..1), LINEAR, no mips
uniform float uK;             // 0..1: blend floor vs quantile (try 0.6–0.8)
uniform float uEps;           // base feather for smoothstep threshold (e.g., 0.02)
uniform float uLonOffset;     // same as your worldToUV
uniform bool  uFlipV;         // same as your worldToUV

// jitter to avoid banding/popping at coverage edges:
uniform float uFeatherJitterAmp;  // 0..0.03 (try 0.01)
uniform float uJitterCellKm;      // km size for stable jitter cells (e.g., 8.0)

uniform int   uNumSteps;     // e.g., 8 (start here)
uniform float uSigmaT;       // extinction scale (try 1.5 .. 4.0)
uniform float uJitterAmp;    // 0..1 start-jitter fraction (try 0.3)
uniform vec3  uCloudColor;   // cloud tint (e.g., vec3(1.0))

uniform float uCovCellDeg;       // ERA5 grid size in degrees (e.g. 0.25)
uniform float uWalkAmpDeg;       // max angular random-walk at top (deg), ~0.2–0.6
uniform float uWalkFreq;         // walk frequency (units of “per shell thickness”), ~3–7
uniform float uWalkOctaves;      // 1–4 (how wiggly the walk is)
uniform float uGateNoiseLKm;     // km wavelength for 3D threshold noise, ~60–200
uniform float uGateNoiseAmp;     // threshold mod amplitude, 0–0.25 (start 0.12)
uniform float uTopSpreadDeg;     // tiny soft spread at high t (deg), 0–0.25

uniform float uNoiseWalkKm;    // km wander of density basis top-to-bottom (start 60.0)
uniform float uTwistDegMax;    // max rotation of density basis around radial axis (start 14.0)

uniform float uCloudBrightness;
uniform float cloudExtinctionMode;

in vec3 vWorld;   
out vec4 fragColor;        

// small hash from UV cell
float hash12(vec2 p){
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * q.z);
}

// convert tiny (dLat,dLon) to equirect UV deltas
vec2 dLatLon_to_dUV(float dLat, float dLon, bool flipV){
  float du = dLon * (1.0 / (2.0*3.141592653589793));
  float dv = -dLat * (1.0 / 3.141592653589793);
  if (flipV) dv = -dv;
  return vec2(du, dv);
}

// 1D fbm used to drive a random-walk in angle space
float fbm1D(float x, float octaves){
  float s = 0.0, a = 0.5, f = 1.0;
  for (int i=0;i<8;i++){
    if (float(i) >= octaves) break;
    // value noise via hash + smoothstep
    float xf = floor(x*f), xd = fract(x*f);
    float n0 = hash12(vec2(xf, 17.0));
    float n1 = hash12(vec2(xf+1.0, 17.0));
    float u  = xd*xd*(3.0-2.0*xd);
    s += mix(n0, n1, u) * a;
    a *= 0.5; f *= 2.0;
  }
  return s; // ~[0,1]
}


// ---------- helpers: hash / fade / value noise ----------
float hash13(vec3 p){
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419) + uSeed);
    p += dot(p, p.yzx + 19.19);
    return fract(p.x * p.y * p.z);
}

vec3 fade3(vec3 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }

// value noise (tile-free, cheap)
float valueNoise3D(vec3 p){
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = fade3(f);

    float n000 = hash13(i + vec3(0,0,0));
    float n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0));
    float n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1));
    float n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1));
    float n111 = hash13(i + vec3(1,1,1));

    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);

    float nxy0 = mix(nx00, nx10, u.y);
    float nxy1 = mix(nx01, nx11, u.y);

    return mix(nxy0, nxy1, u.z); // [0,1]
}

// remap [0,1] -> [-1,1] then soft contrast
float normNoise(vec3 p){
    return (valueNoise3D(p) * 2.0 - 1.0);
}

// ---------- vertical profile inside the shell ----------
float shellT01(vec3 worldPos, float rBase, float rTop){
    float r = length(worldPos);
    return clamp((r - rBase) / max(1e-6, (rTop - rBase)), 0.0, 1.0);
}

// bell curve (more density mid-layer, softer near base/top)
float bell01(float t){
    float a = smoothstep(0.0, 1.0, t);
    float b = 1.0 - a;
    return a * b * 4.0; // peaks ~1 in the middle
}

// ---------- FBM with vertical anisotropy ----------
float fbmAniso(vec3 w_km,
               float L0, float L1, float L2,
               float A0, float A1, float A2,
               float vertSquash)
{
    // squash vertical for “flatter” clouds
    vec3 q0 = w_km / max(1e-6, L0); q0.y *= vertSquash;
    vec3 q1 = w_km / max(1e-6, L1); q1.y *= vertSquash;
    vec3 q2 = w_km / max(1e-6, L2); q2.y *= vertSquash;

    float n0 = normNoise(q0);
    float n1 = normNoise(q1);
    float n2 = normNoise(q2);

    // mild shaping to keep energy centered
    n0 = tanh(n0 * 1.2);
    n1 = tanh(n1 * 1.2);
    n2 = tanh(n2 * 1.2);

    return A0*n0 + A1*n1 + A2*n2; // can be negative
}

// ---------- coarse clump octave (very low frequency) ----------
float clumpMask(vec3 w_km, float Lclump){
    vec3 q = w_km / max(1e-6, Lclump);
    // map noise to [0,1], sharpen to form blobs
    float c = valueNoise3D(q);
    c = smoothstep(0.35, 0.75, c);
    return c; // [0,1]
}

// ---------- world → ERA5 UV (equirect) ----------
vec2 worldToUV(vec3 p){
  vec3 n = normalize(p);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
  float v = 0.5 - lat / 3.141592653589793;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

// stable per-column seed from ERA5 cell id:
float columnSeed(vec2 uv){
  vec2 cell = floor(uv * vec2(360.0, 180.0) / max(uCovCellDeg, 1e-6));
  return hash12(cell);
}

// rotate vector v around unit axis by angle (radians)
vec3 rotateAroundAxis(vec3 v, vec3 axis, float ang){
  float c = cos(ang), s = sin(ang);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// world-anchored density with height-dependent basis walk + twist
float densityWorldTwisted(vec3 worldPos){
  // normalized shell height
  float t = shellT01(worldPos, uRBase, uRTop);

  // per-column stable seed
  vec2 uv    = worldToUV(worldPos);
  float seed = columnSeed(uv);

  // random walk in km across height (same idea you used for gate but for density coords)
  float f1 = fbm1D(t * uWalkFreq + seed*1.7, uWalkOctaves);
  float f2 = fbm1D(t * (uWalkFreq*0.83) + seed*3.1, uWalkOctaves);
  float f3 = fbm1D(t * (uWalkFreq*1.27) + seed*4.9, uWalkOctaves);

  vec3 walkKm = (vec3(f1, f2, f3) - 0.5) * 2.0 * uNoiseWalkKm * smoothstep(0.0, 1.0, t);

  // twist density basis around radial axis with height
  vec3 axis   = normalize(worldPos);
  float twist = radians(uTwistDegMax) * (hash12(uv*37.0) - 0.5) * 2.0 * t;

  // build sampling coord in km, then rotate
  vec3 w_km = worldPos * uWorldToKm + walkKm;
  w_km      = rotateAroundAxis(w_km, axis, twist);

  // now your existing anisotropic FBM with vertical squash
  float d = fbmAniso(
    w_km,
    uNoiseL0Km, uNoiseL1Km, uNoiseL2Km,
    uNoiseAmp0, uNoiseAmp1, uNoiseAmp2,
    uVertSquash
  );

  float d01 = clamp(0.5 + 0.5 * d, 0.0, 1.0);

  // same clumping + vertical bell as before
  float t01 = t;
  float vp  = bell01(t01);
  float C   = mix(1.0, clumpMask(w_km, uClumpLKm), clamp(uClumpAmp, 0.0, 1.0));

  return d01 * C * vp * uDensityGain;
}

// ERA5 gate with height decorrelation + threshold modulation + soft top spread
float era5Gate3DColumn(vec3 worldPos){
  // column params
  float t = shellT01(worldPos, uRBase, uRTop);     // 0 (base) → 1 (top)
  vec2  uv = worldToUV(worldPos);

  // --- (1) height-dependent random walk offset (no single tilt) ---
  // Use the ERA5 grid cell as a stable seed per column
  float cellDeg = max(uCovCellDeg, 1e-6);
  vec2  cellId  = floor(uv * vec2(360.0, 180.0) / cellDeg);
  float seed    = hash12(cellId);

  // Walk angle & radius profiles (world-locked)
  float thetaX  = 6.2831853 * fbm1D(t * uWalkFreq + seed*3.1, uWalkOctaves);
  float thetaY  = 6.2831853 * fbm1D(t * (uWalkFreq*0.73) + seed*5.7, uWalkOctaves);
  float ampRad  = radians(uWalkAmpDeg) * smoothstep(0.0, 1.0, t); // grows with height

  // Map two angles to small lon/lat deflections (not just one axis)
  float dLon = ampRad * (0.6 * sin(thetaX) + 0.4 * sin(thetaY*1.7 + 1.3));
  float dLat = ampRad * (0.6 * cos(thetaY) + 0.4 * cos(thetaX*1.4 - 0.7));

  vec2 uvWalk = uv + dLatLon_to_dUV(dLat, dLon, uFlipV);
  uvWalk = fract(uvWalk);

  // --- (2) sample base coverage + optional tiny top spread (soft max) ---
  float cov0 = texture(uCov, uvWalk).r;

  float bleed = smoothstep(0.45, 1.0, t); // spread only in upper half
  float dA    = radians(uTopSpreadDeg) * bleed;
  vec2  dU    = dLatLon_to_dUV(0.0, dA, uFlipV);
  vec2  dV    = dLatLon_to_dUV(dA, 0.0, uFlipV);

  float c1 = texture(uCov, fract(uvWalk + dU )).r;
  float c2 = texture(uCov, fract(uvWalk - dU )).r;
  float c3 = texture(uCov, fract(uvWalk + dV )).r;
  float c4 = texture(uCov, fract(uvWalk - dV )).r;

  float cov = mix(cov0, max(max(c1,c2), max(c3,c4)), bleed * 0.5);

  // --- (3) threshold modulation with true 3D noise (breaks slice cloning) ---
  vec3 w_km = worldPos * uWorldToKm;
  float n3  = normNoise(w_km / max(1e-6, uGateNoiseLKm));   // [-1,1]
  float L   = texture(uLook, uvWalk).r;

  // Move the quantile threshold a bit with height & 3D noise
  float qBase = 1.0 - cov;
  float q     = clamp(qBase + n3 * uGateNoiseAmp * (0.35 + 0.65*t), 0.0, 1.0);

  // stable per-cell feather jitter
  vec3 cell3 = floor(worldPos * uWorldToKm / 8.0); // 8 km cells; tune if needed
  float j    = (hash13(cell3) - 0.5) * 2.0;
  float eps  = uEps + uFeatherJitterAmp * j;

  float mask = smoothstep(q - eps, q + eps, L);

  // final soft gate (floor + masked)
  return mix(cov, mask * cov, clamp(uK, 0.0, 1.0));
}


bool intersectSphere(vec3 ro, vec3 rd, float R, out float tEnter, out float tExit){
  // Solve |ro + t rd|^2 = R^2
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R*R;
  float disc = b*b - c;
  if (disc < 0.0) { tEnter = tExit = 0.0; return false; }
  float s = sqrt(max(0.0, disc));
  float t0 = -b - s;
  float t1 = -b + s;
  tEnter = min(t0, t1);
  tExit  = max(t0, t1);
  return tExit > 0.0; // sphere is in front or we are inside
}

// compute the marching interval inside the shell [Rbase, Rtop]
// returns false if the ray misses the shell completely.
bool shellSegment(vec3 ro, vec3 rd, float Rbase, float Rtop, out float t0, out float t1){
  float eOut, xOut, eIn,  xIn;
  bool hitOuter = intersectSphere(ro, rd, Rtop,  eOut, xOut);
  bool hitInner = intersectSphere(ro, rd, Rbase, eIn,  xIn);

  if (!hitOuter) return false;

  // Start/end through outer sphere
  float start = max(eOut, 0.0);
  float end   = xOut;

  // Carve out the inner sphere if we cross it (we only want the shell)
  // If the ray intersects the inner sphere between start and end, clamp end to inner entry.
  if (hitInner) {
    // if camera is outside the shell, the first inner intersection we hit is eIn
    // if camera is already inside the inner sphere, adjust start
    if (eIn > start && eIn < end) end = eIn;
    if (xIn > start && xIn < end) start = xIn; // handle inside cases
  }

  // Valid only if a positive length segment remains
  if (end <= start) return false;
  t0 = start;
  t1 = end;
  return true;
}

struct CloudCtx {
  vec2  uv;        // base equirect UV at p
  float t;         // shell height 0..1
  vec3  axis;      // radial axis at p
  float seed;      // stable per-column seed
  vec3  wkm;       // world km coords with walk+twist applied
  vec2  uvWalk;    // UV after height random-walk (for coverage)
  float gateN;     // [-1,1] cheap height decorrelator for gate
  float epsJit;    // feather jitter
};


CloudCtx makeCloudCtx(vec3 p){
  CloudCtx c;

  c.uv   = worldToUV(p);
  c.t    = shellT01(p, uRBase, uRTop);
  c.axis = normalize(p);

  // per-column seed (ERA5 cell id)
  vec2 cell = floor(c.uv * vec2(360.0, 180.0) / max(uCovCellDeg, 1e-6));
  c.seed = hash12(cell);

  // --- height-dependent random walk for BOTH gate + density (no trig) ---
  float fx = fbm1D(c.t * uWalkFreq        + c.seed*3.1, uWalkOctaves); // [0,1]
  float fy = fbm1D(c.t * (uWalkFreq*0.73) + c.seed*5.7, uWalkOctaves); // [0,1]
  float fz = fbm1D(c.t * (uWalkFreq*1.27) + c.seed*4.9, uWalkOctaves); // [0,1]

  // coverage UV walk (angles→small lon/lat deflections without sin/cos)
  float ampRad = radians(uWalkAmpDeg) * c.t;      // grows with height
  float dLon   = ampRad * (fx*2.0 - 1.0);
  float dLat   = ampRad * (fy*2.0 - 1.0);
  c.uvWalk     = fract(c.uv + dLatLon_to_dUV(dLat, dLon, uFlipV));

  // density basis random walk in km
  vec3 walkKm = (vec3(fx, fy, fz) - 0.5) * 2.0 * uNoiseWalkKm * c.t;

  // small-angle twist (linearized, no sin/cos)
  float ang = radians(uTwistDegMax) * (hash12(c.uv*37.0) - 0.5) * 2.0 * c.t;
  vec3  wkm = p * uWorldToKm + walkKm;
       wkm += cross(c.axis, wkm) * ang;           // linear rotation
  c.wkm = wkm;

  // cheap per-height decorrelator for gate (replaces 3D noise)
  vec3 cell3 = floor(p * uWorldToKm / 8.0);       // 8 km cells
  c.gateN    = hash13(cell3) * 2.0 - 1.0;         // [-1,1]

  // feather jitter reusing same cell
  c.epsJit   = uEps + uFeatherJitterAmp * (hash13(cell3) * 2.0 - 1.0);

  return c;
}



float densityWorldTwisted_ctx(in CloudCtx c){
  // FBM (unchanged look)
  float d = fbmAniso(
    c.wkm,
    uNoiseL0Km, uNoiseL1Km, uNoiseL2Km,
    uNoiseAmp0, uNoiseAmp1, uNoiseAmp2,
    uVertSquash
  );

  float d01 = clamp(0.5 + 0.5 * d, 0.0, 1.0);

  // clumps (optional – keep if you see the impact)
  float C = mix(1.0, clumpMask(c.wkm, uClumpLKm), clamp(uClumpAmp, 0.0, 1.0));

  // vertical profile
  float vp = bell01(c.t);

  return d01 * C * vp * uDensityGain;
}
float era5Gate3DColumn_ctx(in CloudCtx c){
  // base coverage at walked UV
  float cov0 = texture(uCov, c.uvWalk).r;

  // OPTIONAL anvil spread (comment out to save 4 tex reads)
  float cov = cov0;
  float bleed = smoothstep(0.45, 1.0, c.t);
  float dA    = radians(uTopSpreadDeg) * bleed;
  vec2  dU    = dLatLon_to_dUV(0.0, dA, uFlipV);
  vec2  dV    = dLatLon_to_dUV(dA, 0.0, uFlipV);
  float c1 = texture(uCov, fract(c.uvWalk + dU )).r;
  float c2 = texture(uCov, fract(c.uvWalk - dU )).r;
  float c3 = texture(uCov, fract(c.uvWalk + dV )).r;
  float c4 = texture(uCov, fract(c.uvWalk - dV )).r;
  cov = mix(cov0, max(max(c1,c2), max(c3,c4)), bleed * 0.5);

  // correlated carrier
  float L = texture(uLook, c.uvWalk).r;

  // quantile threshold with cheap height decorrelation
  float qBase = 1.0 - cov;
  float q     = clamp(qBase + c.gateN * uGateNoiseAmp * (0.35 + 0.65*c.t), 0.0, 1.0);

  // stochastic mask with feather
  float mask = smoothstep(q - c.epsJit, q + c.epsJit, L);

  // final soft gate
  return mix(cov, mask * cov, clamp(uK, 0.0, 1.0));
}

float cloudExtinction(vec3 p){
if (cloudExtinctionMode == 1.0){
  CloudCtx c = makeCloudCtx(p);                   // shared once
  float rho  = densityWorldTwisted_ctx(c) * era5Gate3DColumn_ctx(c);
  return rho * uSigmaT;
} else {
    float rho = densityWorldTwisted(p) * era5Gate3DColumn(p);  // ← new gate
  return rho * uSigmaT;
  }
}

// float cloudExtinction(vec3 p){
//   float rho = densityWorldTwisted(p) * era5Gate3DColumn(p);  // ← new gate
//   return rho * uSigmaT;
// }

vec4 marchClouds(vec3 ro, vec3 rd){
  float t0, t1;
  if (!shellSegment(ro, rd, uRBase, uRTop, t0, t1)) {
    return vec4(0.0); // miss: fully transparent
  }

  float segLen   = t1 - t0;
  int   steps    = max(1, uNumSteps);
  float dt       = segLen / float(steps);

  // world-locked jitter on the start to hide banding
  // build a stable cell from the first sample point
  vec3 p0  = ro + t0 * rd;
  float cellScale = (uWorldToKm > 0.0) ? (uJitterCellKm / uWorldToKm) : 1.0;
  float j = hash13(floor(p0 / max(1e-6, cellScale))) * 2.0 - 1.0;

  float t  = t0 + (0.5 + 0.5 * uJitterAmp * j) * dt;

  float accA   = 0.0;

  for (int i = 0; i < 128; ++i) { // compile-time cap
    if (i >= steps) break;
    vec3 p = ro + t * rd;

    float sigma = cloudExtinction(p);         // extinction at sample
    float aStep = 1.0 - exp(-sigma * dt);     // alpha this step (Beer–Lambert)

    // front-to-back compositing
    float w = (1.0 - accA) * aStep;
    accA   += w;

    // early out when opaque enough
    if (accA > 0.98) break;

    t += dt;
  }

  vec3 col = vec3(accA * uCloudBrightness); 
  return vec4(col, accA);
}

void main(){
  vec3 ro = uCamPos;
  vec3 rd = normalize(vWorld - uCamPos); // proxy sphere fragment → camera ray

  vec4 cloud = marchClouds(ro, rd);

  // For now just show alpha as brightness so you can tune steps/scale.
  // Replace with proper lighting later.
  vec3 view = mix(vec3(0.0), cloud.rgb, 1.0); // or just vec3(cloud.a)
  fragColor = vec4(view, cloud.a);
}

`




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
    gphTex?: THREE.Texture | null;  // geopotential height or DEM, R in [0..1]
    windTex?: THREE.Texture | null;
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
  gphTex,
  windTex,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef  = useRef<THREE.ShaderMaterial | null>(null);
  const pipelineRef = useRef<CloudPipelineManager | null>(null);
  const lookTexRef  = useRef<THREE.Texture | null>(null);
  const era5CoverageRawRef   = useRef<THREE.Texture | null>(null);
const volGroupRef = useRef<THREE.Group | null>(null);           // holds proxy + ring meshes
const rBaseRef = useRef<number>(0);
const rTopRef  = useRef<number>(0);


  useEffect(() => {
    if (!enabled || !renderer || !scene || !camera) return;
    let disposed = false;
    const paneHubDisposeCleanup: Array<() => void> = [];

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
        t.minFilter = THREE.NearestFilter;
        t.magFilter = THREE.NearestFilter;
        t.colorSpace = THREE.NoColorSpace;
        t.generateMipmaps = false;
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
      const { singleChannelRawEra5, tau, tauBlur } = pipelineRef.current.runOnce({
        covRawTex: era5CoverageRawRef.current,
        lookTex:   lookTexRef.current,
        iterations,
        colorChannel: colorChannel
      });

      // ---- Build/refresh the visible cloud mesh ----
      // 2) In tryRunPipelineAndAttach() — build/refresh the visible cloud mesh
const globeRadius = getGlobeRadius();
const SHELLS = 0;
// remove any previous group
if (volGroupRef.current) {
  scene!.remove(volGroupRef.current);
  volGroupRef.current.children.forEach(c => {
    // @ts-ignore
    c.geometry?.dispose?.();
    // @ts-ignore
    c.material?.dispose?.();
  });
  volGroupRef.current = null;
}

// decide initial radii (editable later)
rBaseRef.current = globeRadius + 10.0;
rTopRef.current  = globeRadius + 15.0;

// make a group: [proxyMesh (translucent)] + [ringBase, ringTop] for verification
const g = new THREE.Group();

// 1) proxy sphere at R_top (shader that visualizes shell thickness)
{
  // when creating the material:
const size = new THREE.Vector2();
renderer!.getSize(size);                      // CSS pixels
const dpr = renderer!.getPixelRatio();        // device pixel ratio
const drawW = Math.round(size.x * dpr);       // drawing buffer size
const drawH = Math.round(size.y * dpr);


  const geom = new THREE.SphereGeometry(1, 256, 128);
  const mat  = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader:   CLOUD_PROXY_VERT,
    fragmentShader: CLOUD_PROXY_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    premultipliedAlpha: true,
    uniforms: {
      uCamPos:  { value: camera!.position.clone() },
      uRBase:   { value: rBaseRef.current },
      uRTop:    { value: rTopRef.current },
      uWorldToKm: { value: 6371/173 },
      uVertSquash: { value: 10.0 },
      uNoiseL0Km: { value: 3.0 },
      uNoiseAmp0: { value: 0.5 },
      uNoiseL1Km: { value: 0.4 },
      uNoiseAmp1: { value: 0.1 },
      uNoiseL2Km: { value: 0.15 },
      uNoiseAmp2: { value: 0.2 },
      uClumpLKm: { value: 8.0 },
      uClumpAmp: { value: 0.0 },
      uDensityGain: { value: 1.0 },
      uSeed: { value: 4 },
      uFeatherJitterAmp: { value: 0.01 },
      uJitterCellKm: { value: 8.0 },
      uLook:     { value: lookTexRef.current },
      uCov:      { value: singleChannelRawEra5 },
      uEps:      { value: feather },
      uLonOffset:{ value: 0.25 },
      uFlipV:    { value: true },
      uK:        { value: 0.7 },
      uNumSteps: { value: 4 },
      uSigmaT: { value: 2.0 },
      uJitterAmp: { value: 0.3 },
      uCloudColor: { value: new THREE.Vector3(0.97, 0.96, 0.94) },
      uCovCellDeg: { value: 0.25 },
      uWalkAmpDeg: { value: 0.35 },
      uWalkFreq: { value: 5.0 },
      uWalkOctaves: { value: 3.0 },
      uGateNoiseLKm: { value: 120.0 },
      uGateNoiseAmp: { value: 0.12 },
      uTopSpreadDeg: { value: 0.12 },
      uNoiseWalkKm: { value: 60.0 },
      uTwistDegMax: { value: 90.0 },
      uCloudBrightness: { value: 0.9 },
      cloudExtinctionMode: { value: 0 }
    }
  });
  mat.toneMapped = false;

  paneHubDisposeCleanup.push(
  PaneHub.bind(
    `3d cloud cover`,
    {
      cloudExtinctionMode: { type: "number", uniform: "cloudExtinctionMode", min: 0, max: 1, step: 1 },
uWorldToKm: { type: "number", uniform: "uWorldToKm", min: 0, max: 100, step: 0.01 },
uVertSquash: { type: "number", uniform: "uVertSquash", min: 0, max: 200, step: 0.01 },
uNoiseL0Km: { type: "number", uniform: "uNoiseL0Km", min: 0, max: 50, step: 0.01 },
uNoiseAmp0: { type: "number", uniform: "uNoiseAmp0", min: 0, max: 200, step: 0.01 },
uNoiseL1Km: { type: "number", uniform: "uNoiseL1Km", min: 0, max: 50, step: 0.01 },
uNoiseAmp1: { type: "number", uniform: "uNoiseAmp1", min: 0, max: 200, step: 0.01 },
uNoiseL2Km: { type: "number", uniform: "uNoiseL2Km", min: 0, max: 50, step: 0.01 },
uNoiseAmp2: { type: "number", uniform: "uNoiseAmp2", min: 0, max: 200, step: 0.01 },
uClumpLKm: { type: "number", uniform: "uClumpLKm", min: 0, max: 20, step: 0.1 },
uClumpAmp: { type: "number", uniform: "uClumpAmp", min: 0, max: 2, step: 0.01 },
uDensityGain: { type: "number", uniform: "uDensityGain", min: 0, max: 5, step: 0.01 },
uSeed: { type: "number", uniform: "uSeed", min: 0, max: 100, step: 1.0 },
uFeatherJitterAmp: { type: "number", uniform: "uFeatherJitterAmp", min: 0, max: 0.1, step: 0.001 },
uJitterCellKm: { type: "number", uniform: "uJitterCellKm", min: 0, max: 20, step: 0.1 },
uEps: { type: "number", uniform: "uEps", min: 0, max: 10, step: 0.001 },
uK: { type: "number", uniform: "uK", min: 0, max: 2, step: 0.01 },
uNumSteps: { type: "number", uniform: "uNumSteps", min: 1, max: 64, step: 1.0 },
uSigmaT: { type: "number", uniform: "uSigmaT", min: 0, max: 5, step: 0.01 },
uJitterAmp: { type: "number", uniform: "uJitterAmp", min: 0, max: 1, step: 0.01 },
uCovCellDeg: { type: "number", uniform: "uCovCellDeg", min: 0, max: 1, step: 0.01 },
uWalkAmpDeg: { type: "number", uniform: "uWalkAmpDeg", min: 0, max: 1, step: 0.01 },
uWalkFreq: { type: "number", uniform: "uWalkFreq", min: 0, max: 10, step: 0.1 },
uWalkOctaves: { type: "number", uniform: "uWalkOctaves", min: 1, max: 4, step: 1.0 },
uGateNoiseLKm: { type: "number", uniform: "uGateNoiseLKm", min: 0, max: 500, step: 1.0 },
uGateNoiseAmp: { type: "number", uniform: "uGateNoiseAmp", min: 0, max: 1, step: 0.01 },
uTopSpreadDeg: { type: "number", uniform: "uTopSpreadDeg", min: 0, max: 1, step: 0.01 },
uNoiseWalkKm: { type: "number", uniform: "uNoiseWalkKm", min: 0, max: 1000, step: 1 },
uTwistDegMax: { type: "number", uniform: "uTwistDegMax", min: 0, max: 360, step: 1 },
uCloudBrightness: { type: "number", uniform: "uCloudBrightness", min: 0, max: 1, step: 0.01 },
    }, mat))


  const proxy = new THREE.Mesh(geom, mat);
  proxy.scale.setScalar(rTopRef.current);   // keep the sphere scaled to R_top (nice for debugging)
  proxy.renderOrder = 16;
  proxy.userData.isCloudProxy = true;
  g.add(proxy);
}


// 2) thin ring at R_base (wireframe)
{
  const geom = new THREE.SphereGeometry(1, 64, 32);
  const wire = new THREE.WireframeGeometry(geom);
  const mat  = new THREE.LineBasicMaterial({ color: 0xFFD54F, transparent: true, opacity: 0.9 });
  const ring = new THREE.LineSegments(wire, mat);
  ring.scale.setScalar(rBaseRef.current);
  ring.renderOrder = 15;
  g.add(ring);
}

// 3) thin ring at R_top (wireframe)
{
  const geom = new THREE.SphereGeometry(1, 64, 32);
  const wire = new THREE.WireframeGeometry(geom);
  const mat  = new THREE.LineBasicMaterial({ color: 0x64B5F6, transparent: true, opacity: 0.9 });
  const ring = new THREE.LineSegments(wire, mat);
  ring.scale.setScalar(rTopRef.current);
  ring.renderOrder = 15;
  g.add(ring);
}

g.frustumCulled = false;
scene!.add(g);
volGroupRef.current = g;

// we’ll drive radius in the shader, so use a unit sphere here
const geom = new THREE.SphereGeometry(1, 256, 128);

if (!meshRef.current) {
  const mat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
    vertexShader:   CLOUD_SHELL_VERT,   // <- use new vert
    fragmentShader: CLOUD_FRAG,         // same frag
  transparent: true,
  depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  uniforms: {
      // existing uniforms
      uOpacity:  { value: opacity },  
      uLook:     { value: lookTexRef.current },
      uTau:      { value: tau },
      uCov:      { value: singleChannelRawEra5 },
      uEps:      { value: feather },
      uLonOffset:{ value: 0.25 },
      uFlipV:    { value: true },
      uTauBlur:  { value: tauBlur },
      uUseTauBlur: { value: true },
      uK:        { value: 0.7 },

      // NEW shell uniforms
      uBaseR:      { value: globeRadius + 0.25 }, // same as your old overlayR
      uDz:         { value: 0.5 },                 // start with zero spacing
      uShellCount: { value: SHELLS },

          uLayerFalloff:     { value: 0.2 },  // how much the outermost fades (0.6 ≈ 40% lighter)
    uDensityJitterAmp: { value: 0.1 }, // ±15% alpha jitter per shell/uv
    uFeatherJitterAmp: { value: 0.003 }, // +0.003 feather per shell
    uShellOffsetScale: { value: 0.0001 },  
          uZOffset:        { value: zOffsetForPressure(pressureLevel) },        // <- main slider
      uUseTerrain:     { value: !!( gphTex ?? null ) },
      uTerrainTexture: { value: gphTex ?? null },
      uExaggeration:   { value: 1.0 },
      uAboveTerrain:   { value: 0.0 },    
       uPressure:       { value: pressureLevel },  
    }
  });
  mat.toneMapped = false;
  
  // Controls for your CLOUD_SHELL material
paneHubDisposeCleanup.push(
  PaneHub.bind(
    `Cloud Cover (${pressureLevel} hPa)`,
    {
      Epsilon: {
        type: "number",
        uniform: "uEps",
        min: 0.0,
        max: 0.1,
        step: 0.001,
      },
      CoverageBlendK: {
        type: "number",
        uniform: "uK",
        min: 0.0,
        max: 1.0,
        step: 0.01,
      },
      ShellSpacing_uDz: {
        type: "number",
        uniform: "uDz",
        min: 0.0,
        max: 10.0,
        step: 0.1,
      },
      LayerFalloff: {
        type: "number",
        uniform: "uLayerFalloff",
        min: 0.0,
        max: 1.0,
        step: 0.01,
      },
      DensityJitterAmp: {
        type: "number",
        uniform: "uDensityJitterAmp",
        min: 0.0,
        max: 1.0,
        step: 0.01,
      },
      FeatherJitterAmp: {
        type: "number",
        uniform: "uFeatherJitterAmp",
        min: 0.0,
        max: 0.5,
        step: 0.001,
      },
    ShellOffsetScale: { type: "number", uniform: "uShellOffsetScale", min: 0.0, max: 0.001, step: 0.0001 },
       Z_Offset:          { type: "number", uniform: "uZOffset", min: -10.0, max: 10.0, step: 0.01 },

        TerrainExaggeration: { type: "number", uniform: "uExaggeration", min: 0.0, max: 100.0, step: 1.0 },
        Above_Terrain_m:   { type: "number", uniform: "uAboveTerrain", min: -50.0, max: 50.0, step: 1.0 },
  Use_Terrain: {
      type: "boolean",
      uniform: "uUseTerrain",
      value: !!gphTex,
    },
      },
    mat
  )
);


  // create instanced mesh with 5 instances
  // const inst = new THREE.InstancedMesh(geom, mat, SHELLS);

  // // set per-instance matrices to identity
  // const m = new THREE.Matrix4();
  // for (let i = 0; i < SHELLS; i++) inst.setMatrixAt(i, m);

  // inst.instanceMatrix.needsUpdate = true;
  // inst.frustumCulled = false;
  // inst.renderOrder   = 15;

  // scene!.add(inst);
  // meshRef.current = inst as unknown as THREE.Mesh;  // keep your refs happy
  // matRef.current  = mat;
} else {
  const mat = matRef.current!;
  mat.uniforms.uLook.value    = lookTexRef.current;
  mat.uniforms.uTau.value     = tau;
  mat.uniforms.uCov.value     = singleChannelRawEra5;
  mat.uniforms.uTauBlur.value = tauBlur;

  // (optional live tweak) — you can expose these later
  // mat.uniforms.uDz.value = 0.0;
  // mat.uniforms.uBaseR.value = globeRadius + 0.25;
}


      renderer!.render(scene!, camera!);
    }

    return () => {
      disposed = true;
      for (const d of paneHubDisposeCleanup){
        if (d) d();
      }

      if (volGroupRef.current && scene) {
  scene.remove(volGroupRef.current);
  volGroupRef.current.children.forEach(c => {
    // @ts-ignore
    c.geometry?.dispose?.();
    // @ts-ignore
    c.material?.dispose?.();
  });
  volGroupRef.current = null;
}

      pipelineRef.current?.dispose(); pipelineRef.current = null;
      if (meshRef.current && scene) scene.remove(meshRef.current);
      meshRef.current?.geometry.dispose();
      (meshRef.current?.material as THREE.ShaderMaterial | undefined)?.dispose?.();
      meshRef.current = null;
      matRef.current  = null;
      era5CoverageRawRef.current?.dispose();  era5CoverageRawRef.current  = null;
      lookTexRef.current?.dispose(); lookTexRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera, opacity, feather, eraSize.w, eraSize.h, tilePx, iterations, gphTex, windTex]);

  // Live param updates
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uOpacity.value = opacity; }, [opacity]);
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uEps.value     = feather; }, [feather]);

  useEffect(() => {
  if (!scene || !camera) return;
  let raf = 0;
  const tick = () => {
    scene.traverse(obj => {
      const mat = (obj as any).material as THREE.ShaderMaterial;
      if (mat && mat.uniforms && mat.uniforms.uCamPos) {
        mat.uniforms.uCamPos.value.copy((camera as any).position);
      }

    });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, [scene, camera]);


  return null;
}
