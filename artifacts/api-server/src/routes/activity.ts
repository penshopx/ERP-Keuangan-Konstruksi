import { Router, type IRouter } from "express";
import { ListActivityResponse } from "@workspace/api-zod";
import { activity } from "../lib/demo-data";

const router: IRouter = Router();

router.get("/activity", (_req, res) => {
  res.json(ListActivityResponse.parse(activity));
});

export default router;