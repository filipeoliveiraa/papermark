import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "next-auth/react";
import { toast } from "sonner";

interface ExportStatus {
  status: string;
  progress?: string;
  exportId?: string;
  startTime?: number;
}

interface ExportVisitsModalProps {
  teamId: string;
  dataroomId: string;
  dataroomName: string;
  groupId?: string;
  groupName?: string;
  onClose: () => void;
}

export function ExportVisitsModal({
  teamId,
  dataroomId,
  dataroomName,
  groupId,
  groupName,
  onClose,
}: ExportVisitsModalProps) {
  const { data: session } = useSession();
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const exportStartedRef = useRef<boolean>(false);

  // Cleanup interval on component unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const startExport = useCallback(async () => {
    // Prevent double triggering
    if (exportStartedRef.current) {
      console.warn("Export already started, skipping duplicate request");
      return;
    }
    exportStartedRef.current = true;

    try {
      // Show modal immediately
      setShowModal(true);

      // Get view count first
      try {
        const viewCountResponse = await fetch(
          `/api/teams/${teamId}/datarooms/${dataroomId}/views-count${groupId ? `?groupId=${groupId}` : ""}`,
          { method: "GET" },
        );

        if (viewCountResponse.ok) {
          const viewData = await viewCountResponse.json();
          setViewCount(viewData.count || 0);
        }
      } catch (error) {
        console.error("Error fetching view count:", error);
        // Continue with export even if view count fails
      }

      // Trigger the background export job
      const response = await fetch(
        `/api/teams/${teamId}/datarooms/${dataroomId}${groupId ? `/groups/${groupId}` : ""}/export-visits`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      if (data.exportId) {
        const startTime = Date.now();
        setExportStatus({
          status: "PROCESSING",
          exportId: data.exportId,
          startTime,
        });

        // Clear any existing interval
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }

        // Start polling
        pollIntervalRef.current = setInterval(async () => {
          try {
            const statusResponse = await fetch(
              `/api/teams/${teamId}/export-jobs/${data.exportId}`,
              { method: "GET" },
            );

            if (statusResponse.ok) {
              const statusData = await statusResponse.json();

              // Update progress
              setExportStatus((prev) => ({
                ...prev!,
                progress: "Preparing export...",
              }));

              if (statusData.status === "COMPLETED" && statusData.isReady) {
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }

                // Create a direct link to the API endpoint (it will redirect to blob)
                const downloadUrl = `/api/teams/${teamId}/export-jobs/${data.exportId}?download=true`;
                try {
                  const link = window.document.createElement("a");
                  link.href = downloadUrl;
                  link.setAttribute(
                    "download",
                    `${statusData.resourceName || dataroomName}_${groupName ? `${groupName}_` : ""}visits_${new Date().toISOString().split("T")[0]}.csv`,
                  );
                  link.rel = "noopener noreferrer";
                  link.style.display = "none";

                  window.document.body.appendChild(link);
                  link.click();
                  window.document.body.removeChild(link);
                } catch (error) {
                  // Fallback: open in new tab if programmatic download fails
                  window.open(downloadUrl, "_blank");
                  console.error("Download failed, opened in new tab:", error);
                }

                handleClose();
                toast.success("Export successfully downloaded");
              } else if (statusData.status === "FAILED") {
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
                handleClose();
                toast.error(
                  `Export failed: ${statusData.error || "Unknown error"}`,
                );
              }
            }
          } catch (error) {
            console.error("Error polling export status:", error);
          }
        }, 5000); // Poll every 5 seconds

        // Clear interval after 10 minutes to prevent indefinite polling
        setTimeout(() => {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          handleClose();
        }, 600000);
      }
    } catch (error) {
      console.error("Error:", error);
      toast.error(
        "An error occurred while starting the export. Please try again.",
      );
      handleClose();
    }
  }, [teamId, dataroomId, groupId, dataroomName, groupName]);

  // Start export immediately when component mounts
  useEffect(() => {
    startExport();
  }, [startExport]);

  // Send export via email
  const sendExportEmail = async () => {
    if (!exportStatus?.exportId || !session?.user?.email) return;

    try {
      const response = await fetch(
        `/api/teams/${teamId}/export-jobs/${exportStatus.exportId}/send-email`,
        { method: "POST" },
      );

      if (response.ok) {
        toast.success("Export will be sent to your email when ready");
        handleClose();
      } else {
        toast.error("Failed to setup email notification");
      }
    } catch (error) {
      console.error("Error sending email:", error);
      toast.error("Failed to setup email notification");
    }
  };

  // Handle close - cleanup and call parent onClose
  const handleClose = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setShowModal(false);
    setExportStatus(null);
    exportStartedRef.current = false; // Reset for potential reuse
    onClose();
  };

  // Don't render anything if not visible and no modal to show
  if (!showModal) {
    return null;
  }

  const displayName = groupName
    ? `${dataroomName} - ${groupName}`
    : dataroomName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Export Visits</h3>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-muted-foreground"></div>
            <span className="text-sm text-gray-600">
              {exportStatus?.progress || "Processing export..."}
            </span>
          </div>

          <div className="text-sm text-gray-600">
            Exporting visits for: {displayName}
          </div>

          {viewCount !== null && (
            <div className="text-sm text-gray-600">
              Found {viewCount} visit{viewCount !== 1 ? "s" : ""} to export
            </div>
          )}

          {viewCount !== null && viewCount > 10 && session?.user?.email && (
            <div className="rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-900">
              <p className="mb-2 font-medium text-muted-foreground">
                Large export detected ({viewCount} visits)
              </p>
              <p className="mb-3 text-muted-foreground">
                This export may take several minutes. We recommend getting it
                emailed to you when ready.
              </p>
              <button
                onClick={sendExportEmail}
                className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/80"
              >
                Email to {session.user.email}
              </button>
            </div>
          )}

          {(!viewCount || viewCount <= 10) && (
            <div className="text-sm text-gray-500">
              Your export will be ready shortly...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
