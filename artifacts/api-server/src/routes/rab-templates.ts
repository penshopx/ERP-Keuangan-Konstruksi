import { Router, type IRouter } from "express";
import { db, rabTemplatesTable } from "@workspace/db";
import { ListRabTemplatesResponse } from "@workspace/api-zod";
import { requirePermission } from "../middlewares/access";

const router: IRouter = Router();

router.get("/rab/templates", requirePermission("projects:view"), async (_req, res) => {
  const templates = await db.select().from(rabTemplatesTable).orderBy(rabTemplatesTable.projectType, rabTemplatesTable.name);
  res.json(ListRabTemplatesResponse.parse(templates.map((template) => {
    const items = template.items.map((item) => ({
      ...item,
      parentCode: item.parentCode ?? null,
      budget: Math.round(item.quantity * item.unitPrice),
    }));
    return {
      id: template.id,
      name: template.name,
      projectType: template.projectType,
      description: template.description,
      sourceNote: template.sourceNote,
      itemCount: items.length,
      totalBudget: items.reduce((sum, item) => sum + item.budget, 0),
      items,
    };
  })));
});

export default router;