import { python } from "@trigger.dev/python";
import { logger, retry, task } from "@trigger.dev/sdk/v3";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFile } from "@/lib/files/get-file";
import { putFileServer } from "@/lib/files/put-file-server";
import prisma from "@/lib/prisma";

import { updateStatus } from "../utils/generate-trigger-status";
import { getExtensionFromContentType } from "../utils/get-content-type";
import { convertPdfToImageRoute } from "./pdf-to-image-route";

export type ConvertPayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
};

export const convertFilesToPdfTask = task({
  id: "convert-files-to-pdf",
  retry: { maxAttempts: 3 },
  queue: {
    concurrencyLimit: 10,
  },
  run: async (payload: ConvertPayload) => {
    updateStatus({ progress: 0, text: "Initializing..." });

    const team = await prisma.team.findUnique({
      where: {
        id: payload.teamId,
      },
    });

    if (!team) {
      logger.error("Team not found", { teamId: payload.teamId });
      return;
    }

    const document = await prisma.document.findUnique({
      where: {
        id: payload.documentId,
        teamId: payload.teamId,
      },
      select: {
        name: true,
        versions: {
          where: {
            id: payload.documentVersionId,
          },
          select: {
            file: true,
            originalFile: true,
            contentType: true,
            storageType: true,
          },
        },
      },
    });

    if (
      !document ||
      !document.versions[0] ||
      !document.versions[0].originalFile ||
      !document.versions[0].contentType
    ) {
      updateStatus({ progress: 0, text: "Document not found" });

      logger.error("Document not found", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
      });
      return;
    }

    updateStatus({ progress: 10, text: "Retrieving file..." });

    const fileUrl = await getFile({
      data: document.versions[0].originalFile,
      type: document.versions[0].storageType,
    });

    // Prepare form data
    const formData = new FormData();
    formData.append(
      "downloadFrom",
      JSON.stringify([
        {
          url: fileUrl,
        },
      ]),
    );
    formData.append("quality", "75");

    updateStatus({ progress: 20, text: "Converting document..." });

    // Make the conversion request
    const conversionResponse = await retry.fetch(
      `${process.env.NEXT_PRIVATE_CONVERSION_BASE_URL}/forms/libreoffice/convert`,
      {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Basic ${process.env.NEXT_PRIVATE_INTERNAL_AUTH_TOKEN}`,
        },
        retry: {
          byStatus: {
            "500-599": {
              strategy: "backoff",
              maxAttempts: 3,
              factor: 2,
              minTimeoutInMs: 1_000,
              maxTimeoutInMs: 30_000,
              randomize: false,
            },
          },
        },
      },
    );

    let conversionBuffer: Buffer;

    if (!conversionResponse.ok) {
      const contentType = document.versions[0].contentType;
      const isDocx =
        contentType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      if (isDocx) {
        logger.warn("DOCX conversion failed, attempting sanitization…", {
          status: conversionResponse.status,
        });
        updateStatus({ progress: 25, text: "Sanitizing document…" });

        const docxResponse = await fetch(fileUrl);
        const docxBuffer = Buffer.from(await docxResponse.arrayBuffer());

        const inputPath = join(tmpdir(), `input-${Date.now()}.docx`);
        const outputPath = join(tmpdir(), `output-${Date.now()}.docx`);
        await writeFile(inputPath, docxBuffer);

        const result = await python.runScript(
          "./ee/features/conversions/python/docx-sanitizer.py",
          ["-v", inputPath, outputPath],
        );
        logger.info("Sanitizer output", { stderr: result.stderr });

        const sanitizedBuffer = await readFile(outputPath);
        const retryFormData = new FormData();
        retryFormData.append(
          "files",
          new Blob([new Uint8Array(sanitizedBuffer)], { type: contentType }),
          document.name,
        );
        retryFormData.append("quality", "75");

        const retryResponse = await fetch(
          `${process.env.NEXT_PRIVATE_CONVERSION_BASE_URL}/forms/libreoffice/convert`,
          {
            method: "POST",
            body: retryFormData,
            headers: {
              Authorization: `Basic ${process.env.NEXT_PRIVATE_INTERNAL_AUTH_TOKEN}`,
            },
          },
        );

        if (!retryResponse.ok) {
          updateStatus({ progress: 0, text: "Conversion failed" });
          const body = await retryResponse.json();
          throw new Error(
            `Conversion failed after sanitization: ${body.message} ${retryResponse.status}`,
          );
        }

        conversionBuffer = Buffer.from(await retryResponse.arrayBuffer());
      } else {
        updateStatus({ progress: 0, text: "Conversion failed" });
        const body = await conversionResponse.json();
        throw new Error(
          `Conversion failed: ${body.message} ${conversionResponse.status}`,
        );
      }
    } else {
      conversionBuffer = Buffer.from(await conversionResponse.arrayBuffer());
    }

    console.log("conversionBuffer", conversionBuffer);

    // get docId from url with starts with "doc_" with regex
    const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    updateStatus({ progress: 30, text: "Saving converted file..." });

    // Save the converted file to the database
    const { type: storageType, data } = await putFileServer({
      file: {
        name: `${document.name}.pdf`,
        type: "application/pdf",
        buffer: conversionBuffer,
      },
      teamId: payload.teamId,
      docId: docId,
    });

    if (!data || !storageType) {
      updateStatus({ progress: 0, text: "Failed to save converted file" });

      logger.error("Failed to save converted file to database", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
        docId: docId,
      });
      return;
    }

    console.log("data from conversion", data);
    console.log("storageType from conversion", storageType);

    const { versionNumber } = await prisma.documentVersion.update({
      where: { id: payload.documentVersionId },
      data: {
        file: data,
        type: "pdf",
        storageType: storageType,
      },
      select: {
        versionNumber: true,
      },
    });

    updateStatus({ progress: 40, text: "Initiating document processing..." });

    await convertPdfToImageRoute.trigger(
      {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
        versionNumber: versionNumber,
      },
      {
        idempotencyKey: `${payload.teamId}-${payload.documentVersionId}`,
        tags: [
          `team_${payload.teamId}`,
          `document_${payload.documentId}`,
          `version:${payload.documentVersionId}`,
        ],
      },
    );

    logger.info("Document converted", {
      documentId: payload.documentId,
      documentVersionId: payload.documentVersionId,
      teamId: payload.teamId,
      docId: docId,
    });
    return;
  },
});

// convert cad file to pdf
export const convertCadToPdfTask = task({
  id: "convert-cad-to-pdf",
  retry: { maxAttempts: 3 },
  queue: {
    concurrencyLimit: 2,
  },
  run: async (payload: ConvertPayload) => {
    const team = await prisma.team.findUnique({
      where: {
        id: payload.teamId,
      },
    });

    if (!team) {
      logger.error("Team not found", { teamId: payload.teamId });
      return;
    }

    const document = await prisma.document.findUnique({
      where: {
        id: payload.documentId,
        teamId: payload.teamId,
      },
      select: {
        name: true,
        versions: {
          where: {
            id: payload.documentVersionId,
          },
          select: {
            file: true,
            originalFile: true,
            contentType: true,
            storageType: true,
          },
        },
      },
    });

    if (
      !document ||
      !document.versions[0] ||
      !document.versions[0].originalFile ||
      !document.versions[0].contentType
    ) {
      logger.error("Document not found", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
      });
      return;
    }

    const fileUrl = await getFile({
      data: document.versions[0].originalFile,
      type: document.versions[0].storageType,
    });

    // create payload for cad to pdf conversion
    const tasksPayload = {
      tasks: {
        "import-file-v1": {
          operation: "import/url",
          url: fileUrl,
          filename: document.name,
        },
        "convert-file-v1": {
          operation: "convert",
          input: ["import-file-v1"],
          input_format: getExtensionFromContentType(
            document.versions[0].contentType,
          ),
          output_format: "pdf",
          engine: "cadconverter",
          all_layouts: true,
          auto_zoom: false,
        },
        "export-file-v1": {
          operation: "export/url",
          input: ["convert-file-v1"],
          inline: false,
          archive_multiple_files: false,
        },
      },
      redirect: true,
    };

    // Make the conversion request
    const conversionResponse = await retry.fetch(
      `${process.env.NEXT_PRIVATE_CONVERT_API_URL}`,
      {
        method: "POST",
        body: JSON.stringify(tasksPayload),
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PRIVATE_CONVERT_API_KEY}`,
          "Content-Type": "application/json",
        },
        retry: {
          byStatus: {
            "500-599": {
              strategy: "backoff",
              maxAttempts: 3,
              factor: 2,
              minTimeoutInMs: 1_000,
              maxTimeoutInMs: 30_000,
              randomize: false,
            },
          },
        },
      },
    );

    if (!conversionResponse.ok) {
      const body = await conversionResponse.json();
      throw new Error(
        `Conversion failed: ${body.message} ${conversionResponse.status}`,
      );
    }

    const conversionBuffer = Buffer.from(
      await conversionResponse.arrayBuffer(),
    );

    // get docId from url with starts with "doc_" with regex
    const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    // Save the converted file to the database
    const { type: storageType, data } = await putFileServer({
      file: {
        name: `${document.name}.pdf`,
        type: "application/pdf",
        buffer: conversionBuffer,
      },
      teamId: payload.teamId,
      docId: docId,
    });

    if (!data || !storageType) {
      logger.error("Failed to save converted file to database", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
        docId: docId,
      });
      return;
    }

    console.log("data from conversion", data);
    console.log("storageType from conversion", storageType);

    await prisma.documentVersion.update({
      where: { id: payload.documentVersionId },
      data: {
        file: data,
        type: "pdf",
        storageType: storageType,
      },
    });

    await convertPdfToImageRoute.trigger(
      {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
      },
      {
        idempotencyKey: `${payload.teamId}-${payload.documentVersionId}`,
        tags: [
          `team_${payload.teamId}`,
          `document_${payload.documentId}`,
          `version:${payload.documentVersionId}`,
        ],
      },
    );

    logger.info("Document converted", {
      documentId: payload.documentId,
      documentVersionId: payload.documentVersionId,
      teamId: payload.teamId,
      docId: docId,
    });
    return;
  },
});

