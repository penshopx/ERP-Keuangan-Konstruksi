import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  inventoryMovementsTable,
  materialVarianceEventsTable,
  materialVarianceExceptionsTable,
  materialWasteToleranceVersionsTable,
  materialsTable,
  projectCostCodesTable,
  projectsTable,
  rabBaselinesTable,
  rabItemsTable,
  rabMaterialRequirementsTable,
} from "@workspace/db";
import {
  CreateInventoryMovementBody,
  CreateInventoryMovementResponse,
  CreateInventoryMovementParams,
  CreateMaterialRequirementBody,
  CreateMaterialRequirementParams,
  CreateMaterialRequirementResponse,
  GetProjectMaterialReconciliationParams,
  GetProjectMaterialReconciliationResponse,
  UpdateMaterialVarianceExceptionBody,
  UpdateMaterialVarianceExceptionParams,
  UpdateMaterialVarianceExceptionResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";
import { calculateMaterialVariance, MATERIAL_QUANTITY_SCALE } from "../lib/material-reconciliation";

function quantity(value: number) {
  return value / MATERIAL_QUANTITY_SCALE;
}

function calendarDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function movementResponse(row: typeof inventoryMovementsTable.$inferSelect) {
  return {
    ...row,
    quantity: quantity(row.quantityMicros),
    baseQuantity: quantity(row.baseQuantityMicros),
  };
}

async function accessibleProject(req: Parameters<typeof canAccessProject>[0], projectId: string) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project || !canAccessProject(req, project.id)) return null;
  return project;
}

const router: IRouter = Router();

