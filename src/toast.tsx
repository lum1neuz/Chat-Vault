import hot, { Toaster } from "react-hot-toast";

/** One place for every message ChatVault shows. Errors and confirmations get their own icon, the rest stay plain. */
export function notify(message: string) {
  if (/^error|could not|cannot|can't|failed|not found|denied|unable/i.test(message)) return hot.error(message);
  if (/copied|saved|synced|restored|forked|ready|done|removed|added/i.test(message)) return hot.success(message);
  return hot(message);
}

export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      gutter={8}
      toastOptions={{
        duration: 3500,
        style: {
          background: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontSize: "13px",
          maxWidth: "420px",
          padding: "10px 12px",
          boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
        },
        success: { iconTheme: { primary: "#10b981", secondary: "var(--popover)" } },
        error: { duration: 6000, iconTheme: { primary: "#ef4444", secondary: "var(--popover)" } },
      }}
    />
  );
}
