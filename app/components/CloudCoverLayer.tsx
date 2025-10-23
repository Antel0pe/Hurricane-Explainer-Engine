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
const CLOUD_LIQUID_WATER_AND_ICE_API = "/api/cloud_water_ice"

function colorChannelFromPressure(p: number): 0 | 1 | 2 {
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

function proxySphereRadiusFromPressure(p: number): number[] {
  if (p === 850) return [10, 15];
  if (p === 500) return [15, 20];
  if (p === 250) return [20, 25];
  return [-1, -1];
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
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Materials
  private blurHMat!: THREE.ShaderMaterial;
  private blurVMat!: THREE.ShaderMaterial;
  private maskMat!: THREE.ShaderMaterial;
  private updateMat!: THREE.ShaderMaterial;
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
    this.maskRT = new THREE.WebGLRenderTarget(this.w, this.h, rMip);
    this.tauRT = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauLoRT = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
    this.tauHiRT = new THREE.WebGLRenderTarget(this.w, this.h, rNoMip);
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
        uMask: { value: null }, uCov: { value: null },
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

  private draw(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, viewport?: { w: number, h: number }) {
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevVP = new THREE.Vector4(); r.getViewport(prevVP);
    const prevSc = new THREE.Vector4(); r.getScissor(prevSc);
    const prevST = r.getScissorTest();

    r.setScissorTest(false);
    if (viewport) r.setViewport(0, 0, viewport.w, viewport.h); else r.setViewport(0, 0, this.w, this.h);

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
    lookTex: THREE.Texture;    // fBm look texture (R in [0..1])
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
    this.copyPressureLevelChannelToRed.uniforms.uSrc.value = covRawTex;
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

    //     for (let k = 0; k < iterations; k++) {
    //       // Mask at full res
    //       this.maskMat.uniforms.uTau.value = this.tauRT.texture;
    //       this.draw(this.maskMat, this.maskRT);

    //       // mipmaps for mask & coverage
    //       this.maskRT.texture.generateMipmaps = true;

    //       // Tile update (render to tile RT size)
    //       this.updateMat.uniforms.uTau.value   = this.tauRT.texture;
    //       this.updateMat.uniforms.uTauLo.value = this.tauLoRT.texture;
    //       this.updateMat.uniforms.uTauHi.value = this.tauHiRT.texture;
    //       this.updateMat.uniforms.uMask.value  = this.maskRT.texture;
    //       this.updateMat.uniforms.uCov.value   = this.singleRedChannelForPressureLevelTarget.texture;

    //       this.draw(this.updateMat, this.tauTileRT, { w: this.tauTileRT.width, h: this.tauTileRT.height });

    //       // Upsample τ/lo/hi back to full res (nearest/bilinear)
    //       this.upsampleMat.uniforms.uSrc.value = this.tauTileRT.texture;
    //       this.draw(this.upsampleMat, this.tauRT);
    //       this.draw(this.upsampleMat, this.tauLoRT);
    //       this.draw(this.upsampleMat, this.tauHiRT);
    //     }
    //     // --- τ blur for Option E ---
    // this.blurHMat.uniforms.uSrc.value = this.tauRT.texture;
    // this.draw(this.blurHMat, this.tauBlurH);

    // this.blurVMat.uniforms.uSrc.value = this.tauBlurH.texture;
    // this.draw(this.blurVMat, this.tauBlurV);
    // this.tauBlurV.texture.generateMipmaps = true;

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

uniform float uDensityGain;    // overall gain, e.g., 1.0
uniform float uSeed;           // randomization seed, e.g., 13.0

uniform sampler2D uCov;       // ERA5 cloud cover (0..1), NEAREST, no mips
uniform sampler2D uLook;      // correlated carrier in UV (0..1), LINEAR, no mips
uniform sampler2D uCloudWaterAndIce;
uniform float uK;             // 0..1: blend floor vs quantile (try 0.6–0.8)
uniform float uEps;           // base feather for smoothstep threshold (e.g., 0.02)
uniform float uLonOffset;     // same as your worldToUV
uniform bool  uFlipV;         // same as your worldToUV

uniform float uSigmaT;       // extinction scale (try 1.5 .. 4.0)

uniform float uWalkAmpDeg;       // max angular random-walk at top (deg), ~0.2–0.6
uniform float uWalkFreq;         // walk frequency (units of “per shell thickness”), ~3–7

uniform float uTwistDegMax;    // max rotation of density basis around radial axis (start 14.0)

uniform float uCloudBrightness;
uniform float uMinOpacity;

// --- Adaptive marching controls ---
uniform float uMaxTStep;          // target max change in shell-height per sample, e.g. 0.02
uniform int   uMinStepsAdaptive;  // floor, e.g. 8
uniform int   uMaxStepsAdaptive;  // cap, e.g. 96
uniform float uMaxStepKm;         // optional physical cap (km per sample), e.g. 2.0 (use <=0 to disable)

uniform float uEdgeL;      // normalized thickness scale for edge fade, try 0.06..0.15
uniform float uEdgeGamma;  // 0.8..2.0 (1 = linear-in-exp space; >1 tightens the edge)

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

// Continuous vs cell-anchored seed (the latter creates grid-aligned jumps)
float columnSeed(vec2 uv){
    // --- continuous in UV: no jumps across cell borders ---
    return hash12(fract(uv * vec2(4096.0, 4096.0)));
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

float edgeFadeT(float t){
  // t is 0 at base, 1 at top
  float d = min(t, 1.0 - t);                 // distance to nearest shell boundary (0..0.5)
  float L = max(1e-4, uEdgeL);               // decay length in t-units
  float f = 1.0 - exp(-d / L);               // exponential rise away from edge
  return pow(clamp(f, 0.0, 1.0), uEdgeGamma);
}


struct CloudCtx {
  vec2  uv;        // base equirect UV at p
  float t;         // shell height 0..1
  float seed;      // stable per-column seed
  vec2  uvWalk;    // UV after height random-walk (for coverage)
  float epsJit;    // feather jitter
};

CloudCtx makeCloudCtx(vec3 p){
  CloudCtx c;

  c.uv   = worldToUV(p);
  c.t    = shellT01(p, uRBase, uRTop);

  // per-column seed (ERA5 cell id)
  vec2 cell = floor(c.uv * vec2(360.0, 180.0) / 1e-6);
  c.seed = columnSeed(c.uv);

  // --- height-dependent random walk for BOTH gate + density (no trig) ---
  float fx = fbm1D(c.t * uWalkFreq        + c.seed*3.1, 1.0); // [0,1]
  float fy = fbm1D(c.t * (uWalkFreq*0.73) + c.seed*5.7, 1.0); // [0,1]
  float fz = fbm1D(c.t * (uWalkFreq*1.27) + c.seed*4.9, 1.0); // [0,1]

  // coverage UV walk (angles→small lon/lat deflections without sin/cos)
  float ampRad = radians(uWalkAmpDeg) * c.t;      // grows with height
  float dLon   = ampRad * (fx*2.0 - 1.0);
  float dLat   = ampRad * (fy*2.0 - 1.0);
  c.uvWalk     = fract(c.uv + dLatLon_to_dUV(dLat, dLon, uFlipV));

  // density basis random walk in km
  vec3 walkKm = vec3(0.0);

  vec3  wkm = p * uWorldToKm + walkKm;

  // cheap per-height decorrelator for gate (replaces 3D noise)
  vec3 cell3 = floor(p * uWorldToKm / 8.0);       // 8 km cells

  // feather jitter reusing same cell
  c.epsJit   = uEps;

  return c;
}

float densityWorldTwisted_ctx(in CloudCtx c){
  float vp   = bell01(c.t);                  // your vertical profile
  float fade = edgeFadeT(c.t);               // NEW: exponential outer-edge fade
  return 0.5 * vp * fade * uDensityGain;     // was: 0.5 * vp * uDensityGain
} 

float era5Gate3DColumn_ctx(in CloudCtx c){
  // base coverage at walked UV
  float cov = texture(uCov, c.uvWalk).r;

  // correlated carrier
  float L = texture(uLook, c.uvWalk).r;

  // quantile threshold with cheap height decorrelation
  float qBase = 1.0 - cov;
  float q     = clamp(qBase, 0.0, 1.0);

  // stochastic mask with feather
  float mask = smoothstep(q - c.epsJit, q + c.epsJit, L);

  // final soft gate
  return mix(cov, mask * cov, clamp(uK, 0.0, 1.0));
}

float cloudExtinction(vec3 p){
  CloudCtx c = makeCloudCtx(p);                   // shared once
  float rho  = densityWorldTwisted_ctx(c) * era5Gate3DColumn_ctx(c);
  return rho * uSigmaT;
}

// Adaptive steps based on vertical (radial) resolution and an optional km spacing cap
int adaptiveStepCount(vec3 ro, vec3 rd, float t0, float t1){
  float segLen = max(1e-6, t1 - t0);

  // Approximate incidence using radial axis at the segment's midpoint
  vec3 pmid   = ro + (t0 + 0.5 * segLen) * rd;
  vec3 axis   = normalize(pmid);
  float cosInc = abs(dot(rd, axis));          // how fast radius changes along the ray

  // Total span in normalized shell height (0..1) the ray traverses in this segment
  float shellH = max(1e-6, (uRTop - uRBase));
  float tSpan  = (segLen * cosInc) / shellH;  // ≈ Δ((r-Rbase)/(Rtop-Rbase))

  // Steps to keep per-sample Δt ≤ uMaxTStep
  float stepsT = (uMaxTStep > 0.0) ? ceil(tSpan / uMaxTStep) : 0.0;

  float stepsKm = 0.0;
  if (uMaxStepKm > 0.0 && uWorldToKm > 0.0){
    float segKm = segLen * uWorldToKm;
    stepsKm = ceil(segKm / uMaxStepKm);
  }

  float need = max(stepsT, stepsKm);

  // Fallback to at least 1 if both disabled
  if (need < 1.0) need = 1.0;

  // Clamp to user ranges
  int steps = int(clamp(need, float(uMinStepsAdaptive), float(uMaxStepsAdaptive)));
  return max(1, steps);
}

float getCloudBrightness(vec3 p0) {
    // Sample encoded texture
    vec4 c = texture(uCloudWaterAndIce, worldToUV(p0));

    // Decode and scale as before
    float liquid = c.r;  
    float ice    = c.g; 

    // Combine water and ice contributions
    // Ice contributes slightly less to optical thickness (ice crystals scatter more forward)
    float opticalDepth = liquid + 0.7 * ice;

    // Map optical depth to brightness:
    // more water/ice → darker; less → brighter
    // exponential gives a realistic falloff
    float brightness = exp(-3.0 * opticalDepth);

    // Optional: remap to nicer visual range (0.15–1.0)
    brightness = mix(0.15, 1.0, brightness);

    return brightness;
}

vec4 marchClouds(vec3 ro, vec3 rd){
  float t0, t1;
  if (!shellSegment(ro, rd, uRBase, uRTop, t0, t1)) {
    return vec4(0.0); // miss: fully transparent
  }

    float segLen   = t1 - t0;
  int   steps    = adaptiveStepCount(ro, rd, t0, t1);
  float dt          = segLen / float(steps);

  // world-locked jitter on the start to hide banding
  // build a stable cell from the first sample point
  vec3 p0  = ro + t0 * rd;
  float j = hash13(floor(p0 / 1e-6)) * 2.0 - 1.0;
  float t  = t0 + (0.5 + 0.5 * j) * dt;
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

  if (accA < uMinOpacity) discard;

  vec3 col = vec3(getCloudBrightness(p0)); 
  return vec4(col, accA);
}

void main(){
  vec3 ro = uCamPos;
  vec3 rd = normalize(vWorld - uCamPos); // proxy sphere fragment → camera ray

  vec4 cloud = marchClouds(ro, rd);

  fragColor = cloud;
}
`

// -------------------------------- React component --------------------------------
type Props = {
  url: string;                               // ERA5 coverage (red channel)
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  datehour?: string;
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
  tilePx = 1,
  iterations = 10,
  gphTex,
  windTex,
  datehour,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  const pipelineRef = useRef<CloudPipelineManager | null>(null);
  const lookTexRef = useRef<THREE.Texture | null>(null);
  const era5CoverageRawRef = useRef<THREE.Texture | null>(null);
  const volGroupRef = useRef<THREE.Group | null>(null);           // holds proxy + ring meshes
  const rBaseRef = useRef<number>(0);
  const rTopRef = useRef<number>(0);
  const cloudWaterAndIceRef = useRef<THREE.Texture | null>(null);


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

    loader.load(
      CLOUD_LIQUID_WATER_AND_ICE_API + `/${datehour}`,
      t => {
        if (disposed) { t.dispose(); return; }
        t.flipY = true;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipMapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.colorSpace = THREE.NoColorSpace;
        t.generateMipmaps = false;
        cloudWaterAndIceRef.current = t;
      },
      undefined,
      err => console.error("Cloud liquid water and ice", err)
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
        lookTex: lookTexRef.current,
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
      const globeRadiusBounds = proxySphereRadiusFromPressure(pressureLevel);
      rBaseRef.current = globeRadius + globeRadiusBounds[0];
      rTopRef.current = globeRadius + globeRadiusBounds[1];

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
        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: CLOUD_PROXY_VERT,
          fragmentShader: CLOUD_PROXY_FRAG,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide,
          premultipliedAlpha: true,
          uniforms: {
            uCamPos: { value: camera!.position.clone() },
            uRBase: { value: rBaseRef.current },
            uRTop: { value: rTopRef.current },
            uWorldToKm: { value: 6371 / 173 },
            uDensityGain: { value: 1.0 },
            uSeed: { value: 4 },
            uLook: { value: lookTexRef.current },
            uCov: { value: singleChannelRawEra5 },
            uCloudWaterAndIce: { value: cloudWaterAndIceRef.current},
            uEps: { value: 0.6 },
            uLonOffset: { value: 0.25 },
            uFlipV: { value: true },
            uK: { value: 0.4 },
            uSigmaT: { value: 2.0 },
            uWalkAmpDeg: { value: 0.0 },
            uWalkFreq: { value: 10.0 },
            uCloudBrightness: { value: 0.9 },
            uMaxTStep: { value: 1.3 },
            uMinStepsAdaptive: { value: 4 },
            uMaxStepsAdaptive: { value: 16 },
            uMaxStepKm: { value: 3 },
            uEdgeL: { value: 0.1 },
            uEdgeGamma: { value: 1.3 },
            uMinOpacity: { value: 0.6 },
          }
        });
        mat.toneMapped = false;

        paneHubDisposeCleanup.push(
          PaneHub.bind(
            `Cloud Cover (${pressureLevel}hpa)`,
            {
              uEdgeL: { type: "number", uniform: "uEdgeL", min: 0, max: 10, step: 0.01 },
              uEdgeGamma: { type: "number", uniform: "uEdgeGamma", min: 0, max: 10, step: 0.01 },
              uMaxTStep: { type: "number", uniform: "uMaxTStep", min: 0, max: 10, step: 0.01 },
              uMinStepsAdaptive: { type: "number", uniform: "uMinStepsAdaptive", min: 0, max: 100, step: 1 },
              uMaxStepsAdaptive: { type: "number", uniform: "uMaxStepsAdaptive", min: 0, max: 250, step: 1 },
              uMaxStepKm: { type: "number", uniform: "uMaxStepKm", min: 0, max: 100, step: 1 },
              uWorldToKm: { type: "number", uniform: "uWorldToKm", min: 0, max: 100, step: 0.01 },
              uDensityGain: { type: "number", uniform: "uDensityGain", min: 0, max: 50, step: 0.01 },
              uSeed: { type: "number", uniform: "uSeed", min: 0, max: 100, step: 1.0 },
              uEps: { type: "number", uniform: "uEps", min: 0, max: 10, step: 0.001 },
              uK: { type: "number", uniform: "uK", min: 0, max: 2, step: 0.01 },
              uSigmaT: { type: "number", uniform: "uSigmaT", min: 0, max: 5, step: 0.01 },
              uWalkAmpDeg: { type: "number", uniform: "uWalkAmpDeg", min: 0, max: 1, step: 0.01 },
              uWalkFreq: { type: "number", uniform: "uWalkFreq", min: 0, max: 10, step: 0.1 },
              uCloudBrightness: { type: "number", uniform: "uCloudBrightness", min: 0, max: 1, step: 0.01 },
              uMinOpacity: { type: "number", uniform: "uMinOpacity", min: 0, max: 1, step: 0.01 },
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
        const mat = new THREE.LineBasicMaterial({ color: 0xFFD54F, transparent: true, opacity: 0.9 });
        const ring = new THREE.LineSegments(wire, mat);
        ring.scale.setScalar(rBaseRef.current);
        // ring.renderOrder = 15;
        ring.visible = false;
        g.add(ring);
      }

      // 3) thin ring at R_top (wireframe)
      {
        const geom = new THREE.SphereGeometry(1, 64, 32);
        const wire = new THREE.WireframeGeometry(geom);
        const mat = new THREE.LineBasicMaterial({ color: 0x64B5F6, transparent: true, opacity: 0.9 });
        const ring = new THREE.LineSegments(wire, mat);
        ring.scale.setScalar(rTopRef.current);
        // ring.renderOrder = 15;
        ring.visible = false;
        g.add(ring);
      }

      g.frustumCulled = false;
      scene!.add(g);
      volGroupRef.current = g;

      // we’ll drive radius in the shader, so use a unit sphere here
      const geom = new THREE.SphereGeometry(1, 256, 128);

      if (!meshRef.current) {
        //   const mat = new THREE.ShaderMaterial({
        //   glslVersion: THREE.GLSL3,
        //     vertexShader:   CLOUD_SHELL_VERT,   // <- use new vert
        //     fragmentShader: CLOUD_FRAG,         // same frag
        //   transparent: true,
        //   depthWrite: false,
        //     depthTest: true,
        //     blending: THREE.NormalBlending,
        //   uniforms: {
        //       // existing uniforms
        //       uOpacity:  { value: opacity },  
        //       uLook:     { value: lookTexRef.current },
        //       uTau:      { value: tau },
        //       uCov:      { value: singleChannelRawEra5 },
        //       uEps:      { value: feather },
        //       uLonOffset:{ value: 0.25 },
        //       uFlipV:    { value: true },
        //       uTauBlur:  { value: tauBlur },
        //       uUseTauBlur: { value: true },
        //       uK:        { value: 0.7 },

        //       // NEW shell uniforms
        //       uBaseR:      { value: globeRadius + 0.25 }, // same as your old overlayR
        //       uDz:         { value: 0.5 },                 // start with zero spacing
        //       uShellCount: { value: SHELLS },

        //           uLayerFalloff:     { value: 0.2 },  // how much the outermost fades (0.6 ≈ 40% lighter)
        //     uDensityJitterAmp: { value: 0.1 }, // ±15% alpha jitter per shell/uv
        //     uFeatherJitterAmp: { value: 0.003 }, // +0.003 feather per shell
        //     uShellOffsetScale: { value: 0.0001 },  
        //           uZOffset:        { value: zOffsetForPressure(pressureLevel) },        // <- main slider
        //       uUseTerrain:     { value: !!( gphTex ?? null ) },
        //       uTerrainTexture: { value: gphTex ?? null },
        //       uExaggeration:   { value: 1.0 },
        //       uAboveTerrain:   { value: 0.0 },    
        //        uPressure:       { value: pressureLevel },  
        //     }
        //   });
        //   mat.toneMapped = false;

        //   // Controls for your CLOUD_SHELL material
        // paneHubDisposeCleanup.push(
        //   PaneHub.bind(
        //     `Cloud Cover (${pressureLevel} hPa)`,
        //     {
        //       Epsilon: {
        //         type: "number",
        //         uniform: "uEps",
        //         min: 0.0,
        //         max: 0.1,
        //         step: 0.001,
        //       },
        //       CoverageBlendK: {
        //         type: "number",
        //         uniform: "uK",
        //         min: 0.0,
        //         max: 1.0,
        //         step: 0.01,
        //       },
        //       ShellSpacing_uDz: {
        //         type: "number",
        //         uniform: "uDz",
        //         min: 0.0,
        //         max: 10.0,
        //         step: 0.1,
        //       },
        //       LayerFalloff: {
        //         type: "number",
        //         uniform: "uLayerFalloff",
        //         min: 0.0,
        //         max: 1.0,
        //         step: 0.01,
        //       },
        //       DensityJitterAmp: {
        //         type: "number",
        //         uniform: "uDensityJitterAmp",
        //         min: 0.0,
        //         max: 1.0,
        //         step: 0.01,
        //       },
        //       FeatherJitterAmp: {
        //         type: "number",
        //         uniform: "uFeatherJitterAmp",
        //         min: 0.0,
        //         max: 0.5,
        //         step: 0.001,
        //       },
        //     ShellOffsetScale: { type: "number", uniform: "uShellOffsetScale", min: 0.0, max: 0.001, step: 0.0001 },
        //        Z_Offset:          { type: "number", uniform: "uZOffset", min: -10.0, max: 10.0, step: 0.01 },

        //         TerrainExaggeration: { type: "number", uniform: "uExaggeration", min: 0.0, max: 100.0, step: 1.0 },
        //         Above_Terrain_m:   { type: "number", uniform: "uAboveTerrain", min: -50.0, max: 50.0, step: 1.0 },
        //   Use_Terrain: {
        //       type: "boolean",
        //       uniform: "uUseTerrain",
        //       value: !!gphTex,
        //     },
        //       },
        //     mat
        //   )
        // );


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
        mat.uniforms.uLook.value = lookTexRef.current;
        mat.uniforms.uTau.value = tau;
        mat.uniforms.uCov.value = singleChannelRawEra5;
        mat.uniforms.uTauBlur.value = tauBlur;

        // (optional live tweak) — you can expose these later
        // mat.uniforms.uDz.value = 0.0;
        // mat.uniforms.uBaseR.value = globeRadius + 0.25;
      }


      renderer!.render(scene!, camera!);
    }

    return () => {
      disposed = true;
      for (const d of paneHubDisposeCleanup) {
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
      matRef.current = null;
      era5CoverageRawRef.current?.dispose(); era5CoverageRawRef.current = null;
      lookTexRef.current?.dispose(); lookTexRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera, opacity, feather, eraSize.w, eraSize.h, tilePx, iterations, gphTex, windTex]);

  // Live param updates
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uOpacity.value = opacity; }, [opacity]);
  useEffect(() => { if (matRef.current) matRef.current.uniforms.uEps.value = feather; }, [feather]);

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
