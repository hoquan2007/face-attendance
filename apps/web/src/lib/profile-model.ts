/**
 * Mongoose Profile model.
 *
 * Phase 2: the application owns the `profiles` collection. Better Auth
 * owns `user`, `account`, `session`, `verification`. The two
 * subsystems share the same MongoDB cluster but never share
 * documents.
 *
 * The `userId` field references the Better Auth `user._id` conceptually
 * (as a string). Mongoose does not enforce a foreign-key relationship
 * because Better Auth's user collection is owned by another library;
 * we rely on application logic to keep the linkage consistent.
 *
 * Indexes:
 *   - `userId` is UNIQUE so a Better Auth user can have at most one
 *     Profile document. This also provides the idempotency guarantee
 *     for double-clicked onboarding submissions.
 *   - `identificationCode` is UNIQUE so duplicate codes are rejected
 *     at the database layer with a 11000 error that the service maps
 *     to a safe user-facing message.
 */

import mongoose, {
  type HydratedDocument,
  type InferSchemaType,
  type Model,
  Schema,
} from "mongoose";

import { ROLES } from "@/lib/profile-schema";

/**
 * Plain TypeScript representation of a Profile document.
 *
 * The model also exposes a Mongoose Document class for full Mongoose
 * semantics. Server code should work with `ProfileDoc` (HydratedDocument).
 */
export type ProfileAttrs = {
  userId: string;
  emailSnapshot: string;
  role: (typeof ROLES)[number];
  fullName: string;
  identificationCode: string;
  phone?: string;
  onboardingCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const ProfileSchema = new Schema<ProfileAttrs>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    emailSnapshot: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ROLES,
      required: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    identificationCode: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      unique: true,
      index: true,
    },
    phone: {
      type: String,
      required: false,
      trim: true,
      maxlength: 32,
      default: undefined,
    },
    onboardingCompleted: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "profiles",
    // We never store biometric data here — embeddings belong to a
    // future `face_profiles` collection in Phase 4+.
  },
);

/**
 * Compound secondary indexes are intentionally not added here.
 * The two unique indexes (`userId`, `identificationCode`) cover the
 * Phase 2 access patterns.
 */

// Avoid re-registering the model during Next.js hot reload.
const modelKey = "Profile";
export const ProfileModel: Model<ProfileAttrs> =
  (mongoose.models[modelKey] as Model<ProfileAttrs> | undefined) ||
  mongoose.model<ProfileAttrs>(modelKey, ProfileSchema);

/**
 * Document type with full Mongoose semantics (`save`, `populate`, ...).
 * Service code uses the Model APIs, but this type is exported for tests.
 */
export type ProfileDoc = HydratedDocument<ProfileAttrs>;

/**
 * Helper: convert a Profile document (or hydrated subdoc) into a plain
 * JSON-safe object for Server Actions / Server Components.
 *
 * This intentionally does NOT include Mongoose internals or the ObjectId
 * so that consumers never accidentally leak them to the browser.
 */
export function toPlainProfile(doc: ProfileDoc | null): ProfileAttrs | null {
  if (!doc) return null;
  return {
    userId: doc.userId,
    emailSnapshot: doc.emailSnapshot,
    role: doc.role,
    fullName: doc.fullName,
    identificationCode: doc.identificationCode,
    phone: doc.phone ?? undefined,
    onboardingCompleted: doc.onboardingCompleted,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Type re-export: `InferSchemaType<typeof ProfileSchema>` could be used
// for full inference, but explicit `ProfileAttrs` keeps the public
// surface stable across Mongoose upgrades.
export type { InferSchemaType };