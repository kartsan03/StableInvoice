import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const rpc = process.env.VITE_RPC_URL ?? "";
  if (command === "build") {
    if (!rpc || /localhost|127\.0\.0\.1/i.test(rpc)) {
      throw new Error(
        "Production build requires VITE_RPC_URL to be a public HTTPS RPC (not localhost).",
      );
    }
    if (!process.env.VITE_PROGRAM_ID) {
      throw new Error("Production build requires VITE_PROGRAM_ID.");
    }
    if (!process.env.VITE_MINT) {
      throw new Error("Production build requires VITE_MINT.");
    }
  }
  return {
    plugins: [react()],
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        buffer: "buffer",
      },
    },
  };
});
