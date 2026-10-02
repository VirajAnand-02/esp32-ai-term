import type { Metadata } from "next";
import { JetBrains_Mono, VT323 } from "next/font/google";
import "./globals.css";

const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });
const vt323 = VT323({ variable: "--font-vt323", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "AI-TERM // control", template: "%s · AI-TERM" },
  description: "Control server for ESP32 AI terminals",
};

// Applies the saved CRT-effects preference before first paint.
const fxScript = `try{document.documentElement.dataset.fx=localStorage.getItem("aiterm.fx")==="off"?"off":"on"}catch(e){document.documentElement.dataset.fx="on"}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-fx="on" className={`${jetbrains.variable} ${vt323.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: fxScript }} />
      </head>
      <body className="min-h-dvh">
        {children}
        <div className="crt-overlay" aria-hidden>
          <div className="crt-sweep" />
        </div>
      </body>
    </html>
  );
}
