# Privacy & Security

> Status: **Phase 5.1E4A** — PHASE 5.1A ships the persistence foundation for the `classes` and `class_memberships` collections. This phase adds two new Mongoose models, their service layers, and server-only utilities for class code generation, normalization, and password hashing. PHASE 5.1A.1 hardens the class join password primitive (PBKDF2-SHA256, async, constant-time verification, versioned encoded hash). PHASE 5.1B adds the **authenticated Teacher create-class Server Action** (`createClassAction`) — the first browser-reachable entry point on top of the 5.1A service. The action derives teacher identity exclusively from the Better Auth server session, requires a completed Profile with `role === "teacher"`, validates browser-supplied `name` + `password` server-side, generates a fresh canonical 7-char `classCode` server-side via the 5.1A generator, reuses `hashClassPassword(...)` from the service to persist `passwordHash` only, and performs a BOUNDED internal retry (at most `MAX_CLASS_CODE_ATTEMPTS`) on exact `classCode` unique-index collisions only. The action does NOT introduce a create-class UI, a `/api/classes` route, a `ClassMembership` write, an attendance session, a Face Service call, or any FaceProfile touch. PHASE 5.1C adds the **authenticated Student join-class Server Action** (`createJoinClassAction`) — the student-side counterpart to PHASE 5.1B. The action derives student identity exclusively from the Better Auth server session, requires a completed Profile with `role === "student"`, validates browser-supplied `classCode` + `password` server-side (canonicalizing the classCode via `z.preprocess` and enforcing the canonical alphabet `[A-HJ-NP-Z2-9]`), looks up the class through the server-only `getClassJoinCredentialByCode(...)` primitive, runs ONE async PBKDF2 verification workload (real or dummy) on every branch that would otherwise short-circuit — missing class / archived class / malformed stored hash all execute `await runDummyPasswordVerification(password)` against the fixed `DUMMY_CLASS_PASSWORD_HASH` constant before returning `INVALID_CLASS_CREDENTIALS` (wall-clock timing tests are explicitly NOT used; the contract asserts BEHAVIOR); classifies the membership insert's E11000 collision via the precise server-only `isMembershipDuplicateKeyError` predicate that accepts ONLY compound `(classId, studentUserId)` collisions — unrelated 11000 errors map to `CLASS_JOIN_FAILED` and the insert is NEVER retried. The action does NOT introduce a join UI, a `/api/classes/join` route, a `Class` write, a `Profile` mutation, a `FaceProfile` touch, a Face Service call, or any attendance logic. Better Auth collections remain untouched. PHASE 5.1D1 ships the **authenticated class-list read model foundation** as a server-only module (`getVisibleClassesForCurrentUser()` in `apps/web/src/lib/classes/class-read-service.ts`) — NOT a Server Action, NOT an REST route. The function accepts NO arguments and derives identity exclusively from the Better Auth server session and the persisted Profile. It is the canonical, READ-ONLY entry point for future Server Components that need to list the caller's classes. Teacher visibility = `Class.teacherUserId === session.user.id`; Student visibility = `ClassMembership.studentUserId === session.user.id` AND `status === "active"`. The student path batches the referenced `Class` lookups in a single `ClassModel.find({ _id: { $in: [...] } })` query — there is NO application-memory scan and NO obvious N+1. Missing referenced class ids are skipped safely; duplicate class ids across corrupt memberships are deduplicated. The safe summary DTO contains ONLY `{ id, name, classCode, status, createdAt }` — `passwordHash`, `teacherUserId`, `studentUserId`, membership internal ids, and biometric fields are NEVER serialized. The module is READ-ONLY: it does NOT create / mutate any `Class`, `ClassMembership`, or `Profile`; it does NOT call the Face Service; it does NOT touch `FaceProfile`; it does NOT verify a class password. D1 does NOT add a class list page, a class detail page, a roster, attendance, or any other public API surface. PHASE 5.1D2A ships the **authenticated class-detail read model** as a server-only function (`getClassDetailForCurrentUser(classId)` in `apps/web/src/lib/classes/class-read-service.ts`) — NOT a Server Action, NOT an HTTP route. The function accepts ONLY `classId` (the resource identifier). Identity derives exclusively from `session.user.id`; role derives exclusively from `Profile.role`. Teacher access = `ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })` (the authorization constraint is encoded directly in the filter — the database refuses to surface a class the teacher does not own). Student access = `ClassMembershipModel.findOne({ classId, studentUserId: session.user.id, status: "active" })` THEN `ClassModel.findById(classId)`. Malformed `classId` (not a canonical 24-hex string) collapses to the SAME `CLASS_NOT_ACCESSIBLE` boundary used for missing / unauthorized classes — there is intentionally NO separate outward-facing code for "malformed syntax" vs "not yours" vs "no membership". The safe detail DTO contains ONLY `{ id, name, classCode, status, createdAt, updatedAt, role }` — `passwordHash`, `teacherUserId`, `studentUserId`, Mongoose internals, biometric fields, and roster / membership identifiers are NEVER serialized. The module is READ-ONLY: it does NOT create / mutate any `Class`, `ClassMembership`, or `Profile`; it does NOT call the Face Service; it does NOT touch `FaceProfile`; it does NOT verify a class password. Archived classes remain readable to authorized viewers (owner teacher or student with active membership); the result exposes `status: "archived"` safely. D2A does NOT add a class detail page, a roster, attendance, or any other public API surface. — PHASE 5.1A ships the persistence foundation for the `classes` and `class_memberships` collections. This phase adds two new Mongoose models, their service layers, and server-only utilities for class code generation, normalization, and password hashing. PHASE 5.1A.1 hardens the class join password primitive (PBKDF2-SHA256, async, constant-time verification, versioned encoded hash). PHASE 5.1B adds the **authenticated Teacher create-class Server Action** (`createClassAction`) — the first browser-reachable entry point on top of the 5.1A service. The action derives teacher identity exclusively from the Better Auth server session, requires a completed Profile with `role === "teacher"`, validates browser-supplied `name` + `password` server-side, generates a fresh canonical 7-char `classCode` server-side via the 5.1A generator, reuses `hashClassPassword(...)` from the service to persist `passwordHash` only, and performs a BOUNDED internal retry (at most `MAX_CLASS_CODE_ATTEMPTS`) on exact `classCode` unique-index collisions only. The action does NOT introduce a create-class UI, a `/api/classes` route, a `ClassMembership` write, an attendance session, a Face Service call, or any FaceProfile touch. PHASE 5.1C adds the **authenticated Student join-class Server Action** (`createJoinClassAction`) — the student-side counterpart to PHASE 5.1B. The action derives student identity exclusively from the Better Auth server session, requires a completed Profile with `role === "student"`, validates browser-supplied `classCode` + `password` server-side (canonicalizing the classCode via `z.preprocess` and enforcing the canonical alphabet `[A-HJ-NP-Z2-9]`), looks up the class through the server-only `getClassJoinCredentialByCode(...)` primitive, runs ONE async PBKDF2 verification workload (real or dummy) on every branch that would otherwise short-circuit — missing class / archived class / malformed stored hash all execute `await runDummyPasswordVerification(password)` against the fixed `DUMMY_CLASS_PASSWORD_HASH` constant before returning `INVALID_CLASS_CREDENTIALS`; classifies the membership insert's E11000 collision via the precise server-only `isMembershipDuplicateKeyError` predicate that accepts ONLY compound `(classId, studentUserId)` collisions. The `DUMMY_CLASS_PASSWORD_HASH` constant is a single string literal — it is NEVER generated at module load via `hashClassPassword()`, `pbkdf2`, `randomBytes`, top-level `await`, or any other runtime primitive. The `getClassJoinCredentialByCode` primitive and `DUMMY_CLASS_PASSWORD_HASH` constant are server-only deep-path imports and are INTENTIONALLY NOT re-exported through the public `index.ts` barrel so `passwordHash` cannot leak into a browser-facing payload. The action does NOT introduce a join UI, a `/api/classes/join` route, a `Class` write, a `Profile` mutation, a `FaceProfile` touch, a Face Service call, or any attendance logic. Better Auth collections remain untouched.
>
> **PHASE 5.1C.1 — JOIN IDEMPOTENCY + CANONICAL VERIFICATION AUDIT.** Duplicate membership after VALID class credentials is an **idempotent success** — the compound `(classId, studentUserId)` unique-index collision maps to `ok: true, alreadyJoined: true` with the ALREADY-PERSISTED membership projected via the new server-only `getSafeMembership(classId, studentUserId)` primitive in `class-membership-service.ts`. The insert is NEVER retried. Password verification, the canonical credential-state branches, and the `active`/`joinable` check all run BEFORE the idempotency classification — an existing membership MUST NOT allow bypassing the class password. The `ALREADY_JOINED` error code is REMOVED; the duplicate path is no longer a failure mode. Unrelated E11000 collisions (a future `idempotencyKey` index) still map to `CLASS_JOIN_FAILED`.
> server-only Next.js orchestration service
> (`finalizeEnrollmentSessionForUser`) that loads the temporary
> `FaceEnrollmentSession`, decrypts its accepted samples server-side
> using the existing PHASE 4.1 AES-256-GCM utility, reconstructs the
> exact AAD from authoritative persisted metadata, validates plaintext
> vectors, calls the B1A client exactly once, and re-checks the
> enrollment generation after the Face Service response. PHASE 4.6B1B
> does NOT persist a `FaceProfile`, does NOT delete the temporary
> session, and does NOT expose a Next.js route. Plaintext sample
> embeddings exist only transiently in server memory. The post-finalize
> generation re-check reduces stale-result risk but PHASE 4.6B2 must
> still atomically verify `generationId` when persisting/replacing
> `FaceProfile` and consuming the temporary session.
> PHASE 4.6B2A adds the **atomic completion claim** on the temporary
> `FaceEnrollmentSession` — an OPTIONAL `finalizationClaim` field
> (`token`, `generationId`, `claimedAt`) acquired and released by
> server-only service operations. The claim is the server-side
> capability that closes the small race between B1B's post-finalize
> recheck and B2B FaceProfile persistence. The claim token is server-only
> (`node:crypto randomUUID()`), is never sent to the browser or to the
> Face Service, and is never logged. The claim carries no expiry /
> lease / heartbeat / setTimeout / background cleanup — the existing
> session TTL remains the lifecycle boundary.
> PHASE 4.6B2B adds the **claim-bound `FaceProfile` persistence**
> orchestration (`persistFinalizedFaceProfileForUser`) — a server-only
> Next.js module that runs B1B → B2A claim → centroid encryption with
> the existing PHASE 4.1 AES-GCM utility and exact AAD → copy encrypted
> samples verbatim → idempotent persistence keyed on
> `sourceEnrollmentGenerationId`. The centroid is never logged; the
> claim token is returned only to trusted-server continuations and never
> appears in any browser DTO. The temporary enrollment session is NOT
> consumed / deleted by B2B — that belongs to PHASE 4.6B2C. No MongoDB
> multi-document transaction is introduced in B2B.
> PHASE 4.6B2C adds the **temporary-enrollment consumption +
> post-persistence crash-recovery** orchestration
> (`completeFinalizedFaceEnrollmentForUser`) — a server-only Next.js
> module. It pre-flights the persisted `FaceProfile`, then atomically
> consumes the matching temporary session via a strict CAS delete on
> `(userId, generationId, claimToken)` (NORMAL path) or a
> lineage-bound CAS delete on `(userId, generationId)` (CRASH-RECOVERY
> path). The recovery path requires NO original claim token because the
> durable `FaceProfile.sourceEnrollmentGenerationId` lineage proves
> commit. The B2C result contains only `configured`, `enrolledAt`,
> `sampleCount`, and `cleanupStatus` — never the claim token, the
> generationId, the centroid, ciphertext, IV, authTag, keyVersion,
> model metadata, or `userId`. A different-generation session is
> NEVER deleted. No MongoDB transaction. No biometric decryption. No
> Face Service call. No browser route / Server Action / UI. The
> orchestration remains server-internal only.
> PHASE 4.6B3A wraps the B2C orchestrator in an authenticated Server
> Action (`finishFaceEnrollment`). Identity is derived EXCLUSIVELY
> from the Better Auth server session; the browser sends no
> `userId`. The action gates on a completed `Profile`, then calls
> `completeFinalizedFaceEnrollmentForUser(session.user.id)` exactly
> once. The success result contains only `configured`, `enrolledAt`,
> `sampleCount`, and `cleanupStatus`. The failure result is a
> stable, safe enum (`UNAUTHENTICATED`, `PROFILE_INCOMPLETE`,
> `ENROLLMENT_SESSION_NOT_FOUND`, `ENROLLMENT_SESSION_EXPIRED`,
> `ENROLLMENT_INCOMPLETE`, `INCONSISTENT_FACE_SAMPLES`,
> `MODEL_MISMATCH`, `ENROLLMENT_SAMPLE_DECRYPTION_FAILED`,
> `ENROLLMENT_SAMPLE_VECTOR_INVALID`,
> `ENROLLMENT_GENERATION_CHANGED`,
> `ENROLLMENT_FINALIZATION_ALREADY_CLAIMED`,
> `ENROLLMENT_FINALIZATION_IN_PROGRESS`,
> `FACE_PROFILE_ALREADY_EXISTS`, `FACE_SERVICE_TIMEOUT`,
> `FACE_SERVICE_UNAVAILABLE`, `FACE_SERVICE_UNAUTHORIZED`,
> `FACE_SERVICE_INVALID_RESPONSE`,
> `BIOMETRIC_ENCRYPTION_UNAVAILABLE`,
> `ENROLLMENT_COMPLETION_FAILED`) — each carries a restrained
> human-readable message and a `retryable` hint. No `userId`,
> `generationId`, `claimToken`, `centroid`, ciphertext, IV,
> authTag, keyVersion, or model metadata is ever serialized into
> the response. The action does NOT add a public
> `/api/face-id/enrollment/finalize` route. The action does NOT add
> a Finish setup button — UI consumption belongs to PHASE 4.6B3B.

> PHASE 4.6B3B introduces the user-visible "Finish setup" button.
> The button is the ONLY browser-side trigger for the B3A Server
> Action. The button does NOT receive `userId`, `generationId`,
> `claimToken`, `centroid`, sample data, or model metadata. The
> Server Action is invoked with ZERO arguments. The button does
> NOT write to `localStorage`, `sessionStorage`, `IndexedDB`, or
> the `Cache` API. The button does NOT issue `fetch()` to the
> Face Service. The button does NOT restart the camera, request
> `getUserMedia`, or capture another image. The button does NOT
> auto-retry. The rendered DOM does NOT contain `centroid`,
> `generationId`, `sourceEnrollmentGenerationId`, `claimToken`,
> `ciphertext`, `authTag`, `keyVersion`, or any model identifier.
> On success the user is navigated to `/face-id` via
> `router.replace(...)`; the URL never receives biometric values.
> A synchronous `finishInFlightRef` guarantees two rapid clicks
> collapse into exactly ONE Server Action invocation. Retryable
> errors keep the user on the 5/5 setup state and allow another
> explicit click; non-retryable errors render the safe B3A
> message without auto-restart. Expired / generation-changed /
> not-found / incomplete states trigger a single, safe
> `router.refresh()` to reconcile the server-rendered setup
> shell without re-invoking the action. PHASE 4.6B3B does NOT
> introduce re-enrollment, delete-Face-ID, or any other
> next-step UI.

## Biometric handling principles

1. **Store embeddings, not images.** The web database stores normalized
   numeric vectors returned by the Face Service. Raw camera frames are
   decoded, processed, and discarded in the same request lifecycle.
2. **No permanent image retention.** The Face Service decodes uploads
   in memory and never writes them to disk. Benchmark tools print
   metrics only; they do not save annotated images.
3. **No logging of biometric data.** Server logs must never include
   embeddings, raw image bytes, or base64 image data. Safe log fields:
   `route`, `method`, `status`, `duration_ms`, `face_count`, `engine`,
   `provider`.
4. **No embedding exposure to the browser.** `POST /v1/faces/analyze`
   never returns embeddings. `POST /v1/faces/compare` returns similarity
   + threshold + match flag only — never embeddings.
5. **Owner-only modification.** A user may only modify their own
   `faceProfile`. Teacher endpoints cannot write student embeddings.
6. **Face recognition ≠ liveness detection.** PHASE 3 explicitly does not
   protect against photo spoof, screen replay, or printed face attacks.
   Anti-spoof / liveness detection will arrive in a dedicated later phase
   (Phase 9).
7. **Biometric encryption.** From PHASE 4.1, face embeddings are
   encrypted with AES-256-GCM before storage. The encryption key is
   independent from authentication secrets.

## Phase 5.1A.1 class password storage

PHASE 5.1A.1 hardens the class join password primitive ahead of the future
class create / join Server Actions. Design decisions:

