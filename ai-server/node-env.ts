// Imported first by server.ts so NODE_ENV is set before Next or React load.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= process.argv.includes("--dev") ? "development" : "production";
