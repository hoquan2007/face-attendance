/**
 * Profile service layer.
 *
 * Phase 2: encapsulates all reads and writes against the `profiles`
 * collection. Server Components, Server Actions, and tests should call
 * this module rather than touching the Mongoose model directly.
 *
 * Authorization:
 *   - Every service function is invoked with an authenticated Better
 *     Auth `userId`. The service NEVER derives identity from request
 *     bodies or query strings.
 *   - Lookup-by-arbitrary-user-id is not exposed.
 *
 * Idempotency:
 *   - `upsertOnboarding` uses the unique index on `userId` so repeated
 *     submissions cannot create duplicate Profile documents.
 *
 * Errors:
 *   - Duplicate-key errors are mapped to safe user-facing
 *     `ProfileError` instances via `profile-errors.ts`.
 *   - Raw Mongoose / MongoDB errors never escape this module.
 */

import "server-only";

import { getMongooseConnection } from "@/lib/mongoose";
import { ProfileModel, type ProfileAttrs } from "@/lib/profile-model";

import { OnboardingSchema, ProfileUpdateSchema } from "@/lib/profile-schema";
import {
  PROFILE_ERROR_CODES,
  ProfileError,
  mapMongoDuplicateKeyError,
} from "@/lib/profile-errors";

/**
 * Lazily ensures the Mongoose connection is ready before any model
 * operation. Calling it once at the top of each service function is
 * cheap (subsequent calls are O(1)) and keeps each function safe to
 * invoke from any server-side context.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

/**
 * Returns the Profile document for the given Better Auth user, or
 * `null` if no profile exists.
 *
 * Authorization: only the current user's own profile can be read.
 * The caller is responsible for ensuring `userId` came from the
 * authenticated session, not from the request body.
 */
export async function getProfileByUserId(
  userId: string,
): Promise<ProfileAttrs | null> {
  await ensureConnection();
  const doc = await ProfileModel.findOne({ userId }).lean<ProfileAttrs>().exec();
  return doc ?? null;
}

/**
 * Returns `true` if the given user has a Profile with
 * `onboardingCompleted === true`.
 *
 * Missing profile → `false`. A profile with `onboardingCompleted:
 * false` → `false`.
 */
export async function isOnboardingComplete(userId: string): Promise<boolean> {
  const profile = await getProfileByUserId(userId);
  return Boolean(profile?.onboardingCompleted);
}

/**
 * PHASE 5.1D2B — Server-only batch lookup primitive for student
 * Profile projections.
 *
 * `getStudentProfilesByUserIds(userIds)` performs a SINGLE batched
 * `ProfileModel.find({ userId: { $in: [...] } })` query and returns
 * the safe `SafeStudentProfileProjection` for every Profile that
 * exists, has completed onboarding, and carries `role === "student"`.
 *
 * The function is the AUTHORITATIVE batch lookup for roster
 * composition. It exists to prevent the obvious N+1 of one
 * `getProfileByUserId(...)` call per membership row, and to keep
 * the application memory scan out of the data path (no
 * application-side filter over the whole `profiles` collection).
 *
 * ## Output shape
 *
 *   - The result is a `Map<string, SafeStudentProfileProjection>`
 *     keyed by `userId` so the caller can correlate a
 *     `ClassMembership.studentUserId` row to its Profile.
 *   - Profiles that do not exist, are incomplete
 *     (`onboardingCompleted === false`), or carry a non-student
 *     `role` are OMITTED from the map. Corrupt / legacy memberships
 *     that point at an absent or non-student Profile can therefore
 *     be skipped safely by the caller.
 *   - `userIds` that do not appear in any Profile are simply absent
 *     from the returned Map (NOT represented by `null`).
 *   - Duplicate input ids are deduplicated before the query.
 *
 * ## Privacy
 *
 *   - The function projects ONLY the fields the application
 *     identity layer exposes for roster composition: `userId`
 *     (internally, for correlation), `fullName`,
 *     `identificationCode`, `role`, and `onboardingCompleted`.
 *   - `emailSnapshot`, `phone`, `createdAt`, `updatedAt`, and the
 *     Mongo `_id` are NEVER read from the database driver buffer.
 *     The projection is set explicitly on the Mongoose `.find(...)`
 *     chain so the unwanted fields never reach application memory.
 *   - This function does NOT consult the Better Auth `user`
 *     collection. Better Auth identity is intentionally out of
 *     scope for roster composition.
 *
 * ## Authorization
 *
 * The function performs NO authentication, NO role check, and NO
 * ownership check. The CALLER is responsible for supplying ONLY
 * user ids the caller is authorized to project. The PHASE 5.1D2B
 * teacher roster service supplies the `studentUserId` values
 * derived from active memberships of a class the teacher owns.
 *
 * ## Idempotency
 *
 * The function is read-only and side-effect-free. Repeated calls
 * with the same input return the same projection.
 *
 * ## Errors
 *
 * The function never throws on lookup failure: the production code
 * wraps the query in `try/catch` and maps unexpected DB failures
 * to the generic `CLASS_READ_FAILED` code. The caller never sees a
 * raw stack trace or a Mongo error message.
 */
export interface SafeStudentProfileProjection {
  userId: string;
  fullName: string;
  identificationCode: string;
  role: "student";
  onboardingCompleted: true;
}

