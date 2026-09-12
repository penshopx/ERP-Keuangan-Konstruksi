import { Router, type IRouter } from "express";
import healthRouter from "./health";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import invoicesRouter from "./invoices";
import projectsRouter from "./projects";
import taxRouter from "./tax";

const router: IRouter = Router();

router.use(healthRouter);
router.use(activityRouter);
router.use(dashboardRouter);
router.use(invoicesRouter);
router.use(projectsRouter);
router.use(taxRouter);

export default router;
