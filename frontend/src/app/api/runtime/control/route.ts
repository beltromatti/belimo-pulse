import { NextResponse } from "next/server";

import { getApiBaseUrl } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const backendResponse = await fetch(`${getApiBaseUrl()}/api/runtime/control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
        message: error instanceof Error ? error.message : "Unexpected control proxy error.",
      },
      { status: 500 },
    );
  }
}
