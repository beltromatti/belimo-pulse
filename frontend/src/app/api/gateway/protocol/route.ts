import { NextResponse } from "next/server";

import { getApiBaseUrl } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const backendResponse = await fetch(`${getApiBaseUrl()}/api/gateway/protocol`, {
      cache: "no-store",
    });

    const payload = await backendResponse.json();

    return NextResponse.json(payload, {
      status: backendResponse.status,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Unexpected gateway protocol proxy error.",
      },
      { status: 500 },
    );
  }
}
