// Transactional e-mail through Resend's HTTP API (no SDK). Without RESEND_API_KEY the message is only logged
// (development) and kept in `outbox` (tests) so verification/reset links can still be followed locally.
function createMailer(config, fetchImpl = globalThis.fetch) {
  const outbox = [];
  return {
    outbox,
    configured: !!config.email.resendApiKey,
    async send({ to, subject, text }) {
      outbox.push({ to, subject, text });
      if (outbox.length > 50) outbox.shift();
      if (config.email.silent) return { delivered: false };
      if (!config.email.resendApiKey) {
        if (!config.prod) console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}\n`);
        else console.warn(`[mail] RESEND_API_KEY is not set; e-mail "${subject}" was NOT delivered.`);
        return { delivered: false };
      }
      try {
        const r = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.email.resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: config.email.from, to: [to], subject, text }),
        });
        if (!r.ok) console.error("[mail] provider rejected message:", r.status);
        return { delivered: r.ok };
      } catch (e) {
        console.error("[mail] send failed:", e.message);
        return { delivered: false };
      }
    },
  };
}
module.exports = { createMailer };
