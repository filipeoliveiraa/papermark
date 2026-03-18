import { NextRequest, NextResponse } from "next/server";

import { getFile } from "@/lib/files/get-file";
import prisma from "@/lib/prisma";
import { log } from "@/lib/utils";

const MAX_PAGES_PER_REQUEST = 50;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { viewId, documentVersionId, pageNumbers } = body as {
      viewId: string;
      documentVersionId: string;
      pageNumbers: number[];
    };

    if (!documentVersionId || !pageNumbers || pageNumbers.length === 0) {
      return NextResponse.json(
        { message: "Missing required fields." },
        { status: 400 },
      );
    }

    if (pageNumbers.length > MAX_PAGES_PER_REQUEST) {
      return NextResponse.json(
        {
          message: `Cannot request more than ${MAX_PAGES_PER_REQUEST} pages at once.`,
        },
        { status: 400 },
      );
    }

    if (viewId) {
      const view = await prisma.view.findUnique({
        where: { id: viewId },
        select: { id: true, documentId: true },
      });

      if (!view) {
        return NextResponse.json(
          { message: "View not found." },
          { status: 404 },
        );
      }

      // Verify the document version belongs to the document associated with this view
      const documentVersion = await prisma.documentVersion.findUnique({
        where: { id: documentVersionId },
        select: { documentId: true },
      });

      if (!documentVersion || documentVersion.documentId !== view.documentId) {
        return NextResponse.json(
          { message: "Unauthorized access." },
          { status: 403 },
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
