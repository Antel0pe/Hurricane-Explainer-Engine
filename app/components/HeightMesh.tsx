"use client";
import { useEffect, useRef } from "react";
import { mat4 } from "gl-matrix";

type Props = { datehour: string };

export default function GridMeshLit_glMatrix({ datehour }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = canvas.getContext("webgl2")!;
    if (!gl) return;

    async function main() {
      // 1) Fetch & decode PNG
      const resp = await fetch(`http://localhost:8001/gph/${datehour}`);
      const bmp = await createImageBitmap(await resp.blob());
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = off.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data, width: nx, height: ny } = ctx.getImageData(0, 0, bmp.width, bmp.height);

      // 2) Positions (x,y,z) + values
      const positions = new Float32Array(nx * ny * 3);
      const values = new Float32Array(nx * ny);
      let idx = 0;
      let vmin = Infinity, vmax = -Infinity;
      const zScale = 1 / 10000;

      // We'll also store z in a separate array for easy neighbor lookup
      const zGrid = new Float32Array(nx * ny);

      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p = (j * nx + i) * 4;
          const R = data[p], G = data[p + 1], B = data[p + 2];
          const value = (R * 256 * 256 + G * 256 + B) * 0.1 - 10000.0;
          const x = (i / (nx - 1)) * 2 - 1;
          const y = (j / (ny - 1)) * 2 - 1;
          const z = value * zScale;

          positions[idx * 3 + 0] = x;
          positions[idx * 3 + 1] = y;
          positions[idx * 3 + 2] = z;

          zGrid[idx] = z;
          values[idx] = value;
          if (value < vmin) vmin = value;
          if (value > vmax) vmax = value;

          idx++;
        }
      }
      const range = (vmax - vmin) || 1;

      // 3) Build index buffer: two triangles per cell
      const quadCount = (nx - 1) * (ny - 1);
      const indices = new Uint32Array(quadCount * 6);
      let ii = 0;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i;
          const b = j * nx + i + 1;
          const c = (j + 1) * nx + i;
          const d = (j + 1) * nx + i + 1;
          indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
          indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
        }
      }

      // 4) Compute per-vertex normals (central differences on zGrid)
      // normal ≈ normalize( vec3(-dz/dx, -dz/dy, 1) )
      const normals = new Float32Array(nx * ny * 3);
      const idxAt = (i: number, j: number) => j * nx + i;

      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const iL = Math.max(i - 1, 0);
          const iR = Math.min(i + 1, nx - 1);
          const jD = Math.max(j - 1, 0);
          const jU = Math.min(j + 1, ny - 1);

          const zL = zGrid[idxAt(iL, j)];
          const zR = zGrid[idxAt(iR, j)];
          const zD = zGrid[idxAt(i, jD)];
          const zU = zGrid[idxAt(i, jU)];

          const dzdx = (zR - zL) * 0.5;
          const dzdy = (zU - zD) * 0.5;

          // N = (-dzdx, -dzdy, 1)
          let nxv = -dzdx, nyv = -dzdy, nzv = 1.0;
          const invLen = 1.0 / Math.hypot(nxv, nyv, nzv);
          nxv *= invLen; nyv *= invLen; nzv *= invLen;

          const k = idxAt(i, j) * 3;
          normals[k + 0] = nxv;
          normals[k + 1] = nyv;
          normals[k + 2] = nzv;
        }
      }

      // 5) Buffers
      const posBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const norBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
      gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

      const valBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, valBuf);
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);

      const idxBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

      // 6) Shaders: add aNormal + simple directional lighting
      const vs = `#version 300 es
      in vec3 aPos;
      in vec3 aNormal;
      in float aVal;

      out float vVal;
      out vec3 vNormal;   // in view-space
      out vec3 vPosVS;    // position in view-space (optional)

      uniform mat4 uMVP;
      uniform mat4 uMV;   // view * model

      void main() {
        vVal = aVal;
        // transform normal to view space (no scaling in model -> ok)
        vNormal = mat3(uMV) * aNormal;
        vec4 posVS = uMV * vec4(aPos, 1.0);
        vPosVS = posVS.xyz;
        gl_Position = uMVP * vec4(aPos, 1.0);
      }`;

      const fs = `#version 300 es
      precision highp float;

      in float vVal;
      in vec3 vNormal;

      out vec4 fragColor;

      uniform float uMin;
      uniform float uRange;

      void main() {
        // color by value (same as before)
        float t = (vVal - uMin) / uRange;
        vec3 baseColor;
        if (t < 0.5) {
          baseColor = mix(vec3(0.0,0.0,1.0), vec3(0.0,1.0,0.0), t*2.0);
        } else {
          baseColor = mix(vec3(0.0,1.0,0.0), vec3(1.0,0.0,0.0), (t-0.5)*2.0);
        }

        // simple directional light in view space
        vec3 N = normalize(vNormal);
        vec3 L = normalize(vec3(0.4, 0.6, 0.7)); // from above/front-left
        float lambert = max(dot(N, L), 0.0);

        float ambient = 0.35;
        float diffuse = 0.65 * lambert;
        vec3 color = baseColor * (ambient + diffuse);

        fragColor = vec4(color, 1.0);
      }`;

      const prog = gl.createProgram()!;
      const vsh = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vsh, vs); gl.compileShader(vsh);
      const fsh = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fsh, fs); gl.compileShader(fsh);
      gl.attachShader(prog, vsh); gl.attachShader(prog, fsh); gl.linkProgram(prog); gl.useProgram(prog);

      const aPos = gl.getAttribLocation(prog, "aPos");
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

      const aNor = gl.getAttribLocation(prog, "aNormal");
      gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
      gl.enableVertexAttribArray(aNor);
      gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 0, 0);

      const aVal = gl.getAttribLocation(prog, "aVal");
      gl.bindBuffer(gl.ARRAY_BUFFER, valBuf);
      gl.enableVertexAttribArray(aVal);
      gl.vertexAttribPointer(aVal, 1, gl.FLOAT, false, 0, 0);

      const uMin = gl.getUniformLocation(prog, "uMin");
      const uRange = gl.getUniformLocation(prog, "uRange");
      gl.uniform1f(uMin, vmin);
      gl.uniform1f(uRange, range);

      // 7) MVP / MV (gl-matrix)
      const uMVP = gl.getUniformLocation(prog, "uMVP");
      const uMV  = gl.getUniformLocation(prog, "uMV");

      const proj = mat4.create();
      const view = mat4.create();
      const model = mat4.create();
      const mv = mat4.create();
      const mvp = mat4.create();

      mat4.perspective(proj, 45 * Math.PI / 180, canvas.width / canvas.height, 0.1, 20.0);
      mat4.lookAt(view, [0, 0, 3], [0, 0, 0], [0, 1, 0]);
      mat4.rotateX(model, model, -25 * Math.PI / 180);

      mat4.multiply(mv, view, model);      // mv = view * model
      mat4.multiply(mvp, proj, mv);        // mvp = proj * mv

      gl.uniformMatrix4fv(uMV,  false, mv);
      gl.uniformMatrix4fv(uMVP, false, mvp);

      // 8) Draw
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE); // simple

      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);

      gl.deleteShader(vsh);
      gl.deleteShader(fsh);
    }

    main();
  }, [datehour]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={800}
      style={{ width: "800px", height: "800px", border: "1px solid black" }}
    />
  );
}