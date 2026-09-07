import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Face Attendance System",
  description: "Web-based facial-recognition attendance for classrooms.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Touching env here ensures the app fails fast at boot if misconfigured.
  void env.APP_NAME;
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-50">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}