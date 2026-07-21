import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Cormorant_Garamond, Inter } from "next/font/google";
import { RegisterServiceWorker } from "./register-service-worker";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0d1b2e" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1720" },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "LaBaJo & Co — l'école financière de la famille",
    description: "Suivre les cadeaux Bitcoin, les portefeuilles et les missions d'investissement de toute la famille.",
    manifest: "/manifest.webmanifest",
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: { index: false, follow: false },
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "LaBaJo & Co",
    },
    icons: {
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      shortcut: "/favicon.svg",
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      title: "LaBaJo & Co",
      description: "L'école financière de la famille",
      images: [{ url: `${origin}/og.png`, width: 1792, height: 936 }],
    },
    twitter: { card: "summary_large_image", images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className={`antialiased ${cormorantGaramond.variable} ${inter.variable}`}>
        <a href="#main-content" className="skip-link">
          Aller au contenu principal
        </a>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}