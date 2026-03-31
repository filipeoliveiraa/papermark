import { limiter } from "@/lib/cron";
import prisma from "@/lib/prisma";
import { log } from "@/lib/utils";
import type { TeamNotificationType } from "@/lib/zod/schemas/notifications";

type DigestGroup = {
  userId: string;
  teamId: string;
  type: TeamNotificationType;
  email: string;
  teamName: string;
  items: Record<string, unknown>[];
};

export async function processNotificationDigest(
  frequency: "DAILY" | "WEEKLY",
) {
  const preferences = await prisma.notificationPreference.findMany({
    where: { frequency },
    select: {
      userId: true,
      teamId: true,
      type: true,
    },
  });

  if (preferences.length === 0) {
    return { processed: 0, sent: 0 };
  }

  const prefGroups = new Map<string, typeof preferences>();
  for (const pref of preferences) {
    const key = `${pref.userId}:${pref.teamId}:${pref.type}`;
    prefGroups.set(key, [...(prefGroups.get(key) || []), pref]);
  }

  const digestItems = await prisma.notificationDigest.findMany({
    where: {
      processedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });

  if (digestItems.length === 0) {
    return { processed: 0, sent: 0 };
  }

  const groups = new Map<string, DigestGroup>();

  for (const item of digestItems) {
    const key = `${item.userId}:${item.teamId}:${item.type}`;
    if (!prefGroups.has(key)) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        userId: item.userId,
        teamId: item.teamId,
        type: item.type as TeamNotificationType,
        email: "",
        teamName: "",
        items: [],
      });
    }
    groups.get(key)!.items.push(item.payload as Record<string, unknown>);
  }

  if (groups.size === 0) {
    return { processed: 0, sent: 0 };
  }

  const userIds = [...new Set([...groups.values()].map((g) => g.userId))];
  const teamIds = [...new Set([...groups.values()].map((g) => g.teamId))];

  const [users, teams] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    }),
    prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.email]));
  const teamMap = new Map(teams.map((t) => [t.id, t.name]));

  for (const group of groups.values()) {
    group.email = userMap.get(group.userId) || "";
    group.teamName = teamMap.get(group.teamId) || "Unknown Team";
  }

  let sent = 0;
  const digestItemIds = digestItems.map((i) => i.id);

  for (const group of groups.values()) {
    if (!group.email || group.items.length === 0) continue;

    try {
      await limiter.schedule(() =>
        sendDigestEmail(group, frequency),
      );
      sent++;
    } catch (error) {
      await log({
        message: `Failed to send ${frequency.toLowerCase()} ${group.type} digest to ${group.email}. Error: ${(error as Error).message}`,
        type: "error",
      });
    }
  }

  await prisma.notificationDigest.updateMany({
    where: { id: { in: digestItemIds } },
    data: { processedAt: new Date() },
  });

  return { processed: digestItems.length, sent };
}

async function sendDigestEmail(
  group: DigestGroup,
  frequency: "DAILY" | "WEEKLY",
) {
  const { sendEmail } = await import("@/lib/resend");

  const frequencyLabel = frequency === "DAILY" ? "yesterday" : "this week";
  const totalCount = group.items.length;

  const { subject, body } = buildDigestContent(
    group.type,
    group.items,
    group.teamName,
    frequencyLabel,
    totalCount,
  );

  await sendEmail({
    to: group.email,
    subject,
    text: body,
    system: true,
    test: process.env.NODE_ENV === "development",
  });
}

