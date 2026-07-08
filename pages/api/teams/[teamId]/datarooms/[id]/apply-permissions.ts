import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  DefaultPermissionStrategy,
  ItemType,
  RootItemAccess,
} from "@prisma/client";
import { getServerSession } from "next-auth";

import { resolveRootItemAccessFlags } from "@/lib/dataroom/root-item-access";
import { errorhandler } from "@/lib/errorHandler";
import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";

type GroupTarget = "VIEWER_GROUP" | "PERMISSION_GROUP";

type DataroomDocumentRef = {
  id: string;
  documentId: string;
  folderId: string | null;
};

const VALID_STRATEGIES = new Set<string>([
  "INHERIT_FROM_PARENT",
  "ASK_EVERY_TIME",
  "HIDDEN_BY_DEFAULT",
]);

async function revalidateLinksForDataroom(dataroomId: string): Promise<void> {
  try {
    const links = await prisma.link.findMany({
      where: {
        dataroomId,
        deletedAt: null,
        OR: [{ permissionGroupId: { not: null } }, { groupId: { not: null } }],
      },
      select: { id: true, domainId: true },
    });

    if (links.length === 0) return;

    const revalidateUrl = process.env.NEXTAUTH_URL;
    const revalidateToken = process.env.REVALIDATE_TOKEN;
    if (!revalidateUrl || !revalidateToken) return;

    await Promise.all(
      links.map((link) =>
        fetch(
          `${revalidateUrl}/api/revalidate?secret=${revalidateToken}&linkId=${link.id}&hasDomain=${link.domainId ? "true" : "false"}`,
        ).catch((err) =>
          console.error(`Error revalidating link ${link.id}:`, err),
        ),
      ),
    );
  } catch (error) {
    console.error(
      `Error revalidating links for dataroom ${dataroomId}:`,
      error,
    );
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const { teamId, id: dataroomId } = req.query as {
    teamId: string;
    id: string;
  };

  const userId = (session.user as CustomUser).id;

  try {
    // `folderPath` is still sent by older clients but no longer trusted; the
    // containing folder is resolved from each document's own `folderId`.
    const { documentIds, strategy, groupStrategy, linkStrategy } = req.body as {
      documentIds: string[];
      strategy?: string;
      groupStrategy?: string;
      linkStrategy?: string;
      folderPath?: string;
    };

    // Validate input
    if (
      !documentIds ||
      !Array.isArray(documentIds) ||
      documentIds.length === 0
    ) {
      return res.status(400).json({ message: "Document IDs are required" });
    }

    // Validate all provided strategies
    for (const value of [strategy, groupStrategy, linkStrategy]) {
      if (value !== undefined && !VALID_STRATEGIES.has(value)) {
        return res.status(400).json({ message: "Invalid strategy" });
      }
    }

    // Check if the user is part of the team
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        users: { some: { userId } },
      },
    });

    if (!team) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Get dataroom and verify it exists and belongs to the team
    const dataroom = await prisma.dataroom.findUnique({
      where: { id: dataroomId },
      select: {
        id: true,
        teamId: true,
        defaultPermissionStrategy: true,
        defaultGroupPermissionStrategy: true,
        defaultRootItemAccess: true,
        defaultGroupRootItemAccess: true,
      },
    });

    if (!dataroom || dataroom.teamId !== teamId) {
      return res.status(404).json({ message: "Dataroom not found" });
    }

    // Resolve effective strategies. Precedence:
    //   1. Explicit per-target strategy from the request body.
    //   2. Legacy `strategy` field (applied to both targets) for backward
    //      compatibility with older clients that didn't know about the split.
    //   3. The dataroom's stored defaults.
    const effectiveGroupStrategy =
      (groupStrategy as DefaultPermissionStrategy | undefined) ??
      (strategy as DefaultPermissionStrategy | undefined) ??
      dataroom.defaultGroupPermissionStrategy;
    const effectiveLinkStrategy =
      (linkStrategy as DefaultPermissionStrategy | undefined) ??
      (strategy as DefaultPermissionStrategy | undefined) ??
      dataroom.defaultPermissionStrategy;

    // Get dataroom documents for the provided document IDs
    const dataroomDocuments = await prisma.dataroomDocument.findMany({
      where: {
        documentId: { in: documentIds },
        dataroomId,
      },
      select: { id: true, documentId: true, folderId: true },
    });

    if (dataroomDocuments.length === 0) {
      return res
        .status(404)
        .json({ message: "No documents found in this dataroom" });
    }

    // Apply each strategy independently to its target group type
    await Promise.all([
      applyPermissionStrategy({
        dataroomId,
        dataroomDocuments,
        strategy: effectiveGroupStrategy,
        rootItemAccess: dataroom.defaultGroupRootItemAccess,
        target: "VIEWER_GROUP",
      }),
      applyPermissionStrategy({
        dataroomId,
        dataroomDocuments,
        strategy: effectiveLinkStrategy,
        rootItemAccess: dataroom.defaultRootItemAccess,
        target: "PERMISSION_GROUP",
      }),
    ]);

    // Revalidate ISR pages for links with permission restrictions
    await revalidateLinksForDataroom(dataroomId);

    return res.status(200).json({
      message: "Permissions applied successfully",
      documentsProcessed: dataroomDocuments.length,
      groupStrategy: effectiveGroupStrategy,
      linkStrategy: effectiveLinkStrategy,
    });
  } catch (error) {
    errorhandler(error, res);
  }
}

