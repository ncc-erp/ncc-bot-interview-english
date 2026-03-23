import LayoutClient from "@/components/LayoutClient";

export const metadata = {
  title: "Interview Bot Dashboard",
  description: "Admin dashboard",
};

export default function RootLayout({ children }: any) {
  return (
    <html>
      <body>
        <LayoutClient>{children}</LayoutClient>
      </body>
    </html>
  );
}