import { ItemType, Prisma } from "@prisma/client";

/**
 * SQL builders for bulk-saving viewer-group permissions.
 *
 * Replaces the previous loop of per-row `prisma.viewerGroupAccessControls
 * .upsert(...)` calls inside `prisma.$transaction(async (tx) => …)`, which
 * needed thousands of round-trips on large datarooms and reliably timed out
 * Prisma's interactive-transaction window for big "Save changes" payloads.
 *
 * The handler combines three statements inside a single transaction:
 *   1. `buildBulkUpsertPermissionsSql` — single `INSERT … ON CONFLICT DO
 *      UPDATE` for every entry in the user-supplied payload.
 *   2. `buildFindAncestorFolderIdsSql` — single recursive-CTE walk of
 *      `DataroomFolder.parentId` returning the distinct ancestor folder ids
 *      of every item the payload is making visible.
 *   3. `buildUpsertAncestorVisibilitySql` — single bulk upsert that forces
 *      `canView=true` on those ancestor folders while preserving any
 *      existing `canDownload`. This is the server-side safety net for
 *      callers (e.g. the post-upload modal in
 *      `set-unified-permissions-modal.tsx`) that submit only a single
 *      document and don't compute parent chains client-side.
 *
 * `id` values are generated client-side as cuids — same convention as the
 * rest of the schema's `@id @default(cuid())` columns — and passed in as
 * normal bound parameters. We deliberately avoid `gen_random_uuid()::text`
 * here so every row in `ViewerGroupAccessControls` keeps a consistent id
 * format.
 *
 * All builders are pure functions over their inputs so we can assert their
 * shape in unit tests without spinning up Postgres.
 */

export type PermissionUpsertRow = {
  /** Pre-generated cuid (same format as `@id @default(cuid())`). */
  id: string;
  itemId: string;
  itemType: ItemType;
  canView: boolean;
  canDownload: boolean;
};

export type AncestorUpsertRow = {
  /** Pre-generated cuid for the new `ViewerGroupAccessControls` row. */
  id: string;
  folderId: string;
};

/**
 * Build the bulk upsert SQL for the user-supplied payload.
 *
 * Returns `null` when `rows` is empty so the caller can skip the round-trip.
 */
export function buildBulkUpsertPermissionsSql(
  groupId: string,
  rows: PermissionUpsertRow[],
): Prisma.Sql | null {
  if (rows.length === 0) return null;

  // We sort by itemId so the row-lock order is stable across concurrent
  // saves for the same group — same property the previous loop relied on.
  const sortedRows = [...rows].sort((a, b) =>
    a.itemId.localeCompare(b.itemId),
  );

  const valueRows = sortedRows.map(
    (row) =>
      Prisma.sql`(${row.id}, ${row.itemId}, ${row.itemType}::"ItemType", ${row.canView}, ${row.canDownload})`,
  );

  return Prisma.sql`
    INSERT INTO "ViewerGroupAccessControls" (
      "id",
      "groupId",
      "itemId",
      "itemType",
      "canView",
      "canDownload",
      "createdAt",
      "updatedAt"
    )
    SELECT
      v."id",
      ${groupId},
      v."itemId",
      v."itemType",
      v."canView",
      v."canDownload",
      NOW(),
      NOW()
    FROM (VALUES ${Prisma.join(valueRows)})
      AS v("id", "itemId", "itemType", "canView", "canDownload")
    ON CONFLICT ("groupId", "itemId") DO UPDATE SET
      "itemType" = EXCLUDED."itemType",
      "canView" = EXCLUDED."canView",
      "canDownload" = EXCLUDED."canDownload",
      "updatedAt" = NOW();
  `;
}

/**
 * Build a single recursive-CTE statement that returns the distinct ancestor
 * folder ids of every item in the payload that is being made visible.
 *
 * Returns `null` when there's nothing visible (no walk needed).
 *
 * Notes:
 * - Constrained to `dataroomId` so a malicious or buggy caller can't trick
 *   us into walking folders in a different dataroom.
 * - Folder→parent walking starts from each visible folder *and* from each
 *   visible document's `folderId`. Root-level documents have no folder, so
 *   they're filtered out (correct: they have no ancestor to make visible).
 */
