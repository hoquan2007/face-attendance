/**
 * Mongoose connection helper.
 *
 * Phase 2: profile collection (and future business collections).
 *
 * This module is server-only. Never import it from client components.
 *
 * Design notes:
 *   - The connection uses the same MONGODB_URI and `face_attendance` database
 *     that the Better Auth MongoDB adapter uses. The two subsystems share
 *     the underlying MongoDB cluster but maintain separate persistence
 *     concerns.
 *   - We never replace the Better Auth adapter. Better Auth keeps using its
 *     own MongoDB driver (via `mongodbAdapter`). Mongoose is a separate
 *     connection used exclusively for application business data.
 *   - The connection is cached on `globalThis` to survive Next.js hot
 *     reloads in development and to avoid opening a fresh connection on
 *     every Vercel serverless invocation that reuses a warm container.
 *   - We expose `getMongooseConnection()` and `getMongooseDb()`. Mongoose
 *     models register themselves against a single default connection, so
 *     every model shares the same cached connection.
 */
import mongoose from "mongoose";

import { env } from "@/lib/env";
import { DATABASE_NAME } from "@/lib/mongodb";

/**
 * Global cache for the Mongoose connection state.
 *
 * Using `globalThis` is the standard Next.js pattern for singletons that
 * must survive hot module reloads (HMR) in development.
 */
declare global {
  // eslint-disable-next-line no-var
  var _mongooseConnectionPromise: Promise<typeof mongoose> | undefined;
}

const MONGODB_URI = env.MONGODB_URI;

/**
 * Lazily establishes the Mongoose connection and returns the singleton
 * Mongoose module (`mongoose`).
 *
 * Subsequent calls reuse the cached connection. On Vercel serverless,
 * cold starts open a new TCP connection once and the runtime keeps the
 * function instance warm for follow-up invocations.
 */
export async function getMongooseConnection(): Promise<typeof mongoose> {
  if (!global._mongooseConnectionPromise) {
    global._mongooseConnectionPromise = mongoose
      .connect(MONGODB_URI, {
        dbName: DATABASE_NAME,
        serverSelectionTimeoutMS: 10_000,
      })
      .then(() => mongoose);
  }
  return global._mongooseConnectionPromise;
}

/**
 * Returns the Mongoose-backed `Db` instance for the `face_attendance`
 * database.
 *
 * Useful for raw collection access without registering a model, e.g.
 * for migration scripts. Business code should prefer typed models.
 */
export async function getMongooseDb() {
  await getMongooseConnection();
  // `mongoose.connection.db` is typed as `Db | null` in some Mongoose
  // versions; we assert non-null because we only ever connect once and
  // never disconnect explicitly.
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Mongoose connection is not ready.");
  }
  return db;
}