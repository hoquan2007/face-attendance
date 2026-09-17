/**
 * `GET /api/attendance/export` — CSV export for closed attendance sessions.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY + CSV EXPORT.
 *
 * Authenticated Teacher-only API route that exports a closed attendance
 * session as an Excel-compatible CSV file.
 *
 * ## Authorization
 *
 *   - Requires Better Auth session
 *   - Requires completed Teacher Profile
 *   - Requires teacher role
 *   - Requires class ownership
 *   - Session must belong to the specified class
 *   - Session must be CLOSED
 *
 * ## Query parameters
 *
 *   - `classId`   — Mongo ObjectId string of the class
 *   - `sessionId` — Mongo ObjectId string of the attendance session
 *
 * ## CSV format
 *
 *   - UTF-8 with BOM for Vietnamese text compatibility in Excel
 *   - Columns: STT, Họ và tên, Mã sinh viên, Trạng thái, Thời gian nhận diện
 *   - Present rows: recognizedAt formatted
 *   - Absent rows: blank recognizedAt
 *   - Correct CSV escaping (commas, quotes, newlines)
 *   - Formula injection protection for text cells
 *   - Safe filename: attendance-<classCode>-<date>.csv
 *
 * ## Privacy
 *
 *   - Exports ONLY: fullName, identificationCode, status, recognizedAt
 *   - NEVER exports: studentUserId, AttendanceMark._id, teacherUserId,
 *     membershipId, FaceProfile, embeddings, centroids, biometric data
 *
 * ## Constraints
 *
 *   - Active sessions are rejected (only closed sessions exported)
 *   - Uses UTF-8 BOM for Excel/Vietnamese compatibility
 *   - No XLSX dependency
 */

import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getAttendanceFinalSummaryForCurrentTeacher,
  ATTENDANCE_FINAL_SUMMARY_ERROR_CODES,
  type SafeAttendanceFinalSummaryDto,
} from "@/lib/attendance/attendance-final-summary-read-service";
import {
  ClassModel,
} from "@/lib/classes/class-model";

// =============================================================================
// Constants
// =============================================================================

/** UTF-8 BOM prefix for Excel/Vietnamese compatibility */
const UTF8_BOM = "\uFEFF";

/** CSV header row */
const CSV_HEADERS = [
  "STT",
  "Họ và tên",
  "Mã sinh viên",
  "Trạng thái",
  "Thời gian nhận diện",
];

/** Spreadsheet formula prefixes that must be neutralized */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r", "\n"];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validates a Mongo ObjectId string.
 */
