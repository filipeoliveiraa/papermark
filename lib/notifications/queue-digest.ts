import prisma from "@/lib/prisma";
import type { TeamNotificationType } from "@/lib/zod/schemas/notifications";

export async function queueDigestNotification({
  userId,
  teamId,
  type,
  payload,
}: {
  userId: string;
  teamId: string;
  type: TeamNotificationType;
  payload: Record<string, unknown>;
}) {
  await prisma.notificationDigest.create({
    data: {
      userId,
      teamId,
      type,
      payload,
    },
  });
}

export async function queueDigestNotifications(
  items: {
    userId: string;
    teamId: string;
    type: TeamNotificationType;
    payload: Record<string, unknown>;
  }[],
) {
  if (items.length === 0) return;

  await prisma.notificationDigest.createMany({
    data: items.map((item) => ({
      userId: item.userId,
      teamId: item.teamId,
      type: item.type,
      payload: item.payload,
    })),
  });
}
