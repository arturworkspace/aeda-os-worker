export default {
  async email(message, env, ctx) {
    const rawEmail = await streamToBase64(message.raw);

    const payload = {
      from: message.from,
      to: message.to,
      rawEmail: rawEmail,
      timestamp: Date.now(),
    };

    const webhookPromise = fetch(env.RAILWAY_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': env.WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error('webhook post failed:', err.message);
    });

    const forwardPromise = message.forward('artur@aedawallet.com').catch((err) => {
      console.error('forward failed:', err.message);
    });

    ctx.waitUntil(Promise.all([webhookPromise, forwardPromise]));
  },
};

async function streamToBase64(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return uint8ArrayToBase64(combined);
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