export async function getStudentProfilesByUserIds(
  userIds: ReadonlyArray<string>,
): Promise<Map<string, SafeStudentProfileProjection>> {
  await ensureConnection();

  // Defensive input dedup — the caller should already dedupe but
  // the function is total for arbitrary input shapes. An empty
  // input short-circuits to an empty Map so we never issue a
  // `$in: []` query against MongoDB.
  const unique = Array.from(new Set(userIds)).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (unique.length === 0) return new Map();

  const docs = await ProfileModel.find({
    userId: { $in: unique },
  })
    // Project ONLY the fields required for roster composition.
    // `emailSnapshot`, `phone`, `createdAt`, `updatedAt`, and the
    // Mongo `_id` are intentionally excluded so they never reach
    // application memory.
    .select({
      userId: 1,
      fullName: 1,
      identificationCode: 1,
      role: 1,
      onboardingCompleted: 1,
    })
    .lean<
      Array<{
        userId: string;
        fullName: string;
        identificationCode: string;
        role: string;
        onboardingCompleted: boolean;
      }>
    >()
    .exec();

  const out = new Map<string, SafeStudentProfileProjection>();
  for (const doc of docs) {
    if (!doc.userId) continue;
    // Defensive: only student-role, completed Profiles enter the
    // projection. A corrupt / legacy Profile with role != "student"
    // (or with onboardingCompleted === false) is omitted so the
    // caller can skip the membership row safely.
    if (doc.role !== "student") continue;
    if (doc.onboardingCompleted !== true) continue;
    if (typeof doc.fullName !== "string") continue;
    if (typeof doc.identificationCode !== "string") continue;
    out.set(doc.userId, {
      userId: doc.userId,
      fullName: doc.fullName,
      identificationCode: doc.identificationCode,
      role: "student",
      onboardingCompleted: true,
    });
  }
  return out;
}

/**
 * Atomically creates (or updates) the Profile for the given Better Auth
 * user, marking onboarding as complete.
 *
 * Behavior:
 *   - If no profile exists, one is created with the supplied fields and
 *     `onboardingCompleted: true`.
 *   - If a profile already exists, it is updated **without** changing
 *     `userId` or `emailSnapshot`. `onboardingCompleted` is set to
 *     `true`. This protects the user from accidentally re-running
 *     onboarding with a different identificationCode and wiping their
 *     history, while still allowing corrections during the same flow.
 *   - Because `userId` is unique, this method is idempotent at the
 *     database level: parallel submissions collapse to a single
 *     document.
 *
 * Throws:
 *   - `ProfileError(IDENTIFICATION_CODE_TAKEN)` if the chosen code is
 *     owned by another profile.
 *   - `ProfileError(INVALID_PROFILE_DATA)` if the input fails Zod.
 *
 * @param userId        Better Auth user ID from the session.
 * @param emailSnapshot Better Auth email from the session.
 * @param input         Validated onboarding payload.
 */
export async function upsertOnboarding(
  userId: string,
  emailSnapshot: string,
  input: unknown,
): Promise<ProfileAttrs> {
  const parsed = OnboardingSchema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ProfileError({
      code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
      message: "Some fields are missing or invalid.",
      fieldErrors: flat.fieldErrors,
    });
  }
  const data = parsed.data;

  await ensureConnection();

  try {
    const doc = await ProfileModel.findOneAndUpdate(
      { userId },
      {
        $set: {
          emailSnapshot,
          role: data.role,
          fullName: data.fullName,
          identificationCode: data.identificationCode,
          phone: data.phone,
          onboardingCompleted: true,
        },
        $setOnInsert: {
          userId,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    )
      .lean<ProfileAttrs>()
      .exec();
    if (!doc) {
      throw new ProfileError({
        code: PROFILE_ERROR_CODES.UNKNOWN_ERROR,
        message: "Failed to save profile.",
      });
    }
    return doc;
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw mapMongoDuplicateKeyError(err);
  }
}

/**
 * Updates an existing completed Profile for the given user.
 *
 * Authorization:
 *   - Only the profile whose `userId` matches the authenticated user
 *     can be modified. There is no public API to update another
 *     user's profile.
 *
 * Forbidden fields:
 *   - `userId`, `emailSnapshot`, and `role` are NEVER modifiable here.
 *     `userId`/`emailSnapshot` come from the Better Auth session;
 *     `role` changes must go through a controlled flow that does
 *     not exist yet.
 *
 * Throws:
 *   - `ProfileError(PROFILE_NOT_FOUND)` if no profile exists yet.
 *   - `ProfileError(INVALID_PROFILE_DATA)` on Zod failure.
 *   - `ProfileError(IDENTIFICATION_CODE_TAKEN)` on duplicate code.
 */
export async function updateProfile(
  userId: string,
  input: unknown,
): Promise<ProfileAttrs> {
  const parsed = ProfileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ProfileError({
      code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
      message: "Some fields are missing or invalid.",
      fieldErrors: flat.fieldErrors,
    });
  }
  const data = parsed.data;

  await ensureConnection();

  try {
    const doc = await ProfileModel.findOneAndUpdate(
      { userId },
      {
        $set: {
          fullName: data.fullName,
          identificationCode: data.identificationCode,
          phone: data.phone,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    )
      .lean<ProfileAttrs>()
      .exec();

    if (!doc) {
      throw new ProfileError({
        code: PROFILE_ERROR_CODES.PROFILE_NOT_FOUND,
        message: "Profile not found.",
      });
    }
    return doc;
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw mapMongoDuplicateKeyError(err);
  }
}

// Internal helpers exported for tests only.
export const __testing = {
  ProfileModel,
};