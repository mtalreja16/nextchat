import { Analytics } from "@vercel/analytics/react";
import { Home } from "./components/home";
import { getServerSideConfig } from "./config/server";
import { initializeMcpSystem } from "./mcp/actions";

export const dynamic = "force-dynamic";

const serverConfig = getServerSideConfig();

export default async function App() {
  console.log("[DEBUG] rendering root App component at runtime, enableMcp =", serverConfig.enableMcp);

  if (serverConfig.enableMcp) {
    initializeMcpSystem().catch((err) => {
      console.error("[MCP] Startup initialization failed:", err);
    });
  }

  return (
    <>
      <Home />
      {serverConfig?.isVercel && (
        <>
          <Analytics />
        </>
      )}
    </>
  );
}
