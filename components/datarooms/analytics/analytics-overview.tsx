import { useRouter } from "next/router";

import { useMemo } from "react";

import { useDataroomFoldersTree } from "@/lib/swr/use-dataroom";
import { useDataroomDocumentStats } from "@/lib/swr/use-dataroom-document-stats";
import { useDataroomStats } from "@/lib/swr/use-dataroom-stats";

import StatsChart from "@/components/documents/stats-chart";
import { Gauge } from "@/components/ui/gauge";

interface DataroomAnalyticsOverviewProps {
  selectedDocument: {
    id: string;
    name: string;
  } | null;
  setSelectedDocument: React.Dispatch<
    React.SetStateAction<{
      id: string;
      name: string;
    } | null>
  >;
}

export default function DataroomAnalyticsOverview({
  selectedDocument,
  setSelectedDocument,
}: DataroomAnalyticsOverviewProps) {
  const router = useRouter();
  const { id: dataroomId } = router.query as { id: string };

  const {
    stats: dataroomStats,
    loading: dataroomLoading,
    error: dataroomError,
  } = useDataroomStats();

  const { folders, loading: foldersLoading } = useDataroomFoldersTree({
    dataroomId,
    include_documents: true,
  });

  const documentNamesById = useMemo(() => {
    const map = new Map<string, string>();
    folders?.forEach((item: any) => {
      if (item?.document?.id) {
        map.set(item.document.id, item.document.name);
      }
      item?.documents?.forEach((doc: any) => {
        if (doc?.document?.id) {
          map.set(doc.document.id, doc.document.name);
        }
      });
    });
    return map;
  }, [folders]);

  const mostViewedDocument = useMemo(() => {
    if (!dataroomStats || selectedDocument) return null;
    if (documentNamesById.size === 0) return null;

    // View records persist after a document is removed, so only count views for
    // documents still present in the dataroom to avoid selecting a stale one.
    const viewsByDocument = dataroomStats.documentViews.reduce(
      (acc, view) => {
        if (!view.documentId) return acc;
        if (!documentNamesById.has(view.documentId)) return acc;

        acc[view.documentId] = (acc[view.documentId] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    let maxViews = 0;
    let mostViewedId = "";
    Object.entries(viewsByDocument).forEach(([docId, count]) => {
      if (count > maxViews) {
        maxViews = count;
        mostViewedId = docId;
      }
    });

    return mostViewedId
      ? {
          id: mostViewedId,
          name: documentNamesById.get(mostViewedId) ?? mostViewedId,
        }
      : null;
  }, [dataroomStats, selectedDocument, documentNamesById]);

  const documentId = selectedDocument?.id || mostViewedDocument?.id;
  const { stats: documentStats, loading: documentLoading } =
    useDataroomDocumentStats(documentId);

  // The per-document chart is supplementary, so a document stats failure (e.g. a
  // removed document) should not blank the overview; only dataroom stats are.
  const loading =
    documentLoading ||
    (dataroomLoading && !documentId) ||
    (foldersLoading && !selectedDocument);
  const error = dataroomError && !documentId;

  if (loading) {
    return <div>Loading analytics...</div>;
  }

  if (error) {
    return <div>Error loading analytics</div>;
  }

  const completionRate = 0;

  const displayName =
    selectedDocument?.name ||
    (mostViewedDocument?.name !== mostViewedDocument?.id
      ? mostViewedDocument?.name
      : "Most viewed document");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6">
        <div>
          <h3 className="mb-4 text-lg font-medium">
            {displayName ? displayName : "Document Engagement"}
          </h3>
          {documentStats && (
            <StatsChart
              documentId={documentId || ""}
              totalPagesMax={documentStats?.totalPagesMax || 0}
              statsData={{
                stats: documentStats,
                loading: false,
                error: null,
              }}
            />
          )}
        </div>

        {/* INFO: hiding completion rate for now */}
        {/* <div className="flex flex-col items-center justify-center rounded-lg border p-6">
          <h3 className="mb-4 text-lg font-medium">
            {displayName
              ? `${displayName} - Completion Rate`
              : "Completion Rate"}
          </h3>
          <div className="flex flex-col items-center">
            <Gauge value={completionRate} size="large" showValue={true} />
            <p className="mt-4 text-sm text-muted-foreground">
              Document has {documentStats?.totalViews || 0} view
              {documentStats?.totalViews !== 1 ? "s" : ""} in this dataroom
            </p>
            {!selectedDocument && mostViewedDocument && (
              <button
                onClick={() => setSelectedDocument(mostViewedDocument)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                View all documents
              </button>
            )}
          </div>
        </div> */}
      </div>
    </div>
  );
}
