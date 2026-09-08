import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { AppShell } from "@/components/AppShell";
import { Providers } from "@/components/Providers";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    template: "%s — Face Attendance",
    default: "Face Attendance",
  },
  description: "Web-based facial-recognition attendance for classrooms.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  const profile = session
    ? await getProfileByUserId(session.user.id)
    : null;

  const user =
    session && profile?.onboardingCompleted
      ? {
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
          role: profile.role,
        }
      : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} font-sans antialiased`}>
        <Providers>
          <AppShell user={user}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
