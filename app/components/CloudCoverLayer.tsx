// CloudCoverLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PaneHub } from "./tweaks/PaneHub";

// Swap this to your endpoint (PNG of the global fBm look field, R in [0..1])
const FBM_NOISE_API = "/api/cloud_cover/noise";

function colorChannelFromPressure(p: number): 0|1|2 {
  if (p === 850) return 0; // R
  if (p === 500) return 1; // G
  if (p === 250) return 2; // B
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

// ------------------------------- Display shaders -------------------------------
// 1) NEW vertex shader (replace CLOUD_VERT with this)
const CLOUD_SHELL_VERT = /* glsl */`
out vec3 vWorld;
flat out int vShell; 

uniform float uBaseR;      // base radius of the cloud shell (meters in your world units)
uniform float uDz;         // radial spacing between shells (same units as uBaseR)
uniform int   uShellCount; // just for reference if you want to fade by layer

void main() {
  // Use instancing to push each sphere outward along its normal.
  // gl_InstanceID is 0..(uShellCount-1)
  float idx = float(gl_InstanceID);

  // direction from sphere center (ignore original radius; use our own uBaseR)
  vec3 dir = normalize(position);

  // displace radially by idx * uDz
  vec3 shellPos = dir * (uBaseR + idx * uDz);

  vec4 wp = modelMatrix * vec4(shellPos, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;

  vShell = gl_InstanceID;
}
`;

// // Final lightweight compose: feathered mask × coverage
// const CLOUD_FRAG = /* glsl */`
// precision highp float;
// flat in int vShell;
// in vec3 vWorld; out vec4 fragColor;
// uniform sampler2D uLook;   // fBm look tex
// uniform sampler2D uTau;    // solved thresholds
// uniform sampler2D uCov;    // blurred coverage
// uniform float uOpacity;
// uniform float uEps;        // feather width in look-space
// uniform float uLonOffset;
// uniform bool  uFlipV;
// uniform sampler2D uTauBlur; // blurred tau
// uniform bool  uUseTauBlur;  // toggle
// uniform float uK;           // reuse blend factor


// vec2 worldToUV(vec3 p){
//   vec3 n = normalize(p);
//   float lat = asin(clamp(n.y, -1.0, 1.0));
//   float lon = atan(-n.z, n.x);
//   float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
//   float v = 0.5 - lat / 3.141592653589793;
//   if (uFlipV) v = 1.0 - v;
//   return vec2(u, v);
// }

// void main(){
//   vec2 uv = worldToUV(vWorld);
//   float offs = 0.0015 * float(vShell);
// uv += vec2(
//     sin(123.45*float(vShell)) * offs,
//     cos(456.78*float(vShell)) * offs
// );
//   float L = texture(uLook, uv).r;
//   float T = texture(uTau,  uv).r;
//   float C = texture(uCov,  uv).r;

//   // Feathered binary (keeps edges soft)
//   // float mask = smoothstep(T - uEps, T + uEps, L);
//   // float alpha = 1.0 * C;

//     // Option C: coverage floor blend
//   // float mask = smoothstep(T - uEps, T + uEps, L);
//   // float alpha = mix(C, mask * C, uK); // (1-k)*C + k*(mask*C)

//     // Option E: soft + floor + blurred tau
//   float T_used = uUseTauBlur ? texture(uTauBlur, uv).r : T;
//   T_used += 0.02 * float(vShell); 
//   float mask   = smoothstep(T_used - uEps, T_used + uEps, L);
//   float alpha  = mix(C, mask * C, uK);
//   // float facing = abs(dot(normalize(vWorld), normalize(cameraPosition - vWorld)));
// // alpha *= smoothstep(0.2, 0.5, facing);




//   if (alpha <= 0.001) discard;
//   fragColor = vec4(vec3(alpha), alpha * uOpacity);
// }
// `;
// Final lightweight compose: feathered mask × coverage
// const CLOUD_FRAG = /* glsl */`
// precision highp float;
// flat in int vShell;
// in vec3 vWorld; out vec4 fragColor;
// uniform sampler2D uLook;   // fBm look tex
// uniform sampler2D uTau;    // solved thresholds
// uniform sampler2D uCov;    // blurred coverage
// uniform float uOpacity;
// uniform float uEps;        // feather width in look-space
// uniform float uLonOffset;
// uniform bool  uFlipV;
// uniform sampler2D uTauBlur; // blurred tau
// uniform bool  uUseTauBlur;  // toggle
// uniform float uK;           // reuse blend factor
// uniform int   uShellCount;
// uniform float uLayerFalloff;     // 0..1, how fast outer shells fade (try 0.6)
// uniform float uDensityJitterAmp; // 0..0.5, multiplicative noise on alpha (try 0.15)
// uniform float uFeatherJitterAmp; // 0..0.02, extra eps per shell (try 0.003)

// // tiny, cheap hash → [0,1)
// float hash31(vec3 p){
//   return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
// }

// vec2 worldToUV(vec3 p){
//   vec3 n = normalize(p);
//   float lat = asin(clamp(n.y, -1.0, 1.0));
//   float lon = atan(-n.z, n.x);
//   float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
//   float v = 0.5 - lat / 3.141592653589793;
//   if (uFlipV) v = 1.0 - v;
//   return vec2(u, v);
// }
// void main(){
//   vec2 uv = worldToUV(vWorld);

//   // already added earlier:
//   float offs = 0.0015 * float(vShell);
//   uv += vec2(
//     sin(123.45*float(vShell)) * offs,
//     cos(456.78*float(vShell)) * offs
//   );

//   float L = texture(uLook, uv).r;
//   float T = texture(uTau,  uv).r;
//   float C = texture(uCov,  uv).r;

//   // slightly different feather per shell
//   float epsShell = uEps + uFeatherJitterAmp * float(vShell);

//   float T_used = uUseTauBlur ? texture(uTauBlur, uv).r : T;
//   T_used += 0.02 * float(vShell);      // small threshold bias from earlier
//   float mask = smoothstep(T_used - epsShell, T_used + epsShell, L);

//   // base alpha (Option C/E mix)
//   float alpha = mix(C, mask * C, uK);

//   // ---- NEW: per-shell density shaping ----
//   // 1) outer shells contribute less (Beer–Lambert-ish falloff)
//   float shellN = float(uShellCount > 1 ? uShellCount - 1 : 1);
//   float t = float(vShell) / shellN;             // 0 (inner) → 1 (outer)
//   float falloff = mix(1.0, 1.0 - uLayerFalloff, t);

//   // 2) multiplicative tiny jitter so stacks aren’t uniform
//   float jitter = mix(1.0 - uDensityJitterAmp,
//                      1.0 + uDensityJitterAmp,
//                      hash31(vec3(uv * 1024.0, float(vShell)*13.0)));

//   alpha *= falloff * jitter;

//   if (alpha <= 0.001) discard;
//   fragColor = vec4(vec3(alpha), alpha);
// }
// `;

// const CLOUD_FRAG = /* glsl */`
// precision highp float;
// flat in int vShell;
// in vec3 vWorld; out vec4 fragColor;
// uniform sampler2D uLook;   // fBm look tex
// uniform sampler2D uTau;    // solved thresholds
// uniform sampler2D uCov;    // blurred coverage
// uniform float uOpacity;
// uniform float uEps;        // feather width in look-space
// uniform float uLonOffset;
// uniform bool  uFlipV;
// uniform sampler2D uTauBlur; // blurred tau
// uniform bool  uUseTauBlur;  // toggle
// uniform float uK;           // reuse blend factor
// uniform int   uShellCount;
// uniform float uLayerFalloff;     // 0..1, how fast outer shells fade (try 0.6)
// uniform float uDensityJitterAmp; // 0..0.5, multiplicative noise on alpha (try 0.15)
// uniform float uFeatherJitterAmp; // 0..0.02, extra eps per shell (try 0.003)

// // tiny, cheap hash → [0,1)
// float hash31(vec3 p){
//   return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
// }

// vec2 worldToUV(vec3 p){
//   vec3 n = normalize(p);
//   float lat = asin(clamp(n.y, -1.0, 1.0));
//   float lon = atan(-n.z, n.x);
//   float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
//   float v = 0.5 - lat / 3.141592653589793;
//   if (uFlipV) v = 1.0 - v;
//   return vec2(u, v);
// }
// void main(){
//   vec2 uv = worldToUV(vWorld);

// float cov = texture(uCov, uv).r;      // 0..1 ERA5 coverage (from your swizzled-R texture)
// float L   = texture(uLook, uv).r;     // your correlated noise (domain-warped fBm, etc.)

// // Map coverage to a threshold in the same space as L.
// // If L ~ U(0,1), the inverse-CDF is trivial: threshold t = 1 - cov.
// // If L is roughly Gaussian(0,1), use Phi^{-1}(1-cov). With U(0,1) noise, this is fine:
// float t = 1.0 - cov;

// // Binary mask with a tiny feather (edge softness)
// float mask = smoothstep(t - uEps, t + uEps, L);

// // Composite: use mask *and* retain a coverage floor so thin areas don’t vanish:
// float alpha = mix(cov, mask * cov, uK); // uK≈0.6–0.8

// if (alpha <= 0.001) discard;
// fragColor = vec4(vec3(alpha), alpha);

// }
// `;

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
const globeRadius = 100;
const SHELLS = 10;

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
    },
    mat
  )
);


  // create instanced mesh with 5 instances
  const inst = new THREE.InstancedMesh(geom, mat, SHELLS);

  // set per-instance matrices to identity
  const m = new THREE.Matrix4();
  for (let i = 0; i < SHELLS; i++) inst.setMatrixAt(i, m);

  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  inst.renderOrder   = 15;

  scene!.add(inst);
  meshRef.current = inst as unknown as THREE.Mesh;  // keep your refs happy
  matRef.current  = mat;
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
