import { useRouter } from "next/router";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTeam } from "@/context/team-context";
import { DocumentStorageType } from "@prisma/client";
import { useSession } from "next-auth/react";
import { DropEvent, FileRejection, useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { mutate } from "swr";

import { useAnalytics } from "@/lib/analytics";
import {
  FREE_PLAN_ACCEPTED_FILE_TYPES,
  FULL_PLAN_ACCEPTED_FILE_TYPES,
  SUPPORTED_DOCUMENT_MIME_TYPES,
} from "@/lib/constants";
import { DocumentData, createDocument } from "@/lib/documents/create-document";
import { resumableUpload } from "@/lib/files/tus-upload";
import {
  BulkFolderRequestItem,
  BulkFolderResultItem,
  bulkCreateFoldersChunked,
  createFolderInMainDocs,
  isSystemFile,
} from "@/lib/folders/create-folder";
import { usePlan } from "@/lib/swr/use-billing";
import useLimits from "@/lib/swr/use-limits";
import { useTeamSettings } from "@/lib/swr/use-team-settings";
import { CustomUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getSupportedContentType } from "@/lib/utils/get-content-type";
import {
  getFileSizeLimit,
  getFileSizeLimits,
} from "@/lib/utils/get-file-size-limits";
import { getPagesCount } from "@/lib/utils/get-page-number-count";

// These mime values are kept out of useDropzone's `accept` to keep the file
// type fallback path in getFilesFromEvent reachable (some browsers, notably
// Firefox, can't detect MIME type for files yielded from a dropped folder and
// need this lookup table to fix it up).
const acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial =
  FREE_PLAN_ACCEPTED_FILE_TYPES;
const allAcceptableDropZoneMimeTypes = FULL_PLAN_ACCEPTED_FILE_TYPES;

interface FileWithPaths extends File {
  path?: string;
  whereToUploadPath?: string;
  dataroomUploadPath?: string;
  /** Name of the top-level drag item this file belongs to */
  topLevelItemName?: string;
  topLevelItemIsFolder?: boolean;
  /** Number of folders created during traversal for this top-level item */
  topLevelItemFolderCount?: number;
  /** Server-generated slug path for the top-level folder (e.g. "folder-with-100-subfolders") */
  topLevelItemFolderPath?: string;
  /** Database id of the top-level folder in the dataroom (only set in dataroom uploads) */
  topLevelDataroomFolderId?: string;
}

export interface RejectedFile {
  fileName: string;
  message: string;
  reason?: "error" | "plan-limit" | "max-files";
  /** Individual file paths skipped due to limits — used for downloadable list */
  skippedFileNames?: string[];
}

export interface UploadItemState {
  itemId: string;
  name: string;
  type: "folder" | "file";
  /** Total entries: all nested folders + all files for folders; 1 for loose files */
  totalEntries: number;
  completedEntries: number;
  failedEntries: number;
  cancelled?: boolean;
  /** Pre-computed link for completed folder items */
  folderHref?: string;
  /** Byte-level upload progress for granular tracking (especially single large files) */
  bytesUploaded?: number;
  bytesTotal?: number;
}

export interface UploadBatchState {
  batchId: string;
  items: UploadItemState[];
  startedAt: number;
  /** Total entries across all items (folders + files) */
  totalEntries: number;
  completedEntries: number;
  failedEntries: number;
  cancelled?: boolean;
  /** Aggregate byte-level progress across all items */
  bytesUploaded?: number;
  bytesTotal?: number;
}

const UPLOAD_CONCURRENCY = 5;

/**
 * Window during which per-file SWR mutate keys are coalesced. The upload
 * loop fires up to 4 mutates per completed file; without batching, 400 files
 * produces 1600 GET refetches that re-fetch unpaginated folder trees and
 * saturate the per-origin connection pool. With a small debounce window
 * each unique key fires at most once per window, regardless of how many
 * files completed in that interval.
 */
const MUTATE_FLUSH_INTERVAL_MS = 500;

async function processWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/** Coalesces SWR mutate calls by key, flushing on a fixed interval + on demand. */
function createMutateQueue(intervalMs: number) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const keys = Array.from(pending);
    pending.clear();
    for (const key of keys) mutate(key);
  };

  return {
    enqueue(key: string | undefined | null | false) {
      if (!key) return;
      pending.add(key);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
  };
}

function stripLeadingSlash(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith("/") ? p.slice(1) : p;
}

/**
 * Parent path (without leading slash) of a folder path expressed in the
 * client-side "no leading slash" format. Returns undefined when the parent is
 * the root (i.e. the path is empty, "/", or a single top-level segment) —
 * callers should fall back to the `?root=true` key in that case.
 */
function parentPathOf(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const segments = p.split("/").filter(Boolean);
  if (segments.length <= 1) return undefined;
  return segments.slice(0, -1).join("/");
}

export interface UploadedTopLevelFolder {
  /** Database id of the dataroom folder */
  dataroomFolderId: string;
  /** Folder name shown to the user */
  name: string;
}

interface UploadZoneProps extends React.PropsWithChildren {
  onUploadBatchStart: (batch: UploadBatchState, cancelFn: () => void) => void;
  onUploadBatchUpdate: (batchId: string, update: Partial<UploadBatchState>) => void;
  onUploadRejected: (rejected: RejectedFile[]) => void;
  onUploadSuccess?: (
    files: {
      fileName: string;
      documentId: string;
      dataroomDocumentId: string;
      /** Set when this file was uploaded as part of a top-level dataroom folder */
      topLevelDataroomFolderId?: string;
    }[],
    folders?: UploadedTopLevelFolder[],
  ) => void;
  onTraversalStart?: (
    preliminaryItems?: { name: string; isFolder: boolean }[],
  ) => void;
  onUploadAborted?: () => void;
  setRejectedFiles: React.Dispatch<React.SetStateAction<RejectedFile[]>>;
  cancelledItemIdsRef?: React.RefObject<Set<string>>;
  folderPathName?: string;
  dataroomId?: string;
  dataroomName?: string;
  disabled?: boolean;
}

