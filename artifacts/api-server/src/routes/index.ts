import { Router, type IRouter, type RequestHandler } from "express";
import healthRouter from "./health";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import { createInvoicesRouter, type InvoicePersistenceHooks } from "./invoices";
import { createProjectsRouter, type ProjectPersistenceHooks } from "./projects";
import taxRouter from "./tax";
import { createAccessRouter, type AccessPersistenceHooks, type AccessRouterDependencies } from "./access";
import rabTemplatesRouter from "./rab-templates";
import { requireAccess } from "../middlewares/access";
import aiControlPlaneRouter from "./ai-control-plane";

export function createApiRouter(
  accessMiddleware: RequestHandler = requireAccess,
  invoicePersistenceHooks: InvoicePersistenceHooks = {},
  projectPersistenceHooks: ProjectPersistenceHooks = {},
  accessDependencies?: AccessRouterDependencies,
  accessPersistenceHooks: AccessPersistenceHooks = {},
): IRouter {
  const router: IRouter = Router();
  router.use(healthRouter);
  router.use(accessMiddleware);
  router.use(createAccessRouter(accessDependencies, accessPersistenceHooks));
  router.use(activityRouter);
  router.use(dashboardRouter);
  router.use(createInvoicesRouter(invoicePersistenceHooks));
  router.use(createProjectsRouter(projectPersistenceHooks));
  router.use(rabTemplatesRouter);
  router.use(taxRouter);
  router.use(aiControlPlaneRouter);
  return router;
}

export default createApiRouter();
