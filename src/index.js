export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/update") {
      try {
        await updateData(env);
        return new Response("OK");
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
      }
    }
    return new Response("Oil Data Worker Running");
  },

  async scheduled(event, env) {
    await updateData(env);
  }
};

async function updateData(env) {
  const res = await fetch(
    "https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD",
    {
      headers: {
        Authorization: "Token " + env.OILPRICEAPI_KEY
      }
    }
  );
  if (!res.ok) {
    throw new Error("API returned " + res.status);
  }
  const data = await res.json();
  await env.OIL_KV.put("latest_oil_data", JSON.stringify(data));
}
