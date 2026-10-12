import { NextResponse } from "next/server";
import crypto from "crypto";

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export async function GET(request: Request) {
  try {
    const baseUrl = process.env.BASE_URL || "https://apigee-golden-demos-prod.35-190-67-22.nip.io";
    const origin = new URL(baseUrl).origin;

    // 1. Dynamic Client Registration against Apigee OASM registry
    const dcrUrl = `${origin}/atlassian-mcp/v1/mcp/authv2/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`;

    // Disable TLS unauthorized check
    const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const host = request.headers.get("host") || "localhost:3000";
    const protocol = host.startsWith("localhost") ? "http" : "https";
    const redirectUri = `${protocol}://${host}/api/auth/atlassian/callback`;

    console.log(`[OAuth DCR] Registering client with redirect_uri: ${redirectUri}`);

    const response = await fetch(dcrUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_name: "NextChat",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "read:me read:account offline_access email read:jira-work write:jira-work search:confluence read:confluence-user read:page:confluence write:page:confluence read:comment:confluence write:comment:confluence read:space:confluence read:hierarchical-content:confluence write:component:compass read:component:compass read:scorecard:compass write:scorecard:compass read:event:compass read:metric:compass read:all:twg write:all:twg",
      }),
    });

    if (originalRejectUnauthorized !== undefined) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
    } else {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Apigee Dynamic Client Registration failed: HTTP ${response.status} - ${errText}`);
    }

    const dcrData = await response.json();
    console.log("[OAuth DCR] DCR Response Data:", JSON.stringify(dcrData));
    const { client_id, client_secret } = dcrData;

    if (!client_id) {
      throw new Error(`DCR response missing client_id: ${JSON.stringify(dcrData)}`);
    }

    // Generate PKCE values
    const { verifier, challenge } = generatePkce();
    // Generate dynamic state parameter
    const state = crypto.randomBytes(16).toString("hex");

    // 2. Redirect to Apigee Authorize URL
    const authorizeUrl = `${origin}/atlassian-mcp/oauth2/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=${encodeURIComponent(
      "read:me read:account offline_access email read:jira-work write:jira-work search:confluence read:confluence-user read:page:confluence write:page:confluence read:comment:confluence write:comment:confluence read:space:confluence read:hierarchical-content:confluence write:component:compass read:component:compass read:scorecard:compass write:scorecard:compass read:event:compass read:metric:compass read:all:twg write:all:twg",
    )}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&prompt=consent`;

    console.log(`[OAuth DCR] Redirecting to Authorize URL: ${authorizeUrl}`);

    const res = NextResponse.redirect(authorizeUrl);
    // Set HTTP-only cookies containing client_id, client_secret, PKCE code_verifier, and state
    res.cookies.set("atlassian_client_id", client_id, { httpOnly: true, secure: protocol === "https" });
    res.cookies.set("atlassian_code_verifier", verifier, { httpOnly: true, secure: protocol === "https" });
    res.cookies.set("atlassian_oauth_state", state, { httpOnly: true, secure: protocol === "https" });
    if (client_secret) {
      res.cookies.set("atlassian_client_secret", client_secret, { httpOnly: true, secure: protocol === "https" });
    }

    return res;
  } catch (error) {
    console.error(`[OAuth DCR Error]: ${error}`);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
