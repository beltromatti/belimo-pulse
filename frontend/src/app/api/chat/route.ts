import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      message: "Belimo Brain is disabled for the final demo build.",
    },
    { status: 410 },
  );
}
