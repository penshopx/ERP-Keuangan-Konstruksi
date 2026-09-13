import { Router, type IRouter } from "express";
import healthRouter from "./health";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import invoicesRouter from "./invoices";
import projectsRouter from "./projects";
import taxRouter from "./tax";
import accessRouter from "./access";
import { requireAccess } from "../middlewares/access";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAccess);
router.use(accessRouter);
router.use(activityRouter);
router.use(dashboardRouter);
router.use(invoicesRouter);
router.use(projectsRouter);
router.use(taxRouter);

export default router;
