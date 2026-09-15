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
} from "./class-membership-service";