- **One-way hashing only.** Class passwords are hashed with **PBKDF2-SHA256**
  via the asynchronous `node:crypto.pbkdf2` (wrapped with `util.promisify`).
  The raw password is never stored.
- **Asynchronous request-path API.** `hashClassPassword(password)` and
  `verifyClassPassword(password, encodedHash)` both `await` PBKDF2 work so
  the request-path event loop is never blocked. No `pbkdf2Sync`,
  `scryptSync`, or busy-loop is used anywhere in the runtime.
- **Random salt per hash.** Every `hashClassPassword()` call generates a fresh
  32-byte random salt via `crypto.randomBytes()`, defeating rainbow tables.
  Two identical passwords therefore produce different encoded hashes.
- **Iteration count.** `CLASS_PASSWORD_PBKDF2_ITERATIONS = 100_000` PBKDF2
  iterations provide defense against brute-force on leaked hashes. The
  value lives in a single centralized constant and is **encoded into every
  produced hash**, so the work factor can be evolved later without breaking
  verification of older hashes.
- **Self-describing versioned hash format.** Encoded values have the shape
  `pbkdf2-sha256$<iterations>$<saltHex>$<derivedKeyHex>`. The encoded value
  carries the algorithm identifier, iteration count, salt, and derived
  key. The string does **not** carry `userId`, `classId`, `classCode`, or
  any other identity-bearing field.
- **Constant-time verification.** `verifyClassPassword()` compares the
  re-derived key bytes to the stored key bytes using
  `crypto.timingSafeEqual`, with explicit pre-flight length validation so
  the function never crashes on a malformed stored value and never leaks
  a `===` short-circuit to a timing attacker.
- **Strict parsing.** The encoded hash parser is total and never throws.
  Wrong field count, unknown algorithm, non-numeric or non-positive
  iteration count, invalid hex, wrong salt length, and wrong derived key
  length each map to a controlled `false` from verification (or to a
  service-layer domain error when the future Server Action surfaces the
  failure).
- **No recovery.** There is no "show current password" flow. A teacher who
  forgets the password must use a reset-password workflow (not in scope for
  PHASE 5.1A).
- **Never logged.** Plaintext class passwords (when accepted by the service)
  are discarded immediately after hashing. They never appear in server logs,
  MongoDB documents, or browser DTOs. The hashing module itself contains
  no `console.log` / `logger.*` / `debug(` calls.
- **No `Math.random()`.** Class codes and password salt are generated using
  `node:crypto.randomBytes()`. `Math.random()` is never used.

## Phase 5.1B create-class Server Action privacy posture

PHASE 5.1B ships the first browser-reachable entry point on top of
the PHASE 5.1A class persistence foundation:
`createClassAction(input)` in
`apps/web/src/lib/classes/create-class-action.ts`. It is a
`"use server"` Server Action. The privacy / security posture is:

- **Identity from the Better Auth session only.** The action derives
  `teacherUserId` from `session.user.id` via `getSession()`. The
  browser never supplies `teacherUserId`, `userId`, `role`,
  `classCode`, `passwordHash`, or `status`. The action's Zod input
  schema is `.strict()` — any extra key is rejected before the
  service layer is reached.
- **Profile gating.** The application `Profile` is loaded via the
  existing `getProfileByUserId` and must satisfy both
  `onboardingCompleted === true` and `role === "teacher"`. Missing
  profile → `PROFILE_INCOMPLETE`; student role →
  `TEACHER_REQUIRED`. The Profile is read for gating only — it is
  NEVER mutated by the action.
- **Server-generated `classCode`.** `classCode` is generated inside
  the action via the existing `generateClassCode()` primitive
  (canonical 7-char, crypto-random, no `Math.random`). The browser
  cannot supply or override `classCode`.
- **Bounded retry on `classCode` collisions only.** The action
  performs at most `MAX_CLASS_CODE_ATTEMPTS` insert attempts.
  Retries are allowed ONLY when the service throws
  `ClassServiceError(CLASS_CODE_ALREADY_EXISTS)`, which the
  service produces ONLY when the precise
  `isClassCodeDuplicateKeyError(err)` predicate confirms the
  MongoDB `code === 11000` collided key is `classCode` (via
  `keyValue.classCode`). Unrelated 11000 errors and any other
  failure stop the loop immediately. There is no read-before-insert
  uniqueness check; the unique index closes the race. Exhausting
  the retry budget surfaces `CLASS_CODE_GENERATION_FAILED`.
- **Password hashing reused, never re-implemented.** The action
  reuses the PHASE 5.1A.1 `hashClassPassword(...)` primitive
  (PBKDF2-SHA256, async, 100k iterations, versioned encoded hash).
  The plaintext password:
  - enters the action exactly once (only because the teacher chose
    it),
  - is NEVER trimmed, lowercased, or otherwise transformed — the
    exact bytes the teacher submitted are passed to the hash
    primitive,
  - is NEVER logged, NEVER returned, NEVER stored as plaintext,
    NEVER included in error messages or in doc examples as a real
    credential,
  - is discarded immediately after
    `await hashClassPassword(...)` returns. Only `passwordHash` is
    persisted.
- **PasswordHash is never serialized.** The success result
  `{ ok: true, class: { id, name, classCode, status, createdAt } }`
  intentionally omits `passwordHash`. The error union
  (`UNAUTHENTICATED`, `PROFILE_INCOMPLETE`, `TEACHER_REQUIRED`,
  `INVALID_CLASS_NAME`, `INVALID_CLASS_PASSWORD`,
  `CLASS_CODE_GENERATION_FAILED`, `CLASS_CREATION_FAILED`) and
  their messages are browser-safe copy that never references the
  password, hash, Mongo URI, driver stack, or `E11000` text.
- **`teacherUserId` is not returned.** The caller already represents
  the authenticated teacher; the response does not echo
  `teacherUserId` back to the browser.
- **Service boundary.** The action calls the existing
  `createClass(...)` service function — it never touches the
  Mongoose model directly. PHASE 5.1B adds one precise classifier
  helper (`isClassCodeDuplicateKeyError`) to the service so the
  action can distinguish a precise `classCode` collision from any
  unrelated duplicate-key error.
- **No automatic browser-side retry.** The action does NOT
  internally retry on auth failure, validation failure, generic
  DB error, or password hashing error — only on an exact
  `classCode` unique-index collision. The action performs NO
  router-level side effects (`router.refresh`, `redirect`,
  `revalidatePath`).
- **Scope.** The action does NOT create `ClassMembership`,
  attendance sessions, `FaceProfile`, or any other domain record.
  It does NOT call the Face Service. It does NOT introduce a
  `/api/classes` route or any create-class UI.
- **No rate limit yet.** PHASE 5.1B does not introduce a new
  rate-limit primitive or dependency.

## Phase 5.1E3 student join-class UI privacy posture

PHASE 5.1E3 ships the **student-only "Join class" UI** that calls
the existing `createJoinClassAction({ classCode, password })`
PHASE 5.1C Server Action from a focused client form, behind a
new server-gated `/classes/join` route. The privacy / security
posture is:

- **Identity-free form.** The `JoinClassForm` Client Component
  accepts NO identity props. It never receives `studentUserId`,
  `userId`, `role`, `classId`, `teacherUserId`, `membershipId`,
  or `passwordHash`. Identity derives exclusively from the
  Better Auth session inside the Server Action.
- **Minimal browser-supplied payload.** The form sends ONLY
  `{ classCode, password }` to `createJoinClassAction`. The
  action's `.strict()` Zod schema strips any extra keys; the
  browser cannot smuggle identity or membership data through
  the action signature.
- **Server-side student guard.** `/classes/join` is a Server
  Component that requires (a) a Better Auth session, (b) a
  completed `Profile`, and (c) `role === "student"`. An
  authenticated teacher visiting `/classes/join` is redirected
  to `/classes`. The Server Action repeats the same gate
  server-side as a defense-in-depth boundary — a stale cached
  client tree cannot bypass it.
- **Critical enumeration protection preserved.** The UI maps
  ALL four `INVALID_CLASS_CREDENTIALS` branches (missing class
  / wrong password / archived class / malformed stored hash) to
  ONE generic user-facing message: "Class code or password is
  incorrect, or the class is unavailable." The UI MUST NOT
  display separate messages for each branch — that would
  undermine the backend's timing-attack mitigation and allow
  attackers to enumerate live class codes.
- **No class-existence lookup.** The form performs NO
  `checkClassCodeExists(...)` call, NO `/api/classes/check`
  request, NO blur-time validation against the database. The
  only network call from the form is the single Server Action
  invocation.
- **Double-submit protection.** A synchronous `submitInFlightRef`
  is inspected and set BEFORE the first `await` inside
  `handleSubmit`. Two rapid clicks collapse into exactly ONE
  Server Action invocation. On a safe failure the guard is
  released so the user may retry explicitly. On success the
  form is replaced by the success state — no automatic retry.
- **Password privacy.** The `password` field uses
  `type="password"` and `autoComplete="current-password"`. The
  password lives only in a React local state variable for the
  lifetime of the form. After a successful submission the
  password state is cleared via `setPassword("")` immediately.
  The component never writes `localStorage`, `sessionStorage`,
  IndexedDB, or the Cache API; never places the password in a
  URL; never calls `console.log` / `console.error` with the
  password or `passwordHash`; never echoes the password in the
  success state (the form is hidden and only the server-returned
  `classCode` is rendered).
- **No `passwordHash` in DOM.** The success state renders only
  safe fields returned by the action: `classCode`, and the
  `alreadyJoined` boolean (which toggles between "Joined class"
  and "Already joined"). `passwordHash`, `studentUserId`,
  `teacherUserId`, `membershipId`, and any internal Mongoose
  identifiers are NEVER serialized into the rendered tree.
- **Safe error mapping.** `CLASS_JOIN_FAILED` (generic DB
  failure) renders a single generic "Please try again in a
  moment" message — never Mongo error codes, stack traces,
  connection strings, or collection names. Input-format errors
  (`INVALID_CLASS_CODE`, `INVALID_CLASS_PASSWORD`) map to
  specific but still generic validation copy.
- **No Face Service / FaceProfile / attendance touch.** The
  join flow does NOT call the Face Service, does NOT inspect
  `FaceProfile`, does NOT require Face ID, does NOT create or
  read attendance sessions.
- **No public join API.** There is intentionally NO
  `POST /api/classes/join` HTTP route. The Server Action is
  the ONLY entry point.

## Phase 5.1C join-class Server Action privacy posture

PHASE 5.1C ships the student-side counterpart to PHASE 5.1B:
`createJoinClassAction(input)` in
`apps/web/src/lib/classes/join-class-action.ts`. It is a
`"use server"` Server Action. The privacy / security posture is:

- **Identity from the Better Auth session only.** The action
  derives `studentUserId` from `session.user.id` via
  `getSession()`. The browser never supplies `studentUserId`,
  `userId`, `role`, `classId`, `passwordHash`, `status`, or
  `joinedAt`. The action's Zod input schema is `.strict()` and
  strips any extra keys via `flatten().fieldErrors`.
- **Profile gating.** The action calls the existing
  `getProfileByUserId(studentUserId)` and requires
  `onboardingCompleted === true` AND `role === "student"`.
  Missing profile / incomplete onboarding → `PROFILE_INCOMPLETE`
  (non-retryable). Wrong role → `STUDENT_REQUIRED` (non-
  retryable). The profile document is NEVER mutated.
- **Canonical classCode.** The browser-supplied classCode is
  canonicalized to uppercase via `z.preprocess` and validated
  against the canonical alphabet `[A-HJ-NP-Z2-9]` (excludes `I`,
  `O`, `0`, `1`). The lookup re-applies
  `normalizeClassCode(code)` so case / whitespace variations are
  handled correctly even when the schema bypassed them.
- **Password is never trimmed.** The browser-supplied password
  reaches `verifyClassPassword(password, storedHash)` byte-for-
  byte. There is no `String#trim`, no lowercase, no whitespace
  removal, no `Number()`, no `parseInt()`. The student's exact
  bytes are hashed. Whitespace, casing, and any other byte are
  preserved exactly.
- **`passwordHash` is exposed only to server-side join
  orchestration.** A new server-only primitive
  `getClassJoinCredentialByCode(code)` returns a
  `ClassJoinCredential` shape that includes `passwordHash` for
  the action's use. The primitive is INTENTIONALLY NOT re-
  exported through the public `apps/web/src/lib/classes/
  index.ts` barrel so a hand-crafted client (or a future careless
  consumer) cannot smuggle `passwordHash` into a browser-facing
  payload. `SafeClassDto` continues to omit `passwordHash`.
- **Fixed `DUMMY_CLASS_PASSWORD_HASH` constant.** A single,
  syntactically-valid encoded PBKDF2 hash (`pbkdf2-sha256$
  100000$<32-byte salt hex>$<32-byte derived key hex>`) lives
  in `apps/web/src/lib/classes/class-service.ts` as a single
  string literal. It is NEVER generated at module load via
  `hashClassPassword()`, `pbkdf2`, `randomBytes`, top-level
  `await`, or any other runtime primitive. Module evaluation is
  therefore synchronous and side-effect-free.
- **Canonical timing path.** The action runs ONE async PBKDF2
  verification workload on every branch that would otherwise
  short-circuit:
    - missing class → `await runDummyPasswordVerification(password)`
    - archived class → `await runDummyPasswordVerification(password)`
    - malformed stored hash → `await runDummyPasswordVerification(password)`
    - wrong password → `await verifyClassPassword(password, storedHash)`
  All four branches return the SAME safe code
  `INVALID_CLASS_CREDENTIALS`. An attacker observing latency
  cannot differentiate "wrong password" from "missing class" /
  "archived class" / "malformed hash" by less than the cost of
  one async PBKDF2 workload. Wall-clock timing tests are
  explicitly NOT used — the test contract asserts BEHAVIOR
  (which primitive is invoked on each branch), not latency.
- **Precise `isMembershipDuplicateKeyError` classifier.** The
  classifier accepts a Mongo `code === 11000` collision ONLY
  when `keyValue` (or `keyPattern`) identifies the compound
  `(classId, studentUserId)` uniqueness. Unrelated 11000
  collisions (a future `idempotencyKey` index, etc.) map to
  `CLASS_JOIN_FAILED` and the insert is NEVER retried.
- **Duplicate membership is an idempotent success
  (PHASE 5.1C.1).** When `createMembership` collides on the
  compound `(classId, studentUserId)` index, the action
  fetches the ALREADY-PERSISTED membership via the new
  server-only `getSafeMembership(classId, studentUserId)`
  primitive in `class-membership-service.ts` and surfaces
  `ok: true, alreadyJoined: true` with the existing
  `SafeMembershipDto` projected. The action does NOT
  internally retry the insert and does NOT surface an
  `ALREADY_JOINED` error code. Password verification and
  the canonical credential-state branches run FIRST — the
  idempotency classification fires ONLY after the supplied
  password has been verified against the stored hash.
  An existing membership MUST NOT allow bypassing the class
  password.
- **No `Class` write, no `Profile` mutation, no `FaceProfile`
  touch, no Face Service call, no attendance session, no
  `/api/classes/join` route, no join UI, no new rate-limit
  dependency, no Better Auth configuration change.** Better
  Auth collections remain untouched.
- **Safe result projection.** The success result is the
  browser-safe `SafeMembershipDto` projection
  `{ id, classId, classCode, joinedAt, status: "active",
  alreadyJoined: boolean }`. It NEVER includes `password`,
  `passwordHash`, `studentUserId`, `teacherUserId`, raw
  Mongoose fields, raw stack traces, Mongo error messages, or
  the raw `classId` ObjectId. The `alreadyJoined` flag is
  `false` on a fresh insert and `true` when the action
  detected an existing membership via the compound unique
  index and surfaced an idempotent success
  (PHASE 5.1C.1).
- **No logging.** Plaintext passwords, `passwordHash`, MongoDB
  internals, raw stack traces, `studentUserId`, and
  `teacherUserId` are NEVER logged. The action module contains
  no `console.log` / `logger.*` / `debug(` calls. The test
  suite asserts no password appears in any console output.

## Phase 5.1D1 class-list read model privacy posture

PHASE 5.1D1 ships the server-only authenticated class-list
read boundary as a plain `async` function
(`getVisibleClassesForCurrentUser()` in
`apps/web/src/lib/classes/class-read-service.ts`). It is NOT a
Server Action, NOT a REST route, and NOT a UI surface. The
privacy / security posture is:

- **Identity from the Better Auth session only.** The function
  derives `userId` from `session.user.id` via `getSession()`.
  The function accepts NO `userId` argument — a hand-crafted
  caller cannot select another user. The function performs NO
  class query on the unauthenticated branch.