async function applyPermissionStrategy(opts: {
  dataroomId: string;
  dataroomDocuments: DataroomDocumentRef[];
  strategy: DefaultPermissionStrategy;
  rootItemAccess: RootItemAccess;
  target: GroupTarget;
}) {
  const { dataroomId, dataroomDocuments, strategy, rootItemAccess, target } =
    opts;

  // ASK_EVERY_TIME and HIDDEN_BY_DEFAULT both intentionally leave the document
  // hidden until something else writes the access control rows (the unified
  // permissions modal for ASK_EVERY_TIME, manual configuration for
  // HIDDEN_BY_DEFAULT).
  if (strategy !== DefaultPermissionStrategy.INHERIT_FROM_PARENT) return;

  // Group documents by the folder they actually live in (server-side truth,
  // not the client-provided path). Root-level documents have no parent to
  // inherit from and get the dataroom's root-item default instead.
  const rootDocuments: DataroomDocumentRef[] = [];
  const documentsByFolderId = new Map<string, DataroomDocumentRef[]>();
  for (const doc of dataroomDocuments) {
    if (doc.folderId === null) {
      rootDocuments.push(doc);
    } else {
      const list = documentsByFolderId.get(doc.folderId) ?? [];
      list.push(doc);
      documentsByFolderId.set(doc.folderId, list);
    }
  }

  await Promise.all([
    rootDocuments.length > 0
      ? applyRootLevelPermissions(
          dataroomId,
          rootDocuments,
          rootItemAccess,
          target,
        )
      : Promise.resolve(),
    ...Array.from(documentsByFolderId, ([folderId, docs]) =>
      inheritFromContainingFolder(folderId, docs, target),
    ),
  ]);
}

/**
 * Upsert-equivalent for default-permission rows: remove any existing rows for
 * the exact (group, document) pairs we're about to write, then insert the new
 * values. Unlike `createMany({ skipDuplicates: true })`, a stale row (e.g.
 * `canView=false` left behind by an earlier write) is corrected instead of
 * silently kept.
 */
async function upsertViewerGroupDocumentRows(
  data: {
    groupId: string;
    itemId: string;
    itemType: ItemType;
    canView: boolean;
    canDownload: boolean;
  }[],
) {
  if (data.length === 0) return;
  const groupIds = Array.from(new Set(data.map((d) => d.groupId)));
  const itemIds = Array.from(new Set(data.map((d) => d.itemId)));
  await prisma.$transaction([
    prisma.viewerGroupAccessControls.deleteMany({
      where: {
        groupId: { in: groupIds },
        itemId: { in: itemIds },
        itemType: ItemType.DATAROOM_DOCUMENT,
      },
    }),
    prisma.viewerGroupAccessControls.createMany({ data }),
  ]);
}

