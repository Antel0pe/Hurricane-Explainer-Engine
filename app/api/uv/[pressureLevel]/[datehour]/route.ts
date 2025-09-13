// app/api/uv/[datehour]/route.ts
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseDatehour, uvDir, boundsHeaders,
} from "../../../_lib/shared";

// export const runtime = nodeRuntime;
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: { datehour: string } }
) {
  const { datehour } = ctx.params;

  let dt: Date;
  try {
    dt = parseDatehour(datehour);
  } catch {
    return NextResponse.json({ error: "Invalid datehour format" }, { status: 400 });
  }

  const ts = [
    dt.getUTCFullYear().toString().padStart(4, "0"),
    (dt.getUTCMonth() + 1).toString().padStart(2, "0"),
    dt.getUTCDate().toString().padStart(2, "0"),
    dt.getUTCHours().toString().padStart(2, "0"),
  ].join("");

  const imgPath = path.join(uvDir(), `uv_${ts}.png`);
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
