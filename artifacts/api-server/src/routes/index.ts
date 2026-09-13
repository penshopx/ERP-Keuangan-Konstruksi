import { Router, type IRouter, type RequestHandler } from "express";
import healthRouter from "./health";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import { createInvoicesRouter, type InvoicePersistenceHooks } from "./invoices";
import { createProjectsRouter, type ProjectPersistenceHooks } from "./projects";
import taxRouter from "./tax";
import accessRouter from "./access";
import rabTemplatesRouter from "./rab-templates";
import { requireAccess } from "../middlewares/access";

export function createApiRouter(
  accessMiddleware: RequestHandler = requireAccess,
  invoicePersistenceHooks: InvoicePersistenceHooks = {},
  projectPersistenceHooks: ProjectPersistenceHooks = {},
): IRouter {
  const router: IRouter = Router();
  router.use(healthRouter);
  router.use(accessMiddleware);
  router.use(accessRouter);
  router.use(activityRouter);
  router.use(dashboardRouter);
  router.use(createInvoicesRouter(invoicePersistenceHooks));
  router.use(createProjectsRouter(projectPersistenceHooks));
  router.use(rabTemplatesRouter);
  router.use(taxRouter);
  return router;
}

export default createApiRouter();
