import { z } from "zod";

// --- Viewer notification preferences (external viewers for dataroom change notifications) ---

export const ViewerNotificationFrequency = z.enum([
  "instant",
  "daily",
  "weekly",
]);
export type ViewerNotificationFrequency = z.infer<
  typeof ViewerNotificationFrequency
>;

/** @deprecated Use ViewerNotificationFrequency instead */
export const NotificationFrequency = ViewerNotificationFrequency;
/** @deprecated Use ViewerNotificationFrequency instead */
export type NotificationFrequency = ViewerNotificationFrequency;

export const ZViewerNotificationPreferencesSchema = z
  .object({
    dataroom: z.record(
      z.object({
        enabled: z.boolean(),
        frequency: ViewerNotificationFrequency.optional().default("instant"),
      }),
    ),
  })
  .optional()
  .default({ dataroom: {} });

export const ZUserNotificationPreferencesSchema = z
  .object({
    yearInReview: z.object({
      enabled: z.boolean(),
    }),
  })
  .optional()
  .default({ yearInReview: { enabled: true } });

// --- Team member notification preferences ---

export const TeamNotificationType = z.enum([
  "DOCUMENT_VIEW",
  "DATAROOM_VIEW",
  "BLOCKED_ACCESS",
  "DATAROOM_UPLOAD",
  "CONVERSATION_MESSAGE",
]);
export type TeamNotificationType = z.infer<typeof TeamNotificationType>;
export const TEAM_NOTIFICATION_TYPES = TeamNotificationType.options;

export const TeamNotificationFrequency = z.enum([
  "IMMEDIATE",
  "DAILY",
  "WEEKLY",
  "NEVER",
]);
export type TeamNotificationFrequency = z.infer<
  typeof TeamNotificationFrequency
>;
export const TEAM_NOTIFICATION_FREQUENCIES = TeamNotificationFrequency.options;

export const ZNotificationPreferenceSchema = z.object({
  type: TeamNotificationType,
  frequency: TeamNotificationFrequency,
});

export const ZUpdateNotificationPreferencesSchema = z.object({
  preferences: z.array(ZNotificationPreferenceSchema).min(1),
});

export const DEFAULT_ADMIN_PREFERENCES: Record<
  TeamNotificationType,
  TeamNotificationFrequency
> = {
  DOCUMENT_VIEW: "IMMEDIATE",
  DATAROOM_VIEW: "IMMEDIATE",
  BLOCKED_ACCESS: "IMMEDIATE",
  DATAROOM_UPLOAD: "IMMEDIATE",
  CONVERSATION_MESSAGE: "IMMEDIATE",
};

export const DEFAULT_MEMBER_PREFERENCES: Record<
  TeamNotificationType,
  TeamNotificationFrequency
> = {
  DOCUMENT_VIEW: "IMMEDIATE",
  DATAROOM_VIEW: "IMMEDIATE",
  BLOCKED_ACCESS: "IMMEDIATE",
  DATAROOM_UPLOAD: "IMMEDIATE",
  CONVERSATION_MESSAGE: "NEVER",
};
