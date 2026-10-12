import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "../config/server";
import { OPENAI_BASE_URL, ServiceProvider } from "../constant";
import { cloudflareAIGatewayUrl } from "../utils/cloudflare";
import { getModelProvider, isModelNotavailableInServer } from "../utils/model";

const serverConfig = getServerSideConfig();

interface ClassifierDetails {
  tier: string;
  complexity: string;
  task: string;
}

function resolveClassifierDetails(
  requestedModel: string,
  routedModel: string,
  headers?: Headers | null,
): ClassifierDetails {
  let tier = headers?.get("x-gateway-judge-tier") || "";
  let complexity = headers?.get("x-gateway-judge-complexity") || "";
  let task = headers?.get("x-gateway-judge-task") || "";

  // Check if requested model explicitly specifies a tier: e.g. auto:judge:low, auto:judge:high, auto:judge:max
  if (!tier && requestedModel.includes(":")) {
    const parts = requestedModel.split(":");
    if (parts.length >= 3) {
      tier = parts[2].toLowerCase();
    }
  }

  const modelLower = (routedModel || "").toLowerCase();

  // If tier is not provided by header or model name, infer from the routed model
  if (!tier) {
    if (modelLower.includes("opus")) {
      tier = "max";
    } else if (modelLower.includes("sonnet")) {
      tier = "high";
    } else if (modelLower.includes("haiku")) {
      tier = "low";
    } else if (modelLower.includes("flash-lite")) {
      tier = "low";
    } else if (modelLower.includes("pro")) {
      tier = "high";
    } else if (modelLower.includes("flash")) {
      tier = "medium";
    } else {
      tier = "standard";
    }
  }

  // Determine complexity
  if (!complexity) {
    switch (tier.toLowerCase()) {
      case "low":
        complexity = "1-3";
        break;
      case "medium":
        complexity = "4-6";
        break;
      case "high":
        complexity = "7-8";
        break;
      case "max":
        complexity = "9-10";
        break;
      default:
        complexity = "1-5";
    }
  }

  // Determine task
  if (!task) {
    switch (tier.toLowerCase()) {
      case "low":
        task = "simple_chat / fast_query";
        break;
      case "medium":
        task = "general_reasoning";
        break;
      case "high":
        task = "complex_coding / multi_step";
        break;
      case "max":
        task = "deep_reasoning / formal_analysis";
        break;
      default:
        task = "general";
    }
  }

  return {
    tier: tier.charAt(0).toUpperCase() + tier.slice(1),
    complexity,
    task,
  };
}

