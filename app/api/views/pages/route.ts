import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { verifyDataroomSession } from "@/lib/auth/dataroom-auth";
import { getFile } from "@/lib/files/get-file";
import prisma from "@/lib/prisma";
import { ratelimit } from "@/lib/redis";
import { log } from "@/lib/utils";

const MAX_PAGES_PER_REQUEST = 15;
const VIEW_MAX_AGE_MS = 23 * 60 * 60 * 1000; // 23 hours

const requestSchema = z.object({
  viewId: z.string().cuid(),
  documentVersionId: z.string().cuid(),
  pageNumbers: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_PAGES_PER_REQUEST),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Invalid request." },
        { status: 400 },
      );
    }

    const { viewId, documentVersionId, pageNumbers } = parsed.data;

    // Run rate limit, view lookup, and version lookup in parallel
    const [rateLimitResult, view, documentVersion] = await Promise.all([
      ratelimit(60, "1 m").limit(`view-pages:${viewId}`),
      prisma.view.findUnique({
        where: { id: viewId },
        select: {
          id: true,
          documentId: true,
          dataroomId: true,
          linkId: true,
          viewedAt: true,
        },
      }),
      prisma.documentVersion.findUnique({
        where: { id: documentVersionId },
        select: { documentId: true },
      }),
    ]);

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { message: "Too many requests. Please try again later." },
        { status: 429 },
      );
    }

    if (!view) {
      return NextResponse.json({ message: "View not found." }, { status: 404 });
    }

    if (Date.now() - view.viewedAt.getTime() > VIEW_MAX_AGE_MS) {
      return NextResponse.json(
        { message: "View session expired." },
        { status: 401 },
      );
    }

    if (!documentVersion || documentVersion.documentId !== view.documentId) {
      return NextResponse.json(
        { message: "Unauthorized access." },
        { status: 403 },
      );
    }

    // Validate dataroom session for dataroom document views
    if (view.dataroomId && view.linkId) {
      const session = await verifyDataroomSession(
        request,
        view.linkId,
        view.dataroomId,
      );
      if (!session) {
        return NextResponse.json(
          { message: "Invalid or expired session." },
          { status: 401 },
        );
      }
    }

    const documentPages = await prisma.documentPage.findMany({
      where: {
        versionId: documentVersionId,
        pageNumber: { in: pageNumbers },
      },
      select: {
        file: true,
        storageType: true,
        pageNumber: true,
      },
    });

    const pagesWithUrls = await Promise.all(
      documentPages.map(async (page) => {
        const { storageType, ...otherPage } = page;
        return {
          pageNumber: otherPage.pageNumber,
          file: await getFile({ data: page.file, type: storageType }),
        };
      }),
    );

    return NextResponse.json({ pages: pagesWithUrls });
  } catch (error) {
    log({
      message: `Failed to fetch page URLs. \n\n ${error}`,
      type: "error",
    });
    return NextResponse.json(
      { message: (error as Error).message },
      { status: 500 },
    );
  }
}
