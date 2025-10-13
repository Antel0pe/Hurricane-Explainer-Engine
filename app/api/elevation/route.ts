// app/api/landMask/route.ts
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { elevationMapPath, boundsHeaders } from "../_lib/shared";

// export const runtime = nodeRuntime;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const buf = await readFile(elevationMapPath());      // Buffer
    const body = new Uint8Array(buf);                // BodyInit
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        ...boundsHeaders(),
      },
    });
  } catch {
    return NextResponse.json({ error: "image doesn't exist" }, { status: 404 });
  }
}