- **Profile gating.** The function calls the existing
  `getProfileByUserId(userId)` and requires
  `onboardingCompleted === true`. Missing profile / incomplete
  onboarding → `PROFILE_INCOMPLETE` (the function performs NO
  class query on this branch). The role derives EXCLUSIVELY from
  the persisted `Profile.role`; the browser cannot choose the
  viewer role.
- **Teacher visibility** is `Class.teacherUserId === session.user.id`.
  The query uses the existing `teacherUserId` index on the
  `classes` collection. A teacher does NOT see classes owned by
  another teacher.
- **Student visibility** is
  `ClassMembership.studentUserId === session.user.id` AND
  `status === "active"`. The query asks for `status: "active"`
  explicitly so a future status expansion (e.g. `removed`) cannot
  silently grant visibility from a non-active membership. A
  student does NOT see another student's classes.
- **No `Class` scan + application-memory filter.** The student
  read path uses TWO queries — one membership query + ONE
  batched `ClassModel.find({ _id: { $in: [...] } })` lookup.
  There is no obvious N+1 one-query-per-class loop, and the
  implementation does NOT fetch the entire `classes` collection
  and filter in application memory.
- **Missing referenced class ids are skipped safely.** A
  membership referencing a non-existent class document does NOT
  crash the read; the summary is simply omitted from the
  result. No Mongo internals are leaked on this path.
- **Duplicate class ids are deduplicated.** A corrupt legacy
  dataset that contains duplicate `classId`s across membership
  rows for the same student cannot produce duplicate class
  summaries in the result.
- **Safe DTO.** The result contains ONLY
  `{ id, name, classCode, status, createdAt }` per class. It
  NEVER includes `password`, `passwordHash`, `teacherUserId`,
  `studentUserId`, membership internal ids, Mongoose internals
  (`__v`), biometric fields, raw timestamps, or credential
  helpers.
- **Read-only.** The module NEVER creates / updates / deletes a
  `Class`, a `ClassMembership`, or a `Profile`. It NEVER calls
  the Face Service. It NEVER reads or writes a `FaceProfile`. It
  NEVER reads `passwordHash`. It NEVER calls
  `verifyClassPassword`, `runDummyPasswordVerification`,
  `hashClassPassword`, or `getClassJoinCredentialByCode`. It
  NEVER touches attendance data.
- **Safe error mapping.** Unexpected DB / read failures map to
  `CLASS_READ_FAILED`. Mongo URI, raw query text, collection
  names, and raw stack traces are NEVER serialized. There is no
  internal `passwordHash` or `studentUserId` exposure on the
  error path.
- **No logging.** Plaintext passwords, `passwordHash`, biometric
  fields, Mongo error messages, and `studentUserId` are NEVER
  logged. The module contains no `console.log` / `logger.*` /
  `debug(` calls.

## Phase 5.1D2A class-detail read model privacy posture

PHASE 5.1D2A ships the server-only authenticated class-detail
read boundary as a plain `async` function
(`getClassDetailForCurrentUser(classId)` in
`apps/web/src/lib/classes/class-read-service.ts`). It is NOT a
Server Action, NOT a REST route, NOT a UI surface, and NOT a
roster. The privacy / security posture is:

- **Identity from the Better Auth session only.** The function
  derives `userId` from `session.user.id` via `getSession()`.
  The function accepts ONLY `classId` (the resource
  identifier) — `userId`, `teacherUserId`, `studentUserId`,
  `role`, and `membershipId` are NEVER accepted from the
  caller. A hand-crafted caller cannot impersonate another
  viewer. The function performs NO class / membership query
  on the unauthenticated branch.
- **Profile gating.** The function calls the existing
  `getProfileByUserId(userId)` and requires
  `onboardingCompleted === true`. Missing profile / incomplete
  onboarding → `PROFILE_INCOMPLETE` (the function performs NO
  class / membership query on this branch). The role derives
  EXCLUSIVELY from the persisted `Profile.role`; the browser
  cannot choose the viewer branch.
- **Teacher authorization** uses
  `ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })`.
  The authorization constraint is encoded DIRECTLY in the
  filter — the database itself refuses to surface a class the
  teacher does not own. The implementation does NOT fetch an
  arbitrary class and compare the owner client-side. There is
  intentionally NO separate `NOT_CLASS_OWNER` outward-facing
  code; the result is the generic `CLASS_NOT_ACCESSIBLE`.
- **Student authorization** uses
  `ClassMembershipModel.findOne({ classId, studentUserId: session.user.id, status: "active" })`
  as the EXCLUSIVE membership gate. Inactive memberships,
  non-existent memberships, and another student's
  memberships all collapse to the same safe
  `CLASS_NOT_ACCESSIBLE` boundary. The class is loaded via
  `ClassModel.findById(classId)` ONLY after the membership
  has been proven. The implementation does NOT fetch every
  membership and does NOT fetch every class.
- **`classId` syntax validation.** A malformed `classId` (not
  a canonical 24-hex string) collapses to the SAME
  `CLASS_NOT_ACCESSIBLE` boundary used for missing /
  unauthorized classes. There is intentionally NO separate
  `INVALID_CLASS_ID` code; the browser cannot enumerate valid
  vs. invalid ids via the error path. Malformed ids NEVER
  reach the database — no `CastError`, no raw Mongoose
  exception, no stack trace leak.
- **Failure indistinguishability.** Malformed id, missing
  class, unauthorized teacher, student no-membership, and
  student inactive-membership ALL map to the same browser-
  safe `CLASS_NOT_ACCESSIBLE` code. An attacker observing
  the error code cannot differentiate "malformed syntax" from
  "missing class" from "not yours" from "no membership".
- **Archived class behavior.** Archived does NOT automatically
  mean inaccessible. Owner teachers and active-member
  students may still read archived class detail; the result
  exposes `status: "archived"` safely. A non-member cannot
  infer archived-class existence (the failure collapses to
  `CLASS_NOT_ACCESSIBLE`).
- **Safe detail DTO.** The result contains ONLY
  `{ id, name, classCode, status, createdAt, updatedAt, role }`.
  It NEVER includes `password`, `passwordHash`,
  `teacherUserId`, `studentUserId`, `membershipId`,
  `identificationCode`, Mongoose internals (`__v`), biometric
  fields, raw timestamps, student profiles, member rosters,
  student counts, or credential helpers.
- **No roster.** The safe detail NEVER contains `students`,
  `members`, student emails, student `identificationCode`,
  or any `Profile` payload. Roster belongs to PHASE 5.1D2B.
  The detail read does NOT issue a roster-shaped query
  (no `listMembershipsByClassId` call).
- **Read-only.** The module NEVER creates / updates / deletes
  a `Class`, a `ClassMembership`, or a `Profile`. It NEVER
  calls the Face Service. It NEVER reads or writes a
  `FaceProfile`. It NEVER reads `passwordHash`. It NEVER
  calls `verifyClassPassword`, `runDummyPasswordVerification`,
  `hashClassPassword`, or `getClassJoinCredentialByCode`. It
  NEVER touches attendance data. The detail read requires NO
  class password — existing membership / ownership grants
  read authorization. The detail read has NO biometric
  requirement — no `FaceProfile`, no Face ID enrollment, no
  camera, no Face Service call.
- **Safe error mapping.** Unexpected DB / read failures map
  to `CLASS_READ_FAILED`. Mongo URI, raw query text,
  collection names, raw stack traces, and `CastError` are
  NEVER serialized. The error message never identifies which
  kind of inaccessibility failed.
- **No logging.** Plaintext passwords, `passwordHash`,
  biometric fields, Mongo error messages, `studentUserId`,
  `teacherUserId`, and `membershipId` are NEVER logged. The
  module contains no `console.log` / `logger.*` / `debug(`
  calls.
- **No public API.** No REST route, no Server Action, no UI
  component was added in D2A. The function is consumed
  exclusively by future Server Components / Server Actions
  / Route Handlers (none of which exist in this phase).

## Phase 2 identity vs business data

Better Auth owns the `user`, `session`, `account`, `verification`
collections. The application owns the `profiles` collection. The
application **must not** write to Better Auth's collections directly.
Better Auth continues to use its official MongoDB adapter; the
application uses Mongoose via a separate cached `mongoose.connect()`
connection against the same `face_attendance` database.

The `Profile.userId` field references the Better Auth `user._id`
conceptually (as a string). The application does not enforce a
cross-collection foreign key at the database level because Better Auth
owns its own user collection.

## Phase 2 profile authorization rules

| Action | Required |
| --- | --- |
| View another user's profile by id | **Not allowed.** No public profile lookup endpoint exists. |
| Update `profile.fullName`, `profile.identificationCode`, `profile.phone` | Authenticated AND `profile.userId = session.user.id` |
| Change `profile.role` via profile-edit | **Not allowed.** Role mutation must go through a dedicated controlled flow that does not exist yet. |
| Submit onboarding | Authenticated. Idempotent — repeated submissions do not create duplicate documents. |
| Update `profile.userId` / `profile.emailSnapshot` from a client | **Not allowed.** These fields are derived from the Better Auth session server-side. |

## Phase 2 role model limitations

- `student` self-selection is allowed.
- `teacher` self-selection is allowed for the MVP. **This is a known
  security limitation.** A future production deployment must add a
  teacher-invite flow, an administrator approval flow, or a verification
  step. Phase 2 documents this gap but does not implement the
  verification flow.

## Phase 2 stored profile fields (privacy posture)

The application stores only what Phase 2 actually needs:

- `fullName`
- `identificationCode` (treated as a generic business identifier)
- `phone` (optional)
- `role`
- `emailSnapshot` (captured from Better Auth session, never from request
  body)
- `onboardingCompleted` (boolean flag)
- `userId` (Better Auth user ID — not user-modifiable)
- `createdAt` / `updatedAt` (Mongoose timestamps)

The application does **not** store:

- home address
- date of birth
- government ID
- gender
- sensitive demographic information
- raw face photos, embeddings, or any biometric data

## Phase 4+ biometric encryption

**Face embeddings will use application-level AES-256-GCM encryption before
persistent storage.** This is implemented in PHASE 4.1 as a dedicated
encryption foundation module.

### Dedicated encryption key

Biometric data is protected with a dedicated key:

- `BIOMETRIC_ENCRYPTION_KEY` — independent from authentication and
  service secrets
- Must be exactly 32 random bytes, base64-encoded
- Generate locally with: `openssl rand -base64 32`
- Do NOT reuse `BETTER_AUTH_SECRET`, `FACE_SERVICE_SECRET`,
  `GOOGLE_CLIENT_SECRET`, or any other secret

### Encryption details

| Property | Value |
| --- | --- |
| Algorithm | AES-256-GCM |
| Key size | 256 bits (32 bytes) |
| Key encoding | base64 |
| IV | Fresh random per encryption (96 bits / 12 bytes) |
| Auth tag | 128 bits / 16 bytes (GCM built-in) |
| AAD | Context binding (userId, modelIdentity, templateVersion, vectorType) |
| Key version | `1` (for future rotation support) |

### Authenticated encryption

- AES-256-GCM provides authenticated encryption (AEAD)
- Every encryption operation generates a fresh IV
- IV is never derived from userId or any other predictable value
- Authenticated Associated Data (AAD) binds ciphertext to a specific
  context (user, model, template version)
- Decryption requires the same AAD — tampering causes authentication
  failure

### Key rotation readiness

- `keyVersion: 1` is included in all encrypted output
- The module infrastructure supports future key rotation
- Actual key rotation is not implemented in PHASE 4.1

### Vector serialization

- Face embeddings are serialized as float32 binary before encryption
- Float32 precision is sufficient for normalized ArcFace embeddings
- Binary format is deterministic and compact
- No JSON serialization for biometric vectors

### Template version vs key version

The biometric database uses two distinct version fields that must not
be confused:

- `templateVersion` — biometric template structure / format version.
  Lives on `FaceProfile` and `FaceEnrollmentSession`. A future change to
  the embedded schema (e.g. new quality fields, new sample ordering)
  increments this value.
- `keyVersion` (inside `EncryptedBiometricValue`) — encryption key
  generation. Lives on every encrypted value. A future key rotation
  increments this value. Currently always `1`.

The two are independent: rotating the encryption key does not require
a template migration, and bumping the template version does not require
re-encrypting old ciphertexts (old documents remain readable with the
old key).

## Phase 4.2 biometric database schema

PHASE 4.2 introduces two Mongoose collections. Both store ONLY
encrypted biometric vectors (`ciphertext`, `iv`, `authTag`, `keyVersion`)
plus aggregated, non-identifying quality metadata.

### `face_profiles`

Permanent active biometric enrollment. **Unique per Better Auth user**
via a unique index on `userId`.

Stored fields (PHASE 4.2 — persistence foundation only):

- `userId`, `status` (`"active"`), `modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization` (`"l2"`), `templateVersion`,
  `requiredSampleCount`, `sampleCount`
- `samples[]`: each entry carries an encrypted vector (`encryptedVector`),
  `sampleIndex`, and an optional quality block (`detectionScore`,
  `blurScore`, `brightness`, `relativeFaceArea`)
- `centroid`: a single encrypted reference vector
- `qualitySummary`: aggregated, non-biometric metrics
  (`meanDetectionScore`, `meanBlurScore`, `meanBrightness`,
  `minSelfSimilarity`, `meanSelfSimilarity`)
- `enrolledAt`, `createdAt`, `updatedAt`

The schema does NOT include any field for plaintext embeddings, raw
images, base64 frames, face crops, landmarks, bounding boxes, image
hashes, or camera frames.

### `face_enrollment_sessions`

Temporary per-user state used while a user is enrolling. **Unique per
Better Auth user** via a unique index on `userId`. A TTL index on
`expiresAt` (with `expireAfterSeconds: 0`) instructs MongoDB to delete
the document once `expiresAt` is in the past.

Stored fields (PHASE 4.2 — persistence foundation only, plus
PHASE 4.5B4.3 `generationId`):

- `userId`, `mode` (`"create"` or `"replace"`), `templateVersion`,
  `requiredSampleCount`
