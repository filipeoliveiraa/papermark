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

export default function DigestConversationMessages({
  teamName = "My Team",
  totalMessages = 5,
  frequency = "daily",
}: {
  teamName: string;
  totalMessages: number;
  frequency: "daily" | "weekly";
}) {
  const periodLabel = frequency === "daily" ? "yesterday" : "this week";

  return (
    <Html>
      <Head />
      <Preview>
        {`${totalMessages} new conversation message${totalMessages !== 1 ? "s" : ""} ${periodLabel} on ${teamName}`}
      </Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-10 w-[465px] p-5">
            <Text className="mb-8 mt-4 text-center text-2xl font-normal">
              <span className="font-bold tracking-tighter">Papermark</span>
            </Text>
            <Text className="mb-8 mt-4 text-center text-xl font-semibold">
              {totalMessages} new conversation message
              {totalMessages !== 1 ? "s" : ""} {periodLabel}
            </Text>
            <Text className="text-sm leading-6 text-black">
              You have {totalMessages} new message
              {totalMessages !== 1 ? "s" : ""} across your conversations on{" "}
              <span className="font-semibold">{teamName}</span> {periodLabel}.
            </Text>
            <Section className="my-8 text-center">
              <Button
                className="rounded bg-black text-center text-xs font-semibold text-white no-underline"
                href="https://app.papermark.com/conversations"
                style={{ padding: "12px 20px" }}
              >
                View conversations
              </Button>
            </Section>
            <Footer
              footerText={
                <>
                  You received this {frequency} digest because you have
                  conversation notifications set to {frequency} on{" "}
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