router.get("/projects/:projectId/material-reconciliation", requirePermission("projects:view"), async (req, res): Promise<void> => {
  const parsed = GetProjectMaterialReconciliationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const project = await accessibleProject(req, parsed.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan atau berada di luar penugasan Anda" });
    return;
  }
  const [baseline] = await db.select().from(rabBaselinesTable)
    .where(eq(rabBaselinesTable.projectId, project.id))
    .orderBy(desc(rabBaselinesTable.version))
    .limit(1);
  if (!baseline) {
    res.status(404).json({ error: "Baseline RAB tidak ditemukan" });
    return;
  }

  const asOf = new Date();
  const day = asOf.toISOString().slice(0, 10);
  const requirements = await db.select({
    requirement: rabMaterialRequirementsTable,
    rabItem: rabItemsTable,
    material: materialsTable,
  }).from(rabMaterialRequirementsTable)
    .innerJoin(rabItemsTable, eq(rabItemsTable.id, rabMaterialRequirementsTable.rabItemId))
    .innerJoin(materialsTable, eq(materialsTable.id, rabMaterialRequirementsTable.materialId))
    .where(and(
      eq(rabMaterialRequirementsTable.baselineId, baseline.id),
      lte(rabMaterialRequirementsTable.effectiveFrom, day),
      or(isNull(rabMaterialRequirementsTable.effectiveTo), gte(rabMaterialRequirementsTable.effectiveTo, day)),
    )).orderBy(desc(rabMaterialRequirementsTable.analysisVersion), desc(rabMaterialRequirementsTable.effectiveFrom));
  const effectiveRequirements = [...new Map(
    requirements.map((row) => [`${row.requirement.rabItemId}:${row.requirement.materialId}`, row]),
  ).values()];
  const movements = await db.select().from(inventoryMovementsTable)
    .where(and(eq(inventoryMovementsTable.projectId, project.id), eq(inventoryMovementsTable.baselineId, baseline.id)))
    .orderBy(desc(inventoryMovementsTable.occurredAt));
  const tolerances = await db.select().from(materialWasteToleranceVersionsTable)
    .where(and(
      or(isNull(materialWasteToleranceVersionsTable.projectId), eq(materialWasteToleranceVersionsTable.projectId, project.id)),
      lte(materialWasteToleranceVersionsTable.effectiveFrom, day),
      or(isNull(materialWasteToleranceVersionsTable.effectiveTo), gte(materialWasteToleranceVersionsTable.effectiveTo, day)),
    )).orderBy(desc(materialWasteToleranceVersionsTable.effectiveFrom));
  const existingExceptions = await db.select().from(materialVarianceExceptionsTable)
    .where(and(eq(materialVarianceExceptionsTable.projectId, project.id), eq(materialVarianceExceptionsTable.baselineId, baseline.id)));

  const movementKey = (costCodeId: string, materialId: string) => `${costCodeId}:${materialId}`;
  const movementsByKey = new Map<string, typeof movements>();
  for (const movement of movements) {
    const key = movementKey(movement.costCodeId, movement.materialId);
    movementsByKey.set(key, [...(movementsByKey.get(key) ?? []), movement]);
  }
  const exceptionByKey = new Map(existingExceptions.map((item) => [movementKey(item.costCodeId, item.materialId), item]));

  const items = await db.transaction(async (tx) => {
    const results = [];
    for (const { requirement, rabItem, material } of effectiveRequirements) {
      const evidence = movementsByKey.get(movementKey(requirement.costCodeId, requirement.materialId)) ?? [];
      const applicableTolerance = tolerances
        .filter((candidate) =>
          (!candidate.materialId || candidate.materialId === requirement.materialId) &&
          (!candidate.costCodeId || candidate.costCodeId === requirement.costCodeId) &&
          (!candidate.workCategory || candidate.workCategory === rabItem.category))
        .sort((a, b) => {
          const specificity = (row: typeof a) => Number(Boolean(row.projectId)) + Number(Boolean(row.costCodeId)) + Number(Boolean(row.materialId)) + Number(Boolean(row.workCategory));
          return specificity(b) - specificity(a);
        })[0];
      const toleranceBasisPoints = applicableTolerance?.toleranceBasisPoints ?? 0;
      const calculation = calculateMaterialVariance({
        workQuantityBasisPoints: rabItem.quantityBasisPoints,
        coefficientMicros: requirement.coefficientMicros,
        toleranceBasisPoints,
        movements: evidence,
      });
      const {
        totals,
        theoreticalQuantityMicros: theoreticalMicros,
        consumedQuantityMicros: consumedMicros,
        toleranceQuantityMicros: toleranceMicros,
        varianceQuantityMicros: varianceMicros,
        exceedsTolerance,
      } = calculation;
      let exception = exceptionByKey.get(movementKey(requirement.costCodeId, requirement.materialId));

      if (exceedsTolerance) {
        const values = {
          theoreticalQuantityMicros: theoreticalMicros,
          consumedQuantityMicros: consumedMicros,
          varianceQuantityMicros: varianceMicros,
          toleranceQuantityMicros: toleranceMicros,
          toleranceVersionId: applicableTolerance?.id ?? null,
        };
        if (exception) {
          const shouldReopen = exception.status === "CLOSED" && exception.consumedQuantityMicros !== consumedMicros;
          [exception] = await tx.update(materialVarianceExceptionsTable).set({
            ...values,
            ...(shouldReopen ? {
              status: "OPEN",
              classification: null,
              disposition: null,
              reviewedBy: null,
              reviewedAt: null,
              closedBy: null,
              closedAt: null,
            } : {}),
          })
            .where(eq(materialVarianceExceptionsTable.id, exception.id)).returning();
          if (shouldReopen) {
            await tx.insert(materialVarianceEventsTable).values({
              id: randomUUID(),
              exceptionId: exception.id,
              eventType: "REOPENED",
              actorUserId: req.access!.userId,
              actorName: req.access!.displayName,
              detail: "Exception dibuka kembali karena movement baru mengubah pemakaian dan selisih masih melewati toleransi.",
              metadata: { consumedQuantityMicros: consumedMicros, varianceQuantityMicros: varianceMicros },
            });
          }
        } else {
          const [createdException] = await tx.insert(materialVarianceExceptionsTable).values({
            id: randomUUID(),
            projectId: project.id,
            baselineId: baseline.id,
            costCodeId: requirement.costCodeId,
            rabItemId: requirement.rabItemId,
            materialId: requirement.materialId,
            ...values,
          }).onConflictDoNothing().returning();
          if (createdException) {
            exception = createdException;
            await tx.insert(materialVarianceEventsTable).values({
              id: randomUUID(),
              exceptionId: exception.id,
              eventType: "DETECTED",
              actorUserId: req.access!.userId,
              actorName: req.access!.displayName,
              detail: "Selisih pemakaian melewati kebutuhan dan toleransi deterministik.",
              metadata: { analysisVersion: requirement.analysisVersion },
            });
          } else {
            [exception] = await tx.select().from(materialVarianceExceptionsTable).where(and(
              eq(materialVarianceExceptionsTable.projectId, project.id),
              eq(materialVarianceExceptionsTable.baselineId, baseline.id),
              eq(materialVarianceExceptionsTable.costCodeId, requirement.costCodeId),
              eq(materialVarianceExceptionsTable.materialId, requirement.materialId),
            )).limit(1);
          }
        }
      }

      const events = exception
        ? await tx.select().from(materialVarianceEventsTable).where(eq(materialVarianceEventsTable.exceptionId, exception.id)).orderBy(desc(materialVarianceEventsTable.createdAt))
        : [];
      const exceptionResponse = exception ? {
        ...exception,
        theoreticalQuantity: quantity(exception.theoreticalQuantityMicros),
        consumedQuantity: quantity(exception.consumedQuantityMicros),
        varianceQuantity: quantity(exception.varianceQuantityMicros),
        toleranceQuantity: quantity(exception.toleranceQuantityMicros),
        events,
      } : null;
      results.push({
        rabItemId: requirement.rabItemId,
        costCodeId: requirement.costCodeId,
        workCode: rabItem.code,
        workName: rabItem.name,
        materialId: material.id,
        materialCode: material.code,
        materialName: material.name,
        unit: material.baseUnit,
        analysisVersion: requirement.analysisVersion,
        coefficient: quantity(requirement.coefficientMicros),
        theoreticalQuantity: quantity(theoreticalMicros),
        tolerancePercent: toleranceBasisPoints / 100,
        toleranceQuantity: quantity(toleranceMicros),
        allowedQuantity: quantity(theoreticalMicros + toleranceMicros),
        procuredQuantity: quantity(totals.get("PROCURED") ?? 0),
        receivedQuantity: quantity(totals.get("RECEIVED") ?? 0),
        issuedQuantity: quantity(totals.get("ISSUED") ?? 0),
        returnedQuantity: quantity(totals.get("RETURNED") ?? 0),
        installedQuantity: quantity(totals.get("INSTALLED") ?? 0),
        invoicedQuantity: quantity(totals.get("INVOICED") ?? 0),
        actualCostQuantity: quantity(totals.get("ACTUAL_COST") ?? 0),
        consumedQuantity: quantity(consumedMicros),
        varianceQuantity: quantity(varianceMicros),
        exceedsTolerance,
        exception: exceptionResponse,
        evidence: evidence.map(movementResponse),
      });
    }
    return results;
  });

  res.json(GetProjectMaterialReconciliationResponse.parse({
    projectId: project.id,
    baselineId: baseline.id,
    asOf,
    openExceptionCount: items.filter((item) => item.exception?.status !== "CLOSED" && item.exceedsTolerance).length,
    items,
  }));
});

