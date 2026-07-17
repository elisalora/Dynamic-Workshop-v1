import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sessionsRouter from "./sessions.js";
import workshopsRouter from "./workshops.js";
import tablesRouter from "./tables.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionsRouter);
router.use("/workshops", workshopsRouter);
router.use("/tables", tablesRouter);

export default router;
