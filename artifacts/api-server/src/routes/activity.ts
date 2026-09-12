import { Router, type IRouter } from "express";
import { ListActivityResponse } from "@workspace/api-zod";
import { desc } from "drizzle-orm";
import { auditLogsTable, db } from "@workspace/db";

const router: IRouter = Router();

router.get("/activity", async (_req, res) => {
  const activity = await db.select().from(auditLogsTable)
    .orderBy(desc(auditLogsTable.timestamp))
    .limit(100);
  res.json(ListActivityResponse.parse(activity.map(({ entityId: _entityId, metadata: _metadata, ...item }) => ({
    ...item,
    timestamp: item.timestamp.toISOString(),
  }))));
});

export default router;