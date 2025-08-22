"use client";

import {useEffect, useMemo, useRef} from "react";
import type {Viewer, Primitive, GeometryAttributes, VertexFormat} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

type SceneModeName = "3D" | "2D" | "COLUMBUS_VIEW";

declare global {
  interface Window { CESIUM_BASE_URL?: string }
}

export default function CesiumMap({
  datehour,
  sceneMode = "3D",
  subSample = 4,
  exaggeration = 0.2,
}: {
  datehour: string;
  sceneMode?: SceneModeName;
  subSample?: number;
  exaggeration?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const primitiveRef = useRef<Primitive | null>(null);

  const pngUrl = useMemo(() => {
    const proto = typeof location !== "undefined" ? location.protocol : "http:";
    return `${proto}//localhost:8001/gph/${datehour}`;
  }, [datehour]);

  // Initialize viewer once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      if (viewerRef.current) return;

      // Ensure Cesium workers can be found
      if (typeof window !== "undefined" && !window.CESIUM_BASE_URL) {
        window.CESIUM_BASE_URL = "/cesium";
      }

      const Cesium: typeof import("cesium") = await import("cesium");
      const mode = sceneMode === "2D"
        ? Cesium.SceneMode.SCENE2D
        : sceneMode === "COLUMBUS_VIEW"
        ? Cesium.SceneMode.COLUMBUS_VIEW
        : Cesium.SceneMode.SCENE3D;

      if (cancelled) return;

      const viewer = new Cesium.Viewer(containerRef.current!, {
        baseLayerPicker: false,
        timeline: false,
        animation: false,
        geocoder: false,
        homeButton: false,
        sceneMode: mode,
        terrain: undefined,
        useBrowserRecommendedResolution: true,
      });

      // Helpful runtime diagnostics
      viewer.scene.renderError.addEventListener((err: unknown) => {
        console.error("Cesium renderError", err);
      });

      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          credit: "© OpenStreetMap",
          maximumLevel: 19,
        })
      );

      viewerRef.current = viewer;
    })();

    return () => {
      cancelled = true;
      try {
        if (primitiveRef.current && viewerRef.current) {
          viewerRef.current.scene.primitives.remove(primitiveRef.current);
          primitiveRef.current = null;
        }
        viewerRef.current?.destroy?.();
      } catch {}
      viewerRef.current = null;
    };
  }, [sceneMode]);

  // Load PNG for this datehour, decode and render as displaced mesh
  useEffect(() => {
    let aborted = false;

    (async () => {
      const viewer = viewerRef.current;
      if (!viewer) return;

      // Remove previous primitive
      if (primitiveRef.current) {
        try { viewer.scene.primitives.remove(primitiveRef.current); } catch {}
        primitiveRef.current = null;
      }

      // Fetch to read custom headers for bounds/size
      let res: Response;
      try {
        res = await fetch(pngUrl, {mode: "cors"});
      } catch (e) {
        console.error("Failed to fetch PNG", e);
        return;
      }
      if (!res.ok) {
        console.error("PNG fetch not OK", res.status, res.statusText);
        return;
      }

      // Parse bounds header if provided
      const boundsHdr = res.headers.get("X-Bounds");
      const bounds = boundsHdr
        ? (boundsHdr.split(",").map(Number) as [number, number, number, number])
        : ([-180, -85.05112878, 180, 85.05112878] as [number, number, number, number]);

      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (e) {
        console.error("Failed to read PNG blob", e);
        return;
      }
      let img: HTMLImageElement;
      let blobUrl: string;
      try {
        const out = await blobToHtmlImage(blob);
        img = out.img;
        blobUrl = out.url;
      } catch (e) {
        console.error("Failed to decode image", e);
        return;
      }
      const {imageData, width, height} = toImageData(img);

      const Cesium: typeof import("cesium") = await import("cesium");

      const mesh = buildDisplacedRectangle({
        Cesium,
        imageData,
        imgW: width,
        imgH: height,
        boundsDeg: bounds,
        subSample,
        heightFromPixel: (r: number, g: number, b: number) => {
          // Mapbox Terrain-RGB → meters
          return -10000 + (r * 65536 + g * 256 + b) * 0.1;
        },
        exaggeration,
      });

      if (aborted) return;

      const primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({geometry: mesh.geometry}),
        appearance: new Cesium.EllipsoidSurfaceAppearance({
          material: new Cesium.Material({
            fabric: { type: "Image", uniforms: { image: blobUrl } },
          }),
        }),
      });

      try {
        viewer.scene.primitives.add(primitive);
      } catch (e) {
        console.error("Failed to add primitive", e);
        return;
      }
      primitiveRef.current = primitive;

      const rect = Cesium.Rectangle.fromDegrees(...bounds);
      viewer.camera.flyTo({destination: rect});
    })();

    return () => {
      aborted = true;
    };
  }, [pngUrl, subSample, exaggeration]);

  return <div ref={containerRef} style={{position: "absolute", inset: 0}} />;
}

