/**
 * Integration test: real Better Auth + real MongoDB session validation.
 *
 * This test:
 * 1. Reads MONGODB_URI from apps/web/.env.local
 * 2. Connects to the real MongoDB Atlas cluster
 * 3. Inserts a controlled user + account + session document
 * 4. Calls auth.api.getSession() with a cookie header containing the session token
 * 5. Verifies the session is found and matches
 * 6. Cleans up the inserted documents
 *
 * This proves server-side session validation works against real MongoDB.
 *
 * Skipped if .env.local is not found.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { auth } from "@/lib/auth";

function loadMongoUri(): string | null {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return null;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "MONGODB_URI") return value;
  }
  return null;
}

const MONGODB_URI = loadMongoUri();
const SKIP = !MONGODB_URI;

describe.skipIf(SKIP)("real Better Auth + MongoDB session validation", () => {
  let client: MongoClient;
  const dbName = "face_attendance";
  const testUserId = new ObjectId();
  const testAccountId = new ObjectId();
  const testSessionId = new ObjectId();
  const testSessionToken = `test-session-token-${Date.now()}`;

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI!, { retryWrites: true });
    await client.connect();
    const db = client.db(dbName);
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 1000 * 60 * 60);

    await db.collection("user").insertOne({
      _id: testUserId,
      id: testUserId.toHexString(),
      email: "test-integration@example.com",
      name: "Test Integration",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection("account").insertOne({
      _id: testAccountId,
      id: testAccountId.toHexString(),
      accountId: "google-test",
      providerId: "google",
      userId: testUserId.toHexString(),
      createdAt: now,
      updatedAt: now,
    });

    await db.collection("session").insertOne({
      _id: testSessionId,
      id: testSessionId.toHexString(),
      token: testSessionToken,
      userId: testUserId.toHexString(),
      expiresAt: futureExpiry,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    if (client) {
      const db = client.db(dbName);
      await db.collection("user").deleteOne({ _id: testUserId });
      await db.collection("account").deleteOne({ _id: testAccountId });
      await db.collection("session").deleteOne({ _id: testSessionId });
      await client.close();
    }
  });

  it("validates a real session from MongoDB via auth.api.getSession", async () => {
    const authInstance = await auth();
    const headers = new Headers();
    headers.set("cookie", `better-auth.session_token=${testSessionToken}`);

    const result = await authInstance.api.getSession({ headers });

    expect(result).not.toBeNull();
    expect(result?.user).not.toBeNull();
    expect(result?.user?.email).toBe("test-integration@example.com");
  });

  it("returns null for an invalid session token", async () => {
    const authInstance = await auth();
    const headers = new Headers();
    headers.set(
      "cookie",
      `better-auth.session_token=invalid-token-${Date.now()}`,
    );

    const result = await authInstance.api.getSession({ headers });

    expect(result).toBeNull();
  });
});