function buildDigestContent(
  type: TeamNotificationType,
  items: Record<string, unknown>[],
  teamName: string,
  frequencyLabel: string,
  totalCount: number,
): { subject: string; body: string } {
  const MAX_ITEMS = 5;

  switch (type) {
    case "DOCUMENT_VIEW": {
      const docCounts = new Map<string, number>();
      for (const item of items) {
        const name = (item.documentName as string) || "Unknown Document";
        docCounts.set(name, (docCounts.get(name) || 0) + 1);
      }
      const sorted = [...docCounts.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, MAX_ITEMS);
      const remaining = sorted.length - MAX_ITEMS;

      let body = `Here's what happened on ${teamName} ${frequencyLabel}:\n\n`;
      body += `Document Views (${totalCount})\n`;
      for (const [name, count] of top) {
        body += `  - ${name}: ${count} view${count > 1 ? "s" : ""}\n`;
      }
      if (remaining > 0) {
        body += `  + ${remaining} more document${remaining > 1 ? "s" : ""}\n`;
      }

      return {
        subject: `${totalCount} document view${totalCount > 1 ? "s" : ""} ${frequencyLabel} on ${teamName}`,
        body,
      };
    }

    case "DATAROOM_VIEW": {
      const drCounts = new Map<string, number>();
      for (const item of items) {
        const name = (item.dataroomName as string) || "Unknown Data Room";
        drCounts.set(name, (drCounts.get(name) || 0) + 1);
      }
      const sorted = [...drCounts.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, MAX_ITEMS);
      const remaining = sorted.length - MAX_ITEMS;

      let body = `Here's what happened on ${teamName} ${frequencyLabel}:\n\n`;
      body += `Data Room Views (${totalCount})\n`;
      for (const [name, count] of top) {
        body += `  - ${name}: ${count} visit${count > 1 ? "s" : ""}\n`;
      }
      if (remaining > 0) {
        body += `  + ${remaining} more data room${remaining > 1 ? "s" : ""}\n`;
      }

      return {
        subject: `${totalCount} data room visit${totalCount > 1 ? "s" : ""} ${frequencyLabel} on ${teamName}`,
        body,
      };
    }

    case "BLOCKED_ACCESS": {
      let body = `Here's what happened on ${teamName} ${frequencyLabel}:\n\n`;
      body += `Blocked Access Attempts (${totalCount})\n`;
      const top = items.slice(0, MAX_ITEMS);
      for (const item of top) {
        body += `  - ${item.blockedEmail || "Unknown"} tried to access "${item.resourceName || "a resource"}"\n`;
      }
      if (totalCount > MAX_ITEMS) {
        body += `  + ${totalCount - MAX_ITEMS} more attempt${totalCount - MAX_ITEMS > 1 ? "s" : ""}\n`;
      }

      return {
        subject: `${totalCount} blocked access attempt${totalCount > 1 ? "s" : ""} ${frequencyLabel} on ${teamName}`,
        body,
      };
    }

    case "DATAROOM_UPLOAD": {
      const drCounts = new Map<string, string[]>();
      for (const item of items) {
        const name = (item.dataroomName as string) || "Unknown Data Room";
        const docs = (item.documentNames as string[]) || [];
        drCounts.set(name, [...(drCounts.get(name) || []), ...docs]);
      }
      const sorted = [...drCounts.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      );
      const top = sorted.slice(0, MAX_ITEMS);

      let body = `Here's what happened on ${teamName} ${frequencyLabel}:\n\n`;
      body += `Data Room Uploads (${totalCount})\n`;
      for (const [name, docs] of top) {
        body += `  - ${name}: ${docs.length} file${docs.length > 1 ? "s" : ""} uploaded\n`;
      }

      return {
        subject: `${totalCount} data room upload${totalCount > 1 ? "s" : ""} ${frequencyLabel} on ${teamName}`,
        body,
      };
    }

    case "CONVERSATION_MESSAGE": {
      let body = `Here's what happened on ${teamName} ${frequencyLabel}:\n\n`;
      body += `New Conversation Messages (${totalCount})\n`;
      body += `  You have ${totalCount} new message${totalCount > 1 ? "s" : ""} across your conversations.\n`;

      return {
        subject: `${totalCount} new conversation message${totalCount > 1 ? "s" : ""} ${frequencyLabel} on ${teamName}`,
        body,
      };
    }

    default: {
      return {
        subject: `Activity digest ${frequencyLabel} on ${teamName}`,
        body: `You have ${totalCount} new notification${totalCount > 1 ? "s" : ""} on ${teamName}.`,
      };
    }
  }
}