async function upsertPermissionGroupDocumentRows(
  data: {
    groupId: string;
    itemId: string;
    itemType: ItemType;
    canView: boolean;
    canDownload: boolean;
    canDownloadOriginal: boolean;
  }[],
) {
  if (data.length === 0) return;
  const groupIds = Array.from(new Set(data.map((d) => d.groupId)));
  const itemIds = Array.from(new Set(data.map((d) => d.itemId)));
  await prisma.$transaction([
    prisma.permissionGroupAccessControls.deleteMany({
      where: {
        groupId: { in: groupIds },
        itemId: { in: itemIds },
        itemType: ItemType.DATAROOM_DOCUMENT,
      },
    }),
    prisma.permissionGroupAccessControls.createMany({ data }),
  ]);
}

async function applyRootLevelPermissions(
  dataroomId: string,
  dataroomDocuments: DataroomDocumentRef[],
  rootItemAccess: RootItemAccess,
  target: GroupTarget,
) {
  const flags = resolveRootItemAccessFlags(rootItemAccess);
  // HIDDEN: no rows are written, so the documents stay invisible until an
  // admin grants access explicitly.
  if (!flags) return;

  if (target === "VIEWER_GROUP") {
    const viewerGroups = await prisma.viewerGroup.findMany({
      where: { dataroomId },
      select: { id: true },
    });
    if (viewerGroups.length === 0) return;

    await upsertViewerGroupDocumentRows(
      viewerGroups.flatMap((group) =>
        dataroomDocuments.map((doc) => ({
          groupId: group.id,
          itemId: doc.id,
          itemType: ItemType.DATAROOM_DOCUMENT,
          canView: flags.canView,
          canDownload: flags.canDownload,
        })),
      ),
    );
    return;
  }

  const permissionGroups = await prisma.permissionGroup.findMany({
    where: { dataroomId },
    select: { id: true },
  });
  if (permissionGroups.length === 0) return;

  await upsertPermissionGroupDocumentRows(
    permissionGroups.flatMap((group) =>
      dataroomDocuments.map((doc) => ({
        groupId: group.id,
        itemId: doc.id,
        itemType: ItemType.DATAROOM_DOCUMENT,
        canView: flags.canView,
        canDownload: flags.canDownload,
        canDownloadOriginal: false,
      })),
    ),
  );
}

/**
 * Copies the ACLs of the folder the documents actually live in onto the
 * documents. Groups without a row on the folder get no row on the document
 * (not visible), mirroring the folder exactly.
 *
 * Note this intentionally reads the *containing* folder's permissions — a
 * previous version derived the parent from the client-supplied folder path
 * with an off-by-one (`slice(0, -1)`), inheriting from the grandparent and
 * leaving freshly uploaded documents without any viewable row.
 */
async function inheritFromContainingFolder(
  folderId: string,
  dataroomDocuments: DataroomDocumentRef[],
  target: GroupTarget,
) {
  if (target === "VIEWER_GROUP") {
    const folderPermissions = await prisma.viewerGroupAccessControls.findMany({
      where: {
        itemId: folderId,
        itemType: ItemType.DATAROOM_FOLDER,
      },
      select: { groupId: true, canView: true, canDownload: true },
    });

    if (folderPermissions.length === 0) return;

    await upsertViewerGroupDocumentRows(
      folderPermissions.flatMap((folderPerm) =>
        dataroomDocuments.map((doc) => ({
          groupId: folderPerm.groupId,
          itemId: doc.id,
          itemType: ItemType.DATAROOM_DOCUMENT,
          canView: folderPerm.canView,
          canDownload: folderPerm.canDownload,
        })),
      ),
    );
    return;
  }

  const folderPermissions = await prisma.permissionGroupAccessControls.findMany(
    {
      where: {
        itemId: folderId,
        itemType: ItemType.DATAROOM_FOLDER,
      },
      select: {
        groupId: true,
        canView: true,
        canDownload: true,
        canDownloadOriginal: true,
      },
    },
  );

  if (folderPermissions.length === 0) return;

  await upsertPermissionGroupDocumentRows(
    folderPermissions.flatMap((folderPerm) =>
      dataroomDocuments.map((doc) => ({
        groupId: folderPerm.groupId,
        itemId: doc.id,
        itemType: ItemType.DATAROOM_DOCUMENT,
        canView: folderPerm.canView,
        canDownload: folderPerm.canDownload,
        canDownloadOriginal: folderPerm.canDownloadOriginal,
      })),
    ),
  );
}
