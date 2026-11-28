// Local / self-hosted entry point. On Vercel the same application is served by api/index.js.
//   npm start          (uses SQLite unless DATABASE_URL is set)
const http = require("http");
const { createRuntime } = require("./src/bootstrap");

createRuntime()
  .then(({ app, config }) => {
    const server = http.createServer((req, res) => {
      app.handle(req, res).catch(e => {
        console.error("[server] unhandled:", e);
        if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); }
        res.end(JSON.stringify({ error: "Something went wrong on our side. Please try again." }));
      });
    });
    server.listen(config.port, () => {
      console.log(`WISHLY running at http://localhost:${config.port}`);
      if (!config.paymongoConfigured) console.log("[payments] PAYMONGO_SECRET_KEY not set: browsing works, checkout is disabled.");
    });
  })
  .catch(e => { console.error("Failed to start WISHLY:", e.message); process.exit(1); });