function isValidObjectId(id: string): boolean {
  if (typeof id !== "string" || id.length !== 24) return false;
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Sanitizes a cell value for CSV export, preventing:
 * 1. CSV injection via formula prefixes
 * 2. CSV structural issues via proper escaping
 *
 * Formula injection protection: cells starting with =, +, -, @, tab, CR, LF
 * are neutralized by prefixing with a single quote.
 */
function sanitizeCellValue(value: string | null | undefined): string {
  if (value == null) return "";

  const str = String(value);

  // Formula injection protection: neutralize spreadsheet formula prefixes.
  // A cell value starting with =, +, -, @, or whitespace (which can be
  // interpreted as formula continuation) is prefixed with a single quote.
  if (str.length > 0 && str[0] !== undefined && FORMULA_PREFIXES.includes(str[0])) {
    return "'" + str;
  }

  return str;
}

/**
 * Formats recognizedAt timestamp for CSV export.
 * Returns empty string for absent students.
 */
function formatRecognizedAtForCsv(iso: string | null): string {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    // Format: YYYY-MM-DD HH:mm:ss (24-hour, consistent)
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch {
    return "";
  }
}

/**
 * Escapes a value for CSV format:
 * - Fields containing comma, double-quote, or newline are wrapped in double-quotes
 * - Double-quotes inside the field are escaped by doubling them ("")
 */
function escapeCSVField(value: string): string {
  const needsQuoting =
    value.includes(",") || value.includes('"') || value.includes("\n");

  if (needsQuoting) {
    // Escape double-quotes by doubling them, then wrap in quotes.
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return value;
}

/**
 * Builds one CSV row from a student's attendance data.
 */
function buildCSVRow(
  index: number,
  fullName: string,
  identificationCode: string,
  status: "present" | "absent",
  recognizedAt: string | null,
): string {
  const fields = [
    String(index),
    sanitizeCellValue(fullName),
    sanitizeCellValue(identificationCode),
    status === "present" ? "Present" : "Absent",
    formatRecognizedAtForCsv(recognizedAt),
  ];

  return fields.map(escapeCSVField).join(",");
}

/**
 * Builds the complete CSV content.
 */
function buildCSVContent(summary: SafeAttendanceFinalSummaryDto): string {
  const rows: string[] = [];

  // Add header row.
  rows.push(CSV_HEADERS.join(","));

  // Add student rows in rosterSnapshot order.
  for (let i = 0; i < summary.students.length; i++) {
    const student = summary.students[i];
    if (!student) continue;
    const row = buildCSVRow(
      i + 1, // STT starts at 1
      student.fullName,
      student.identificationCode,
      student.status,
      student.recognizedAt,
    );
    rows.push(row);
  }

  return rows.join("\r\n");
}

/**
 * Sanitizes a filename component (removes/replaces dangerous characters).
 */
function sanitizeFilenameComponent(value: string): string {
  // Remove characters that are problematic in filenames.
  // Allow: alphanumeric, spaces, hyphens, underscores.
  // Remove: slashes, backslashes, colons, asterisks, question marks,
  //         quotes, angle brackets, pipes, etc.
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

/**
 * Builds a safe filename for the CSV export.
 * Format: attendance-<classCode>-<date>.csv
 */
function buildSafeFilename(classCode: string, dateIso: string): string {
  let dateStr = "session";
  try {
    const date = new Date(dateIso);
    // Check if date is valid (Invalid Date has NaN for year).
    const year = date.getUTCFullYear();
    if (!Number.isNaN(year)) {
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      dateStr = `${year}${month}${day}`;
    }
    // If year is NaN, keep "session" fallback.
  } catch {
    // Use fallback.
  }

  const sanitizedClassCode = sanitizeFilenameComponent(classCode);
  return `attendance-${sanitizedClassCode}-${dateStr}.csv`;
}

// =============================================================================
// Route handler
// =============================================================================

export async function GET(request: NextRequest) {
  // ---- 1. Authentication ----
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  // ---- 2. Profile gating ----
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return NextResponse.json(
      { error: "Export failed" },
      { status: 500 },
    );
  }

  if (!profile || !profile.onboardingCompleted) {
    return NextResponse.json(
      { error: "Profile incomplete" },
      { status: 403 },
    );
  }

  // ---- 3. Role gating ----
  if (profile.role !== "teacher") {
    return NextResponse.json(
      { error: "Only teachers can export attendance" },
      { status: 403 },
    );
  }

  // ---- 4. Parse query parameters ----
  const { searchParams } = new URL(request.url);
  const classId = searchParams.get("classId");
  const sessionId = searchParams.get("sessionId");

  if (!classId || !sessionId) {
    return NextResponse.json(
      { error: "Missing classId or sessionId" },
      { status: 400 },
    );
  }

  if (!isValidObjectId(classId) || !isValidObjectId(sessionId)) {
    return NextResponse.json(
      { error: "Invalid classId or sessionId" },
      { status: 400 },
    );
  }

  // ---- 5. Authorization: verify class ownership ----
  let classDoc;
  try {
    classDoc = await ClassModel.findOne({
      _id: classId,
      teacherUserId: userId,
    })
      .select({ _id: 1, classCode: 1 })
      .lean<{ _id: unknown; classCode: string } | null>()
      .exec();
  } catch {
    return NextResponse.json(
      { error: "Export failed" },
      { status: 500 },
    );
  }

  if (!classDoc) {
    return NextResponse.json(
      { error: "Class not accessible" },
      { status: 404 },
    );
  }

  // ---- 6. Load final summary ----
  const summaryResult = await getAttendanceFinalSummaryForCurrentTeacher(
    classId,
    sessionId,
  );

  if (!summaryResult.ok) {
    // Determine appropriate status code.
    if (
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND ||
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE
    ) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 },
      );
    }
    if (
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_CLOSED
    ) {
      return NextResponse.json(
        { error: "Only closed sessions can be exported" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Export failed" },
      { status: 500 },
    );
  }

  // ---- 7. Build CSV content ----
  const csvContent = buildCSVContent(summaryResult.result);

  // ---- 8. Build safe filename ----
  const filename = buildSafeFilename(
    classDoc.classCode,
    summaryResult.result.session.startedAt,
  );

  // ---- 9. Return CSV response ----
  // UTF-8 BOM is prepended for Excel/Vietnamese compatibility.
  return new NextResponse(UTF8_BOM + csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
