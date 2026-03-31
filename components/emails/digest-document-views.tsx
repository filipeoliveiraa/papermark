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

type DocumentViewSummary = {
  documentName: string;
  viewCount: number;
  linkName?: string;
};

export default function DigestDocumentViews({
  teamName = "My Team",
  documents = [
    { documentName: "Pitch Deck v3", viewCount: 18, linkName: "Investor Link" },
    { documentName: "NDA Agreement", viewCount: 12, linkName: "Legal Review" },
    { documentName: "Product Overview", viewCount: 9, linkName: "Sales Demo" },
  ],
  totalViews = 47,
  frequency = "daily",
  remainingCount = 2,
}: {
  teamName: string;
  documents: DocumentViewSummary[];
  totalViews: number;
  frequency: "daily" | "weekly";
  remainingCount: number;
}) {
  const periodLabel = frequency === "daily" ? "yesterday" : "this week";

  return (
    <Html>
      <Head />
      <Preview>
        {`${totalViews} document view${totalViews !== 1 ? "s" : ""} ${periodLabel} on ${teamName}`}
      </Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-10 w-[465px] p-5">
            <Text className="mb-8 mt-4 text-center text-2xl font-normal">
              <span className="font-bold tracking-tighter">Papermark</span>
            </Text>
            <Text className="mb-8 mt-4 text-center text-xl font-semibold">
              {totalViews} document view{totalViews !== 1 ? "s" : ""}{" "}
              {periodLabel}
            </Text>
            <Text className="text-sm leading-6 text-black">
              Here&apos;s a summary of document views on{" "}
              <span className="font-semibold">{teamName}</span> {periodLabel}:
            </Text>
            <Section className="my-4">
              {documents.map((doc, i) => (
                <Text
                  key={i}
                  className="my-1 text-sm leading-6 text-black"
                >
                  •{" "}
                  <span className="font-semibold">{doc.documentName}</span>
                  {" — "}
                  {doc.viewCount} view{doc.viewCount !== 1 ? "s" : ""}
                  {doc.linkName ? (
                    <span className="text-gray-500">
                      {" "}
                      (via {doc.linkName})
                    </span>
                  ) : null}
                </Text>
              ))}
              {remainingCount > 0 ? (
                <Text className="my-1 text-sm leading-6 text-gray-500">
                  + {remainingCount} more document
                  {remainingCount !== 1 ? "s" : ""}
                </Text>
              ) : null}
            </Section>
            <Section className="my-8 text-center">
              <Button
                className="rounded bg-black text-center text-xs font-semibold text-white no-underline"
                href="https://app.papermark.com/documents"
                style={{ padding: "12px 20px" }}
              >
                View all documents
              </Button>
            </Section>
            <Footer
              footerText={
                <>
                  You received this {frequency} digest because you have document
                  view notifications set to {frequency} on{" "}
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
