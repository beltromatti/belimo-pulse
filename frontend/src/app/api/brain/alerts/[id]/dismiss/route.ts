import { NextResponse } from "next/server";

import { getApiBaseUrl } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const backendResponse = await fetch(`${getApiBaseUrl()}/api/brain/alerts/${id}/dismiss`, {
      method: "POST",
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
        message: error instanceof Error ? error.message : "Unexpected dismiss proxy error.",
      },
      { status: 500 },
    );
  }
}
