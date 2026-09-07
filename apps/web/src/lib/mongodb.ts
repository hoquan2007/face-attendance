/**
 * Server-side MongoDB connection module.
 *
 * Provides a reusable, cached MongoDB connection safe for:
 * - Next.js development hot reload (multiple module evaluations)
 * - Vercel serverless execution
 *
 * This module is used by the Better Auth MongoDB adapter.
 * Business data (profiles, classes, attendance) will use Mongoose in later phases.
 *
 * NOTE: This module is server-only. Never import it from client components.
 */

import { MongoClient } from "mongodb";
import { env } from "@/lib/env";

const MONGODB_URI = env.MONGODB_URI;
const MONGODB_DB_NAME = "face_attendance";

/**
 * Global cache for the MongoDB connection state.
 * Prevents creating multiple connections during Next.js hot reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

/**
 * Returns the MongoClient instance, creating a new one if necessary.
 *
 * The same promise is returned on subsequent calls, ensuring a single
 * connection pool is used throughout the application lifecycle.
 *
 * Suitable for Better Auth MongoDB adapter.
 */
export function getMongoClient(): Promise<MongoClient> {
  if (!global._mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      // Enable retry for transient failures
      retryWrites: true,
    });

    global._mongoClient = client;
    global._mongoClientPromise = client.connect();
  }
  return global._mongoClientPromise;
}

/**
 * Returns the MongoDB Db instance for the face_attendance database.
 *
 * Used by Better Auth MongoDB adapter to access collections.
 */
export async function getDatabase() {
  const client = await getMongoClient();
  return client.db(MONGODB_DB_NAME);
}

/**
 * The database name used for this application.
 */
export const DATABASE_NAME = MONGODB_DB_NAME;
