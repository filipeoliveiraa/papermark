import React from "react";

import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

import { Footer } from "./shared/footer";

type BlockedAccessSummary = {
  blockedEmail: string;
  resourceName: string;
  resourceType: "document" | "dataroom";
};

export default function DigestBlockedAccess({
  teamName = "My Team",
  attempts = [
    { blockedEmail: "john@competitor.com", resourceName: "Pitch Deck v3", resourceType: "document" as const },
    { blockedEmail: "unknown@spam.co", resourceName: "NDA Agreement", resourceType: "document" as const },
    { blockedEmail: "test@example.com", resourceName: "Series A Dataroom", resourceType: "dataroom" as const },
  ],
  totalAttempts = 3,
  frequency = "daily",
  remainingCount = 0,
}: {
  teamName: string;
  attempts: BlockedAccessSummary[];
  totalAttempts: number;
  frequency: "daily" | "weekly";
  remainingCount: number;
}) {
  const periodLabel = frequency === "daily" ? "yesterday" : "this week";

  return (
    <Html>
      <Head />
      <Preview>
        {`${totalAttempts} blocked access attempt${totalAttempts !== 1 ? "s" : ""} ${periodLabel} on ${teamName}`}
      </Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-10 w-[465px] p-5">
            <Text className="mb-8 mt-4 text-center text-2xl font-normal">
              <span className="font-bold tracking-tighter">Papermark</span>
            </Text>
            <Text className="mb-8 mt-4 text-center text-xl font-semibold">
              {totalAttempts} blocked access attempt
              {totalAttempts !== 1 ? "s" : ""} {periodLabel}
            </Text>
            <Text className="text-sm leading-6 text-black">
              The following access attempts were blocked on{" "}
              <span className="font-semibold">{teamName}</span> {periodLabel}:
            </Text>
            <Section className="my-4">
              {attempts.map((attempt, i) => (
                <Text
                  key={i}
                  className="my-1 text-sm leading-6 text-black"
                >
                  •{" "}
                  <span className="font-semibold">{attempt.blockedEmail}</span>
                  {" tried to access "}
                  <span className="font-semibold">{attempt.resourceName}</span>
                  <span className="text-gray-500">
                    {" "}
                    ({attempt.resourceType})
                  </span>
                </Text>
              ))}
              {remainingCount > 0 ? (
                <Text className="my-1 text-sm leading-6 text-gray-500">
                  + {remainingCount} more attempt
                  {remainingCount !== 1 ? "s" : ""}
                </Text>
              ) : null}
            </Section>
            <Section className="my-8 text-center">
              <Button
                className="rounded bg-black text-center text-xs font-semibold text-white no-underline"
                href="https://app.papermark.com/settings/general"
                style={{ padding: "12px 20px" }}
              >
                Review security settings
              </Button>
            </Section>
            <Footer
              footerText={
                <>
                  You received this {frequency} digest because you have blocked
                  access notifications set to {frequency} on{" "}
                  <span className="font-semibold">{teamName}</span>. You can
                  change this in your notification settings.
                </>
              }
            />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
