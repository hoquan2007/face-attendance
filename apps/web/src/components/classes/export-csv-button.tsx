/**
 * `ExportCsvButton` — Client Component for CSV export download.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY + CSV EXPORT.
 *
 * Triggers a download of the attendance session as a CSV file.
 */

"use client";

import * as React from "react";
import { Download } from "lucide-react";

export interface ExportCsvButtonProps {
  classId: string;
  sessionId: string;
}

/**
 * Triggers a browser download of the attendance CSV.
 */
export function ExportCsvButton({
  classId,
  sessionId,
}: ExportCsvButtonProps) {
  const [isDownloading, setIsDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  const handleExport = React.useCallback(async () => {
    if (isDownloading) return;

    setIsDownloading(true);
    setDownloadError(null);

    try {
      const url = `/api/attendance/export?classId=${encodeURIComponent(classId)}&sessionId=${encodeURIComponent(sessionId)}`;

      const response = await fetch(url);

      if (!response.ok) {
        let errorMessage = "Export failed";
        try {
          const errorData = await response.json();
          if (errorData && typeof errorData === "object" && "error" in errorData) {
            errorMessage = String((errorData as { error: unknown }).error);
          }
        } catch {
          // Ignore JSON parse errors.
        }
        setDownloadError(errorMessage);
        return;
      }

      // Get the filename from Content-Disposition header.
      const contentDisposition = response.headers.get("Content-Disposition");
      let filename = "attendance-export.csv";
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^";\n]+)"?/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      // Create blob and trigger download.
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
    } catch {
      setDownloadError("Export failed. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  }, [classId, sessionId, isDownloading]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleExport}
        disabled={isDownloading}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
        data-export-csv-button="true"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {isDownloading ? "Exporting..." : "Export as CSV"}
      </button>
      {downloadError ? (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-export-csv-error="true"
        >
          {downloadError}
        </p>
      ) : null}
    </div>
  );
}
