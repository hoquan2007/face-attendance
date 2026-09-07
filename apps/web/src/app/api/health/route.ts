import { NextResponse } from "next/server";

/**
 * Minimal health endpoint for deployment verification.
 *
 * Does NOT:
 * - connect to MongoDB
 * - expose environment variables
 * - expose secrets
 * - call the Face Service
 * - expose filesystem information
 */
export async function GET() {
  return NextResponse.json(
    { status: "ok", service: "web" },
    { status: 200 }
  );
}
