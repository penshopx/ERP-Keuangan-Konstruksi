import type { RabItem } from "@workspace/db";

type RabItemClone = Omit<RabItem, "id" | "baselineId" | "createdAt" | "updatedAt"> & {
  id: string;
  baselineId: string;
};

export function cloneRabItems(
  items: RabItem[],
  baselineId: string,
  idFactory: () => string,
): RabItemClone[] {
  return items.map(({ id: _id, baselineId: _baselineId, createdAt: _createdAt, updatedAt: _updatedAt, ...businessFields }) => ({
    ...businessFields,
    id: idFactory(),
    baselineId,
  }));
}