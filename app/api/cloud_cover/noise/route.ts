// app/api/cloud_cover/noise/route.ts
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDatehour, cloudCoverPath, boundsHeaders } from "../../_lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
) {
  const imgPath = path.join(cloudCoverPath(), 'noise', `fbmNoise.png`);

  try {
    const buf = await readFile(imgPath);
    const body = new Uint8Array(buf);
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