- Optional model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`) — these fields are absent until
  the first sample is processed in a future phase
- `acceptedSamples[]`: each entry carries an encrypted vector
  (`encryptedVector`), `sampleIndex`, an optional quality block, and
  `acceptedAt`
- `expiresAt`, `createdAt`, `updatedAt`
- `generationId` (PHASE 4.5B4.3) — a UUID v4 minted by the server at
  create-or-reset time. Required, non-unique. Used as the
  reconciliation discriminator for multi-tab and reload resilience.
  For legacy documents created before PHASE 4.5B4.3 the field is
  backfilled lazily, atomically, and exactly once on the first
  read of the document (see "Legacy session migration" below).

**TTL deletion is asynchronous.** Service code must call
`isEnrollmentSessionExpired(session)` to detect expiration; relying
solely on physical deletion would create race conditions.

The schema does NOT include any field for plaintext embeddings, raw
images, base64 frames, face crops, or camera frames.

### Service layer

PHASE 4.2 ships two server-only service modules:

- `apps/web/src/lib/biometrics/face-profile-service.ts`
  — `getFaceProfileByUserId`, `hasFaceProfile`, `saveFaceProfile`
  (upsert keyed on `userId`), `deleteFaceProfileByUserId`.
- `apps/web/src/lib/biometrics/enrollment-session-service.ts`
  — `getEnrollmentSessionByUserId`,
  `createOrResetEnrollmentSession` (upsert keyed on `userId`, clears
  `acceptedSamples`, refreshes `expiresAt`, resets model metadata to
  `undefined`, mints a fresh `generationId`), and PHASE 4.5B4.3
  performs an atomic lazy server-side backfill of `generationId`
  for legacy sessions,
  `deleteEnrollmentSessionByUserId`,
  `isEnrollmentSessionExpired`.

Both services map MongoDB duplicate-key errors to safe
`BiometricPersistenceError` instances; raw driver errors never escape
the service layer.

### What is NOT yet implemented

PHASE 4.2 deliberately does NOT implement:

- Camera access (`getUserMedia`) or Face ID UI
- Next.js API routes or Server Actions
- Face Service enrollment endpoints
- InsightFace changes
- Embedding extraction
- Quality gate
- Sample upload
- Enrollment finalization
- Centroid calculation
- Re-enrollment UI
- Face ID deletion UI

Those belong to PHASE 4.3+ and are out of scope for this database-only
mini-phase.

## Phase 4.3 enrollment sample endpoint

PHASE 4.3 ships **one** new Face Service operation:
`POST /v1/faces/enrollment/sample`. The endpoint is the first piece of
the PHASE 4 enrollment pipeline on the server side — a thin wrapper
around the PHASE 3 detection + embedding primitives plus a new quality
gate.

### Server-to-server only

The endpoint requires the shared `X-Service-Token` (same mechanism as
every other `/v1/*` route). It is **internal infrastructure**: only the
trusted Next.js server (`apps/web`) may call it. The browser must
**never** call this endpoint directly. The Face Service does **not**
configure CORS for arbitrary browser origins.

The endpoint is the only place in the Face Service where an embedding
leaves the process. It is allowed to do so ONLY because the documented
caller is the Next.js server, which then encrypts the vector with
AES-256-GCM (PHASE 4.1) before any persistent storage.

### Exactly one face required

The endpoint requires exactly one detected face. Behaviour:

- 0 faces → `422 NO_FACE` (standard PHASE 3 error envelope).
- 2+ faces → `422 MULTIPLE_FACES` (standard PHASE 3 error envelope).

The endpoint never silently picks a single face out of many — it does
not choose the largest or the highest-confidence face. The user must
retake the photo so that exactly one face is in frame.

### Quality gate

The endpoint applies a quality policy on top of the PHASE 3 metrics:

- `detection_score`
- `face_width` / `face_height` (pixels)
- `relative_face_area` (face area / image area)
- `blur_score` (variance of Laplacian — resolution-dependent)
- `brightness` (normalised mean luminance — exposure only)
- `near_edge`

A single sample may be rejected for **one or more** reasons; the
endpoint returns the full list with deterministic ordering. Stable
codes:

| Code | Meaning |
| --- | --- |
| `LOW_DETECTION_CONFIDENCE` | `detection_score` below threshold. |
| `FACE_TOO_SMALL` | `relative_face_area` below threshold. |
| `FACE_TOO_LARGE` | `relative_face_area` above threshold. |
| `TOO_BLURRY` | `blur_score` below threshold. |
| `TOO_DARK` | normalised brightness below threshold. |
| `TOO_BRIGHT` | normalised brightness above threshold. |
| `FACE_NEAR_EDGE` | bbox touches the image border. |

When the gate fails the endpoint still returns `200 OK` with
`accepted=false` and the rejection list — this is a domain outcome, not
an infrastructure error. **The embedding is omitted** on rejection.

#### Scale strategy

The policy uses `relative_face_area` for too-small / too-large
decisions because raw pixel size depends on resolution. The same webcam
is judged fairly across frame sizes.

#### No demographic rejection

The policy never rejects based on gender, age, skin tone, ethnicity, or
appearance. Brightness refers to image exposure only.

#### Thresholds

The thresholds live in a single configuration source
(`services/face-service/app/core/config.py`) and surface in
`services/face-service/.env.example`. **They are CONSERVATIVE
DEVELOPMENT BASELINES — NOT production-calibrated.** They MUST be re-
calibrated against a representative evaluation set before any
production deployment.

| Variable | Default |
| --- | --- |
| `FACE_ENROLLMENT_MIN_DETECTION_SCORE` | `0.7` |
| `FACE_ENROLLMENT_MIN_FACE_AREA` | `0.03` |
| `FACE_ENROLLMENT_MAX_FACE_AREA` | `0.6` |
| `FACE_ENROLLMENT_MIN_BLUR_SCORE` | `80.0` |
| `FACE_ENROLLMENT_MIN_BRIGHTNESS` | `0.18` |
| `FACE_ENROLLMENT_MAX_BRIGHTNESS` | `0.85` |

### Liveness

**Liveness / anti-spoofing is NOT implemented in PHASE 4.3.** The
endpoint accepts any single face that passes the quality gate, including
printed photos, screen replays, and recorded video. Anti-spoof arrives
in a later release (Phase 9 in the architecture plan).

### No persistence

The Face Service remains **stateless**. It does NOT persist:

- raw image bytes
- face crops
- embeddings
- quality results

Everything lives in the request lifecycle. There is no MongoDB, no
SQLite, no JSON file, no `.npy`, no pickle.

### Logging hygiene

PHASE 4.3 safe log fields for the enrollment endpoint:

- `accepted` (bool)
- `face_count` (always 1 — face count errors use the standard envelope)
- `rejection_count` (number of stable codes)
- `processing_ms`

The Face Service **never logs**:

- raw image bytes
- base64 frames
- face crops
- the embedding vector
- the `X-Service-Token` header

### Browser exposure

The endpoint is the only place in the Face Service that returns an
embedding. The existing endpoints remain unchanged:

- `POST /v1/faces/analyze` — never returns embeddings.
- `POST /v1/faces/compare` — returns similarity + threshold + match
  flag only.

These invariants are guarded by unit tests (`/v1/faces/analyze` still
never contains the string `embedding` in its JSON body).

## Phase 4.4B1 enrollment start route

PHASE 4.4B1 ships the first Next.js Face ID route —
`POST /api/face-id/enrollment/start`. The route's only job is to
safely start (or reset) a temporary biometric enrollment session
for the authenticated user.

### Server-only and biometric-free

The route:

- Lives under `apps/web/src/app/api/face-id/enrollment/start/route.ts`.
  It is a Next.js Route Handler, run server-side. No Client Component
  or browser fetch hook is introduced in this mini-phase.
- Accepts **no** biometric payload. The request body is ignored. No
  image, no embedding, no encrypted vector enters or leaves this
  endpoint.
- Does **not** call the Face Service. Neither
  `getFaceServiceHealth()` nor `analyzeEnrollmentSample()` is invoked.
- Does **not** create, replace, or delete a `FaceProfile`.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). The request body's `userId` / `email` fields are
  ignored.
- If no session exists → `401 UNAUTHENTICATED`.
- A malicious body such as `{ "userId": "another-user" }` cannot
  cause creation of an enrollment session for another account. This
  invariant is covered by an explicit unit test.
- If the authenticated user has no Profile, or `onboardingCompleted`
  is false → `409 PROFILE_INCOMPLETE`. The route never auto-creates a
  Profile — onboarding is a separate flow.
- If an active `FaceProfile` already exists → `409
  FACE_PROFILE_ALREADY_EXISTS`. The existing profile is left
  untouched. Explicit re-enrollment is implemented in a later
  mini-phase.

### Session lifetime and reset semantics

- The temporary enrollment session has a server-generated `expiresAt`
  of `now + 15 minutes`, using the existing PHASE 4.2 helper
  `DEFAULT_ENROLLMENT_SESSION_TTL_MS` in
  `apps/web/src/lib/biometrics/enrollment-session-ttl.ts`. The
  browser cannot choose the expiry.
- The required sample count is centralized in
  `apps/web/src/lib/biometrics/biometric-constants.ts` as
  `DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES = 5`. The literal `5`
  must not be repeated across call sites.
- Calling `start` again for a user who already has an unfinished
  CREATE session **resets** that session in place: `acceptedSamples`
  is cleared, `expiresAt` is refreshed, model metadata is reset to
  `undefined`. The unique index on `userId` guarantees at most one
  enrollment-session document per user at the database layer.

### Response privacy

The route's success body is intentionally minimal:

```json
{
  "status": "started",
  "mode": "create",
  "acceptedSamples": 0,
  "requiredSamples": 5,
  "expiresAt": "2026-09-10T14:30:00.000Z"
}
```

It deliberately does **not** include:

- `userId`, `email`, or any other identity-bearing field.
- encrypted sample vectors (`ciphertext`, `iv`, `authTag`,
  `keyVersion`).
- model metadata (`modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`).
- embeddings.
- any object taken directly from the database row.

A failing response uses the standard project envelope:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes include `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`,
`FACE_PROFILE_ALREADY_EXISTS`, and `ENROLLMENT_START_FAILED`.
Mongoose / MongoDB / Better Auth internals are never returned.

### What is NOT yet implemented

PHASE 4.4B1 deliberately does NOT implement:

- Sample upload (`POST /api/face-id/enrollment/sample`).
- Camera access or `getUserMedia`.
- Embedding extraction, encryption, or persistence.
- Face Service calls (`/health` or `/v1/faces/enrollment/sample`).
- Enrollment finalization or `FaceProfile` creation.
- Re-enrollment / replacement flow.
- Status endpoint (`GET /api/face-id/enrollment`).
- Frontend pages, dashboard changes, attendance workflows.

PHASE 4.4B1 ships only the start route and its dedicated tests.

## Phase 4.4B2 enrollment status route

PHASE 4.4B2 adds the read-only status route
`GET /api/face-id/enrollment/status`. The route's only job is to
report the safe current state of the authenticated user's Face ID
enrollment.

### Server-only and biometric-free

The route:

- Lives under `apps/web/src/app/api/face-id/enrollment/status/route.ts`.
  It is a Next.js Route Handler, run server-side. No Client
  Component or browser fetch hook is introduced in this
  mini-phase.
- Accepts **no** biometric payload. No image, no embedding, no
  encrypted vector enters or leaves this endpoint.
- Does **not** call the Face Service. Neither
  `getFaceServiceHealth()` nor `analyzeEnrollmentSample()` is
  invoked.
- Does **not** call the encryption module. The route never
  decrypts anything; reading status does not require
  `BIOMETRIC_ENCRYPTION_KEY`.
- Does **not** create, replace, or delete a `FaceProfile`.
- May attempt a best-effort cleanup of an expired
  `FaceEnrollmentSession` document; cleanup failure never
  surfaces to the browser.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). Query parameters such as `?userId=...` are
  **ignored** — they cannot influence ownership, response
  content, or service calls. This invariant is covered by an
  explicit unit test.
- If no session exists → `401 UNAUTHENTICATED`.
- If the authenticated user has no Profile, or
  `onboardingCompleted` is false → `409 PROFILE_INCOMPLETE`. The
  route never auto-creates a Profile — onboarding is a separate
  flow.

### Expired session handling

- The route checks `isEnrollmentSessionExpired(session)` rather
  than relying on MongoDB TTL deletion. A document with
  `expiresAt` already in the past may still be present in the
  collection; the route treats it as expired regardless.
- On a known-expired session the route attempts a best-effort
  `deleteEnrollmentSessionByUserId(...)` cleanup. A cleanup
  failure is **internal-only** — the response still safely
  reports `enrollment.active = false` and never includes a 5xx
  error. The route does not log biometric sample contents.

### Response privacy

The route's success body is intentionally minimal:

```json
{
  "configured": false,
  "faceId": null,
  "enrollment": {
    "active": false,
    "mode": null,
    "acceptedSamples": 0,
    "requiredSamples": 0,
    "expiresAt": null
  }
}
```

When the user has a permanent Face ID enrollment, `configured`
is `true` and a `faceId` block is present:

```json
{
  "configured": true,
  "faceId": {
    "enrolledAt": "2026-09-01T10:00:00.000Z",
    "sampleCount": 5
  },
  "enrollment": { "...": "..." }
}
```

When a temporary enrollment session is in progress
(`mode` is `"create"` or `"replace"`), the `enrollment` block
reports:

- `active: true`
- `mode` — the stored value (`"create"` or `"replace"`)
- `acceptedSamples` — the LENGTH of the stored
  `acceptedSamples` array
- `requiredSamples` — the stored `requiredSampleCount`
- `expiresAt` — the stored expiry, serialized to ISO 8601

It deliberately does **not** include:

- `userId`, `email`, or any other identity-bearing field.
- encrypted sample vectors (`ciphertext`, `iv`, `authTag`,
  `keyVersion`).
- model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`).
- embeddings.
- centroids.
- quality summaries.
- the actual `acceptedSamples` array (only its length is
  returned).
- any object taken directly from the database row.

A failing response uses the standard project envelope:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes include `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`,
and `ENROLLMENT_STATUS_FAILED`. Mongoose / MongoDB / Better Auth
internals are never returned.

### What is NOT yet implemented

PHASE 4.4B2 deliberately does NOT implement:

- Sample upload (`POST /api/face-id/enrollment/sample`).
- Camera access or `getUserMedia`.
- Embedding extraction, encryption, or persistence.
- Face Service calls (`/health` or `/v1/faces/enrollment/sample`).
- Encryption / decryption calls (the route never imports the
  encryption module).
- Enrollment finalization or `FaceProfile` creation.
- Re-enrollment / replacement flow.
- Frontend pages, dashboard changes, attendance workflows.

PHASE 4.4B2 ships only the status route and its dedicated tests.

## Phase 4.4C enrollment sample route

PHASE 4.4C adds the sample upload route
`POST /api/face-id/enrollment/sample`. The route accepts ONE image
from the authenticated web client, forwards it to the trusted Face
Service, and on accepted samples encrypts the embedding with
AES-256-GCM before persisting it inside the temporary enrollment
session.

### Server-only and transient

The route:

- Lives under
  `apps/web/src/app/api/face-id/enrollment/sample/route.ts`. It is a
  Next.js Route Handler, run server-side. No Client Component or
  browser fetch hook is introduced in this mini-phase.
- Does **not** write the uploaded image to disk, MongoDB, Blob
  storage, `localStorage`, or any public folder. The image stays in
  request-scoped memory.
- Accepts **only** `multipart/form-data` with a single `image` field
  (JPEG, PNG, or WebP; max 1.5 MB). JSON base64, multiple files, and
  continuous video are not accepted.
- Uses existing `analyzeEnrollmentSample(...)` through
  `face-service-client.ts` (server-only). Direct fetch is forbidden.
- Does **not** create or modify any `FaceProfile`. It only appends
  encrypted samples to the existing temporary
  `FaceEnrollmentSession`.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). The request body — including any client-supplied
  `userId` field — is ignored for identity decisions. This invariant
  is covered by an explicit unit test.
- If no session exists → `401 UNAUTHENTICATED`.
- If the authenticated user has no Profile, or
  `onboardingCompleted` is false → `409 PROFILE_INCOMPLETE`. The
  route never auto-creates a Profile.
- If no active enrollment session exists → `409
  ENROLLMENT_NOT_STARTED`. The user must call
  `POST /api/face-id/enrollment/start` explicitly.
- If the existing session has `expiresAt <= now` → `409
  ENROLLMENT_EXPIRED`. The route does not auto-create a new session;
  the user must explicitly call `start` again.
- If the session mode is not `"create"` → the route rejects the
  request (replace-mode sessions are not yet implemented in this
  mini-phase).

### Image validation at the boundary

- File must exist, `size > 0`, `size <= FACE_ENROLLMENT_MAX_SAMPLE_BYTES`
  (centralized constant set to 1.5 MB).
- MIME type must be `image/jpeg`, `image/png`, or `image/webp`. Filename
  extension is not trusted; only the validated `Blob.type` is used.
- Invalid file / oversized / invalid MIME → `400 INVALID_IMAGE` or
  `400 IMAGE_TOO_LARGE`. No oversized payload is ever forwarded to the
  Face Service.
- Face Service remains authoritative for real image decoding.

### Face Service call

- The route calls existing `analyzeEnrollmentSample(...)` through the
  PHASE 4.4A server-only `face-service-client.ts`. The
  `X-Service-Token` is set by the client, never duplicated in the
  route.
- No automatic retry. Each request fires exactly one Face Service
  call. The secret token never appears in responses.

### Face Service error mapping

`FaceServiceClientError` is mapped to safe, stable web-level codes
without exposing raw fetch/FastAPI errors:

| Face Service domain error | Mapped route code | HTTP |
| --- | --- | --- |
| `NO_FACE` | `NO_FACE` (preserved) | 422 |
| `MULTIPLE_FACES` | `MULTIPLE_FACES` (preserved) | 422 |
| `FACE_SERVICE_NOT_CONFIGURED` | `FACE_SERVICE_NOT_CONFIGURED` | 502 |
| `FACE_SERVICE_UNAVAILABLE` | `FACE_SERVICE_UNAVAILABLE` | 502 |
| `FACE_SERVICE_TIMEOUT` | `FACE_SERVICE_TIMEOUT` | 502 |
| `FACE_SERVICE_UNAUTHORIZED` | `FACE_SERVICE_UNAUTHORIZED` | 502 |
| `FACE_SERVICE_INVALID_RESPONSE` | `FACE_SERVICE_INVALID_RESPONSE` | 502 |
| any other | `FACE_SERVICE_UNAVAILABLE` | 502 |

### Quality rejection handling

- Face Service may return `accepted=false` with one or more
  rejection codes (`LOW_DETECTION_CONFIDENCE`, `FACE_TOO_SMALL`,
  `FACE_TOO_LARGE`, `TOO_BLURRY`, `TOO_DARK`, `TOO_BRIGHT`,
  `FACE_NEAR_EDGE`).
- This is a normal domain outcome, **not** a server failure.
- **Nothing is persisted.** No encrypted sample is appended. The
  accepted-sample count is not incremented.
- The route returns a safe progress DTO:

  ```json
  {
    "accepted": false,
    "rejectionReasons": ["FACE_TOO_SMALL"],
    "progress": {
      "acceptedSamples": 2,
      "requiredSamples": 5,
      "complete": false
    }
  }
  ```

- Quality threshold numbers are not returned to the browser.

### Accepted sample handling

For an accepted sample the route:

1. Re-validates the session is still active and below the sample
   limit.
2. Determines the deterministic 0-based `sampleIndex = currentCount`.
3. Validates model compatibility (for samples after the first).
4. Encrypts the embedding using PHASE 4.1 AES-256-GCM with AAD
   binding:

   ```ts
   {
     userId: session.user.id,
     modelIdentity: <from Face Service response>,
     templateVersion: session.templateVersion,
     vectorType: "sample",
     sampleIndex
   }
   ```

5. Atomically appends the encrypted sample to the session using
   `appendAcceptedEnrollmentSample(...)`, which uses MongoDB
   `findOneAndUpdate` with filter conditions to prevent race
   conditions.

For the **first** accepted sample, model metadata
(`modelIdentity`, `modelName`, `embeddingDimension`,
`normalization`) is established at the same time. Subsequent samples
must match exactly; mismatches return `MODEL_MISMATCH` without
modifying existing accepted samples.

### Sample limit

- Maximum `requiredSampleCount = 5` samples per session (centralized
  constant `DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES`).
- When `currentCount >= requiredSampleCount`, the route returns
  `ENROLLMENT_SAMPLE_LIMIT_REACHED` without calling the Face Service.

### Concurrency

`appendAcceptedEnrollmentSample(...)` uses MongoDB atomic
`findOneAndUpdate` with a filter that includes all of the following
conditions, evaluated atomically by MongoDB:

- `userId` matches the authenticated user.
- `expiresAt > now` (defense-in-depth — the route already checks
  this before calling).
- The session's current `acceptedSamples` length is EXACTLY equal to
  the caller's `expectedSampleIndex` (enforced via `$expr` + `$eq` +
  `$size`). This is the **PHASE 4.4C.1** atomic-exact-length guard
  that prevents duplicate `sampleIndex` values from being persisted
  when two simultaneous requests both read the same starting state.
- The session's current `acceptedSamples` length is less than
  `requiredSampleCount` (enforced via `$expr` + `$lt` + `$size`).
- For the FIRST sample (caller's `expectedSampleIndex === 0`):
  `modelIdentity`, `modelName`, `embeddingDimension`, and
  `normalization` are absent (`$exists: false`), so the FIRST atomic
  update both initializes model metadata AND appends the encrypted
  sample.
- For non-first samples: `modelIdentity`, `modelName`,
  `embeddingDimension`, and `normalization` match the incoming
  values exactly.

Two simultaneous accepted-sample requests therefore CANNOT both assign
the same `sampleIndex` or both exceed the required count. The losing
request receives a safe `ENROLLMENT_SAMPLE_CONFLICT` (HTTP 409) — a
stable application-level conflict that the user/browser may
explicitly retry. The route deliberately does NOT auto-retry, does
NOT call Face Service again, and does NOT re-encrypt under a
different `sampleIndex`.

For the first sample, the same atomic `findOneAndUpdate` initializes
model metadata and appends the encrypted sample in one operation, so
two simultaneous first-samples cannot establish conflicting model
identities. The losing first-sample request also returns
`ENROLLMENT_SAMPLE_CONFLICT`.

The three `sampleIndex` values — the route's AAD field, the
caller's `expectedSampleIndex` argument, and the persisted
`acceptedSamples[i].sampleIndex` field — are guaranteed to be
identical by construction (the route threads one local variable
through both calls).

### No plaintext embedding persistence

The route may temporarily hold the embedding in server memory while
calling `encryptBiometricVector(...)`. Before MongoDB persistence it
is encrypted, and only the encrypted value
(`ciphertext`/`iv`/`authTag`/`keyVersion`) is passed to the
persistence layer. A plaintext `number[]` is NEVER passed to
`appendAcceptedEnrollmentSample(...)`. An explicit unit test asserts
this against a recognizable fake embedding (`0.123456`).

### Biometric key failure handling

If the encryption key is missing or invalid, the route returns a safe
`503 BIOMETRIC_ENCRYPTION_UNAVAILABLE` and never persists the sample
(plaintext or otherwise).

### Response privacy

Success body — accepted sample:

```json
{
  "accepted": true,
  "rejectionReasons": [],
  "progress": {
    "acceptedSamples": 1,
    "requiredSamples": 5,
    "complete": false
  }
}
```

`complete: true` is reported only when `acceptedSamples >=
requiredSamples`. It means "enough temporary samples collected"; it
does NOT mean a `FaceProfile` exists. FaceProfile creation belongs to
a later phase.

Success body — rejected quality:

```json
{
  "accepted": false,
  "rejectionReasons": ["TOO_BLURRY"],
  "progress": {
    "acceptedSamples": 3,
    "requiredSamples": 5,
    "complete": false
  }
}
```

These responses deliberately do **not** include:

- `userId`, `email`, or any other identity-bearing field.
- `embedding`.
- `ciphertext`, `iv`, `authTag`, `keyVersion`.
- `modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`.
- The Face Service response is NEVER spread directly into JSON;
  every field that reaches the wire is explicitly constructed by the
  route.

Stable codes for this endpoint include `UNAUTHENTICATED`,
`PROFILE_INCOMPLETE`, `ENROLLMENT_NOT_STARTED`, `ENROLLMENT_EXPIRED`,
`INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `NO_FACE`, `MULTIPLE_FACES`,
`FACE_SERVICE_UNAVAILABLE`, `FACE_SERVICE_TIMEOUT`,
`FACE_SERVICE_NOT_CONFIGURED`, `MODEL_MISMATCH`,
`ENROLLMENT_SAMPLE_LIMIT_REACHED`, `BIOMETRIC_ENCRYPTION_UNAVAILABLE`,
and `ENROLLMENT_SAMPLE_FAILED`.

### What is NOT yet implemented

PHASE 4.4C deliberately does NOT implement:

- Camera access or `getUserMedia`.
- Frontend UI for capturing photos.
- Embedding-storage on the `FaceProfile` collection.
- Centroid calculation, finalization, or replacement.
- Re-enrollment / FaceProfile deletion flows.
- Attendance workflows.

PHASE 4.4C ships only the sample route and its dedicated tests.

## Phase 4.5A browser camera foundation

PHASE 4.5A ships the first **client-side** Face ID code in the
web app: a small, reusable camera primitive for future enrollment
UI. The mini-phase is deliberately minimal — a live preview and
nothing more.

### Client-only surface

The new files live entirely under
`apps/web/src/components/face-id/`:

- `camera-constants.ts` — stable error codes, friendly messages,
  and `getUserMedia` constraints (`audio: false`, `facingMode:
  "user"`, ideal `1280x720`).
- `camera-errors.ts` — a pure `mapCameraError(unknown)` utility that
  returns a closed-enum `CameraErrorShape` and never leaks raw
  exception names, messages, or stacks.
- `use-face-camera.ts` — a `"use client"` React hook exposing
  `videoRef`, `status` (`idle | requesting | ready | error`),
  `error`, `isReady`, `startCamera`, `stopCamera`.
- `camera-preview.tsx` — a `"use client"` React component that
  renders a `<video>`, "Turn on camera" / "Stop camera" buttons,
  an accessible error block, and a small privacy note.
- `index.ts` — public surface re-exports.

The module MUST NOT import any server-only module. In particular
the camera code never references:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

### Permission is explicit

The browser's `getUserMedia` permission dialog is one of the most
disruptive UX events on the web. PHASE 4.5A enforces the rule:

- `getUserMedia` is NEVER called on mount, render, or effect.
- The ONLY trigger is the user pressing **"Turn on camera"**.
- Opening a page that embeds `CameraPreview` must NOT immediately
  trigger the browser permission dialog.

This is the exact same posture called for in
`docs/frontend-design.md`: no surprise permission prompts.

### Audio is off

PHASE 4.5A requests `audio: false` unconditionally. Microphone
permission is NEVER requested. The microphone LED on supported
platforms therefore never lights up during PHASE 4.5A usage.

### Track cleanup on stop

`stopCamera()` stops EVERY active `MediaStreamTrack` and detaches
the stream from the `<video>` element. The OS-level camera LED is
guaranteed to turn off when the user presses Stop, navigates away,
or closes the consuming component.

The hook also performs the same cleanup in its unmount effect,
so leaving a page that embeds `CameraPreview` never leaves the
webcam running.

### No image capture / no upload

PHASE 4.5A does NOT capture, encode, or upload any image. There
is no:

- `<canvas>` element in the foundation code
- `drawImage`, `toBlob`, or `toDataURL` call
- `ImageCapture` API usage
- `fetch` call to `/api/face-id/enrollment/sample`
- persistent browser storage (`localStorage`, `IndexedDB`)

The only thing the camera writes to is the `<video>` element's
`srcObject` — a live in-memory `MediaStream`. There is no
persistent browser-side state to clean up.

### Privacy copy

`CameraPreview` includes a small, restrained privacy note near
the preview: "The camera preview stays on this device until you
choose to capture a sample." This wording is deliberately
limited to what is true in PHASE 4.5A. It does NOT claim that
future samples are never transmitted, because PHASE 4.5B will
send user-chosen samples to the server.

### Secure context

`navigator.mediaDevices.getUserMedia` is only available in a
secure context (HTTPS or localhost). `useFaceCamera` checks
`window.isSecureContext` BEFORE calling `getUserMedia` and
returns `CAMERA_INSECURE_CONTEXT` if the page is not in a secure
context. No production domains are hard-coded; localhost is
treated as secure by modern browsers.

### Stable camera error codes

Browser exceptions are mapped to a closed enum:

| Browser exception                                              | Mapped code                |
| -------------------------------------------------------------- | -------------------------- |
| `NotAllowedError`                                              | `CAMERA_PERMISSION_DENIED` |
| `NotFoundError`, `OverconstrainedError`                        | `CAMERA_NOT_FOUND`         |
| `NotReadableError`                                             | `CAMERA_IN_USE`            |
| `SecurityError`                                                | `CAMERA_INSECURE_CONTEXT`  |
| anything else (incl. `null`, `undefined`, primitives)          | `CAMERA_UNAVAILABLE`       |

The mapping is pure, isolated to `camera-errors.ts`, and is
unit-tested independently of the hook and the component. Raw
exception names, messages, and stacks are NEVER surfaced to
the user, to logs, or to the UI tree.

### What is NOT yet implemented

PHASE 4.5A deliberately does NOT implement:

- Image capture (`<canvas>`, `ImageCapture`, `toBlob`, `toDataURL`,
  `drawImage`).
- JPEG / PNG / WebP encoding.
- Sample submission to `/api/face-id/enrollment/sample`.
- 5-sample progress, embedding extraction, encryption, or
  persistence.
- Face Service calls.
- Finalization or `FaceProfile` creation.
- Re-enrollment or FaceProfile deletion flows.
- A `/face-id` or `/face-id/setup` application route.
- Any change to sidebar navigation.
- Dashboard, attendance, or classes integration.
- Camera device enumeration / selection.

PHASE 4.5B will integrate the camera foundation into a real
`/face-id` enrollment page and add the missing capture / submit
loop. No part of that work belongs to PHASE 4.5A.

## Phase 4.5B1 Face ID page shell

PHASE 4.5B1 introduces the first two Server Component pages that
expose Face ID to the authenticated user:

- `/face-id` — safe overview page
- `/face-id/setup` — enrollment shell

Both pages share the same server-side authentication and profile
gating as `/dashboard` and `/profile`. No biometric payload enters
or leaves these pages. No Face Service calls are made from the
pages themselves.

### No biometric exposure on the overview page

The `/face-id` page renders ONLY safe fields:

- `configured` (boolean)
- `faceId.enrolledAt` (ISO string)
- `faceId.sampleCount` (integer)
- `enrollment.active`, `enrollment.mode`, `enrollment.acceptedSamples`,
  `enrollment.requiredSamples`, `enrollment.expiresAt`

The page never renders or references:

- `userId`, `email`
- encrypted samples (`ciphertext`, `iv`, `authTag`, `keyVersion`)
- model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`)
- embeddings
- centroids
- quality summaries
- the actual `acceptedSamples` array

### Explicit start action, no auto-enrollment

The `/face-id/setup` page never auto-starts enrollment and never
auto-requests camera permission. The user must explicitly press the
"Start setup" button. The button calls a Server Action
(`startFaceEnrollment`) that wraps the same auth and profile checks
as `POST /api/face-id/enrollment/start`. The action sets the
session under the authenticated user's identity only — it never
accepts a `userId` from the browser.

### CameraPreview retains PHASE 4.5A guarantees

When the enrollment page renders `CameraPreview`, the component
behaves exactly as in PHASE 4.5A:

- `getUserMedia` is only triggered by an explicit button click.
- `audio: false` — no microphone access is requested.
- All MediaStreamTracks are stopped on unmount and on Stop press.

The setup page never exposes a functional Capture button. The
preview's purpose in PHASE 4.5B1 is purely to verify camera access
works before later phases add capture and submission.

### Privacy copy on the setup page

The setup page includes restrained, neutral privacy information:

- "Face setup will use several camera samples to create an
  encrypted biometric template."
- "Raw camera images are not kept by the application."
- "Liveness and anti-spoofing are not enabled in this preview."

These statements are deliberately limited to what the current
architecture supports. No unbacked promises (e.g. "100% secure",
"cannot be fooled") are made. The page is not rendered as a legal
consent form.

### Shared safe status service

To avoid duplicating safe status logic between the existing
`GET /api/face-id/enrollment/status` route and the new Server
Components, a shared module is introduced:

```
apps/web/src/lib/biometrics/face-id-status-service.ts
```

It is server-only, returns typed objects (no JSON-over-HTTP), and
performs the same TTL handling as the status route. It deliberately
NEVER returns any biometric field listed above.

### Server-secret hygiene

The page code NEVER imports:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

Only Client Components in the strict sense (the page-level Client
components for the start button and the pre-existing `CameraPreview`)
are present in the browser bundle. Both use only React, the
shared `cn()` helper, and the camera foundation modules.

### What PHASE 4.5B1 does NOT include

- Image capture / encoding / upload
- POST `/api/face-id/enrollment/sample`
- 5-sample capture loop
- Quality feedback
- Embedding handling
- Finalization
- Centroid calculation
- FaceProfile creation
- Re-enrollment or Face ID deletion

Those belong to PHASE 4.5B2.

## Phase 4.5B2 video frame capture foundation

PHASE 4.5B2 ships the first **client-side image processing** primitive
in the web app: a reusable utility that captures one frame from an
already-ready HTMLVideoElement and returns it as a JPEG Blob held
only in browser memory. PHASE 4.5B2 does NOT submit the frame
anywhere, does NOT persist it, and does NOT integrate into a UI yet.

### Client-only, server-secret free

The new file lives under
`apps/web/src/components/face-id/capture-video-frame.ts`. It is
client-only and never imports:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

The utility performs ZERO network requests — no `fetch`,
`XMLHttpRequest`, `sendBeacon`, or Server Action call. An explicit
unit test asserts `fetch` is never called.

### The captured JPEG stays in memory

The captured frame exists only as:

- temporary canvas pixels during encoding
- the returned in-memory JPEG `Blob`

The frame is NEVER written to:

- the filesystem
- IndexedDB
- localStorage
- sessionStorage
- the Cache API
- MongoDB
- a public directory

After `toBlob` completes, the ephemeral canvas backing memory is
released (`canvas.width = 0; canvas.height = 0`). The utility does
NOT create an object URL — `URL.createObjectURL()` is not called in
PHASE 4.5B2. There is no captured preview yet.

### Encoding policy

| Property | Value |
| --- | --- |
| MIME type | `image/jpeg` |
| Quality | `0.85` (development setting) |
| Max long edge | `1280` |
| Aspect ratio | preserved |
| Upscale | NEVER |
| Encoder | `canvas.toBlob` only |
| `toDataURL` | NOT used |
| Base64 output | NEVER produced |

The Next.js sample endpoint remains authoritative for its existing
1.5 MB request limit.

### Preview mirror does NOT mirror capture

The `CameraPreview` component applies a CSS
`[transform:scaleX(-1)]` to its `<video>` for selfie-style
presentation. CSS transforms do NOT affect the source pixels drawn
via `drawImage`. The capture utility does NOT apply
`ctx.scale(-1, 1)` or `ctx.translate(...)` — the captured image
preserves the original camera frame orientation. A test verifies
that no mirror transform is invoked.

### No biometric payload, no upload yet

The captured `Blob` is held only in browser memory. PHASE 4.5B2 does
NOT claim that future samples are never transmitted, because PHASE
4.5B3 will submit user-chosen samples to
`POST /api/face-id/enrollment/sample`. No part of that submission
flow belongs to PHASE 4.5B2.

### What PHASE 4.5B2 does NOT include

- POST `/api/face-id/enrollment/sample`
- A functional Capture button on `/face-id/setup`
- 5-sample progress mutations
- Quality feedback
- Embedding extraction, encryption, or persistence
- Face Service calls
- Finalization or `FaceProfile` creation
- Re-enrollment or Face ID deletion

Sample submission, finalization, and any embedding handling belong
to PHASE 4.5B3.

## Phase 4.5B3 capture + submit + quality feedback

PHASE 4.5B3 turns the previously-inert `CameraPreview` on
`/face-id/setup` into a working capture loop. Every biometric frame
still travels through the existing Next.js authenticated route; the
browser never speaks to the Face Service directly.

### Browser only ever calls the Next.js route

The browser is restricted to a single network endpoint:

- `POST /api/face-id/enrollment/sample`

The browser does **not** call:

- `${FACE_SERVICE_URL}` directly
- the FastAPI `/v1/faces/enrollment/sample` endpoint
- any other internal infrastructure

The browser does **not** send `X-Service-Token`, `FACE_SERVICE_SECRET`,
`userId`, `email`, `sampleIndex`, or `modelIdentity`. Identity is
derived from the Better Auth session exclusively, sample index is
managed atomically server-side.

### Strict network-boundary invariants

The browser request:

- Uses `multipart/form-data` with exactly one field, `image`,
  carrying the JPEG `Blob`.
- Filename: `"face-sample.jpg"` — harmless metadata only.
- NEVER manually sets `Content-Type: multipart/form-data`. The
  browser is responsible for generating the multipart boundary. A
  manual `Content-Type` would break the boundary and the request
  would be rejected.
- Sends NO `Authorization`, `X-Service-Token`, or any other internal
  header from the browser.

### What the browser sees from the server

The browser receives only safe fields from the existing route:

```json
{
  "accepted": true,
  "rejectionReasons": [],
  "progress": {
    "acceptedSamples": 1,
    "requiredSamples": 5,
    "complete": false
  }
}
```

…or the standard `{ "error": { "code", "message" } }` envelope. The
browser never sees:

- `embedding`
- `ciphertext`, `iv`, `authTag`, `keyVersion`
- `modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`
- `userId`, `email`
- any other biometric payload

### No Blob persistence in the browser

The captured JPEG `Blob` lives only in the local variable inside the
click handler. It is **never**:

- stored in React state, context, or any store
- written to `localStorage`, `sessionStorage`, IndexedDB, or the
  Cache API
- exposed via `URL.createObjectURL()` or rendered into an `<img>`
  thumbnail

The PHASE 4.5B2 utility and the new submission helper both avoid
`toDataURL`, base64, object URLs, and `<canvas>` round-trips. There
is no captured-image preview UI in PHASE 4.5B3.

### Explicit action only

A "Capture sample" button is rendered only while:

- an active enrollment session exists, AND
- the camera hook reports `ready`, AND
- no submission is currently pending, AND
- `progress.complete === false`.

Two rapid clicks are prevented from producing two POSTs by a
synchronous `submissionInFlightRef` guard inside the click handler,
in addition to React's `pending` state used for the disabled
attribute. There is no timer, no interval, no `requestAnimationFrame`
loop, no face-triggered capture. One click produces exactly one
capture and exactly one POST.

### No automatic retry

The browser never retries the POST on:

- timeout
- 409 conflict (`ENROLLMENT_SAMPLE_CONFLICT`,
  `ENROLLMENT_SAMPLE_LIMIT_REACHED`)
- 5xx (`FACE_SERVICE_UNAVAILABLE`, `FACE_SERVICE_TIMEOUT`, ...)
- network failure
- `FACE_SERVICE_INVALID_RESPONSE`

The user must press "Capture sample" again explicitly. Quality
rejection, `NO_FACE`, and `MULTIPLE_FACES` are recoverable
domain-level outcomes; the camera is left running for the next
attempt.

### Server-authoritative progress

The browser receives safe initial progress from the existing
`face-id-status-service` and passes it to the panel as
`initialAcceptedSamples` and `requiredSamples`. The panel NEVER
increments its own counter (`setCount(count + 1)` is forbidden).
After every successful POST response the panel replaces its
displayed progress with the `progress` block from the server
response. Rejected samples, conflicts, and timeouts do NOT advance
progress.

### `complete=true` is an honest temporary state

When the server reports `progress.complete === true` the panel:

- disables further "Capture sample" submissions,
- displays an honest informational message such as *"All required
  samples collected. Final setup is not connected yet."*

The browser does **NOT** claim Face ID is configured, an identity is
verified, or a `FaceProfile` exists. `FaceProfile` creation belongs
to PHASE 4.5B4 / 4.6.

### Privacy copy on the setup page

The setup page privacy note is updated to reflect that each sample
the user explicitly chooses to capture is sent to the application
for face analysis, and that raw camera images are not kept by the
application. This is product information, not legal consent text.
The page does not claim end-to-end encryption.

### Camera lifecycle unchanged

PHASE 4.5B3 does NOT modify the PHASE 4.5A camera behavior:

- `getUserMedia` is still only triggered by an explicit button
  click.
- `audio: false` is still enforced.
- The pending-request guard, the request generation token, the
  unmount cleanup, and the error mapping all remain.

After a successful POST or a quality rejection the camera stream
is left running so the user can try again without re-requesting
permission. The camera is never restarted automatically.

### What is NOT yet implemented

PHASE 4.5B3 deliberately does NOT implement:

- `FaceProfile` creation or any finalization
- Centroid calculation
- Decryption of any persisted encrypted sample
- Re-enrollment or Face ID deletion
- Liveness / anti-spoofing
- Automatic capture, continuous capture, video recording
- base64 encoding, `toDataURL`, object URL preview
- `localStorage`, `sessionStorage`, IndexedDB, Cache API
  persistence of any captured frame
- Direct browser → Face Service calls
- Sending `X-Service-Token` or `FACE_SERVICE_SECRET` from the
  browser
- Sending `userId`, `email`, `sampleIndex`, or `modelIdentity` from
  the browser
- Manual `Content-Type: multipart/form-data`
- Any automatic retry of the POST

Finalization and any related workflow belong to PHASE 4.5B5 / 4.6.

## Phase 4.5B4.3 server-authoritative generation discriminator + legacy migration

PHASE 4.5B4.3 introduces a stable, server-authoritative
**`generationId`** for each `FaceEnrollmentSession` document. It
replaces `expiresAt` as the primary reconciliation discriminator for
multi-tab and reload-resilience paths. The browser continues to
receive `expiresAt` for display ("Session expires at …") but it is
**not** the trigger for the downward-replacement reconciliation
branch.

### Why a server-issued `generationId`?

`expiresAt` is a TTL field that may change on legitimate
non-reset operations (TTL extension). Two reads of the same
`FaceEnrollmentSession` may legitimately observe different
`expiresAt` values without the session having been replaced.
`generationId` is a UUID v4 minted by the server exactly once per
create-or-reset operation, so two reads of the same document
always observe the same `generationId`, and any operation that
replaces the session clears and re-mints it.

### Schema invariant

`generationId` is a non-unique, required `String` (minlength 1).
No global unique index is added — `userId` remains the unique
ownership index. Adding a global unique index would be a global
write bottleneck for an identifier that is only consumed locally
by the browser for reconciliation.

### Legacy session migration strategy

Documents created before PHASE 4.5B4.3 may not have a
`generationId` field. Mongoose does not auto-backfill required
fields on existing documents. The migration is therefore:

- **Lazy / on-demand.** Triggered on the first
  `getEnrollmentSessionByUserId(userId)` call after the schema
  change goes live.
- **Server-side only.** No migration script, no batch update, no
  global scan.
- **Atomic per-document.** Implemented as a single
  `findOneAndUpdate` with the guard
  `{ userId, generationId: { $exists: false } }` and the
  `$set: { generationId: randomUUID() }` payload. MongoDB's
  atomic write semantics guarantee only one concurrent request
  wins the match.
- **No in-memory lock.** The atomic guard is sufficient. The
  service does not rely on any singleton or module-level lock
  to ensure one-`generationId`-per-document.
- **Field-preserving.** The backfill sets only `generationId`.
  `acceptedSamples`, `expiresAt`, `mode`, model metadata, and
  `FaceProfile` are not touched.
- **Idempotent.** Subsequent reads find `generationId` already
  present and return the document unchanged. The second read
  returns the same `generationId` as the first.

### Concurrency contract

Two simultaneous readers of the same legacy session:

| Request | Candidate UUID | Atomic match | Outcome |
| --- | --- | --- | --- |
| A | UUID-A | wins | DB `generationId = UUID-A` |
| B | UUID-B | loses | re-reads, observes `UUID-A` |

Only **one** `generationId` is ever persisted. All readers
observe the same stable value.

### Expired legacy session

The lazy backfill runs lazily but the expired-session check runs
first. An already-expired legacy session is treated as inactive
and is **not** revived merely to attach a `generationId`. The
existing TTL / cleanup behaviour is unchanged.

### Status contract (safe DTO)

For any ACTIVE session returned by the safe status service:

```
generationId: <stable, server-issued, non-empty UUID>
```

For inactive enrollment:

```
generationId: null
```

The status service **never** invents an ephemeral UUID to satisfy
a `generationId ?? randomUUID()` fallback. Identity comes from
the persisted session document (or from the lazy atomic
backfill for legacy sessions). DTO construction must not compute
the ID.

### Browser-side guarantees

- The browser never sends `generationId` to the server in any
  fetch body or header.
- The browser never persists `generationId` to localStorage,
  sessionStorage, IndexedDB, the Cache API, or cookies.
- `expiresAt` is never used as a fallback for `generationId`.
- The same-generation vs new-generation decision uses only
  `generationId`.

### What this phase does NOT change

- `FaceProfile` finalization is unchanged.
- The TTL / expiration semantics are unchanged.
- The unique `userId` ownership invariant is unchanged.
- The session response shape only adds one optional field
  (`generationId`). Existing fields are untouched.

## Secrets

- All secrets live in environment variables. `.env.example` exists at the
  repo root and inside each app; the real `.env*` files are gitignored.
- **Better Auth** uses the official standardized variable names:
  `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
- **Google OAuth** uses: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **MongoDB**: `MONGODB_URI` (server-side only). The application
  database is `face_attendance`.
- **Internal Face Service**: `FACE_SERVICE_SECRET` is shared between the
  web app and the Face Service, sent as `X-Service-Token`. It is never
  bundled to the browser.

### Environment requirements

| Variable | Required | Scope |
| --- | --- | --- |
| `MONGODB_URI` | yes | server |
| `BETTER_AUTH_URL` | yes | server |
| `BETTER_AUTH_SECRET` | yes | server |
| `GOOGLE_CLIENT_ID` | yes | server |
| `GOOGLE_CLIENT_SECRET` | yes | server |
| `NEXT_PUBLIC_APP_URL` | yes | public |
| `FACE_SERVICE_SECRET` | **yes from Phase 3** | server |
| `FACE_SERVICE_URL` | optional (Phase 3+ required) | server |
| `BIOMETRIC_ENCRYPTION_KEY` | optional (Phase 4.1); required from Phase 4.2 | server |

## Face Service authentication (Phase 3 / 4.4A)

- `GET /health` is public — liveness probes do not require credentials.
- All other endpoints (`/v1/*`) require `X-Service-Token:
  ${FACE_SERVICE_SECRET}`.
- When `FACE_SERVICE_SECRET` is not configured on the server, every
  protected request is rejected with `401 FACE_SERVICE_UNAUTHORIZED` so
  the misconfiguration is loud.
- The browser never calls the Face Service directly; only
  `apps/web` (the Next.js server) does.

## Authentication guarantees

### End-user (Better Auth)

- `/login` is public. Authenticated users are redirected based on
  onboarding state: incomplete → `/onboarding`, complete → `/dashboard`.
- `/onboarding`, `/dashboard`, `/profile` all require a valid Better
  Auth session AND, where applicable, a completed `Profile`.
- Sign-out calls Better Auth's official `signOut()`, invalidates the
  server-side session row, and clears the session cookie.

### Server-to-server (web ↔ Face Service)

- All Face Service endpoints except `/health` require the shared
  `FACE_SERVICE_SECRET`. `apps/web` proxies recognition requests to the
  Face Service; the browser holds no credential that could talk to the
  Face Service directly.

## Authorization rules (server-enforced)

| Action | Required |
| --- | --- |
| Create / edit / delete a class | Role = `teacher` AND `teacherId = currentUser._id` |
| Manage class members | Role = `teacher` AND owns the class |
| Start / stop an attendance session | Role = `teacher` AND owns the class |
| Export attendance | Role = `teacher` AND owns the class |
| Join a class | Role = `student` AND not already a member AND correct class password |
| Submit enrollment frames | Authenticated AND `user._id = currentUser._id` |
| Call `POST /api/face-id/enrollment/start` | Authenticated AND completed Profile AND no active `FaceProfile` |
| Call `GET /api/face-id/enrollment/status` | Authenticated AND completed Profile |
| Call Face Service `/v1/faces/*` | `X-Service-Token` matches `FACE_SERVICE_SECRET` |

The frontend may hide buttons for clarity, but it is **not** a security
boundary.

## Transport

- All browser → web traffic is HTTPS in production.
- Web → Face Service traffic is HTTPS in production; loopback is
  acceptable only in development.
- No wildcard CORS. The web origin is explicitly allow-listed on the
  Face Service.

## Validation

- Every web request body is validated with Zod.
- Every Face Service request body is validated with Pydantic.
- File uploads enforce an upper size cap (default 8 MB per frame, 4096 px
  per dimension — see `services/face-service/.env.example`) and an
  explicit MIME allow-list is enforced by content sniffing.
- Embeddings posted from the browser are never trusted as-is. They are
  produced by the Face Service during enrollment.

## Logging hygiene

Log structured fields, not bodies:

- `route`, `method`, `status`, `duration_ms`, `user_id` (Better Auth user
  ID string), `class_id`, `session_id`, `face_count`, `engine`,
  `provider`.

Never log:

- Raw image bytes, base64 frames, embeddings.
- OAuth tokens, Better Auth session tokens.
- Class passwords (plain or hashed).
- `MONGODB_URI`, `BETTER_AUTH_SECRET`, `FACE_SERVICE_SECRET`,
  `GOOGLE_CLIENT_SECRET`.

## Production gate (commercial licensing)

The Face Service uses the InsightFace `buffalo_l` pretrained recognition
model, which is licensed for **non-commercial research use only**.
Commercial deployment requires a separate license from InsightFace —
see `docs/model-license.md`. Do not move the Face Service to a production
attendance workload until the operator has confirmed a commercial model
license and updated the verification log there.

## Future: stronger service-to-service auth

`FACE_SERVICE_SECRET` is the MVP mechanism. The architecture allows
swapping it for mTLS, signed JWTs from the web app's identity provider,
or workload identity (e.g. cloud IAM) without changing route signatures.

## Phase 4.6A1 pure enrollment finalization math

PHASE 4.6A1 ships a **pure-Python math module** inside the Face
Service — `services/face-service/app/engine/enrollment_finalization.py`.
The module turns a batch of *already validated, L2-normalised*
embeddings into an L2-normalised centroid *iff* the batch is
mutually consistent enough to form one enrollment template.

### No HTTP, no persistence, no engine access

The pure math foundation explicitly does NOT:

- call the InsightFace engine
- read environment variables
- write to disk, MongoDB, SQLite, JSON, `.npy`, `.npz`, or `.pkl`
- touch the network
- decode images, handle JPEG bytes, or open raw camera frames
- log embedding values, centroid values, or pairwise vector contents

Configuration is supplied as function arguments by the caller.
`min_self_similarity` is a caller-supplied argument.

### No raw biometric fixtures or persistence

The unit test suite constructs deterministic normalised vectors
synthetically from a seeded numpy generator; no real biometric data is
loaded or referenced.

### Reuse of the PHASE 3 matcher

Pairwise cosine similarity is computed by the existing
`app.engine.matcher.cosine_similarity` helper. This guarantees:

- similarity semantics identical to the existing 1:1 / 1:N code paths
- the same float-drift clamping (`[-1.0, 1.0]`)
- the same shared `INVALID_EMBEDDING` error path for malformed
  inputs

The pure finalization layer wraps the matcher's domain errors into
its own stable codes (`INVALID_EMBEDDING`,
`EMBEDDING_DIMENSION_MISMATCH`, `EMBEDDING_NOT_NORMALIZED`,
`INCONSISTENT_FACE_SAMPLES`, `INVALID_CENTROID`,
`INVALID_SAMPLE_COUNT`) so the future endpoint layer can map them
onto HTTP envelopes without leaking matcher internals.

### What this phase does NOT do

- `FaceProfile` persistence
- Biometric encryption / decryption
- Re-enrollment, deletion, replacement
- Attendance, liveness, anti-spoofing

Those belong to later phases.

## Phase 4.6A2 protected finalization endpoint

PHASE 4.6A2 adds the protected internal HTTP endpoint
`POST /v1/faces/enrollment/finalize` to the Face Service.

### Server-to-server only

The endpoint is designed for **server-to-server communication** between
the trusted Next.js application and the Face Service. It receives
already-decrypted, already-L2-normalised embeddings and returns a
consistency result plus a normalized centroid. The browser must never
call this endpoint directly.

### Architecture boundary

The Face Service remains **stateless** in PHASE 4.6A2. It does NOT:

- read MongoDB (`FaceEnrollmentSession`, `FaceProfile`)
- perform biometric decryption (AES-GCM, `BIOMETRIC_ENCRYPTION_KEY`)
- know about `userId` or Better Auth
- persist the centroid or any other result

The Next.js server (PHASE 4.6B) will be responsible for:
1. Reading encrypted samples from MongoDB.
2. Decrypting them with `BIOMETRIC_ENCRYPTION_KEY`.
3. Sending already-decrypted vectors to this endpoint.

### Authentication

The endpoint is protected by the existing `X-Service-Token` mechanism
(`FACE_SERVICE_SECRET`). `GET /health` remains unchanged and public.

### Privacy guarantees

The endpoint receives biometric vectors, so:

- **Never log:** embeddings, centroid values, request bodies.
- **Safe log fields:** `sample_count`, `pair_count`, `consistent`,
  `model_identity`, domain error code.
- **No persistence:** the Face Service does not write anything to disk,
  MongoDB, or any storage.

### Configuration

`FACE_ENROLLMENT_MIN_SELF_SIMILARITY` (default: `0.7`) controls the
consistency threshold. This is a **DEVELOPMENT BASELINE ONLY** — it
must be re-calibrated against representative evaluation data before
any production deployment.

### What PHASE 4.6A2 does NOT implement

- MongoDB access or `FaceEnrollmentSession` / `FaceProfile` persistence.
- Biometric decryption (AES-GCM, `BIOMETRIC_ENCRYPTION_KEY`).
- Next.js server-side orchestration.
- Face ID enrollment workflow completion (belongs to PHASE 4.6B).

## Phase 4.6B1A Next.js finalization client (server-only)

PHASE 4.6B1A extends the existing server-only Next.js `FaceServiceClient`
(`apps/web/src/lib/biometrics/face-service-client.ts`) with a single
focused function `finalizeFaceEnrollment(...)`. The function is the
server-only Next.js client for the PHASE 4.6A2 endpoint.

### Server-only and biometric-only in memory

The function lives inside `face-service-client.ts`, which opens with
`import "server-only"`. Client Components cannot import it. The
plaintext embeddings and centroid exist only in server memory for
the lifetime of the call.

### No MongoDB / no decryption

PHASE 4.6B1A deliberately does NOT:

- read MongoDB,
- decrypt AES-GCM ciphertext,
- touch `BIOMETRIC_ENCRYPTION_KEY`,
- create, replace, or delete `FaceEnrollmentSession` or `FaceProfile`,
- call any enrollment API route or Server Action,
- expose any biometric payload to the browser.

The function is a thin server-side wrapper around the existing
PHASE 4.4A `faceServiceRequest` HTTP client. MongoDB-backed
orchestration, biometric decryption, and `FaceProfile` persistence
belong to PHASE 4.6B1B.

### Domain error preservation

The upstream domain error codes are preserved verbatim on
`FaceServiceClientError.domainError.code`:

- `INCONSISTENT_FACE_SAMPLES` — the centroid is NEVER exposed on this
  path. The function does NOT map this to `FACE_SERVICE_UNAVAILABLE`.
- `MODEL_MISMATCH`
- `INVALID_SAMPLE_COUNT`
- `INVALID_EMBEDDING`
- `EMBEDDING_DIMENSION_MISMATCH`
- `EMBEDDING_NOT_NORMALIZED`
- `INVALID_CENTROID`

Raw response bodies are never exposed in safe error messages.

### Privacy guarantees

- Plaintext embeddings exist only inside the request body sent to
  the Face Service. They are NOT logged.
- The returned centroid exists only in the typed
  `FinalizeFaceEnrollmentResult` until future Next.js orchestration
  consumes it. It is NOT logged.
- No persistence: nothing is written to disk, MongoDB, `.npy`,
  `.npz`, `.pkl`, JSON dump, or any temp file.
- The Face Service endpoint itself remains the authoritative
  owner of its privacy posture (PHASE 4.6A2 guarantees); the
  client does not weaken it.

### What PHASE 4.6B1A does NOT claim

- Web finalization is NOT yet wired end-to-end. The function is a
  client abstraction only; no Next.js API route, Server Action, or
  UI calls it in PHASE 4.6B1A.
- `FaceProfile` persistence is NOT yet implemented.
- Temporary enrollment sessions are NOT yet finalized or cleaned up.

## Phase 4.6B1B Next.js enrollment finalization orchestration (server-only)

PHASE 4.6B1B adds the first server-only Next.js orchestration that
combines the PHASE 4.5B4.3 enrollment session persistence service,
the PHASE 4.1 AES-GCM decryption utility, and the PHASE 4.6B1A
`finalizeFaceEnrollment` client. The orchestrator lives at
`apps/web/src/lib/biometrics/enrollment-finalization-service.ts` and
is opened with `import "server-only"`.

### Server-only data flow

```
authoritative userId (PHASE 4.6B3 will supply from auth.api.getSession())
    ↓
getEnrollmentSessionByUserId(userId)   ← existing PHASE 4.5B4.3 read service
    ↓
session preconditions (expiration, generationId, mode, sample count, model metadata)
    ↓
AAD reconstruction (PHASE 4.1 fields: userId, modelIdentity, templateVersion, vectorType="sample", sampleIndex)
    ↓
decryptBiometricVector(...) for each sample   ← PHASE 4.1 utility
    ↓
plaintext validation (dimension, finiteness, |v|≈1, tolerance 1e-3)
    ↓
finalizeFaceEnrollment(...)   ← PHASE 4.6B1A client (exactly once)
    ↓
re-read session: existence + expiration + generationId match + completeness
    ↓
return EnrollmentFinalizationResult (centroid + metrics + sourceGenerationId)
```

### Plaintext lifetime

- Plaintext sample embeddings exist only in local server memory for
  the lifetime of the `finalizeEnrollmentSessionForUser` call.
- After the B1A call resolves, the orchestrator best-effort wipes
  the per-sample local buffers (the `decryptedVectors[i]` arrays).
  JavaScript does not guarantee memory zeroization, but this
  best-effort scrub keeps the residual window small.
- Plaintext embeddings never enter:
  - module / global / cache state,
  - React state, cookies, or browser code,
  - logs (no `console.log` of plaintext, centroid, ciphertext, IV,
    authTag, AAD bytes, or full session documents),
  - MongoDB or the filesystem.

### AAD reconstruction

The orchestrator rebuilds the EXACT AAD bytes used by PHASE 4.4C
when the sample was first encrypted. No new AAD fields are
introduced. The fields are:

```
userId                    ← from the function argument (authoritative)
modelIdentity             ← session.modelIdentity
templateVersion           ← session.templateVersion
vectorType                ← constant "sample"
sampleIndex               ← persisted sample.sampleIndex
```

### Session validation

The orchestrator refuses a malformed or expired session, an
unsupported enrollment mode (currently only `create` is supported;
`replace` is rejected with `UNSUPPORTED_ENROLLMENT_MODE`), or
missing authoritative model metadata. It does NOT silently repair
malformed sessions.

### Generation re-check

`sourceGenerationId = session.generationId` is captured BEFORE the
Face Service call. AFTER the call the session is re-read through
the same service. If the generation changed (e.g. another tab
reset the session), the successful centroid is DISCARDED and a
stable `ENROLLMENT_GENERATION_CHANGED` error is thrown. No
persistence happens.

> **PHASE 4.6B2 still requires the atomic CAS.** The B1B recheck
> is a single-document, non-atomic read. PHASE 4.6B2 MUST still
> atomically verify `generationId === sourceGenerationId` when
> persisting the new `FaceProfile` and consuming the temporary
> session. B1B reduces stale-result risk but does NOT close the
> persistence race.

### What PHASE 4.6B1B does NOT do (privacy guarantees)

- No `FaceProfile` write
- No `deleteEnrollmentSessionByUserId` / temporary-session delete
- No `MONGODB_URI` write / transaction
- No Next.js API route, Server Action, or browser fetch
- No UI button / router.refresh
- No plaintext sample embedding returned to any caller
- No logging of plaintext, centroid, ciphertext, IV, authTag, AAD,
  key configuration, or full biometric session documents
- No filesystem write of biometric data (no `.npy`, `.npz`, `.pkl`,
  JSON dumps, etc.)

### What PHASE 4.6B1B does NOT claim

- Enrollment finalization is NOT yet user-accessible. There is NO
  Next.js API, Server Action, or UI for it in PHASE 4.6B1B. The
  orchestrator function exists as a server-internal entry point for
  future phases.
- PHASE 4.6B2 must still perform the atomic generation compare
  before persisting. B1B alone is not sufficient.
- Plaintext sample vectors are wiped best-effort; the orchestrator
  does not claim JavaScript memory zeroization.

## Phase 4.6B2A atomic completion claim (server-only)

PHASE 4.6B2A ships a single, focused persistence primitive that
closes the small race between PHASE 4.6B1B's post-finalize recheck
and the future PHASE 4.6B2B `FaceProfile` persistence. The primitive
is the OPTIONAL `finalizationClaim` field on the temporary
`FaceEnrollmentSession`, plus two server-only service operations:

- `claimEnrollmentSessionForFinalization(...)` — atomic CAS acquire
- `releaseEnrollmentFinalizationClaim(...)` — atomic CAS release

### Token provenance

The claim token is generated server-side via `node:crypto`'s
`randomUUID()` — a v4 UUID. The browser MUST NOT provide it. The
token is opaque, never logged, never sent to the Face Service, never
sent to the browser, and never persisted anywhere except inside the
temporary `FaceEnrollmentSession.finalizationClaim.token` field.

### What the claim is NOT

The claim is NOT:

- a user authorization. It is a server-side capability, not a session,
  cookie, or token. It cannot authorize the user to do anything on
  the platform.
- a lease / timeout / heartbeat. There is intentionally NO claim
  expiry field (`claimExpiresAt`), NO automatic release, NO
  `setTimeout`, NO background cleanup job. The existing session
  `expiresAt` TTL remains the lifecycle boundary.
- user-visible. The token never reaches a status response, a
  `/face-id` payload, a `/face-id/setup` payload, or a start
  response.
- a FaceProfile write. B2A does not persist a `FaceProfile` and
  does not encrypt a centroid.

### Atomic CAS guarantees

The atomic `findOneAndUpdate` filter requires ALL of the following
to match in a single MongoDB operation:

- `userId` matches the authoritative input
- `generationId` matches the B1B finalized snapshot
- `expiresAt > now` — expired sessions cannot be claimed
- `mode`, `templateVersion`, `normalization` are in the supported
  sets
- `$size(acceptedSamples) === requiredSampleCount` — incomplete
  sessions cannot be claimed
- `finalizationClaim` is absent — overwrite is impossible

There is no read → check → write path. The CAS is the only claim
acquisition path. On loss the function performs a controlled
server-side diagnostic re-read to classify the safe domain reason;
the CAS itself is never weakened.

### Reset / start atomic protection

While an ACTIVE unexpired session carries a `finalizationClaim`,
`createOrResetEnrollmentSession(...)` MUST NOT replace the
generation, samples, expiry, model metadata, or claim. The
conditional `findOneAndUpdate` filter enforces this atomically:

```
filter: { userId, finalizationClaim: { $exists: false } }
```

If the session already holds a claim, the filter does not match and
the service surfaces the safe domain code
`ENROLLMENT_FINALIZATION_IN_PROGRESS`. The minimal start-route /
start-action mapping renders this as HTTP 409 with friendly
"Face setup is finishing. Try again shortly." copy. The
`claimToken`, `generationId`, and Mongo details are NEVER exposed.

### Release semantics

`releaseEnrollmentFinalizationClaim(...)` clears the claim ONLY
when `userId`, `generationId`, AND `finalizationClaim.token` ALL
match. Wrong token / wrong generation / wrong userId → no-op. The
function is idempotent and never throws raw Mongo errors.

### Logging hygiene

The claim token, claim object, and any field derived from them are
NEVER logged. Safe log fields, if any, would include only the
generic `code` + `message` from the orchestration error surface.

### Why no claim timeout in B2A

A claim that automatically expires while finalization code is still
executing could reopen the generation-reset race. The existing
enrollment session TTL provides a sufficient lifecycle boundary:

- If the process fails normally, future B2B explicitly releases its
  own claim on the success or failure of FaceProfile persistence.
- If the process crashes completely, the temporary enrollment
  session will eventually expire through the existing session TTL.

Correctness is prioritized over instant crash recovery in the MVP.

### What B2A does NOT do

- No `FaceProfile` write.
- No centroid encryption.
- No temporary-session deletion.
- No finalize API route, Server Action, or browser fetch.
- No UI / button / `router.refresh`.
- No claim expiry / lease / heartbeat / background cleanup.
- No automatic retry on a CAS loss.

## Phase 4.6B2B claim-bound FaceProfile persistence (server-only)

PHASE 4.6B2B closes the enrollment loop by persisting the
finalized `FaceProfile` after the B2A atomic claim is held.
The new orchestration lives in
`apps/web/src/lib/biometrics/face-profile-finalization-service.ts`
and is exposed **only** as the server-only function
`persistFinalizedFaceProfileForUser(userId)`. There is **no**
browser route, Server Action, or UI in this phase.

### What B2B does

- Runs B1B (`finalizeEnrollmentSessionForUser`) to obtain the
  canonical `sourceGenerationId`.
- Acquires a B2A atomic completion claim on
  `(userId, sourceGenerationId)`.
- Re-reads the claimed session and verifies the claim token
  still matches.
- Validates `mode`, `templateVersion`, and `normalization`.
- Cross-checks B1B model metadata against the claimed session.
- Validates the encrypted sample index set is exactly `0..N-1`
  once each.
- Encrypts the centroid with `encryptBiometricVector` using the
  exact AAD contract `(userId, modelIdentity, templateVersion,
  vectorType="centroid")`.
- Forwards encrypted sample envelopes verbatim — no decrypt,
  no re-encrypt.
- Calls `saveFinalizedFaceProfile` for idempotent persistence
  keyed on `(userId, sourceEnrollmentGenerationId)`.
- Persists the new internal lineage field
  `sourceEnrollmentGenerationId` on the `FaceProfile`.
- On failure BEFORE successful persistence, releases the claim
  best-effort (never masks the original error).
- On success, keeps the claim and the temporary enrollment
  session for PHASE 4.6B2C.

### Centroid & sample privacy

- The centroid is encrypted with the same AAD contract as
  PHASE 4.1. The plaintext centroid exists transiently in
  server memory only. It is never logged.
- The encrypted sample envelopes are forwarded byte-for-byte
  (`ciphertext`, `iv`, `authTag`, `keyVersion`). The AAD remains
  valid because the authoritative fields did not change.
- Sample and centroid plaintext are never serialized into a
  browser-safe DTO. The `PersistedFaceProfile` returned by
  `persistFinalizedFaceProfileForUser` is server-only.

### Lineage privacy

- `sourceEnrollmentGenerationId` is a server-only lineage
  field. It is **NOT** exposed in:
  - the browser-safe `face-id-status-service` DTO
  - `/face-id` or `/face-id/setup` pages
  - any other browser-facing payload
- Legacy `FaceProfile` documents lacking the lineage remain
  readable. New persistence requires the field.
- The claim token is returned **only** in the server-only
  result type and **never** in any browser DTO or log line.

### Idempotency & lineage conflict

- First write for generation `A` creates the profile and stores
  `sourceEnrollmentGenerationId = "A"`.
- Same-generation retry returns the existing profile as
  idempotent success and preserves `enrolledAt`.
- Generation-`B` create attempt while generation `A` exists is
  rejected with `FACE_PROFILE_ALREADY_EXISTS`. The existing
  profile is **never** overwritten. The `userId` unique index
  is the final safety net.

### Crash recovery

If B2B persists the profile but crashes before B2C, a retry
of the same generation is recognized via
`sourceEnrollmentGenerationId` and returns the existing profile
as idempotent success. B2C will later consume the matching
session safely.

### What B2B does NOT do

- No browser route / Server Action / UI.
- No finalize API endpoint.
- No enrollment session deletion.
- No reset of the source generation.
- No MongoDB multi-document transaction.
- No plaintext centroid / embedding / claim token logging.
- No direct `BIOMETRIC_ENCRYPTION_KEY` access — the encryption
  utility owns key handling.
- No manual AES — only the existing PHASE 4.1
  `encryptBiometricVector` utility.
- No new statuses beyond `"active"`.
- No decrypt / re-encrypt of accepted samples.

## Phase 4.6B2C temporary-enrollment consumption + crash recovery (server-only)

PHASE 4.6B2C consumes the temporary `FaceEnrollmentSession`
AFTER PHASE 4.6B2B has already persisted the finalized
`FaceProfile`. The orchestration lives at
`apps/web/src/lib/biometrics/face-enrollment-completion-service.ts`
and is exposed **only** as the server-only function
`completeFinalizedFaceEnrollmentForUser(userId)`. There is
**no** public finalize API route in B2C.

### FaceProfile IS the commit point

B2C treats `FaceProfile` as the durable commit point, not the
temporary session deletion. Cleanup is idempotent and post-commit.
Therefore:

- Cleanup failure must NOT roll back `FaceProfile`.
- A retry must NOT attempt to create a second `FaceProfile`.
- A retry must NOT rerun B1B, MUST NOT call the Face Service,
  MUST NOT decrypt or re-encrypt samples.

### Strict CAS consume (NORMAL path)

`consumeEnrollmentSession({ userId, generationId, claimToken })`
performs a single atomic `findOneAndDelete` whose filter
requires `userId`, `generationId`,
`finalizationClaim.token`, and `finalizationClaim.generationId`.
The claim token is the server-side capability matching the B2A
issuance. No read → check → write path is used.

### Lineage-bound consume (CRASH-RECOVERY path)

`recoverAndConsumeEnrollmentSession({ userId, generationId })`
performs a single atomic `findOneAndDelete` whose filter
requires BOTH `userId` AND `generationId`. No claim token is
required — the durable `FaceProfile.sourceEnrollmentGenerationId`
already proves commit. A different generation is NEVER deleted.

### Privacy

The B2C completion result (`FinalizedEnrollmentCompletion`)
carries only:

```ts
{
  configured: boolean;
  enrolledAt: Date | null;
  sampleCount: number | null;
  cleanupStatus: "consumed" | "already_consumed" | "cleanup_pending";
}
```

It NEVER carries `userId`, `claimToken`,
`sourceEnrollmentGenerationId`, `centroid`, embeddings,
ciphertext, IV, authTag, keyVersion, model metadata, or any
other biometric payload. The claim token is server-only and is
deleted atomically with the session — it never appears in the
return value, in any log line, or in any browser DTO.

### What B2C does NOT do

- No browser route / Server Action / UI.
- No finalize API endpoint yet (public finalize belongs to 4.6B3).
- No re-enrollment.
- No `FaceProfile` deletion.
- No MongoDB multi-document transaction.
- No B1B rerun / no Face Service call.
- No biometric decryption / encryption / re-encryption.
- No claim release on the success path — `releaseEnrollmentFinalizationClaim`
  belongs to B2B's failure path. B2C atomically consumes the
  whole session via strict CAS or leaves it alone.
- No delete-by-userId-only operation.
- No browser storage (`localStorage` / `sessionStorage` /
  IndexedDB / Cache API).
- No direct `BIOMETRIC_ENCRYPTION_KEY` access.
- No logging of plaintext biometric data, claim tokens, or
  generation IDs. Safe log fields, if any, are limited to the
  standard application error code + message.

## Phase 5.1D2B teacher-owner roster read model privacy posture

PHASE 5.1D2B ships the server-only authenticated
teacher-owner roster read boundary as a plain `async`
function (`getClassRosterForCurrentTeacher(classId)` in
`apps/web/src/lib/classes/class-read-service.ts`). It is NOT
a Server Action, NOT a REST route, NOT a UI surface. The
privacy / security posture is:

- **Identity from the Better Auth session only.** The
  function derives `userId` from `session.user.id` via
  `getSession()`. The function accepts ONLY `classId` (the
  resource identifier) — `userId`, `teacherUserId`,
  `studentUserId`, `role`, and `membershipId` are NEVER
  accepted from the caller. A hand-crafted caller cannot
  impersonate another viewer. The function performs NO class
  / membership / Profile query on the unauthenticated branch.

- **Profile gating.** The function calls the existing
  `getProfileByUserId(userId)` and requires
  `onboardingCompleted === true`. Missing profile /
  incomplete onboarding → `PROFILE_INCOMPLETE` (the function
  performs NO class / membership / roster query on this
  branch).

- **Role gating is teacher-only.** The function requires
  `profile.role === "teacher"` and returns `TEACHER_REQUIRED`
  BEFORE any class / membership / Profile query is performed
  when the authenticated user is a student (or any
  non-teacher role). A truly unknown role value collapses to
  `CLASS_READ_FAILED` so a legacy Profile cannot leak the
  unknown value through the failure path. This is the
  "no student access" invariant — a student must NOT be
  able to probe the existence of a class through the roster
  boundary.

- **Teacher-owner authorization** uses
  `ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })`.
  The authorization constraint is encoded DIRECTLY in the
  filter — the database itself refuses to surface a class the
  teacher does not own. The implementation does NOT fetch an
  arbitrary class and compare the owner client-side. There is
  intentionally NO separate `NOT_CLASS_OWNER` outward-facing
  code; the result is the generic `CLASS_NOT_ACCESSIBLE`.

- **Active-membership filter.** Only memberships with
  `status === "active"` are surfaced. The query is
  `ClassMembershipModel.find({ classId, status: "active" }).sort({ joinedAt: 1 })`
  (oldest member first). Future statuses (`removed`, etc.)
  cannot leak into the roster. Memberships for any other
  class are excluded by the `classId` filter.

- **`classId` syntax validation.** A malformed `classId` (not
  a canonical 24-hex string) collapses to the SAME
  `CLASS_NOT_ACCESSIBLE` boundary used for missing /
  unauthorized classes. There is intentionally NO separate
  `INVALID_CLASS_ID` code; the browser cannot enumerate valid
  vs. invalid ids via the error path. Malformed ids NEVER
  reach the database — no `CastError`, no raw Mongoose
  exception, no stack trace leak.

- **Failure indistinguishability.** Malformed id, missing
  class, and unauthorized teacher ALL map to the same
  browser-safe `CLASS_NOT_ACCESSIBLE` code. An attacker
  observing the error code cannot differentiate "malformed
  syntax" from "missing class" from "not yours".

- **Archived class behavior.** Archived does NOT automatically
  mean inaccessible. The owner teacher may still read the
  roster of an archived class; the result exposes
  `status: "archived"` safely. No archive controls are
  implemented in this phase.

- **Batched Profile lookup.** Student `userId` values are
  deduplicated and fetched in ONE batched query via the new
  server-only `getStudentProfilesByUserIds(userIds)` primitive
  on `@/lib/profile-service`. There is NO N+1 lookup and NO
  application-memory scan over the `profiles` collection.
  The batch primitive projects ONLY `userId`, `fullName`,
  `identificationCode`, `role`, and `onboardingCompleted` —
  `emailSnapshot`, `phone`, Mongo `_id`, and timestamps are
  NEVER read from the database driver buffer. Profiles that
  are absent, incomplete, or carry a non-student `role` are
  OMITTED from the returned Map so the roster can skip those
  memberships safely.

- **Roster integrity / orphaned memberships.** A corrupt /
  orphaned membership (membership exists but referenced
  Profile is missing / incomplete / non-student) is skipped
  SILENTLY. The orphaned `studentUserId` is NEVER surfaced.
  The read path NEVER mutates or deletes the membership.
  Duplicate corrupt rows for the same `(classId,
  studentUserId)` pair collapse to the EARLIEST `joinedAt`
  (deterministic ordering: oldest member first).

- **Ordering is membership-driven, not Profile-driven.** The
  roster ordering follows the already-sorted membership
  list (`joinedAt` ASC). The Profile batch result order
  CANNOT reorder the roster.

- **No Better Auth user lookup.** The roster never
  queries the Better Auth `user` collection. Profile is the
  application identity source. This avoids exposing
  authentication-layer fields.

- **No biometric / Face Service call.** The roster never
  queries or exposes `FaceProfile`, embeddings, centroids,
  biometric enrollment state, or attendance data. It does
  NOT call the Face Service and does NOT import any
  biometrics module.

- **Safe roster DTO.** The result contains ONLY
  `{ class: { id, name, classCode, status, createdAt, updatedAt },
  students: [{ fullName, identificationCode, joinedAt }] }`.
  It NEVER includes `password`, `passwordHash`,
  `teacherUserId`, `studentUserId`, `membershipId`,
  `emailSnapshot`, `phone`, `email`, Mongoose internals
  (`__v`), biometric fields, raw timestamps, Better Auth
  user data, member counts, credential helpers, or
  attendance data.

- **Read-only.** The module NEVER creates / updates / deletes
  a `Class`, a `ClassMembership`, or a `Profile`. It NEVER
  calls the Face Service. It NEVER reads or writes a
  `FaceProfile`. It NEVER reads `passwordHash`. It NEVER
  calls `verifyClassPassword`, `runDummyPasswordVerification`,
  `hashClassPassword`, or `getClassJoinCredentialByCode`. It
  NEVER touches attendance data. The roster read requires NO
  class password — teacher ownership grants roster
  authorization.

- **Safe error mapping.** Unexpected DB / read failures map
  to `CLASS_READ_FAILED`. Mongo URI, raw query text,
  collection names, raw stack traces, and `CastError` are
  NEVER serialized. The error message never identifies which
  kind of inaccessibility failed.

- **No logging.** Plaintext passwords, `passwordHash`,
  biometric fields, Mongo error messages, `studentUserId`,
  `teacherUserId`, and `membershipId` are NEVER logged. The
  module contains no `console.log` / `logger.*` / `debug(`
  calls.

- **No public API.** No REST route, no Server Action, no UI
  component was added in D2B. The function is consumed
  exclusively by future Server Components / Server Actions
  / Route Handlers (none of which exist in this phase).

- **Internal-only Profile batch primitive.**
  `getStudentProfilesByUserIds` is the server-only Profile
  batch lookup helper. It is exported from
  `@/lib/profile-service` (a server-only module) but is
  intended for internal roster composition only. It projects
  only the roster-safe fields, omits `emailSnapshot` and
  `phone` from the projection, and is NOT re-exported
  through any browser-facing barrel.

## Phase 5.1E1 — `/classes` browser exposure boundary

PHASE 5.1E1 ships the first authenticated **UI surface** on top
of the PHASE 5.1D1 read model: the server-rendered `/classes`
page at `apps/web/src/app/classes/page.tsx`. The page does NOT
introduce any new public HTTP route or Server Action — it is a
thin Server Component that calls `getVisibleClassesForCurrentUser()`
exactly through the established read boundary.

- **No browser persistence.** The page never reads from or
  writes to `localStorage`, `sessionStorage`, IndexedDB, or
  the `Cache` API. Server-side state (`Profile.role` +
  `getVisibleClassesForCurrentUser()`) is the sole source of
  truth.
- **No client-side class fetch.** The page does NOT call
  `fetch("/api/classes")`, does NOT use `useEffect`, does NOT
  introduce SWR or React Query, and does NOT add an `"use
  client"` directive. The Server Component performs exactly
  ONE server-side read per request.
- **Identity is server-derived.** `userId` is taken from the
  Better Auth session, `role` from the persisted Profile.
  The browser cannot supply either value. The role is taken
  straight from the canonical read result, NOT inferred from
  the count of classes or from class ownership.
- **DOM exposure.** The rendered DOM NEVER contains
  `password`, `passwordHash`, `teacherUserId`,
  `studentUserId`, `membershipId`, `emailSnapshot`, `phone`,
  `FaceProfile`, `embedding`, or `centroid`. Only the safe D1
  summary fields (`id`, `name`, `classCode`, `status`,
  `createdAt`) and a derived status label are projected.
- **Failure isolation.** `CLASS_READ_FAILED` is rendered
  through a calm, restrained error block that never exposes
  the raw exception, the Mongo URI, the collection name, or
  the driver stack. `UNAUTHENTICATED` and `PROFILE_INCOMPLETE`
  map to the established `/login` and `/onboarding` redirects.
- **No dead detail link.** The list items are interactive —
  each row is a Next.js `<Link>` to `/classes/<safe-class-id>`
  (PHASE 5.1E4A detail route). The link target carries NO
  query parameters (no `userId`, no `role`, no
  `membershipId`), NO `classCode` credential, NO password, and
  the detail page is server-rendered through D2A. The list
  page does NOT include the link target's `classId` in any
  rendered visible copy other than the safe href; the link
  itself carries the id in the URL only.
- **No Create / Join UI.** The page does NOT render Create
  Class or Join Class buttons, does NOT link to
  `/classes/new` or `/classes/join`, and does NOT invoke
  `createClassAction` or `joinClassAction`. PHASE 5.1E2 and
  PHASE 5.1E3 will add those.

The page does NOT add a `/api/classes` HTTP route, does NOT
add a new runtime dependency, and does NOT modify any prior
phase's read or write semantics.

## Phase 5.1E2 — `/classes/new` + Create-Class browser exposure boundary

PHASE 5.1E2 ships the **teacher-only Create-class browser flow**
that consumes the existing PHASE 5.1B `createClassAction` Server
Action verbatim. This section documents the privacy/security
boundaries that the new `/classes` teacher CTA + the new
`/classes/new` route + the new `CreateClassForm` client
component MUST keep holding.

- **Identity is server-derived at TWO layers.** `/classes/new`
  is a Server Component that runs `getSession()` →
  `getProfileByUserId()` → `profile.role === "teacher"` BEFORE
  it renders any form markup. The client component additionally
  trusts the action's authoritative identity check as a second
  line of defense. The browser cannot supply `userId`,
  `teacherUserId`, `role`, `classCode`, `passwordHash`, or any
  class identifier.
- **The action is the ONLY writer.** `CreateClassForm`
  invokes `createClassAction(input)` directly (typed reference,
  not `fetch`). No HTTP route is added; no
  `fetch("/api/...")` call is made; no `useEffect` triggers a
  write; no `localStorage` / `sessionStorage` / IndexedDB is
  touched.
- **Teacher CTA is role-server-derived.** The "Create class"
  link on `/classes` is rendered ONLY when the EXISTING
  `getVisibleClassesForCurrentUser()` result has
  `role === "teacher"`. Students never see it. The role
  attribute is read from the canonical read DTO — it is
  NEVER inferred from the URL, the session alone, or any
  client-side state.
- **No join UI, no detail UI, no attendance UI.** Students
  hitting `/classes/new` are redirected to `/classes` via the
  established safe navigation. No `/classes/join` route
  exists. No `/classes/[classId]` route exists.
- **No browser password persistence.** The password input is
  `type="password"` with appropriate `autoComplete` tokens.
  The plaintext password is NEVER written to `localStorage`,
  `sessionStorage`, IndexedDB, or the `Cache` API. The
  password is NEVER logged to the console. The password is
  NEVER placed in the URL or in any `query` parameter.
- **No password echo after success.** The success state
  renders ONLY the returned `classCode` (server-generated,
  not the typed password), the returned `name`, and a calm
  "Back to classes" link. The password input is hidden or
  cleared the moment the action returns `ok: true`. The DOM
  NEVER contains the plaintext password after success.
- **No `passwordHash` exposure.** The browser never sees
  `passwordHash`, a `password` echo, a Mongo URI, a Mongo
  error code, an `E11000` literal, a stack trace, or any
  driver / collection name. Failure paths route through
  `role="alert"` blocks that use the action-provided safe
  message verbatim — they do NOT log the raw exception.
- **Bounded server-authoritative generation.** `classCode`
  is generated server-side inside the existing PHASE 5.1B
  action via the bounded-retry helper (at most
  `MAX_CLASS_CODE_ATTEMPTS`). The client NEVER generates a
  code, never receives a partial code, never picks its own
  code, and never retries the action automatically.
- **One user-invoked submission → at most one Server Action
  invocation.** A synchronous `submitInFlightRef` (set before
  the `await`) collapses two rapid presses into ONE call.
  On a safe failure the guard releases so the teacher can
  retry explicitly. No automatic retry exists on
  `CLASS_CODE_GENERATION_FAILED`, `CLASS_CREATION_FAILED`,
  auth failures, or validation failures.
- **The `createClassAction` schema is `.strict()`.** Any
  attempt to smuggle `userId`, `teacherUserId`, `role`,
  `classCode`, `passwordHash`, or `status` through the
  action is rejected server-side by Zod BEFORE the service
  is called. The action never accepts or persists those
  fields at the service layer either.

PHASE 5.1E2 does NOT modify `createClassAction`'s semantics,
schema, or error-code contract. It does NOT modify
`joinClassAction`, the class model, the membership model, the
profile model, the Face Service, or the Better Auth config.
