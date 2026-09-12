import http from "node:http";

const port = Number(process.env.PORT || 8787);
const provider = process.env.AIBOT_PROVIDER || "openai-compatible";
const endpoint = process.env.AIBOT_ENDPOINT || (provider === "mideafire" ? process.env.MIDEAFIRE_ENDPOINT : "");
const apiKey = process.env.AIBOT_API_KEY || (provider === "mideafire" ? process.env.MIDEAFIRE_API_KEY : "");
const model = process.env.AIBOT_MODEL || "";
const allowOrigin = process.env.AIBOT_ALLOW_ORIGIN || "";
const maxBody = 256 * 1024;

function headers() {
  const value = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (allowOrigin) value["Access-Control-Allow-Origin"] = allowOrigin;
  return value;
}
function send(response, status, body) { response.writeHead(status, headers()); response.end(JSON.stringify(body)); }
function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; if (data.length > maxBody) reject(new Error("request too large")); });
    request.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("invalid JSON")); } });
    request.on("error", reject);
  });
}
function content(response) {
  if (response?.choices?.[0]?.message?.content) return response.choices[0].message.content;
  if (response?.choices?.[0]?.text) return response.choices[0].text;
  if (response?.plan) return response.plan;
  return response;
}

async function plan(body) {
  if (!endpoint || !model) throw new Error("AIBOT_ENDPOINT and AIBOT_MODEL are required.");
  const payload = {
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "You are a Minecraft autonomous agent. Return JSON only: thought, goal, actions. Never return commands or code. Every action is validated by a deterministic engine." },
      { role: "user", content: JSON.stringify({ observation: body.observation, memory: body.memory, task: body.task }) }
    ],
    response_format: { type: "json_object" }
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${text.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Upstream did not return JSON."); }
  return { plan: content(parsed) };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, { ...headers(), "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); response.end(); return; }
  if (request.method === "GET" && request.url === "/health") { send(response, 200, { ok: true, provider, configured: Boolean(endpoint && model) }); return; }
  if (request.method !== "POST" || request.url !== "/v1/plan") { send(response, 404, { error: "Not found" }); return; }
  try {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || !body.observation || !body.task) { send(response, 400, { error: "observation and task are required" }); return; }
    send(response, 200, await plan(body));
  } catch (error) { send(response, 502, { error: String(error).slice(0, 300) }); }
});

server.listen(port, "0.0.0.0", () => console.log(`AI Bot secure proxy listening on 0.0.0.0:${port}`));
