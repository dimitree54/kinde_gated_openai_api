export interface Env {
  KINDE_DOMAIN: string;           // e.g. "yourbiz.kinde.com"
  OPENAI_API_KEY: string;         // server-side only
  ALLOWED_ORIGIN?: string;        // e.g. "https://yourapp.com"
  DEV_PRO_TOKEN?: string;         // development bypass token
}

const cors = (origin: string | null, env: Env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
});

function handleOptions(req: Request, env: Env) {
  const headers = cors(req.headers.get("Origin"), env);
  if (
    req.headers.get("Origin") &&
    req.headers.get("Access-Control-Request-Method") &&
    req.headers.get("Access-Control-Request-Headers")
  ) return new Response(null, { headers });
  return new Response(null, { headers: { Allow: "POST, OPTIONS", ...headers } });
}

function hasEntitlement(payload: any, key: string): boolean {
  const features = payload?.data?.entitlements ?? payload?.data?.features ?? [];
  if (Array.isArray(features) &&
      features.some((f: any) => f?.key === key || f?.feature_key === key)) return true;

  const plans = payload?.data?.plans ?? [];
  if (Array.isArray(plans) &&
      plans.some((p: any) => p?.key === key)) return true;

  return false;
}

async function validateKindeAccess(userAccessToken: string, env: Env): Promise<{ success: boolean; error?: Response }> {
  const issuer = env.KINDE_DOMAIN.startsWith("http")
    ? env.KINDE_DOMAIN
    : `https://${env.KINDE_DOMAIN}`;
  const entitlementsUrl = `${issuer}/account_api/v1/entitlements`;

  const entRes = await fetch(entitlementsUrl, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
    cf: { cacheTtl: 0 } as any,
  });
  const entJson = await entRes.json().catch(() => ({}));
  if (!entRes.ok) {
    return {
      success: false,
      error: new Response(JSON.stringify({
        message: `Error: Kinde Account API returned ${entRes.status}`,
        details: entJson,
      }), {
        status: entRes.status,
        headers: cors(null, env),
      })
    };
  }

  const REQUIRED_FEATURE = "ai_preprocessing";
  if (!hasEntitlement(entJson, REQUIRED_FEATURE)) {
    return {
      success: false,
      error: new Response(JSON.stringify({
        success: false,
        message: `Error: Permission '${REQUIRED_FEATURE}' not found.`,
      }), {
        status: 403,
        headers: cors(null, env),
      })
    };
  }

  return { success: true };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ message: "Error: Expected POST request." }), {
        status: 405,
        headers: cors(request.headers.get("Origin"), env),
      });
    }

    // 1) Validate user token (with DEV_PRO_TOKEN bypass)
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ message: "Error: Missing or invalid Authorization header." }), {
        status: 401,
        headers: cors(request.headers.get("Origin"), env),
      });
    }
    const userAccessToken = authHeader.split(" ")[1];

    // Check for development bypass token
    if (env.DEV_PRO_TOKEN && userAccessToken === env.DEV_PRO_TOKEN) {
      // Skip Kinde validation for development token
    } else {
      // Normal Kinde validation
      const validation = await validateKindeAccess(userAccessToken, env);
      if (!validation.success) {
        return validation.error!;
      }
    }

    // 3) Forward POST body to OpenAI with streaming enabled
    const body = await request.text();

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: body,
    });

    const headers = new Headers(upstream.headers);
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.delete("Content-Encoding");
    const baseCors = cors(request.headers.get("Origin"), env);
    Object.entries(baseCors).forEach(([k, v]) => headers.set(k, v as string));

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};