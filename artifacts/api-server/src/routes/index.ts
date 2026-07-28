import { Router, type IRouter } from "express";
import healthRouter from "./health";
import groupsRouter from "./groups.js";
import sessionsRouter from "./sessions.js";
import workshopsRouter from "./workshops.js";
import tablesRouter from "./tables.js";
import searchRouter from "./search.js";
import adminRouter from "./admin.js";
import wsRouter from "./ws.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(groupsRouter);
router.use(sessionsRouter);
router.use(workshopsRouter);
router.use("/tables", tablesRouter);
router.use(searchRouter);
router.use(adminRouter);
router.use(wsRouter);

export default router;