// convert keynote file to pdf
export const convertKeynoteToPdfTask = task({
  id: "convert-keynote-to-pdf",
  retry: { maxAttempts: 3 },
  queue: {
    concurrencyLimit: 2,
  },
  run: async (payload: ConvertPayload) => {
    const team = await prisma.team.findUnique({
      where: {
        id: payload.teamId,
      },
    });

    if (!team) {
      logger.error("Team not found", { teamId: payload.teamId });
      return;
    }

    const document = await prisma.document.findUnique({
      where: {
        id: payload.documentId,
        teamId: payload.teamId,
      },
      select: {
        name: true,
        versions: {
          where: {
            id: payload.documentVersionId,
          },
          select: {
            file: true,
            originalFile: true,
            contentType: true,
            storageType: true,
          },
        },
      },
    });

    if (
      !document ||
      !document.versions[0] ||
      !document.versions[0].originalFile ||
      !document.versions[0].contentType
    ) {
      logger.error("Document not found", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
      });
      return;
    }

    const fileUrl = await getFile({
      data: document.versions[0].originalFile,
      type: document.versions[0].storageType,
    });

    // create payload for keynote to pdf conversion
    const tasksPayload = {
      tasks: {
        "import-file-v1": {
          operation: "import/url",
          url: fileUrl,
          filename: document.name,
        },
        "convert-file-v1": {
          operation: "convert",
          input: ["import-file-v1"],
          input_format: getExtensionFromContentType(
            document.versions[0].contentType,
          ),
          output_format: "pdf",
          engine: "iwork",
        },
        "export-file-v1": {
          operation: "export/url",
          input: ["convert-file-v1"],
          inline: false,
          archive_multiple_files: false,
        },
      },
      redirect: true,
    };

    // Make the conversion request
    const conversionResponse = await retry.fetch(
      `${process.env.NEXT_PRIVATE_CONVERT_API_URL}`,
      {
        method: "POST",
        body: JSON.stringify(tasksPayload),
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PRIVATE_CONVERT_API_KEY}`,
          "Content-Type": "application/json",
        },
        retry: {
          byStatus: {
            "500-599": {
              strategy: "backoff",
              maxAttempts: 3,
              factor: 2,
              minTimeoutInMs: 1_000,
              maxTimeoutInMs: 30_000,
              randomize: false,
            },
          },
        },
      },
    );

    if (!conversionResponse.ok) {
      const body = await conversionResponse.json();
      throw new Error(
        `Conversion failed: ${body.message} ${conversionResponse.status}`,
      );
    }

    const conversionBuffer = Buffer.from(
      await conversionResponse.arrayBuffer(),
    );

    // get docId from url with starts with "doc_" with regex
    const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    // Save the converted file to the database
    const { type: storageType, data } = await putFileServer({
      file: {
        name: `${document.name}.pdf`,
        type: "application/pdf",
        buffer: conversionBuffer,
      },
      teamId: payload.teamId,
      docId: docId,
    });

    if (!data || !storageType) {
      logger.error("Failed to save converted file to database", {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
        docId: docId,
      });
      return;
    }

    console.log("data from conversion", data);
    console.log("storageType from conversion", storageType);

    await prisma.documentVersion.update({
      where: { id: payload.documentVersionId },
      data: {
        file: data,
        type: "pdf",
        storageType: storageType,
      },
    });

    await convertPdfToImageRoute.trigger(
      {
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        teamId: payload.teamId,
      },
      {
        idempotencyKey: `${payload.teamId}-${payload.documentVersionId}`,
        tags: [
          `team_${payload.teamId}`,
          `document_${payload.documentId}`,
          `version:${payload.documentVersionId}`,
        ],
      },
    );

    logger.info("Keynote document converted", {
      documentId: payload.documentId,
      documentVersionId: payload.documentVersionId,
      teamId: payload.teamId,
      docId: docId,
    });
    return;
  },
});