function buildGatewayTelemetrySuffix(
  res: Response,
  json: any,
  requestedModelName?: string,
): string {
  const isCacheHit = res.headers.get("x-cache")?.toUpperCase() === "HIT";
  const totalTokens =
    res.headers.get("x-gateway-total-tokens") ||
    json.usage?.total_tokens ||
    "unknown";
  const routedModel = (
    res.headers.get("x-gateway-routed-model") ||
    res.headers.get("x-llm-model-selected") ||
    json.model ||
    "gemini-2.5-flash"
  ).replace(/^google\//, "");
  const requestedModel =
    res.headers.get("x-gateway-requested-model") ||
    requestedModelName ||
    "";
  const totalCost = res.headers.get("x-gateway-total-cost-usd");

  let banner = isCacheHit
    ? `\n\n*🤖 Cache: HIT | Model: ${routedModel}`
    : `\n\n*🤖 Selected Model: ${routedModel}`;

  const isSmartRouter =
    requestedModel.startsWith("auto:judge") ||
    routedModel !== requestedModel;

  if (requestedModel && requestedModel.startsWith("auto:judge")) {
    banner = `\n\n*🤖 Smart Router: ${requestedModel} ➔ ${routedModel}`;
  }

  if (isSmartRouter) {
    const classifier = resolveClassifierDetails(
      requestedModel,
      routedModel,
      res.headers,
    );
    banner += ` | Tier: ${classifier.tier} | Complexity: ${classifier.complexity} | Task: ${classifier.task}`;
  }

  if (totalCost && parseFloat(totalCost) > 0) {
    banner += ` | Cost: $${parseFloat(totalCost).toFixed(6)}`;
  }
  if (!isCacheHit) banner += ` | Cache: MISS`;
  banner += ` | Total Tokens: ${totalTokens}*`;

  return banner;
}

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();

  const isAzure = req.nextUrl.pathname.includes("azure/deployments");

  var authValue,
    authHeaderName = "";
  if (isAzure) {
    authValue =
      req.headers
        .get("Authorization")
        ?.trim()
        .replaceAll("Bearer ", "")
        .trim() ?? "";

    authHeaderName = "api-key";
  } else {
    authValue = req.headers.get("Authorization") ?? "";
    authHeaderName = "Authorization";
  }

  let path = `${req.nextUrl.pathname}`.replaceAll("/api/openai/", "");

  let baseUrl =
    (isAzure ? serverConfig.azureUrl : serverConfig.baseUrl) || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  if (path.startsWith("v1/")) {
    if (baseUrl.includes("llm-ai-gateway") || baseUrl.endsWith("/v1")) {
      path = path.substring(3);
    }
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (isAzure) {
    const azureApiVersion =
      req?.nextUrl?.searchParams?.get("api-version") ||
      serverConfig.azureApiVersion;
    baseUrl = baseUrl.split("/deployments").shift() as string;
    path = `${req.nextUrl.pathname.replaceAll(
      "/api/azure/",
      "",
    )}?api-version=${azureApiVersion}`;

    // Forward compatibility:
    // if display_name(deployment_name) not set, and '{deploy-id}' in AZURE_URL
    // then using default '{deploy-id}'
    if (serverConfig.customModels && serverConfig.azureUrl) {
      const modelName = path.split("/")[1];
      let realDeployName = "";
      serverConfig.customModels
        .split(",")
        .filter((v) => !!v && !v.startsWith("-") && v.includes(modelName))
        .forEach((m) => {
          const [fullName, displayName] = m.split("=");
          const [_, providerName] = getModelProvider(fullName);
          if (providerName === "azure" && !displayName) {
            const [_, deployId] = (serverConfig?.azureUrl ?? "").split(
              "deployments/",
            );
            if (deployId) {
              realDeployName = deployId;
            }
          }
        });
      if (realDeployName) {
        console.log("[Replace with DeployId", realDeployName);
        path = path.replaceAll(modelName, realDeployName);
      }
    }
  }

  const fetchUrl = cloudflareAIGatewayUrl(`${baseUrl}/${path}`);
  console.log("fetchUrl", fetchUrl);

  let customHeaders: Record<string, string> = {};
  if (process.env.CUSTOM_HEADERS) {
    try {
      customHeaders = JSON.parse(process.env.CUSTOM_HEADERS);
    } catch (e) {
      console.error("[Server Config] failed to parse CUSTOM_HEADERS", e);
    }
  }
  const clientToken = req.headers.get("Authorization")?.replace("Bearer ", "").trim();
  if (clientToken && clientToken.length > 5) {
    customHeaders["x-apikey"] = clientToken;
  } else if (process.env.APIGEE_API_KEY) {
    customHeaders["x-apikey"] = process.env.APIGEE_API_KEY;
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(authValue && { [authHeaderName]: authValue }),
      ...(serverConfig.openaiOrgId && {
        "OpenAI-Organization": serverConfig.openaiOrgId,
      }),
      "Accept-Encoding": "identity",
      ...customHeaders,
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  let requestedModel = "";
  let isTopicGeneration = false;
  // #1815 try to refuse gpt4 request
  if (req.body) {
    let clonedBody = "";
    try {
      clonedBody = await req.clone().text();
      console.log("[Proxy Request] raw body length:", clonedBody.length);
      isTopicGeneration =
        clonedBody.includes("title summarizing our conversation") ||
        clonedBody.includes("generate a four to five word title");
      const jsonBody = JSON.parse(clonedBody) as {
        model?: string;
        temperature?: number;
        top_p?: number;
        messages?: Array<{ role: string; content: string }>;
      };
      requestedModel = jsonBody?.model || "";

      // Vertex AI Anthropic Claude throws a 400 error if both temperature and top_p are specified
      if (
        jsonBody.temperature !== undefined &&
        jsonBody.top_p !== undefined &&
        (requestedModel.startsWith("auto:judge") ||
          requestedModel.toLowerCase().includes("claude") ||
          baseUrl.includes("nip.io") ||
          baseUrl.includes("apigee"))
      ) {
        delete jsonBody.top_p;
      }

      // Vertex AI Anthropic Claude requires conversation to end with a user message
      // and does not support assistant message prefill. NextChat appends a trailing
      // { role: "system", content: "Summarize the discussion..." } when auto-summarizing.
      // Transforming a trailing system message to a user message avoids the 400 prefill error.
      if (
        Array.isArray(jsonBody.messages) &&
        jsonBody.messages.length > 0
      ) {
        const lastMsg = jsonBody.messages[jsonBody.messages.length - 1];
        if (lastMsg && lastMsg.role === "system") {
          lastMsg.role = "user";
        }
      }

      fetchOptions.body = JSON.stringify(jsonBody);

      // #1815 try to refuse gpt4 request
      if (serverConfig.customModels) {
        const checkModel = (jsonBody?.model as string)?.startsWith("auto:judge")
          ? "auto:judge"
          : (jsonBody?.model as string);
        if (
          isModelNotavailableInServer(
            serverConfig.customModels,
            checkModel,
            [
              ServiceProvider.OpenAI,
              ServiceProvider.Azure,
              checkModel, // support provider-unspecified model
            ],
          )
        ) {
          return NextResponse.json(
            {
              error: true,
              message: `you are not allowed to use ${jsonBody?.model} model`,
            },
            {
              status: 403,
            },
          );
        }
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter / proxy intercept error:", e);
      if (clonedBody) {
        fetchOptions.body = clonedBody;
      }
    }
  }

  try {
    console.log("[Proxy Request] method:", fetchOptions.method, "headers:", fetchOptions.headers);
    console.log("[Proxy Request] body:", fetchOptions.body);
    const res = await fetch(fetchUrl, fetchOptions);

    // Extract the OpenAI-Organization header from the response
    const openaiOrganizationHeader = res.headers.get("OpenAI-Organization");

    // Check if serverConfig.openaiOrgId is defined and not an empty string
    if (serverConfig.openaiOrgId && serverConfig.openaiOrgId.trim() !== "") {
      // If openaiOrganizationHeader is present, log it; otherwise, log that the header is not present
      console.log("[Org ID]", openaiOrganizationHeader);
    } else {
      console.log("[Org ID] is not set up.");
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // Conditionally delete the OpenAI-Organization header from the response if [Org ID] is undefined or empty (not setup in ENV)
    // Also, this is to prevent the header from being sent to the client
    if (!serverConfig.openaiOrgId || serverConfig.openaiOrgId.trim() === "") {
      newHeaders.delete("OpenAI-Organization");
    }

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    let responseBody: string | ReadableStream<Uint8Array> | null = res.body;
    const contentType = res.headers.get("content-type") || "";
    const isStream = contentType.includes("text/event-stream");

    console.log("[Proxy Response] status:", res.status, "content-type:", contentType, "isStream:", isStream);
    console.log("[Proxy Response Headers]", Object.fromEntries(res.headers.entries()));

    if (isStream && res.body) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      let selectedModel = (res.headers.get("x-gateway-routed-model") || "").replace(/^google\//, "");
      let totalTokens = parseInt(res.headers.get("x-gateway-total-tokens") || "0", 10) || 0;
      const totalCostHeader = res.headers.get("x-gateway-total-cost-usd");
      const judgeTaskHeader = res.headers.get("x-gateway-judge-task");
      const judgeComplexityHeader = res.headers.get("x-gateway-judge-complexity");

      const transformStream = new TransformStream({
        transform(chunk, controller) {
          // Parse SSE lines to detect selected model and usage tokens, and filter out upstream [DONE]
          try {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed === "data: [DONE]" || trimmed.startsWith("data: [DONE]")) {
                // Do NOT forward upstream [DONE] early; flush() will emit the badge first, then send [DONE]
                continue;
              }
              if (trimmed.startsWith("data:")) {
                const dataStr = trimmed.slice(5).trim();
                if (dataStr) {
                  try {
                    const data = JSON.parse(dataStr);
                    if (data.model) {
                      selectedModel = data.model.replace(/^google\//, "");
                    }
                    if (data.usage?.total_tokens) {
                      totalTokens = data.usage.total_tokens;
                    }
                  } catch {}
                }
              }
              controller.enqueue(encoder.encode(line + "\n"));
            }
          } catch {
            controller.enqueue(chunk);
          }
        },
        flush(controller) {
          if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed !== "data: [DONE]" && !trimmed.startsWith("data: [DONE]")) {
              controller.enqueue(encoder.encode(buffer + "\n\n"));
            }
          }
          if (selectedModel) {
            let badge = "";
            const isSmartRouter =
              requestedModel.startsWith("auto:judge") ||
              selectedModel !== requestedModel;

            if (requestedModel && requestedModel.startsWith("auto:judge")) {
              badge = `\n\n*🤖 Smart Router: ${requestedModel} ➔ ${selectedModel}`;
            } else {
              badge = `\n\n*🤖 Selected Model: ${selectedModel}`;
            }

            if (isSmartRouter) {
              const classifier = resolveClassifierDetails(
                requestedModel,
                selectedModel,
                res.headers,
              );
              badge += ` | Tier: ${classifier.tier} | Complexity: ${classifier.complexity} | Task: ${classifier.task}`;
            }

            if (totalCostHeader && parseFloat(totalCostHeader) > 0) {
              badge += ` | Cost: $${parseFloat(totalCostHeader).toFixed(6)}`;
            }
            if (totalTokens > 0) {
              badge += ` | Tokens: ${totalTokens}`;
            }
            badge += "*";

            const badgeChunk = {
              id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: selectedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: badge,
                  },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(badgeChunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        },
      });
      responseBody = res.body.pipeThrough(transformStream);
    }

    if (res.status === 200) {
      if (!isStream) {
        try {
          const text = await res.text();
          console.log("[Proxy Response] body text:", text);
          try {
            const json = JSON.parse(text);
            let textContent = "";
            let modelName = json.modelVersion || json.model || "gemini-2.5-pro";
            let hasContent = false;
            let isBlocked = false;

            if (json.candidates && Array.isArray(json.candidates)) {
              hasContent = true;
              isBlocked = true;
              json.candidates.forEach((candidate: any) => {
                if (candidate.content && candidate.content.parts) {
                  candidate.content.parts.forEach((part: any) => {
                    if (part.text) {
                      textContent += part.text;
                    }
                  });
                }
              });
              textContent += `\n\n*🛡️ Blocked by Gateway Safety Policy*`;
            } else if (json.choices && Array.isArray(json.choices)) {
              hasContent = true;
              json.choices.forEach((choice: any) => {
                if (choice.message && choice.message.content) {
                  textContent += choice.message.content;
                }
              });
              textContent += buildGatewayTelemetrySuffix(res, json, requestedModel);
            } else if (json.content && Array.isArray(json.content)) {
              hasContent = true;
              json.content.forEach((item: any) => {
                if (item.type === "text" && item.text) {
                  textContent += item.text;
                }
              });
              if (json.usage && !json.usage.total_tokens) {
                json.usage.total_tokens =
                  (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0);
              }
              textContent += buildGatewayTelemetrySuffix(res, json, requestedModel);
            }

            if (hasContent) {
              console.log("[Proxy Response] translating payload to OpenAI format...");

              let isClientStreaming = false;
              try {
                const reqClone = req.clone();
                const reqJson = await reqClone.json();
                isClientStreaming = !!reqJson.stream;
              } catch (e) {
                isClientStreaming = req.headers.get("Accept")?.includes("text/event-stream") || false;
              }
              console.log("[Proxy Response] detected client stream expectation:", isClientStreaming);

              const clientModelName = modelName || "Gateway LLM";

              if (isClientStreaming) {
                newHeaders.set("Content-Type", "text/event-stream");
                const chunk1 = {
                  id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: clientModelName,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: textContent || "",
                      },
                      finish_reason: null,
                    },
                  ],
                };
                const chunk2 = {
                  id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: clientModelName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                };
                responseBody = `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;
              } else {
                if (isBlocked) {
                  const choices = [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: textContent,
                      },
                      finish_reason: "stop",
                    }
                  ];

                  const openaiPayload = {
                    id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: clientModelName,
                    choices,
                    usage: {},
                  };
                  responseBody = JSON.stringify(openaiPayload);
                } else {
                  const contentSuffix = isTopicGeneration
                    ? ""
                    : buildGatewayTelemetrySuffix(res, json, requestedModel);
                  const openaiPayload = {
                    ...json,
                    model: clientModelName,
                    choices: json.choices.map((choice: any) => ({
                      ...choice,
                      message: {
                        ...choice.message,
                        content: choice.message.content + contentSuffix,
                      }
                    }))
                  };
                  responseBody = JSON.stringify(openaiPayload);
                }
              }
            } else {
              responseBody = text;
            }
          } catch (e: any) {
            console.log("[Proxy Response] JSON parse error:", e.message);
            responseBody = text;
          }
        } catch (e: any) {
          console.log("[Proxy Response] text read error:", e.message);
        }
      }
    } else {
      try {
        const errText = await res.text();
        console.log("[Proxy Response] ERROR body text:", errText);

        let isModelArmor = false;
        let modelArmorMsg = "";
        try {
          const errJson = JSON.parse(errText);
          const faultstring = errJson?.fault?.faultstring || "";
          const errorcode = errJson?.fault?.detail?.errorcode || "";
          if (
            faultstring.includes("Model armor template filter matched") ||
            errorcode.includes("steps.sanitize.user.prompt")
          ) {
            isModelArmor = true;
            const reasons: string[] = [];
            if (/PIMatchesFound:\s*true/i.test(faultstring)) reasons.push("Prompt Injection / Jailbreak detected (`PIMatchesFound`)");
            if (/SDPMatchesFound:\s*true/i.test(faultstring)) reasons.push("Sensitive Data / Secrets detected (`SDPMatchesFound`)");
            if (/RAIMatchesFound:\s*true/i.test(faultstring)) reasons.push("Responsible AI Violation (`RAIMatchesFound`)");
            if (/CSAMMatchesFound:\s*true/i.test(faultstring)) reasons.push("CSAM Policy Violation (`CSAMMatchesFound`)");
            if (/URIMatchesFound:\s*true/i.test(faultstring)) reasons.push("Malicious URI (`URIMatchesFound`)");

            const reasonText = reasons.length > 0 ? reasons.join(", ") : "Safety filter triggered";

            modelArmorMsg = `🛡️ **Blocked by Apigee Model Armor**\n\nYour prompt was flagged and blocked by the gateway's security policy before reaching the LLM:\n- **Triggered Filter**: ${reasonText}\n- **Policy**: \`${errorcode || "steps.sanitize.user.prompt.FilterMatched"}\`\n\n*Please rephrase or remove the flagged instructions and try again.*`;
          }
        } catch {}

        if (isModelArmor) {
          let isClientStreaming = false;
          try {
            const reqClone = req.clone();
            const reqJson = await reqClone.json();
            isClientStreaming = !!reqJson.stream;
          } catch (e) {
            isClientStreaming = req.headers.get("Accept")?.includes("text/event-stream") || false;
          }

          if (isClientStreaming) {
            newHeaders.set("Content-Type", "text/event-stream");
            const chunk1 = {
              id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "Apigee Model Armor",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: modelArmorMsg,
                  },
                  finish_reason: null,
                },
              ],
            };
            const chunk2 = {
              id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "Apigee Model Armor",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            return new Response(
              `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`,
              {
                status: 200,
                headers: newHeaders,
              },
            );
          } else {
            const openaiPayload = {
              id: "chatcmpl-" + (res.headers.get("x-request-id") || Math.random().toString(36).substring(7)),
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "Apigee Model Armor",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: modelArmorMsg,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {},
            };
            return new Response(JSON.stringify(openaiPayload), {
              status: 200,
              headers: newHeaders,
            });
          }
        }

        responseBody = errText;
      } catch (e: any) {
        console.log("[Proxy Response] failed to read ERROR body:", e.message);
      }
    }

    return new Response(responseBody, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