export function buildFindAncestorFolderIdsSql(
  dataroomId: string,
  visibleDocumentIds: string[],
  visibleFolderIds: string[],
): Prisma.Sql | null {
  if (visibleDocumentIds.length === 0 && visibleFolderIds.length === 0) {
    return null;
  }

  // Empty arrays don't bind cleanly through `= ANY($1::text[])` in every
  // driver path, so substitute a no-match empty array literal when the
  // input is empty.
  const folderArray =
    visibleFolderIds.length > 0
      ? Prisma.sql`ARRAY[${Prisma.join(visibleFolderIds)}]::text[]`
      : Prisma.sql`ARRAY[]::text[]`;
  const documentArray =
    visibleDocumentIds.length > 0
      ? Prisma.sql`ARRAY[${Prisma.join(visibleDocumentIds)}]::text[]`
      : Prisma.sql`ARRAY[]::text[]`;

  return Prisma.sql`
    WITH RECURSIVE
      starting_folders AS (
        SELECT df."id" AS folder_id
        FROM "DataroomFolder" df
        WHERE df."id" = ANY(${folderArray})
          AND df."dataroomId" = ${dataroomId}

        UNION

        SELECT dd."folderId" AS folder_id
        FROM "DataroomDocument" dd
        WHERE dd."id" = ANY(${documentArray})
          AND dd."dataroomId" = ${dataroomId}
          AND dd."folderId" IS NOT NULL
      ),
      ancestor_folders AS (
        SELECT folder_id FROM starting_folders

        UNION

        SELECT df."parentId" AS folder_id
        FROM ancestor_folders af
        JOIN "DataroomFolder" df ON df."id" = af.folder_id
        WHERE df."parentId" IS NOT NULL
      )
    SELECT DISTINCT folder_id
    FROM ancestor_folders
    WHERE folder_id IS NOT NULL;
  `;
}

/**
 * Bulk-upsert the ancestor folder rows produced by
 * `buildFindAncestorFolderIdsSql`. Forces `canView=true` and never touches
 * `canDownload` so we don't clobber an ancestor's existing download grant.
 *
 * The `WHERE existing.canView = FALSE` guard skips no-op writes when the
 * ancestor is already visible — typical case in steady state.
 */
export function buildUpsertAncestorVisibilitySql(
  groupId: string,
  ancestors: AncestorUpsertRow[],
): Prisma.Sql | null {
  if (ancestors.length === 0) return null;

  // Stable lock order to match the main bulk-upsert path.
  const sorted = [...ancestors].sort((a, b) =>
    a.folderId.localeCompare(b.folderId),
  );

  const valueRows = sorted.map(
    (row) => Prisma.sql`(${row.id}, ${row.folderId})`,
  );

  return Prisma.sql`
    INSERT INTO "ViewerGroupAccessControls" (
      "id",
      "groupId",
      "itemId",
      "itemType",
      "canView",
      "canDownload",
      "createdAt",
      "updatedAt"
    )
    SELECT
      v."id",
      ${groupId},
      v."folderId",
      'DATAROOM_FOLDER'::"ItemType",
      TRUE,
      FALSE,
      NOW(),
      NOW()
    FROM (VALUES ${Prisma.join(valueRows)}) AS v("id", "folderId")
    ON CONFLICT ("groupId", "itemId") DO UPDATE SET
      "canView" = TRUE,
      "updatedAt" = NOW()
    WHERE "ViewerGroupAccessControls"."canView" = FALSE;
  `;
}

/**
 * Convenience: split the payload (whatever the client posted) into the two
 * id arrays the recursive CTE needs.
 */
export function extractVisibleItemIds(
  permissions: Record<
    string,
    { itemType: ItemType; view: boolean; download: boolean }
  >,
): { visibleDocumentIds: string[]; visibleFolderIds: string[] } {
  const visibleDocumentIds: string[] = [];
  const visibleFolderIds: string[] = [];
  for (const [itemId, perm] of Object.entries(permissions)) {
    if (!perm.view) continue;
    if (perm.itemType === ItemType.DATAROOM_DOCUMENT) {
      visibleDocumentIds.push(itemId);
    } else if (perm.itemType === ItemType.DATAROOM_FOLDER) {
      visibleFolderIds.push(itemId);
    }
  }
  return { visibleDocumentIds, visibleFolderIds };
}
