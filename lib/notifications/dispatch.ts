import type { TeamNotificationType } from "@/lib/zod/schemas/notifications";

import { queueDigestNotifications } from "./queue-digest";
import {
  type NotificationRecipient,
  resolveRecipients,
} from "./resolve-recipients";

export type DispatchResult = {
  immediate: NotificationRecipient[];
  queued: NotificationRecipient[];
};

export async function dispatchNotification({
  teamId,
  notificationType,
  linkOwnerId,
  documentOwnerId,
  digestPayload,
}: {
  teamId: string;
  notificationType: TeamNotificationType;
  linkOwnerId?: string | null;
  documentOwnerId?: string | null;
  digestPayload: Record<string, unknown>;
}): Promise<DispatchResult> {
  const recipients = await resolveRecipients({
    teamId,
    notificationType,
    linkOwnerId,
    documentOwnerId,
  });

  const immediate: NotificationRecipient[] = [];
  const queued: NotificationRecipient[] = [];

  for (const recipient of recipients) {
    if (recipient.frequency === "IMMEDIATE") {
      immediate.push(recipient);
    } else {
      queued.push(recipient);
    }
  }

  if (queued.length > 0) {
    await queueDigestNotifications(
      queued.map((r) => ({
        userId: r.userId,
        teamId,
        type: notificationType,
        payload: digestPayload,
      })),
    );
  }

  return { immediate, queued };
}