router.post("/projects/:projectId/material-requirements", requirePermission("projects:write"), async (req, res): Promise<void> => {
  const params = CreateMaterialRequirementParams.safeParse(req.params);
  const body = CreateMaterialRequirementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Konfigurasi kebutuhan material tidak valid" });
    return;
  }
  const project = await accessibleProject(req, params.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan atau berada di luar penugasan Anda" });
    return;
  }
  if (body.data.effectiveTo && body.data.effectiveTo < body.data.effectiveFrom) {
    res.status(400).json({ error: "Tanggal akhir berlaku tidak boleh sebelum tanggal mulai" });
    return;
  }
  const [rabItem] = await db.select({ item: rabItemsTable, baseline: rabBaselinesTable })
    .from(rabItemsTable)
    .innerJoin(rabBaselinesTable, eq(rabBaselinesTable.id, rabItemsTable.baselineId))
    .where(and(
      eq(rabItemsTable.id, body.data.rabItemId),
      eq(rabItemsTable.baselineId, body.data.baselineId),
      eq(rabBaselinesTable.projectId, project.id),
    )).limit(1);
  if (!rabItem || !rabItem.item.costCodeId) {
    res.status(400).json({ error: "Item RAB dan cost code harus termasuk baseline proyek ini" });
    return;
  }
  const costCodeId = rabItem.item.costCodeId;
  const effectiveFrom = calendarDate(body.data.effectiveFrom);
  const effectiveTo = body.data.effectiveTo ? calendarDate(body.data.effectiveTo) : null;

  try {
    const result = await db.transaction(async (tx) => {
      let [material] = await tx.select().from(materialsTable).where(eq(materialsTable.code, body.data.materialCode)).limit(1);
      if (material && material.baseUnit !== body.data.unit) {
        throw new Error("MATERIAL_UNIT_MISMATCH");
      }
      if (!material) {
        [material] = await tx.insert(materialsTable).values({
          id: randomUUID(),
          code: body.data.materialCode,
          name: body.data.materialName,
          baseUnit: body.data.unit,
        }).returning();
      }
      const overlap = and(
        eq(rabMaterialRequirementsTable.baselineId, body.data.baselineId),
        eq(rabMaterialRequirementsTable.rabItemId, body.data.rabItemId),
        eq(rabMaterialRequirementsTable.materialId, material.id),
        effectiveTo ? lte(rabMaterialRequirementsTable.effectiveFrom, effectiveTo) : undefined,
        or(isNull(rabMaterialRequirementsTable.effectiveTo), gte(rabMaterialRequirementsTable.effectiveTo, effectiveFrom)),
      );
      const [overlappingRequirement] = await tx.select({ id: rabMaterialRequirementsTable.id })
        .from(rabMaterialRequirementsTable).where(overlap).limit(1);
      if (overlappingRequirement) throw new Error("REQUIREMENT_PERIOD_OVERLAP");

      const [requirement] = await tx.insert(rabMaterialRequirementsTable).values({
        id: randomUUID(),
        baselineId: body.data.baselineId,
        rabItemId: body.data.rabItemId,
        costCodeId,
        materialId: material.id,
        analysisVersion: body.data.analysisVersion,
        coefficientMicros: Math.round(body.data.coefficient * MATERIAL_QUANTITY_SCALE),
        unit: body.data.unit,
        effectiveFrom,
        effectiveTo,
      }).returning();
      await tx.insert(materialWasteToleranceVersionsTable).values({
        id: randomUUID(),
        projectId: project.id,
        costCodeId,
        materialId: material.id,
        workCategory: rabItem.item.category,
        toleranceBasisPoints: Math.round(body.data.tolerancePercent * 100),
        effectiveFrom,
        effectiveTo,
        reason: body.data.reason,
        createdBy: req.access!.userId,
      });
      await tx.insert(auditLogsTable).values({
        id: randomUUID(),
        action: "DIKONFIGURASI",
        entity: "MaterialRequirement",
        entityId: requirement.id,
        detail: `${material.code} · koefisien ${body.data.coefficient} · toleransi ${body.data.tolerancePercent}%`,
        user: req.access!.displayName,
        actorUserId: req.access!.userId,
        actorRole: req.access!.role,
        tone: "info",
        metadata: { projectId: project.id, baselineId: body.data.baselineId, rabItemId: body.data.rabItemId, analysisVersion: body.data.analysisVersion },
      });
      return { requirement, material };
    });
    res.status(201).json(CreateMaterialRequirementResponse.parse({
      ...result.requirement,
      materialCode: result.material.code,
      materialName: result.material.name,
      coefficient: quantity(result.requirement.coefficientMicros),
      tolerancePercent: body.data.tolerancePercent,
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "MATERIAL_UNIT_MISMATCH") {
      res.status(409).json({ error: "Kode material sudah digunakan dengan satuan dasar berbeda" });
      return;
    }
    if (error instanceof Error && error.message === "REQUIREMENT_PERIOD_OVERLAP") {
      res.status(409).json({ error: "Periode requirement material tumpang tindih dengan versi yang sudah ada" });
      return;
    }
    throw error;
  }
});

router.post("/projects/:projectId/inventory-movements", requirePermission("projects:write"), async (req, res): Promise<void> => {
  const params = CreateInventoryMovementParams.safeParse(req.params);
  const body = CreateInventoryMovementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Data pergerakan material tidak valid" });
    return;
  }
  const project = await accessibleProject(req, params.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan atau berada di luar penugasan Anda" });
    return;
  }
  const [baseline] = await db.select().from(rabBaselinesTable).where(and(
    eq(rabBaselinesTable.id, body.data.baselineId),
    eq(rabBaselinesTable.projectId, project.id),
  )).limit(1);
  if (!baseline) {
    res.status(400).json({ error: "Baseline tidak termasuk proyek ini" });
    return;
  }
  const [costCode] = await db.select().from(projectCostCodesTable).where(and(
    eq(projectCostCodesTable.id, body.data.costCodeId),
    eq(projectCostCodesTable.projectId, project.id),
  )).limit(1);
  const [requirement] = await db.select({ id: rabMaterialRequirementsTable.id }).from(rabMaterialRequirementsTable).where(and(
    eq(rabMaterialRequirementsTable.baselineId, body.data.baselineId),
    eq(rabMaterialRequirementsTable.costCodeId, body.data.costCodeId),
    eq(rabMaterialRequirementsTable.materialId, body.data.materialId),
  )).limit(1);
  if (!costCode || !requirement) {
    res.status(400).json({ error: "Cost code dan material harus termasuk requirement baseline proyek ini" });
    return;
  }
  const [created] = await db.transaction(async (tx) => {
    const rows = await tx.insert(inventoryMovementsTable).values({
      id: randomUUID(),
      projectId: project.id,
      baselineId: body.data.baselineId,
      costCodeId: body.data.costCodeId,
      materialId: body.data.materialId,
      movementType: body.data.movementType,
      quantityMicros: Math.round(body.data.quantity * MATERIAL_QUANTITY_SCALE),
      unit: body.data.unit,
      baseQuantityMicros: Math.round(body.data.baseQuantity * MATERIAL_QUANTITY_SCALE),
      sourceDocumentType: body.data.sourceDocumentType,
      sourceDocumentId: body.data.sourceDocumentId,
      sourceDocumentNumber: body.data.sourceDocumentNumber,
      occurredAt: body.data.occurredAt,
      notes: body.data.notes ?? null,
      createdBy: req.access!.userId,
    }).returning();
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: "DICATAT",
      entity: "InventoryMovement",
      entityId: rows[0].id,
      detail: `${body.data.movementType} ${body.data.quantity} ${body.data.unit} · ${body.data.sourceDocumentNumber}`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: "info",
      metadata: { projectId: project.id, costCodeId: body.data.costCodeId, materialId: body.data.materialId },
    });
    return rows;
  });
  res.status(201).json(CreateInventoryMovementResponse.parse(movementResponse(created)));
});

