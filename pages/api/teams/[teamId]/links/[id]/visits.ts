import { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { LIMITS } from "@/lib/constants";
import { errorhandler } from "@/lib/errorHandler";
import prisma from "@/lib/prisma";
import { getDocumentWithTeamAndUser } from "@/lib/team/helper";
import { getViewPageDuration } from "@/lib/tinybird";
import { CustomUser } from "@/lib/types";
import { log } from "@/lib/utils";

import { authOptions } from "../../../../auth/[...nextauth]";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    // GET /api/teams/:teamId/links/:id/visits
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(401).end("Unauthorized");
    }

    // get link id from query params
    const { teamId, id } = req.query as { teamId: string; id: string };

    const userId = (session.user as CustomUser).id;

    try {
      const teamAccess = await prisma.userTeam.findUnique({
        where: {
          userId_teamId: {
            userId: userId,
            teamId: teamId,
          },
        },
      });
      if (!teamAccess) {
        return res.status(401).end("Unauthorized");
      }

      // get the numPages from document
      const result = await prisma.link.findUnique({
        where: {
          id: id,
        },
        select: {
          deletedAt: true,
          document: {
            select: {
              id: true,
              numPages: true,
              versions: {
                where: { isPrimary: true },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { numPages: true },
              },
              team: {
                select: {
                  id: true,
                  plan: true,
                  pauseStartsAt: true,
                  pauseEndsAt: true,
                },
              },
            },
          },
        },
      });

      // If link doesn't exist (deleted), return empty response
      if (!result || !result.document || result.deletedAt) {
        return res.status(200).json({ views: [], hiddenFromPause: 0 });
      }

      const docId = result.document.id;

      // check if the the team that own the document has the current user
      await getDocumentWithTeamAndUser({
        docId,
        userId,
        options: {
          team: {
            select: {
              users: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      });

      const currentDocNumPages =
        result?.document?.versions[0]?.numPages ||
        result?.document?.numPages ||
        0;

      const pauseStartsAt = result?.document?.team?.pauseStartsAt;
      const pauseEndsAt = result?.document?.team?.pauseEndsAt;

      const allViews = await prisma.view.findMany({
        where: {
          linkId: id,
          teamId: teamId,
        },
        orderBy: {
          viewedAt: "desc",
        },
      });

      // Filter out views that occurred during the pause period and count hidden views
      let hiddenFromPause = 0;
      const views =
        pauseStartsAt && pauseEndsAt
          ? allViews.filter((view) => {
              const viewedAt = new Date(view.viewedAt);
              const isDuringPause =
                viewedAt >= pauseStartsAt && viewedAt <= pauseEndsAt;
              if (isDuringPause) {
                hiddenFromPause++;
              }
              return !isDuringPause;
            })
          : allViews;

      // limit the number of views to 20 on free plan
      const limitedViews =
        result?.document?.team?.plan === "free"
          ? views.slice(0, LIMITS.views)
          : views;

      // A link can be transferred between documents over its lifetime, so a
      // historical view may reference a *different* document than the one the
      // link currently points at. Resolve each view's completion rate against
      // the document that was actually viewed (falling back to the link's
      // current document) instead of assuming a single page count.
      const otherDocumentIds = Array.from(
        new Set(
          limitedViews
            .map((view) => view.documentId)
            .filter(
              (docId): docId is string =>
                !!docId && docId !== result?.document?.id,
            ),
        ),
      );

      const numPagesByDocumentId = new Map<string, number>();
      if (result?.document?.id) {
        numPagesByDocumentId.set(result.document.id, currentDocNumPages);
      }

      if (otherDocumentIds.length > 0) {
        const otherDocuments = await prisma.document.findMany({
          where: { id: { in: otherDocumentIds }, teamId },
          select: {
            id: true,
            numPages: true,
            versions: {
              where: { isPrimary: true },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { numPages: true },
            },
          },
        });
        for (const doc of otherDocuments) {
          numPagesByDocumentId.set(
            doc.id,
            doc.versions[0]?.numPages || doc.numPages || 0,
          );
        }
      }

      const durationsPromises = limitedViews.map((view) => {
        return getViewPageDuration({
          documentId: view.documentId!,
          viewId: view.id,
          since: 0,
        });
      });

      const durations = await Promise.all(durationsPromises);

      // Sum up durations for each view
      const summedDurations = durations.map((duration) => {
        return duration.data.reduce(
          (totalDuration, data) => totalDuration + data.sum_duration,
          0,
        );
      });

      // Construct the response combining views and their respective durations
      const viewsWithDuration = limitedViews.map((view, index) => {
        const viewNumPages = view.documentId
          ? (numPagesByDocumentId.get(view.documentId) ?? currentDocNumPages)
          : currentDocNumPages;
        const completionRate = viewNumPages
          ? (durations[index].data.length / viewNumPages) * 100
          : 0;

        return {
          ...view,
          duration: durations[index],
          totalDuration: summedDurations[index],
          completionRate: completionRate.toFixed(),
        };
      });

      // TODO: Check that the user is owner of the links, otherwise return 401

      return res.status(200).json({
        views: viewsWithDuration,
        hiddenFromPause,
      });
    } catch (error) {
      log({
        message: `Failed to get views for link: _${id}_. \n\n ${error} \n\n*Metadata*: \`{userId: ${userId}}\``,
        type: "error",
      });
      errorhandler(error, res);
    }
  } else {
    // We only allow GET requests
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