// ---------- helpers ----------
async function blobToHtmlImage(blob: Blob): Promise<{img: HTMLImageElement; url: string}> {
  const url = URL.createObjectURL(blob);
  const img = await loadImage(url);
  // Let caller decide when to revoke if needed
  return {img, url};
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

function toImageData(img: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return {imageData, width: img.width, height: img.height};
}

function buildDisplacedRectangle({
  Cesium,
  imageData,
  imgW,
  imgH,
  boundsDeg,
  subSample,
  heightFromPixel,
  exaggeration,
}: {
  Cesium: typeof import("cesium");
  imageData: ImageData;
  imgW: number;
  imgH: number;
  boundsDeg: [number, number, number, number];
  subSample: number;
  heightFromPixel: (r: number, g: number, b: number, a?: number) => number;
  exaggeration: number;
}) {
  const [w, s, e, n] = boundsDeg;
  let effSubSample = Math.max(1, Math.floor(subSample));
  let nx = Math.max(2, Math.floor(imgW / effSubSample));
  let ny = Math.max(2, Math.floor(imgH / effSubSample));
  // Ensure we stay within 16-bit index limits on browsers lacking Uint32 indices
  const maxVertices = 65000;
  if (nx * ny > maxVertices) {
    const scale = Math.ceil(Math.sqrt((nx * ny) / maxVertices));
    effSubSample *= scale;
    nx = Math.max(2, Math.floor(imgW / effSubSample));
    ny = Math.max(2, Math.floor(imgH / effSubSample));
  }

  const positions: number[] = [];
  const sts: number[] = [];
  const indices: number[] = [];

  const toIdx = (ix: number, iy: number) => iy * nx + ix;

  for (let iy = 0; iy < ny; iy++) {
    const v = iy / (ny - 1);
    const lat = Cesium.Math.toRadians(s + v * (n - s));
    for (let ix = 0; ix < nx; ix++) {
      const u = ix / (nx - 1);
      const lon = Cesium.Math.toRadians(w + u * (e - w));

      const px = Math.min(imgW - 1, ix * effSubSample);
      const py = Math.min(imgH - 1, iy * effSubSample);
      const k = (py * imgW + px) * 4;
      const r = imageData.data[k], g = imageData.data[k + 1], b = imageData.data[k + 2];
      const h = heightFromPixel(r, g, b) * exaggeration;

      const cart = Cesium.Cartesian3.fromRadians(lon, lat, h);
      positions.push(cart.x, cart.y, cart.z);
      sts.push(u, 1 - v);
    }
  }

  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = toIdx(ix, iy);
      const b = toIdx(ix + 1, iy);
      const c = toIdx(ix + 1, iy + 1);
      const d = toIdx(ix, iy + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const vertexCount = nx * ny;
  const indexArray = vertexCount <= 65535
    ? new Uint16Array(indices)
    : new Uint32Array(indices);

  const geometry = new Cesium.Geometry({
    attributes: ({
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array(positions),
      }),
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: new Float32Array(sts),
      }),
    } as unknown as GeometryAttributes),
    indices: indexArray,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(new Float64Array(positions))),
  });

  // Ensure the vertex format includes st for MaterialAppearance
  // EllipsoidSurfaceAppearance requires POSITION_AND_ST
  (geometry as unknown as {vertexFormat: VertexFormat}).vertexFormat = Cesium.VertexFormat.POSITION_AND_ST;

  return {geometry};
}


