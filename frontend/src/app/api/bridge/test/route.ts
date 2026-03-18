import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getApiBaseUrl() {
  const value = process.env.API_BASE_URL;

  if (!value) {
    throw new Error("Missing API_BASE_URL.");
  }

  return value.replace(/\/$/, "");
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiBaseUrl = getApiBaseUrl();

    const backendResponse = await fetch(`${apiBaseUrl}/api/db/ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: typeof body.source === "string" ? body.source : "frontend-ui",
        note: typeof body.note === "string" ? body.note : "manual-bridge-test",
      }),
      cache: "no-store",
    });

    const backendPayload = await backendResponse.json();

    if (!backendResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          message: backendPayload.message ?? "Backend write failed.",
        },
        { status: backendResponse.status },
      );
    }

    const databaseResponse = await fetch(`${apiBaseUrl}/api/db/health`, {
      cache: "no-store",
    });
    const databasePayload = await databaseResponse.json();

    return NextResponse.json({
      ok: true,
      bridgeTimestamp: new Date().toISOString(),
      backend: backendPayload,
      database: databasePayload,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Unexpected bridge error.",
      },
      { status: 500 },
    );
  }
}
