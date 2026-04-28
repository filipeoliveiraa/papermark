import { NextApiRequest, NextApiResponse } from "next";

import {
  bulkImportConfig,
  handleBulkLinkImport,
} from "@/lib/api/links/bulk-import";

export const config = bulkImportConfig;

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { teamId, id } = req.query as { teamId: string; id: string };

  return handleBulkLinkImport(req, res, {
    teamId,
    targetId: id,
    linkType: "DATAROOM_LINK",
  });
}