export default function UploadZone({
  children,
  onUploadBatchStart,
  onUploadBatchUpdate,
  onUploadRejected,
  onUploadSuccess,
  onTraversalStart,
  onUploadAborted,
  folderPathName,
  setRejectedFiles,
  cancelledItemIdsRef,
  dataroomId,
  dataroomName,
  disabled = false,
}: UploadZoneProps) {
  const analytics = useAnalytics();
  const { plan, isFree, isTrial } = usePlan();
  const router = useRouter();
  const teamInfo = useTeam();
  const { data: session } = useSession();
  const { limits, canAddDocuments, isPaused } = useLimits();
  const hasDocumentLimit = limits?.documents != null && limits.documents > 0;
  const remainingDocuments = hasDocumentLimit
    ? limits.documents - (limits?.usage?.documents ?? 0)
    : Infinity;

  // Fetch team settings with proper revalidation - ensures settings stay fresh across tabs
  const { settings: teamSettings } = useTeamSettings(teamInfo?.currentTeam?.id);
  const replicateDataroomFolders =
    teamSettings?.replicateDataroomFolders ?? true;

  // Track if we've created the dataroom folder in "All Documents" for non-replication mode
  // Using promise-lock pattern to prevent race conditions during concurrent folder creation
  const dataroomFolderPathRef = useRef<string | null>(null);
  const dataroomFolderCreationPromiseRef = useRef<Promise<string> | null>(null);
  const fileLimitTruncatedRef = useRef(false);

  // Reset the cached dataroom folder path when the replication setting changes
  // This ensures we don't use stale cached paths if the setting is toggled
  useEffect(() => {
    dataroomFolderPathRef.current = null;
    dataroomFolderCreationPromiseRef.current = null;
  }, [replicateDataroomFolders, dataroomId]);

  const fileSizeLimits = useMemo(
    () =>
      getFileSizeLimits({
        limits,
        isFree,
        isTrial,
      }),
    [limits, isFree, isTrial],
  );

  const acceptableDropZoneFileTypes =
    isFree && !isTrial
      ? acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial
      : allAcceptableDropZoneMimeTypes;

  // Helper function to get or create the dataroom folder in "All Documents"
  // Uses promise-lock pattern to prevent concurrent creation attempts
  const getOrCreateDataroomFolder = useCallback(async (): Promise<string> => {
    // If we already have the path cached, return it immediately
    if (dataroomFolderPathRef.current) {
      return dataroomFolderPathRef.current;
    }

    // If there's an ongoing creation, await it
    if (dataroomFolderCreationPromiseRef.current) {
      return dataroomFolderCreationPromiseRef.current;
    }

    // Start a new creation process
    const creationPromise = (async () => {
      try {
        if (!teamInfo?.currentTeam?.id || !dataroomName) {
          throw new Error("Missing team ID or dataroom name");
        }

        // First check if the folder already exists
        const existingFoldersResponse = await fetch(
          `/api/teams/${teamInfo.currentTeam.id}/folders?root=true`,
        );

        if (existingFoldersResponse.ok) {
          const existingFolders = await existingFoldersResponse.json();
          const existingDataroomFolder = existingFolders.find(
            (folder: any) => folder.name === dataroomName,
          );

          if (existingDataroomFolder) {
            // Folder already exists, use it
            const folderPath = existingDataroomFolder.path.startsWith("/")
              ? existingDataroomFolder.path.slice(1)
              : existingDataroomFolder.path;
            dataroomFolderPathRef.current = folderPath;
            return folderPath;
          }
        }

        // Folder doesn't exist, create it
        const dataroomFolderResponse = await createFolderInMainDocs({
          teamId: teamInfo.currentTeam.id,
          name: dataroomName,
          path: undefined, // Create at root level
        });

        const folderPath = dataroomFolderResponse.path.startsWith("/")
          ? dataroomFolderResponse.path.slice(1)
          : dataroomFolderResponse.path;

        dataroomFolderPathRef.current = folderPath;

        analytics.capture("Dataroom Folder Created in Main Docs", {
          folderName: dataroomName,
          dataroomId,
        });

        return folderPath;
      } catch (error) {
        console.error("Error handling dataroom folder:", error);
        // Clear the promise ref on error so subsequent attempts can retry
        dataroomFolderCreationPromiseRef.current = null;
        // Use dataroom name as fallback path
        const fallbackPath = dataroomName || "";
        dataroomFolderPathRef.current = fallbackPath;
        return fallbackPath;
      } finally {
        // Clear the promise ref once creation is complete
        dataroomFolderCreationPromiseRef.current = null;
      }
    })();

    // Store the promise so concurrent callers can await it
    dataroomFolderCreationPromiseRef.current = creationPromise;
    return creationPromise;
  }, [teamInfo, dataroomName, dataroomId, analytics]);

  // this var will help to determine the correct api endpoint to request folder creation (If needed).
  const endpointTargetType = dataroomId
    ? `datarooms/${dataroomId}/folders`
    : "folders";

  const onDropRejected = useCallback(
    (rejectedFiles: FileRejection[]) => {
      const hasTooManyFiles = rejectedFiles.some(({ errors }) =>
        errors.some(({ code }) => code === "too-many-files"),
      );

      if (hasTooManyFiles) {
        const maxFiles = fileSizeLimits.maxFiles ?? 150;
        toast.error(
          `You're trying to upload ${rejectedFiles.length} files, but you can only upload up to ${maxFiles} files at once. Please upload in smaller batches.`,
          { duration: 8000 },
        );
        onUploadRejected([
          {
            fileName: `${rejectedFiles.length} files selected`,
            message: `Maximum ${maxFiles} files per upload`,
            reason: "max-files",
          },
        ]);
        return;
      }

      const rejected = rejectedFiles.map(({ file, errors }) => {
        let message = "";
        if (errors.find(({ code }) => code === "file-too-large")) {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          message = `File size too big (max. ${fileSizeLimitMB} MB). Upgrade to a paid plan to increase the limit.`;
        } else if (errors.find(({ code }) => code === "file-invalid-type")) {
          const isSupported = SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type);
          message = `File type not supported ${
            isFree && !isTrial && isSupported ? `on free plan` : ""
          }`;
        }
        return { fileName: file.name, message };
      });
      onUploadRejected(rejected);
    },
    [onUploadRejected, fileSizeLimits, isFree, isTrial],
  );

  const onDrop = useCallback(
    async (acceptedFiles: FileWithPaths[]) => {
      if (isPaused) {
        toast.error(
          "Your subscription is paused. Resume your subscription to upload documents.",
          {
            action: {
              label: "Go to Billing",
              onClick: () => router.push("/settings/billing"),
            },
          },
        );
        onUploadAborted?.();
        return;
      }

      if (hasDocumentLimit && remainingDocuments <= 0) {
        toast.error(
          `You've reached your plan's document limit (${limits?.usage?.documents}/${limits?.documents} documents). Upgrade your plan to upload more.`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 8000,
          },
        );
        onUploadAborted?.();
        return;
      }

      let filesToUpload = acceptedFiles;

      if (fileLimitTruncatedRef.current) {
        fileLimitTruncatedRef.current = false;
        toast.warning(
          `Your upload was limited to ${acceptedFiles.length} file${acceptedFiles.length === 1 ? "" : "s"} because your plan only allows ${remainingDocuments} more document${remainingDocuments === 1 ? "" : "s"} (${limits?.usage?.documents}/${limits?.documents} used).`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 10000,
          },
        );
      } else if (hasDocumentLimit && acceptedFiles.length > remainingDocuments) {
        const skippedCount = acceptedFiles.length - remainingDocuments;
        toast.warning(
          `You're trying to upload ${acceptedFiles.length} files, but your plan only allows ${remainingDocuments} more document${remainingDocuments === 1 ? "" : "s"} (${limits?.usage?.documents}/${limits?.documents} used). ${skippedCount} file${skippedCount === 1 ? "" : "s"} will be skipped.`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 10000,
          },
        );
        filesToUpload = acceptedFiles.slice(0, remainingDocuments);
        const skippedFiles = acceptedFiles.slice(remainingDocuments);
        setRejectedFiles((prev) => [
          ...skippedFiles.map((f) => ({
            fileName: f.name,
            message: "Document limit reached",
            reason: "plan-limit" as const,
          })),
          ...prev,
        ]);
      }

      const validatedFiles = filesToUpload.reduce<{
        valid: FileWithPaths[];
        invalid: { fileName: string; message: string }[];
      }>(
        (acc, file) => {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          const fileSizeLimit = fileSizeLimitMB * 1024 * 1024;

          if (file.size > fileSizeLimit) {
            acc.invalid.push({
              fileName: file.name,
              message: `File size too big (max. ${fileSizeLimitMB} MB)${
                isFree && !isTrial
                  ? ". Upgrade to a paid plan to increase the limit"
                  : ""
              }`,
            });
          } else {
            acc.valid.push(file);
          }
          return acc;
        },
        { valid: [], invalid: [] },
      );

      if (validatedFiles.invalid.length > 0) {
        setRejectedFiles((prev) => [...validatedFiles.invalid, ...prev]);

        if (validatedFiles.valid.length === 0) {
          toast.error(
            `${validatedFiles.invalid.length} file(s) exceeded size limits`,
          );
          onUploadAborted?.();
          return;
        }
      }

      // Group files by their top-level drag item
      const itemGroups = new Map<
        string,
        {
          name: string;
          isFolder: boolean;
          folderCount: number;
          folderSlugPath?: string;
          dataroomFolderId?: string;
          files: FileWithPaths[];
        }
      >();
      for (const file of validatedFiles.valid) {
        const key = file.topLevelItemName ?? file.name;
        const existing = itemGroups.get(key);
        if (existing) {
          existing.files.push(file);
        } else {
          itemGroups.set(key, {
            name: key,
            isFolder: file.topLevelItemIsFolder ?? false,
            folderCount: file.topLevelItemFolderCount ?? 0,
            folderSlugPath: file.topLevelItemFolderPath,
            dataroomFolderId: file.topLevelDataroomFolderId,
            files: [file],
          });
        }
      }

      const batchId = crypto.randomUUID();
      let totalEntriesAcrossAll = 0;

      const items: UploadItemState[] = Array.from(itemGroups.values()).map(
        (group) => {
          const folderCount = group.isFolder ? group.folderCount : 0;
          const total = folderCount + group.files.length;
          totalEntriesAcrossAll += total;

          let folderHref: string | undefined;
          if (group.isFolder && group.folderSlugPath) {
            folderHref = dataroomId
              ? `/datarooms/${dataroomId}/documents/${group.folderSlugPath}`
              : `/documents/tree/${group.folderSlugPath}`;
          }

          const groupBytesTotal = group.files.reduce((sum, f) => sum + f.size, 0);

          return {
            itemId: crypto.randomUUID(),
            name: group.name,
            type: group.isFolder ? ("folder" as const) : ("file" as const),
            totalEntries: total,
            completedEntries: folderCount,
            failedEntries: 0,
            folderHref,
            bytesUploaded: 0,
            bytesTotal: groupBytesTotal,
          };
        },
      );

      const batch: UploadBatchState = {
        batchId,
        items,
        startedAt: Date.now(),
        totalEntries: totalEntriesAcrossAll,
        // Folders created during traversal count as completed entries
        completedEntries: items.reduce((s, it) => s + it.completedEntries, 0),
        failedEntries: 0,
        bytesUploaded: 0,
        bytesTotal: items.reduce((s, it) => s + (it.bytesTotal ?? 0), 0),
      };

      const dropCancelled = { current: false };
      onUploadBatchStart(batch, () => {
        dropCancelled.current = true;
      });

      // Build a lookup: file -> which UploadItemState it belongs to
      const fileToItem = new Map<FileWithPaths, UploadItemState>();
      let itemIdx = 0;
      for (const group of itemGroups.values()) {
        const item = items[itemIdx++];
        for (const file of group.files) {
          fileToItem.set(file, item);
        }
      }

      let completedCount = batch.completedEntries;
      let failedCount = 0;

      // Per-file byte tracking for granular progress
      const fileBytesUploaded = new Map<FileWithPaths, number>();
      const itemFilesMap = new Map<UploadItemState, FileWithPaths[]>();
      for (const [file, item] of fileToItem) {
        fileBytesUploaded.set(file, 0);
        const files = itemFilesMap.get(item) ?? [];
        files.push(file);
        itemFilesMap.set(item, files);
      }

      const emitUpdate = () => {
        onUploadBatchUpdate(batchId, {
          items: items.map((it) => {
            const filesInItem = itemFilesMap.get(it) ?? [];
            let uploaded = 0;
            for (const f of filesInItem) {
              uploaded += fileBytesUploaded.get(f) ?? 0;
            }
            return { ...it, bytesUploaded: uploaded };
          }),
          completedEntries: completedCount,
          failedEntries: failedCount,
        });
      };

      const mutateQueue = createMutateQueue(MUTATE_FLUSH_INTERVAL_MS);

      const uploadTasks = validatedFiles.valid.map((file) => async () => {
        if (dropCancelled.current) return undefined;

        const path = file.path || file.name;
        const parentItem = fileToItem.get(file)!;

        // Skip files for cancelled items
        if (cancelledItemIdsRef?.current?.has(parentItem.itemId)) {
          return undefined;
        }

        try {
          let numPages = 1;
          if (file.type === "application/pdf") {
            const buffer = await file.arrayBuffer();
            numPages = await getPagesCount(buffer);

            if (numPages > fileSizeLimits.maxPages) {
              failedCount++;
              parentItem.failedEntries++;
              setRejectedFiles((prev) => [
                {
                  fileName: file.name,
                  message: `File has too many pages (max. ${fileSizeLimits.maxPages})`,
                },
                ...prev,
              ]);
              emitUpdate();
              return undefined;
            }
          }

          const { complete } = await resumableUpload({
            file,
            onProgress: (bytesUploaded, _bytesTotal) => {
              fileBytesUploaded.set(file, bytesUploaded);
              emitUpdate();
            },
            onError: () => {
              failedCount++;
              parentItem.failedEntries++;
              setRejectedFiles((prev) => [
                { fileName: file.name, message: "Error uploading file" },
                ...prev,
              ]);
              emitUpdate();
            },
            ownerId: (session?.user as CustomUser).id,
            teamId: teamInfo?.currentTeam?.id as string,
            numPages,
            relativePath: path.substring(0, path.lastIndexOf("/")),
          });

          const uploadResult = await complete;

          let contentType = uploadResult.fileType;
          let supportedFileType = getSupportedContentType(contentType) ?? "";

          if (
            uploadResult.fileName.endsWith(".dwg") ||
            uploadResult.fileName.endsWith(".dxf")
          ) {
            supportedFileType = "cad";
            contentType = `image/vnd.${uploadResult.fileName.split(".").pop()}`;
          }

          if (uploadResult.fileName.endsWith(".xlsm")) {
            supportedFileType = "sheet";
            contentType = "application/vnd.ms-excel.sheet.macroEnabled.12";
          }

          if (
            uploadResult.fileName.endsWith(".kml") ||
            uploadResult.fileName.endsWith(".kmz")
          ) {
            supportedFileType = "map";
            contentType = `application/vnd.google-earth.${uploadResult.fileName.endsWith(".kml") ? "kml+xml" : "kmz"}`;
          }

          if (
            uploadResult.fileName.endsWith(".tif") ||
            uploadResult.fileName.endsWith(".tiff")
          ) {
            supportedFileType = "other";
            contentType = "image/tiff";
          }

          if (uploadResult.fileName.endsWith(".ecw")) {
            supportedFileType = "other";
            contentType = "image/x-ecw";
          }

          if (uploadResult.fileName.endsWith(".bak")) {
            supportedFileType = "other";
            contentType = "application/x-bak";
          }

          const documentData: DocumentData = {
            key: uploadResult.id,
            supportedFileType: supportedFileType,
            name: file.name,
            storageType: DocumentStorageType.S3_PATH,
            contentType: contentType,
            fileSize: file.size,
          };

          const fileUploadPathName = file?.whereToUploadPath;
          const dataroomUploadPathName = file?.dataroomUploadPath;

          const response = await createDocument({
            documentData,
            teamId: teamInfo?.currentTeam?.id as string,
            numPages: uploadResult.numPages,
            folderPathName: fileUploadPathName,
          });

          mutateQueue.enqueue(
            `/api/teams/${teamInfo?.currentTeam?.id}/documents`,
          );
          mutateQueue.enqueue(
            fileUploadPathName &&
              `/api/teams/${teamInfo?.currentTeam?.id}/folder-documents/${fileUploadPathName}`,
          );
          // Refresh folder-list keys so per-folder `_count.documents` updates
          // while the upload is in progress: root (always), the user's
          // current view, and the parent of the folder this specific file
          // lands in (so a subfolder card the user is viewing ticks up). The
          // queue dedupes by key + flushes on a debounce window, so this is
          // bounded to ~one refresh per 500 ms regardless of file count.
          mutateQueue.enqueue(
            `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}?root=true`,
          );
          mutateQueue.enqueue(
            folderPathName &&
              `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}/${folderPathName}`,
          );
          const fileParentPath = parentPathOf(fileUploadPathName);
          mutateQueue.enqueue(
            fileParentPath &&
              `/api/teams/${teamInfo?.currentTeam?.id}/folders/${fileParentPath}`,
          );

          const document = await response.json();
          let dataroomResponse;
          if (dataroomId) {
            try {
              dataroomResponse = await fetch(
                `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    documentId: document.id,
                    folderPathName: dataroomUploadPathName || fileUploadPathName,
                  }),
                },
              );

              if (!dataroomResponse?.ok) {
                const { message } = await dataroomResponse.json();
                console.error(
                  "An error occurred while adding document to the dataroom: ",
                  message,
                );
                return undefined;
              }

              mutateQueue.enqueue(
                `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
              );
              mutateQueue.enqueue(
                (dataroomUploadPathName || fileUploadPathName) &&
                  `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/folder-documents/${dataroomUploadPathName || fileUploadPathName}`,
              );
              const dataroomParentPath = parentPathOf(
                dataroomUploadPathName || fileUploadPathName,
              );
              mutateQueue.enqueue(
                dataroomParentPath &&
                  `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/folders/${dataroomParentPath}`,
              );
            } catch (error) {
              console.error(
                "An error occurred while adding document to the dataroom: ",
                error,
              );
            }
          }

          completedCount++;
          parentItem.completedEntries++;
          fileBytesUploaded.set(file, file.size);
          if (!parentItem.folderHref && document.id) {
            parentItem.folderHref = `/documents/${document.id}`;
          }
          emitUpdate();

          analytics.capture("Document Added", {
            documentId: document.id,
            name: document.name,
            numPages: document.numPages,
            path: router.asPath,
            type: document.type,
            contentType: document.contentType,
            teamId: teamInfo?.currentTeam?.id,
            bulkupload: true,
            dataroomId: dataroomId,
            $set: {
              teamId: teamInfo?.currentTeam?.id,
              teamPlan: plan,
            },
          });
          const dataroomDocumentId = dataroomResponse?.ok
            ? (await dataroomResponse.json()).id
            : null;

          return {
            ...document,
            dataroomDocumentId: dataroomDocumentId,
            topLevelDataroomFolderId: file.topLevelDataroomFolderId,
            topLevelItemIsFolder: file.topLevelItemIsFolder,
          };
        } catch (error) {
          failedCount++;
          parentItem.failedEntries++;
          setRejectedFiles((prev) => [
            { fileName: file.name, message: "Error uploading file" },
            ...prev,
          ]);
          emitUpdate();
          return undefined;
        }
      });

      try {
        const results = await processWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY);

        mutateQueue.enqueue(
          `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}?root=true`,
        );
        mutateQueue.enqueue(
          `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}`,
        );
        mutateQueue.enqueue(
          folderPathName &&
            `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}/${folderPathName}`,
        );

        // When a dataroom drop also replicates folders into "All Documents",
        // refresh the main-docs caches at end of batch. Single revalidation
        // covers what the now-removed per-folder mutate() calls used to do.
        if (dataroomId && replicateDataroomFolders) {
          mutateQueue.enqueue(
            `/api/teams/${teamInfo?.currentTeam?.id}/folders?root=true`,
          );
          mutateQueue.enqueue(
            `/api/teams/${teamInfo?.currentTeam?.id}/documents`,
          );
        }

        mutateQueue.flush();

        const uploadedDocuments = results.filter(Boolean);
        const dataroomDocuments = uploadedDocuments.map((document: any) => ({
          documentId: document.id,
          dataroomDocumentId: document.dataroomDocumentId,
          fileName: document.name,
          topLevelDataroomFolderId: document.topLevelDataroomFolderId,
        }));

        // Collect every top-level folder the user dropped so the caller can
        // offer one-shot folder-level permission configuration instead of
        // walking through every uploaded file individually.
        const uploadedFolders: UploadedTopLevelFolder[] = Array.from(
          itemGroups.values(),
        )
          .filter(
            (group) =>
              group.isFolder && !!group.dataroomFolderId,
          )
          .map((group) => ({
            dataroomFolderId: group.dataroomFolderId!,
            name: group.name,
          }));

        onUploadSuccess?.(dataroomDocuments, uploadedFolders);
      } catch (error) {
        console.error("Upload batch failed:", error);
      } finally {
        mutateQueue.flush();
      }
    },
    [
      onUploadBatchStart,
      onUploadBatchUpdate,
      onUploadAborted,
      endpointTargetType,
      fileSizeLimits,
      isFree,
      isTrial,
      isPaused,
      hasDocumentLimit,
      remainingDocuments,
      dataroomId,
      replicateDataroomFolders,
    ],
  );

  const getFilesFromEvent = useCallback(
    async (event: DropEvent) => {
      // useDropzone invokes getFilesFromEvent for dragenter too; only react to drop/change.
      if ("type" in event && event.type !== "drop" && event.type !== "change") {
        return [];
      }

      let preliminaryItems: { name: string; isFolder: boolean }[] | undefined;
      if ("dataTransfer" in event && event.dataTransfer) {
        preliminaryItems = Array.from(
          event.dataTransfer.items,
          (item) => {
            const entry =
              (typeof item?.webkitGetAsEntry === "function" &&
                item.webkitGetAsEntry()) ??
              (typeof (item as any)?.getAsEntry === "function" &&
                (item as any).getAsEntry()) ??
              null;
            return {
              name: entry?.name ?? (item.type || "Unknown"),
              isFolder: entry?.isDirectory ?? false,
            };
          },
        ).filter((e) => e.name !== "Unknown");
      } else if (
        "target" in event &&
        event.target instanceof HTMLInputElement &&
        event.target.files
      ) {
        preliminaryItems = Array.from(event.target.files, (f) => ({
          name: f.name,
          isFolder: false,
        }));
      }
      onTraversalStart?.(preliminaryItems);

      fileLimitTruncatedRef.current = false;
      const maxFilesPerUpload = fileSizeLimits.maxFiles ?? 150;
      const planDocumentLimit =
        hasDocumentLimit && isFinite(remainingDocuments)
          ? Math.max(0, remainingDocuments)
          : Infinity;
      const fileLimit = Math.min(maxFilesPerUpload, planDocumentLimit);

      if (fileLimit <= 0) return [];

      // ----- Plain <input type="file"> path: no folder traversal needed.
      if (
        "target" in event &&
        event.target &&
        event.target instanceof HTMLInputElement &&
        event.target.files
      ) {
        const out: FileWithPaths[] = [];
        for (let i = 0; i < event.target.files.length; i++) {
          if (out.length >= fileLimit) break;
          const file: FileWithPaths = event.target.files[i];
          file.path = file.name;
          file.whereToUploadPath = folderPathName;
          file.dataroomUploadPath = folderPathName;
          file.topLevelItemName = file.name;
          file.topLevelItemIsFolder = false;
          out.push(file);
        }
        if (out.length < event.target.files.length) {
          fileLimitTruncatedRef.current = true;
        }
        return out;
      }

      if (!("dataTransfer" in event) || !event.dataTransfer) return [];
      if (!teamInfo?.currentTeam?.id) {
        setRejectedFiles((prev) => [
          { fileName: "Unknown Team", message: "Team Id not found" },
          ...prev,
        ]);
        return [];
      }

      const teamId = teamInfo.currentTeam.id;
      const skippedPerTopLevel = new Map<string, string[]>();

      const readAllDirectoryEntries = async (
        dirReader: FileSystemDirectoryReader,
      ): Promise<FileSystemEntry[]> => {
        const allEntries: FileSystemEntry[] = [];
        let batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          dirReader.readEntries(resolve, reject),
        );
        while (batch.length > 0) {
          allEntries.push(...batch);
          batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
            dirReader.readEntries(resolve, reject),
          );
        }
        return allEntries;
      };

      // Per-file row collected during the walk, before bulk folder creation.
      type PendingFile = {
        entry: FileSystemFileEntry;
        parentTempId: string | null;
        topLevelTempId: string | null;
        topLevelName: string;
        topLevelIsFolder: boolean;
      };

      // Walks one top-level entry, collecting folder rows + file rows. No
      // network I/O happens here — that's deferred to a single bulk POST.
      const walkTopLevel = async (
        topEntry: FileSystemEntry,
      ): Promise<{
        folders: BulkFolderRequestItem[];
        files: PendingFile[];
        topLevelTempId: string | null;
      }> => {
        const folders: BulkFolderRequestItem[] = [];
        const files: PendingFile[] = [];
        let topLevelTempId: string | null = null;

        const recurse = async (
          entry: FileSystemEntry,
          parentTempId: string | null,
        ): Promise<void> => {
          if (isSystemFile(entry.name)) return;

          if (entry.isDirectory) {
            if (entry.name.trim() === "") {
              setRejectedFiles((prev) => [
                { fileName: entry.name, message: "Folder name cannot be empty" },
                ...prev,
              ]);
              return;
            }
            const tempId = crypto.randomUUID();
            folders.push({
              tempId,
              name: entry.name,
              parentTempId,
            });
            if (topLevelTempId === null) topLevelTempId = tempId;

            const subs = await readAllDirectoryEntries(
              (entry as FileSystemDirectoryEntry).createReader(),
            );
            await Promise.all(subs.map((sub) => recurse(sub, tempId)));
          } else if (entry.isFile) {
            files.push({
              entry: entry as FileSystemFileEntry,
              parentTempId,
              topLevelTempId,
              topLevelName: topEntry.name,
              topLevelIsFolder: topEntry.isDirectory,
            });
          }
        };

        await recurse(topEntry, null);
        return { folders, files, topLevelTempId };
      };

      const topEntries = Array.from(event.dataTransfer.items, (item) => {
        const entry =
          (typeof item?.webkitGetAsEntry === "function" &&
            item.webkitGetAsEntry()) ??
          (typeof (item as any)?.getAsEntry === "function" &&
            (item as any).getAsEntry()) ??
          null;
        return entry as FileSystemEntry | null;
      }).filter((e): e is FileSystemEntry => !!e);

      const walkResults = await Promise.all(topEntries.map(walkTopLevel));
      const allFolders = walkResults.flatMap((r) => r.folders);
      const allFiles = walkResults.flatMap((r) => r.files);

      // ----- Bulk-create folders (one request per scope, in parallel).
      let dataroomByTemp = new Map<string, BulkFolderResultItem>();
      let mainDocsByTemp = new Map<string, BulkFolderResultItem>();

      const rootPathForApi =
        folderPathName && folderPathName.length > 0
          ? "/" + folderPathName
          : "/";

      if (allFolders.length > 0) {
        try {
          if (dataroomId) {
            // Replicated copies in main docs always live at the team root,
            // regardless of where in the dataroom the user dropped the tree.
            const tasks: Promise<void>[] = [
              bulkCreateFoldersChunked({
                url: `/api/teams/${teamId}/datarooms/${dataroomId}/folders/bulk`,
                rootPath: rootPathForApi,
                folders: allFolders,
              }).then((rows) => {
                dataroomByTemp = new Map(rows.map((r) => [r.tempId, r]));
              }),
            ];
            if (replicateDataroomFolders) {
              tasks.push(
                bulkCreateFoldersChunked({
                  url: `/api/teams/${teamId}/folders/bulk`,
                  rootPath: "/",
                  folders: allFolders,
                }).then((rows) => {
                  mainDocsByTemp = new Map(rows.map((r) => [r.tempId, r]));
                }),
              );
            } else if (dataroomName) {
              await getOrCreateDataroomFolder();
            }
            await Promise.all(tasks);
          } else {
            const rows = await bulkCreateFoldersChunked({
              url: `/api/teams/${teamId}/folders/bulk`,
              rootPath: rootPathForApi,
              folders: allFolders,
            });
            mainDocsByTemp = new Map(rows.map((r) => [r.tempId, r]));
          }

          analytics.capture("Folder Added (bulk)", {
            count: allFolders.length,
            dataroomId: dataroomId,
            replicated: dataroomId ? replicateDataroomFolders : undefined,
          });

          // Broad one-shot revalidation of every cached folder/document key
          // for this scope. Targeted mutates only cover root + the user's
          // current view, which leaves deep paths the user navigated to
          // *during* bulk-create stuck on whatever empty/404 response SWR
          // fetched while the transaction was still in flight (SWR has
          // revalidateOnFocus: false + dedupingInterval: 30s, so the stale
          // cache otherwise persists). mutate(filterFn) only refetches keys
          // already in cache — typically 2–10 keys, fired once at the end of
          // bulkCreateFolders, not per file — so the "GET burst" cost is
          // negligible and bounded.
          const isDataroomFolderKey = (key: unknown) =>
            typeof key === "string" &&
            dataroomId !== undefined &&
            (key.startsWith(
              `/api/teams/${teamId}/datarooms/${dataroomId}/folders`,
            ) ||
              key.startsWith(
                `/api/teams/${teamId}/datarooms/${dataroomId}/folder-documents`,
              ) ||
              key.startsWith(
                `/api/teams/${teamId}/datarooms/${dataroomId}/documents`,
              ));
          const isMainDocsFolderKey = (key: unknown) =>
            typeof key === "string" &&
            (key.startsWith(`/api/teams/${teamId}/folders`) ||
              key.startsWith(`/api/teams/${teamId}/folder-documents`) ||
              key === `/api/teams/${teamId}/documents`);

          if (dataroomId) {
            mutate(isDataroomFolderKey);
            if (replicateDataroomFolders) mutate(isMainDocsFolderKey);
          } else {
            mutate(isMainDocsFolderKey);
          }
        } catch (error) {
          console.error("Bulk folder creation failed:", error);
          setRejectedFiles((prev) => [
            ...allFolders.map((f) => ({
              fileName: f.name,
              message: "Failed to create the folder",
            })),
            ...prev,
          ]);
          return [];
        }
      }

      // Per-top-level folder count for the upload-drawer progress bar.
      const parentByTemp = new Map(
        allFolders.map((f) => [f.tempId, f.parentTempId ?? null]),
      );
      const folderCountByTopLevelTempId = new Map<string, number>();
      for (const f of allFolders) {
        let cur: string | null = f.parentTempId ?? null;
        let topLevel = f.tempId;
        while (cur) {
          topLevel = cur;
          cur = parentByTemp.get(cur) ?? null;
        }
        folderCountByTopLevelTempId.set(
          topLevel,
          (folderCountByTopLevelTempId.get(topLevel) ?? 0) + 1,
        );
      }

      // ----- Resolve files (read content + annotate).
      let dataroomFolderInMainDocsPath: string | undefined;
      if (!replicateDataroomFolders && dataroomId && dataroomName) {
        dataroomFolderInMainDocsPath = await getOrCreateDataroomFolder();
      }

      const filesToBePassedToOnDrop: FileWithPaths[] = [];

      for (let i = 0; i < allFiles.length; i++) {
        if (filesToBePassedToOnDrop.length >= fileLimit) {
          for (let j = i; j < allFiles.length; j++) {
            const skipped = allFiles[j];
            const list =
              skippedPerTopLevel.get(skipped.topLevelName) ?? [];
            list.push(
              skipped.entry.fullPath.startsWith("/")
                ? skipped.entry.fullPath.substring(1)
                : skipped.entry.fullPath,
            );
            skippedPerTopLevel.set(skipped.topLevelName, list);
          }
          fileLimitTruncatedRef.current = true;
          break;
        }

        const pending = allFiles[i];
        let file = await new Promise<FileWithPaths>((resolve) =>
          pending.entry.file(resolve),
        );

        // Firefox can't always detect MIME type from drag-and-dropped folder
        // contents; fall back to the extension table.
        if (file.type === "") {
          const ext = file.name.split(".").pop()?.toLowerCase();
          let correctMimeType: string | undefined;
          if (ext) {
            for (const [mime, extsUntyped] of Object.entries(
              acceptableDropZoneFileTypes,
            )) {
              const exts = extsUntyped as string[];
              if (exts.some((e) => e.toLowerCase() === "." + ext)) {
                correctMimeType = mime;
                break;
              }
            }
          }
          if (correctMimeType) {
            file = new File([file], file.name, {
              type: correctMimeType,
              lastModified: file.lastModified,
            });
          }
        }

        file.path = pending.entry.fullPath.startsWith("/")
          ? pending.entry.fullPath.substring(1)
          : pending.entry.fullPath;

        const mainDocsFolderPath = pending.parentTempId
          ? stripLeadingSlash(mainDocsByTemp.get(pending.parentTempId)?.path)
          : folderPathName;
        const dataroomFolderPath = pending.parentTempId
          ? stripLeadingSlash(dataroomByTemp.get(pending.parentTempId)?.path)
          : folderPathName;

        if (!replicateDataroomFolders && dataroomId && dataroomName) {
          file.whereToUploadPath = dataroomFolderInMainDocsPath;
        } else {
          file.whereToUploadPath = mainDocsFolderPath;
        }
        file.dataroomUploadPath = dataroomId ? dataroomFolderPath : undefined;

        file.topLevelItemName = pending.topLevelName;
        file.topLevelItemIsFolder = pending.topLevelIsFolder;
        if (pending.topLevelTempId) {
          file.topLevelItemFolderCount =
            folderCountByTopLevelTempId.get(pending.topLevelTempId) ?? 0;
          const topLevelDataroom = dataroomByTemp.get(pending.topLevelTempId);
          const topLevelMainDocs = mainDocsByTemp.get(pending.topLevelTempId);
          file.topLevelItemFolderPath = dataroomId
            ? stripLeadingSlash(topLevelDataroom?.path)
            : stripLeadingSlash(topLevelMainDocs?.path);
          file.topLevelDataroomFolderId = topLevelDataroom?.id;
        }

        filesToBePassedToOnDrop.push(file);
      }

      if (skippedPerTopLevel.size > 0) {
        const skippedEntries: RejectedFile[] = [];
        for (const [name, paths] of skippedPerTopLevel) {
          skippedEntries.push({
            fileName: `${name}: ${paths.length} file${paths.length !== 1 ? "s" : ""} not uploaded`,
            message: "Document limit reached",
            reason: "plan-limit",
            skippedFileNames: paths,
          });
        }
        setRejectedFiles((prev) => [...skippedEntries, ...prev]);
      }

      return filesToBePassedToOnDrop;
    },
    [
      folderPathName,
      teamInfo,
      dataroomId,
      dataroomName,
      analytics,
      setRejectedFiles,
      acceptableDropZoneFileTypes,
      getOrCreateDataroomFolder,
      hasDocumentLimit,
      remainingDocuments,
      fileSizeLimits,
      replicateDataroomFolders,
      onTraversalStart,
    ],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: acceptableDropZoneFileTypes,
    multiple: true,
    // maxSize: maxSize * 1024 * 1024, // 30 MB
    maxFiles: fileSizeLimits.maxFiles ?? 150,
    onDrop,
    onDropRejected,
    getFilesFromEvent,
    disabled,
    noClick: disabled,
    noDrag: disabled,
    noDragEventsBubbling: disabled,
  });

  return (
    <div
      {...getRootProps({ onClick: (evt) => evt.stopPropagation() })}
      className={cn(
        "relative",
        dataroomId ? "min-h-[calc(100vh-350px)]" : "min-h-[calc(100vh-270px)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 z-40 -m-1 rounded-lg border-2 border-dashed",
          isDragActive
            ? "pointer-events-auto border-primary/50 bg-gray-100/75 backdrop-blur-sm dark:bg-gray-800/75"
            : "pointer-events-none border-none",
        )}
      >
        <input
          {...getInputProps()}
          name="file"
          id="upload-multi-files-zone"
          className="sr-only"
        />

        {isDragActive && (
          <div className="sticky top-1/2 z-50 -translate-y-1/2 px-2">
            <div className="flex justify-center">
              <div className="inline-flex flex-col rounded-lg bg-background/95 px-6 py-4 text-center ring-1 ring-gray-900/5 dark:bg-gray-900/95 dark:ring-white/10">
                <span className="font-medium text-foreground">
                  Drop your file(s) here
                </span>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {isFree && !isTrial
                    ? `Only *.pdf, *.xls, *.xlsx, *.csv, *.tsv, *.ods, *.png, *.jpeg, *.jpg`
                    : `Only *.pdf, *.pptx, *.docx, *.xlsx, *.xls, *.csv, *.tsv, *.ods, *.ppt, *.odp, *.doc, *.odt, *.dwg, *.dxf, *.png, *.jpg, *.jpeg, *.mp4, *.mov, *.avi, *.webm, *.ogg, *.log`}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}
