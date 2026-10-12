import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import fs from "fs/promises";
import path from "path";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) {
      throw new Error("Missing authorization code from callback redirect.");
    }

    const cookieStore = cookies();
    const clientId = cookieStore.get("atlassian_client_id")?.value;
    const clientSecret = cookieStore.get("atlassian_client_secret")?.value;
    const codeVerifier = cookieStore.get("atlassian_code_verifier")?.value;
    const savedState = cookieStore.get("atlassian_oauth_state")?.value;

    if (!clientId) {
      throw new Error("Missing client_id cookie. Authorization session might have expired.");
    }

    if (!state || state !== savedState) {
      throw new Error("State parameter mismatch or invalid. CSRF protection blocked the request.");
    }

    const baseUrl = process.env.BASE_URL || "https://apigee-golden-demos-prod.35-190-67-22.nip.io";
    const origin = new URL(baseUrl).origin;
    const tokenUrl = `${origin}/atlassian-mcp/oauth2/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/token`;

    const host = request.headers.get("host") || "localhost:3000";
    const protocol = host.startsWith("localhost") ? "http" : "https";
    const redirectUri = `${protocol}://${host}/api/auth/atlassian/callback`;

    console.log(`[OAuth Callback] Requesting token from: ${tokenUrl}`);

    const bodyParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      client_id: clientId,
      ...(codeVerifier && { code_verifier: codeVerifier }),
      ...(clientSecret && { client_secret: clientSecret }),
    });

    const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyParams.toString(),
    });

    if (originalRejectUnauthorized !== undefined) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
    } else {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Apigee token exchange failed: HTTP ${response.status} - ${errText}`);
    }

    const tokenData = await response.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error(`Token response missing access_token: ${JSON.stringify(tokenData)}`);
    }

    console.log(`[OAuth Callback] Token received successfully! Saving to server config...`);

    // Write token directly to server-side mcp_config.json
    const configPath = path.join(process.cwd(), "app/mcp/mcp_config.json");
    const configStr = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configStr);

    if (!config.mcpServers["apigee-atlassian-mcp"]) {
      config.mcpServers["apigee-atlassian-mcp"] = {
        command: "direct-post",
        args: [],
        env: {},
      };
    }
    if (!config.mcpServers["apigee-atlassian-mcp"].env) {
      config.mcpServers["apigee-atlassian-mcp"].env = {};
    }
    config.mcpServers["apigee-atlassian-mcp"].env.APIGEE_API_KEY = accessToken;

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`[OAuth Callback] Token successfully saved to server config.`);

    // Return HTML to redirect user back to MCP Market page
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authenticating Atlassian...</title>
        </head>
        <body>
          <p>Authentication successful! Redirecting back to MCP Market...</p>
          <script>
            window.location.href = '/#mcp-market';
          </script>
        </body>
      </html>
    `;

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    console.error(`[OAuth Callback Error]: ${error}`);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
