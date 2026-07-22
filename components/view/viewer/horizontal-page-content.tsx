import type { MouseEvent, MutableRefObject } from "react";

import { getContainedImageRect } from "@/lib/hooks/use-fullscreen";
import { WatermarkConfig } from "@/lib/types";
import { getSafeLinkHref } from "@/lib/utils/sanitize-link-href";

import { SVGWatermark } from "../watermark-svg";

export type HorizontalViewerPage = {
  file: string | null;
  pageNumber: string;
  embeddedLinks: string[];
  pageLinks: {
    href: string;
    coords: string;
    isInternal?: boolean;
    targetPage?: number;
  }[];
  metadata: { width: number; height: number; scaleFactor: number };
};

type PageDimensions = Record<number, { width: number; height: number }>;

const scaleCoordinates = (coords: string, scaleFactor: number) => {
  return coords
    .split(",")
    .map((coord) => parseFloat(coord) * scaleFactor)
    .join(",");
};

export function HorizontalPageContent({
  page,
  index,
  imgHeight,
  imgMaxHeight,
  imgMaxWidth,
  watermarkConfig,
  viewerEmail,
  linkName,
  ipAddress,
  imageDimensions,
  imageRefs,
  getScaleFactor,
  onImageDimensionsChange,
  onLinkClick,
}: {
  page: HorizontalViewerPage;
  index: number;
  imgHeight?: string;
  imgMaxHeight: string;
  imgMaxWidth?: string;
  watermarkConfig?: WatermarkConfig | null;
  viewerEmail?: string;
  linkName?: string;
  ipAddress?: string;
  imageDimensions: PageDimensions;
  imageRefs: MutableRefObject<(HTMLImageElement | null)[]>;
  getScaleFactor: ({
    naturalHeight,
    scaleFactor,
  }: {
    naturalHeight: number;
    scaleFactor: number;
  }) => number;
  onImageDimensionsChange: (
    index: number,
    dimensions: { width: number; height: number },
  ) => void;
  onLinkClick: (href: string, event: MouseEvent<HTMLAreaElement>) => void;
}) {
  const watermarkBox = imageDimensions[index];
  const watermarkRect =
    watermarkConfig && watermarkBox
      ? getContainedImageRect(
          watermarkBox.width,
          watermarkBox.height,
          page.metadata.height > 0
            ? page.metadata.width / page.metadata.height
            : 0,
        )
      : null;

  return (
    <div className="relative w-fit">
      <img
        className="viewer-image-mobile !pointer-events-auto object-contain"
        style={{
          height: imgHeight,
          maxHeight: imgMaxHeight,
          maxWidth: imgMaxWidth,
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        ref={(ref) => {
          imageRefs.current[index] = ref;
          if (ref) {
            ref.onload = () =>
              onImageDimensionsChange(index, {
                width: ref.clientWidth,
                height: ref.clientHeight,
              });
          }
        }}
        useMap={`#page-map-${index + 1}`}
        src={page.file || "https://www.papermark.com/_static/blank.gif"}
        alt={`Page ${index + 1}`}
      />

      {watermarkConfig && watermarkRect ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: watermarkRect.left, top: watermarkRect.top }}
        >
          <SVGWatermark
            config={watermarkConfig}
            viewerData={{
              email: viewerEmail,
              date: new Date().toLocaleDateString(),
              time: new Date().toLocaleTimeString(),
              link: linkName,
              ipAddress,
            }}
            documentDimensions={{
              width: watermarkRect.width,
              height: watermarkRect.height,
            }}
            pageIndex={index}
          />
        </div>
      ) : null}

      {page.pageLinks ? (
        <map name={`page-map-${index + 1}`}>
          {page.pageLinks
            .filter((link) => !link.href.endsWith(".gif"))
            .map((link, linkIndex) => {
              const safeHref = getSafeLinkHref(link.href);
              if (!safeHref) {
                return null;
              }
              const isInternal = safeHref.startsWith("#");
              return (
                <area
                  key={linkIndex}
                  shape="rect"
                  coords={scaleCoordinates(
                    link.coords,
                    getScaleFactor({
                      naturalHeight: page.metadata.height,
                      scaleFactor: page.metadata.scaleFactor,
                    }),
                  )}
                  href={safeHref}
                  onClick={(event) => onLinkClick(safeHref, event)}
                  target={isInternal ? "_self" : "_blank"}
                  rel={isInternal ? undefined : "noopener noreferrer"}
                />
              );
            })}
        </map>
      ) : null}

      {page.pageLinks && imageDimensions[index]
        ? page.pageLinks
            .filter((link) => link.href.endsWith(".gif"))
            .map((link, linkIndex) => {
              const [x1, y1, x2, y2] = scaleCoordinates(
                link.coords,
                getScaleFactor({
                  naturalHeight: page.metadata.height,
                  scaleFactor: page.metadata.scaleFactor,
                }),
              )
                .split(",")
                .map(Number);

              const overlayWidth = x2 - x1;
              const overlayHeight = y2 - y1;
              const containerWidth =
                imageRefs.current[index]?.parentElement?.clientWidth || 0;
              const imageWidth = imageDimensions[index].width;
              const leftOffset = (containerWidth - imageWidth) / 2;

              return (
                <img
                  key={`overlay-${index}-${linkIndex}`}
                  src={link.href}
                  alt={`Overlay ${index + 1}`}
                  style={{
                    position: "absolute",
                    top: y1,
                    left: x1 + leftOffset,
                    width: `${overlayWidth}px`,
                    height: `${overlayHeight}px`,
                    pointerEvents: "none",
                  }}
                />
              );
            })
        : null}
    </div>
  );
}
