export type ResolvedTheme = "light" | "dark";
export const terminalTheme = (theme: ResolvedTheme) =>
  theme === "dark"
    ? {
        background: "#17191c",
        foreground: "#eceef1",
        cursor: "#a7c6ee",
        selectionBackground: "#35495f",
      }
    : {
        background: "#f7f8fa",
        foreground: "#1d232c",
        cursor: "#315b84",
        selectionBackground: "#dce8f5",
      };
