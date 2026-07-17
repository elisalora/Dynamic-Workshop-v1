import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";
import router from "./routes/index.js";

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML pages — mounted at /api so the proxy prefix is handled
const publicDir = path.resolve(process.cwd(), "public");
app.use("/api", express.static(publicDir));

// Health + API routes (router also mounted at /api)
app.use("/api", router);

export default app;