router.patch("/projects/:projectId/material-exceptions/:exceptionId", requirePermission("projects:write"), async (req, res): Promise<void> => {
  const params = UpdateMaterialVarianceExceptionParams.safeParse(req.params);
  const body = UpdateMaterialVarianceExceptionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Disposition exception tidak valid" });
    return;
  }
  const project = await accessibleProject(req, params.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan atau berada di luar penugasan Anda" });
    return;
  }
  const [current] = await db.select().from(materialVarianceExceptionsTable).where(and(
    eq(materialVarianceExceptionsTable.id, params.data.exceptionId),
    eq(materialVarianceExceptionsTable.projectId, project.id),
  )).limit(1);
  if (!current) {
    res.status(404).json({ error: "Exception material tidak ditemukan" });
    return;
  }
  const now = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(materialVarianceExceptionsTable).set({
      status: body.data.status,
      classification: body.data.classification,
      disposition: body.data.disposition,
      reviewedBy: req.access!.userId,
      reviewedAt: now,
      closedBy: body.data.status === "CLOSED" ? req.access!.userId : null,
      closedAt: body.data.status === "CLOSED" ? now : null,
    }).where(eq(materialVarianceExceptionsTable.id, current.id)).returning();
    await tx.insert(materialVarianceEventsTable).values({
      id: randomUUID(),
      exceptionId: current.id,
      eventType: body.data.status === "CLOSED" ? "CLOSED" : "DISPOSITIONED",
      actorUserId: req.access!.userId,
      actorName: req.access!.displayName,
      detail: body.data.disposition,
      metadata: { classification: body.data.classification, previousStatus: current.status, status: body.data.status },
    });
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: body.data.status === "CLOSED" ? "DITUTUP" : "DITINJAU",
      entity: "MaterialVarianceException",
      entityId: current.id,
      detail: `${body.data.classification} · ${body.data.disposition}`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: body.data.status === "CLOSED" ? "success" : "info",
      metadata: { projectId: project.id, previousStatus: current.status, status: body.data.status },
    });
    return rows;
  });
  const events = await db.select().from(materialVarianceEventsTable).where(eq(materialVarianceEventsTable.exceptionId, updated.id)).orderBy(desc(materialVarianceEventsTable.createdAt));
  res.json(UpdateMaterialVarianceExceptionResponse.parse({
    ...updated,
    theoreticalQuantity: quantity(updated.theoreticalQuantityMicros),
    consumedQuantity: quantity(updated.consumedQuantityMicros),
    varianceQuantity: quantity(updated.varianceQuantityMicros),
    toleranceQuantity: quantity(updated.toleranceQuantityMicros),
    events,
  }));
});

export default router;