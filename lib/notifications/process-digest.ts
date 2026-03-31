import DigestBlockedAccess from "@/components/emails/digest-blocked-access";
import DigestConversationMessages from "@/components/emails/digest-conversation-messages";
import DigestDataroomUploads from "@/components/emails/digest-dataroom-uploads";
import DigestDataroomViews from "@/components/emails/digest-dataroom-views";
import DigestDocumentViews from "@/components/emails/digest-document-views";
import { limiter } from "@/lib/cron";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/resend";
import { log } from "@/lib/utils";
import type { TeamNotificationType } from "@/lib/zod/schemas/notifications";

const MAX_ITEMS = 5;

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

  const prefKeys = new Set(
    preferences.map((p) => `${p.userId}:${p.teamId}:${p.type}`),
  );

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
    if (!prefKeys.has(key)) continue;

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
  const frequencyLabel: "daily" | "weekly" =
    frequency === "DAILY" ? "daily" : "weekly";

  for (const group of groups.values()) {
    if (!group.email || group.items.length === 0) continue;

    try {
      await limiter.schedule(() =>
        sendDigestEmail(group, frequencyLabel),
      );
      sent++;
    } catch (error) {
      await log({
        message: `Failed to send ${frequencyLabel} ${group.type} digest to ${group.email}. Error: ${(error as Error).message}`,
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
  frequency: "daily" | "weekly",
) {
  const { subject, react } = buildDigestEmail(group, frequency);

  await sendEmail({
    to: group.email,
    subject,
    react,
    system: true,
    test: process.env.NODE_ENV === "development",
  });
}

function buildDigestEmail(
  group: DigestGroup,
  frequency: "daily" | "weekly",
): { subject: string; react: React.ReactElement } {
  const periodLabel = frequency === "daily" ? "yesterday" : "this week";
  const totalCount = group.items.length;

  switch (group.type) {
    case "DOCUMENT_VIEW": {
      const docCounts = new Map<string, { count: number; linkName?: string }>();
      for (const item of group.items) {
        const name = (item.documentName as string) || "Unknown Document";
        const existing = docCounts.get(name);
        docCounts.set(name, {
          count: (existing?.count || 0) + 1,
          linkName: (item.linkName as string) || existing?.linkName,
        });
      }
      const sorted = [...docCounts.entries()].sort(
        (a, b) => b[1].count - a[1].count,
      );
      const top = sorted.slice(0, MAX_ITEMS);
      const remaining = Math.max(0, sorted.length - MAX_ITEMS);

      return {
        subject: `${totalCount} document view${totalCount > 1 ? "s" : ""} ${periodLabel} on ${group.teamName}`,
        react: DigestDocumentViews({
          teamName: group.teamName,
          documents: top.map(([name, data]) => ({
            documentName: name,
            viewCount: data.count,
            linkName: data.linkName,
          })),
          totalViews: totalCount,
          frequency,
          remainingCount: remaining,
        }),
      };
    }

    case "DATAROOM_VIEW": {
      const drCounts = new Map<string, { count: number; linkName?: string }>();
      for (const item of group.items) {
        const name = (item.dataroomName as string) || "Unknown Data Room";
        const existing = drCounts.get(name);
        drCounts.set(name, {
          count: (existing?.count || 0) + 1,
          linkName: (item.linkName as string) || existing?.linkName,
        });
      }
      const sorted = [...drCounts.entries()].sort(
        (a, b) => b[1].count - a[1].count,
      );
      const top = sorted.slice(0, MAX_ITEMS);
      const remaining = Math.max(0, sorted.length - MAX_ITEMS);

      return {
        subject: `${totalCount} data room visit${totalCount > 1 ? "s" : ""} ${periodLabel} on ${group.teamName}`,
        react: DigestDataroomViews({
          teamName: group.teamName,
          datarooms: top.map(([name, data]) => ({
            dataroomName: name,
            viewCount: data.count,
            linkName: data.linkName,
          })),
          totalViews: totalCount,
          frequency,
          remainingCount: remaining,
        }),
      };
    }

    case "BLOCKED_ACCESS": {
      const top = group.items.slice(0, MAX_ITEMS);
      const remaining = Math.max(0, totalCount - MAX_ITEMS);

      return {
        subject: `${totalCount} blocked access attempt${totalCount > 1 ? "s" : ""} ${periodLabel} on ${group.teamName}`,
        react: DigestBlockedAccess({
          teamName: group.teamName,
          attempts: top.map((item) => ({
            blockedEmail: (item.blockedEmail as string) || "Unknown",
            resourceName: (item.resourceName as string) || "a resource",
            resourceType:
              (item.resourceType as "document" | "dataroom") || "document",
          })),
          totalAttempts: totalCount,
          frequency,
          remainingCount: remaining,
        }),
      };
    }

    case "DATAROOM_UPLOAD": {
      const drUploads = new Map<
        string,
        { fileCount: number; uploaderEmail?: string }
      >();
      for (const item of group.items) {
        const name = (item.dataroomName as string) || "Unknown Data Room";
        const docs = (item.documentNames as string[]) || [];
        const existing = drUploads.get(name);
        drUploads.set(name, {
          fileCount: (existing?.fileCount || 0) + docs.length,
          uploaderEmail:
            (item.uploaderEmail as string) || existing?.uploaderEmail,
        });
      }
      const sorted = [...drUploads.entries()].sort(
        (a, b) => b[1].fileCount - a[1].fileCount,
      );
      const top = sorted.slice(0, MAX_ITEMS);
      const remaining = Math.max(0, sorted.length - MAX_ITEMS);

      return {
        subject: `${totalCount} data room upload${totalCount > 1 ? "s" : ""} ${periodLabel} on ${group.teamName}`,
        react: DigestDataroomUploads({
          teamName: group.teamName,
          uploads: top.map(([name, data]) => ({
            dataroomName: name,
            fileCount: data.fileCount,
            uploaderEmail: data.uploaderEmail,
          })),
          totalUploads: totalCount,
          frequency,
          remainingCount: remaining,
        }),
      };
    }

    case "CONVERSATION_MESSAGE": {
      return {
        subject: `${totalCount} new conversation message${totalCount > 1 ? "s" : ""} ${periodLabel} on ${group.teamName}`,
        react: DigestConversationMessages({
          teamName: group.teamName,
          totalMessages: totalCount,
          frequency,
        }),
      };
    }

    default: {
      return {
        subject: `Activity digest ${periodLabel} on ${group.teamName}`,
        react: DigestDocumentViews({
          teamName: group.teamName,
          documents: [],
          totalViews: 0,
          frequency,
          remainingCount: 0,
        }),
      };
    }
  }
}
