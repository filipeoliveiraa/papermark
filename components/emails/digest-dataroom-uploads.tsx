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

type UploadSummary = {
  dataroomName: string;
  fileCount: number;
  uploaderEmail?: string;
};

export default function DigestDataroomUploads({
  teamName = "My Team",
  uploads = [
    { dataroomName: "Series A Dataroom", fileCount: 3, uploaderEmail: "investor@firm.com" },
    { dataroomName: "Due Diligence Room", fileCount: 1, uploaderEmail: "lawyer@legal.co" },
  ],
  totalUploads = 4,
  frequency = "daily",
  remainingCount = 0,
}: {
  teamName: string;
  uploads: UploadSummary[];
  totalUploads: number;
  frequency: "daily" | "weekly";
  remainingCount: number;
}) {
  const periodLabel = frequency === "daily" ? "yesterday" : "this week";

  return (
    <Html>
      <Head />
      <Preview>
        {`${totalUploads} data room upload${totalUploads !== 1 ? "s" : ""} ${periodLabel} on ${teamName}`}
      </Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-10 w-[465px] p-5">
            <Text className="mb-8 mt-4 text-center text-2xl font-normal">
              <span className="font-bold tracking-tighter">Papermark</span>
            </Text>
            <Text className="mb-8 mt-4 text-center text-xl font-semibold">
              {totalUploads} data room upload{totalUploads !== 1 ? "s" : ""}{" "}
              {periodLabel}
            </Text>
            <Text className="text-sm leading-6 text-black">
              Viewers uploaded files to data rooms on{" "}
              <span className="font-semibold">{teamName}</span> {periodLabel}:
            </Text>
            <Section className="my-4">
              {uploads.map((upload, i) => (
                <Text
                  key={i}
                  className="my-1 text-sm leading-6 text-black"
                >
                  •{" "}
                  <span className="font-semibold">{upload.dataroomName}</span>
                  {" — "}
                  {upload.fileCount} file{upload.fileCount !== 1 ? "s" : ""}
                  {upload.uploaderEmail ? (
                    <span className="text-gray-500">
                      {" "}
                      (by {upload.uploaderEmail})
                    </span>
                  ) : null}
                </Text>
              ))}
              {remainingCount > 0 ? (
                <Text className="my-1 text-sm leading-6 text-gray-500">
                  + {remainingCount} more data room
                  {remainingCount !== 1 ? "s" : ""}
                </Text>
              ) : null}
            </Section>
            <Section className="my-8 text-center">
              <Button
                className="rounded bg-black text-center text-xs font-semibold text-white no-underline"
                href="https://app.papermark.com/datarooms"
                style={{ padding: "12px 20px" }}
              >
                View all data rooms
              </Button>
            </Section>
            <Footer
              footerText={
                <>
                  You received this {frequency} digest because you have data
                  room upload notifications set to {frequency} on{" "}
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
