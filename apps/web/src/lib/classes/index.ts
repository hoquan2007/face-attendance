/**
 * Public surface for the classes module.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * All exports are server-only. No Mongoose models, password hashes, or
 * plaintext passwords are re-exported here.
 */

// Types and models (internal use)
export { ClassModel, type ClassAttrs, type ClassDoc, type SafeClassDto } from "./class-model";
export {
  ClassMembershipModel,
  type ClassMembershipAttrs,
  type ClassMembershipDoc,
  type SafeMembershipDto,
} from "./class-membership-model";

// Code utilities
export {
  generateClassCode,
  normalizeClassCode,
  isValidClassCodeAlphabet,
  isCanonicalClassCode,
  CLASS_CODE_LENGTH,
} from "./class-code";

// Password utilities (server-only, never exported to browser)
export { hashClassPassword, verifyClassPassword, isValidPasswordHash } from "./class-password";

// Class service
export {
  createClass,
  getClassById,
  getClassByCode,
  listClassesByTeacherUserId,
  type CreateClassInput,
  type SafeClassDto as ClassDto,
  toSafeClassDto,
  type ClassErrorCode,
  ClassServiceError,
  CLASS_ERROR_CODES,
  isClassCodeDuplicateKeyError,
} from "./class-service";

// Membership service
export {
  createMembership,
  getMembershipById,
  getMembership,
  listMembershipsByStudentUserId,
  listMembershipsByClassId,
  type CreateMembershipInput,
  type SafeMembershipDto as MembershipDto,
  toSafeMembershipDto,
  type MembershipErrorCode,
  MembershipServiceError,
  MEMBERSHIP_ERROR_CODES,
  isMembershipDuplicateKeyError,
} from "./class-membership-service";

// PHASE 5.1C — the join-time credential primitive, the fixed
// dummy hash, and the dummy-verification helper are
// INTENTIONALLY NOT re-exported here. They are server-only
// deep-path imports used exclusively by the join Server Action.
// The barrel keeps the public surface restricted to
// `SafeClassDto` / `SafeMembershipDto` so `passwordHash` cannot
// leak into a browser-facing payload.
