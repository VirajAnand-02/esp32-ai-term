// Imported first by server.ts so NODE_ENV is set before Next or React load.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= process.argv.includes("--dev") ? "development" : "production";

// The devices take their timezone from this process (posixTz in gateway/index.ts),
// and so do the agent's calendar answers. On the laptop that was IST for free; on
// Render the container runs in UTC, so every clock face read 5:30 behind. Set TZ in
// the host's environment to move it; Node picks up a change to it at runtime.
env.TZ ??= "Asia/Kolkata";
