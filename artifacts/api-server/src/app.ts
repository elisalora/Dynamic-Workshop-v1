import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";
import router from "./routes/index.js";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// Clerk proxy — must be before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Clerk session middleware — resolves auth from cookies on every request
// Use the raw publishable key directly; host-derived keys cause token mismatches
// when the Replit proxy rewrites the host header.
app.use(
  clerkMiddleware({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  }),
);

// Expose publishable key to the browser (public, no auth required)
app.get("/api/auth/config", (_req, res) => {
  res.json({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "" });
});

// Serve static HTML pages (pod, board, console — auth is enforced client-side in console.html)
// Use __dirname (dist/) so this resolves correctly regardless of cwd (dev vs production)
const publicDir = path.resolve(__dirname, "../public");
app.use("/api", express.static(publicDir));

// Health + API routes (router also mounted at /api)
app.use("/api", router);

// Root redirect → facilitator console
app.get("/", (_req, res) => res.redirect("/api/console.html"));

export default app;
