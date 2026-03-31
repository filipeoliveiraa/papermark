import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getServerSession } from "next-auth";

import { errorhandler } from "@/lib/errorHandler";
import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";
import {
  DEFAULT_ADMIN_PREFERENCES,
  DEFAULT_MEMBER_PREFERENCES,
  TEAM_NOTIFICATION_TYPES,
  ZUpdateNotificationPreferencesSchema,
  type TeamNotificationFrequency,
  type TeamNotificationType,
} from "@/lib/zod/schemas/notifications";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).end("Unauthorized");
  }

  const userId = (session.user as CustomUser).id;
  const { teamId } = req.query as { teamId: string };

  try {
    const userTeam = await prisma.userTeam.findUnique({
      where: {
        userId_teamId: { userId, teamId },
        status: "ACTIVE",
      },
      select: { role: true },
    });

    if (!userTeam) {
      return res.status(403).end("Unauthorized to access this team");
    }

    if (req.method === "GET") {
      return handleGet(req, res, userId, teamId, userTeam.role);
    }

    if (req.method === "PUT") {
      return handlePut(req, res, userId, teamId);
    }

    return res.status(405).json({ message: "Method Not Allowed" });
  } catch (error) {
    errorhandler(error, res);
  }
}

async function handleGet(
  _req: NextApiRequest,
  res: NextApiResponse,
  userId: string,
  teamId: string,
  role: string,
) {
  let preferences = await prisma.notificationPreference.findMany({
    where: { userId, teamId },
    select: { type: true, frequency: true },
  });

  if (preferences.length < TEAM_NOTIFICATION_TYPES.length) {
    const existingTypes = new Set(preferences.map((p) => p.type));
    const defaults =
      role === "MEMBER" ? DEFAULT_MEMBER_PREFERENCES : DEFAULT_ADMIN_PREFERENCES;

    const missing = TEAM_NOTIFICATION_TYPES.filter(
      (t) => !existingTypes.has(t),
    ).map((type) => ({
      userId,
      teamId,
      type,
      frequency: defaults[type as TeamNotificationType],
    }));

    if (missing.length > 0) {
      await prisma.notificationPreference.createMany({
        data: missing,
        skipDuplicates: true,
      });

      preferences = await prisma.notificationPreference.findMany({
        where: { userId, teamId },
        select: { type: true, frequency: true },
      });
    }
  }

  const preferencesMap = Object.fromEntries(
    preferences.map((p) => [p.type, p.frequency as TeamNotificationFrequency]),
  );

  return res.status(200).json({
    preferences: preferencesMap,
    role,
  });
}

async function handlePut(
  req: NextApiRequest,
  res: NextApiResponse,
  userId: string,
  teamId: string,
) {
  const validation = ZUpdateNotificationPreferencesSchema.safeParse(req.body);
  if (!validation.success) {
    return res
      .status(400)
      .json({ message: "Invalid request body", errors: validation.error });
  }

  const { preferences } = validation.data;

  await prisma.$transaction(
    preferences.map((pref) =>
      prisma.notificationPreference.upsert({
        where: {
          userId_teamId_type: {
            userId,
            teamId,
            type: pref.type,
          },
        },
        update: { frequency: pref.frequency },
        create: {
          userId,
          teamId,
          type: pref.type,
          frequency: pref.frequency,
        },
      }),
    ),
  );

  const updated = await prisma.notificationPreference.findMany({
    where: { userId, teamId },
    select: { type: true, frequency: true },
  });

  const preferencesMap = Object.fromEntries(
    updated.map((p) => [p.type, p.frequency as TeamNotificationFrequency]),
  );

  return res.status(200).json({ preferences: preferencesMap });
}
