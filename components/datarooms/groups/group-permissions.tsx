"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTeam } from "@/context/team-context";
import { ItemType, ViewerGroupAccessControls } from "@prisma/client";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDownToLineIcon,
  ChevronDown,
  ChevronRight,
  EyeIcon,
  EyeOffIcon,
  File,
  Folder,
  HomeIcon,
  Loader2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { useFeatureFlags } from "@/lib/hooks/use-feature-flags";
import { useDataroomFoldersTree } from "@/lib/swr/use-dataroom";
import { cn } from "@/lib/utils";
import {
  HIERARCHICAL_DISPLAY_STYLE,
  getHierarchicalDisplayName,
} from "@/lib/utils/hierarchical-display";

import CloudDownloadOff from "@/components/shared/icons/cloud-download-off";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const PermissionItemName = ({ item }: { item: FileOrFolder }) => {
  const { isFeatureEnabled } = useFeatureFlags();
  const isDataroomIndexEnabled = isFeatureEnabled("dataroomIndex");

  const displayName = getHierarchicalDisplayName(
    item.name,
    item.hierarchicalIndex,
    isDataroomIndexEnabled,
  );

  const isRoot = item.id === "__dataroom_root__";

  return (
    <div className="flex items-center text-foreground">
      {isRoot ? (
        <HomeIcon className="mr-2 h-5 w-5" />
      ) : item.itemType === ItemType.DATAROOM_FOLDER ? (
        <Folder className="mr-2 h-5 w-5" />
      ) : (
        <File className="mr-2 h-5 w-5" />
      )}
      <span className="truncate" style={HIERARCHICAL_DISPLAY_STYLE}>
        {displayName}
      </span>
    </div>
  );
};

// Update the FileOrFolder type to include permissions
type FileOrFolder = {
  id: string;
  name: string;
  hierarchicalIndex?: string | null;
  subItems?: FileOrFolder[];
  permissions: {
    view: boolean;
    download: boolean;
    partialView?: boolean;
    partialDownload?: boolean;
  };
  itemType: ItemType;
  documentId?: string;
};

type ItemPermission = Record<
  string,
  { view: boolean; download: boolean; itemType: ItemType }
>;

type ColumnExtra = {
  updatePermissions: (id: string, newPermissions: string[]) => void;
};

const createColumns = (extra: ColumnExtra): ColumnDef<FileOrFolder>[] => [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => {
      const isRoot = row.original.id === "__dataroom_root__";
      return (
        <div className="flex items-center text-foreground">
          {isRoot ? (
            <div className="h-6 w-6 shrink-0" />
          ) : row.getCanExpand() ? (
            <Button
              variant="ghost"
              onClick={row.getToggleExpandedHandler()}
              className="mr-1 h-6 w-6 shrink-0 p-0"
              disabled={isRoot}
            >
              {row.getIsExpanded() ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <div className="mr-1 h-6 w-6 shrink-0" />
          )}
          <PermissionItemName item={row.original} />
        </div>
      );
    },
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => {
      const item = row.original;

      const handleValueChange = (value: string[]) => {
        extra.updatePermissions(item.id, value);
      };

      const toggleValue: string[] = [];
      if (item.permissions.view) toggleValue.push("view");
      if (item.permissions.download) toggleValue.push("download");

      return (
        <ToggleGroup
          type="multiple"
          value={toggleValue}
          onValueChange={handleValueChange}
        >
          <ToggleGroupItem
            value="view"
            aria-label="Toggle view"
            size="sm"
            className={cn(
              "px-2 text-muted-foreground hover:ring-1 hover:ring-gray-400 data-[state=on]:bg-foreground data-[state=on]:text-background",
              item.permissions.view
                ? item.permissions.partialView
                  ? "data-[state=on]:bg-gray-400 data-[state=on]:text-background"
                  : "data-[state=on]:bg-foreground data-[state=on]:text-background"
                : "",
            )}
          >
            {item.permissions.view ||
            (item.permissions.view && item.permissions.partialView) ? (
              <EyeIcon className="h-5 w-5" />
            ) : (
              <EyeOffIcon className="h-5 w-5" />
            )}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="download"
            aria-label="Toggle download"
            size="sm"
            className={cn(
              "px-2 text-muted-foreground hover:ring-1 hover:ring-gray-400 data-[state=on]:bg-foreground data-[state=on]:text-background",
              item.permissions.download
                ? item.permissions.partialDownload
                  ? "data-[state=on]:bg-gray-400 data-[state=on]:text-background"
                  : "data-[state=on]:bg-foreground data-[state=on]:text-background"
                : "",
            )}
          >
            {item.permissions.download ||
            (item.permissions.download && item.permissions.partialDownload) ? (
              <ArrowDownToLineIcon className="h-5 w-5" />
            ) : (
              <CloudDownloadOff className="h-5 w-5" />
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      );
    },
  },
];

// Build tree function to include permissions
const buildTree = (
  items: any[],
  permissions: ViewerGroupAccessControls[],
  parentId: string | null = null,
): FileOrFolder[] => {
  const getPermissions = (id: string) => {
    const permission = permissions.find((p) => p.itemId === id);

    // No row in viewerGroupAccessControls means the viewer cannot see the
    // item. Default to false so the UI faithfully reflects the persisted
    // server state (otherwise toggling one item silently changes the view of
    // unrelated items after refetch, which feels random to users).
    return {
      view: permission ? permission.canView : false,
      download: permission ? permission.canDownload : false,
      partialView: false,
      partialDownload: false,
    };
  };

  const result: FileOrFolder[] = [];

  // Handle folders and their contents
  items
    .filter((item) => item.parentId === parentId && !item.document)
    .forEach((folder) => {
      const subItems = buildTree(items, permissions, folder.id);

      // Add documents directly in this folder
      const folderDocuments = (folder.documents || []).map((doc: any) => ({
        id: doc.id,
        documentId: doc.document.id,
        name: doc.document.name,
        hierarchicalIndex: doc.hierarchicalIndex,
        permissions: getPermissions(doc.id),
        itemType: ItemType.DATAROOM_DOCUMENT,
      }));

      const allSubItems = [...subItems, ...folderDocuments];

      const folderPermissions = getPermissions(folder.id);

      // Calculate view and partialView for folders
      let viewStatus = folderPermissions.view;
      let partialView = false;
      let downloadStatus = folderPermissions.download;
      let partialDownload = false;

      if (allSubItems.length > 0) {
        const viewableItems = allSubItems.filter(
          (item) => item.permissions.view,
        );
        const downloadableItems = allSubItems.filter(
          (item) => item.permissions.download,
        );

        viewStatus = viewableItems.length > 0;
        partialView =
          viewableItems.length > 0 && viewableItems.length < allSubItems.length;
        downloadStatus = downloadableItems.length > 0;
        partialDownload =
          downloadableItems.length > 0 &&
          downloadableItems.length < allSubItems.length;
      }

      result.push({
        id: folder.id,
        name: folder.name,
        hierarchicalIndex: folder.hierarchicalIndex,
        subItems: allSubItems,
        permissions: {
          view: viewStatus,
          download: downloadStatus,
          partialView,
          partialDownload,
        },
        itemType: ItemType.DATAROOM_FOLDER,
      });
    });

  // Handle documents at the current level (including root level)
  items
    .filter(
      (item) =>
        (item.parentId === parentId && item.document) ||
        (parentId === null && item.folderId === null && item.document),
    )
    .forEach((doc) => {
      result.push({
        id: doc.id,
        documentId: doc.document.id,
        name: doc.document.name,
        hierarchicalIndex: doc.hierarchicalIndex,
        permissions: getPermissions(doc.id),
        itemType: ItemType.DATAROOM_DOCUMENT,
      });
    });

  return result;
};

// Build tree with virtual root folder
const buildTreeWithRoot = (
  items: any[],
  permissions: ViewerGroupAccessControls[],
  dataroomName: string = "Dataroom Home",
): FileOrFolder[] => {
  // Get all items (folders and root documents)
  const allItems = buildTree(items, permissions, null);

  // Calculate overall permissions for the virtual root
  const calculateRootPermissions = (items: FileOrFolder[]) => {
    const flattenItems = (items: FileOrFolder[]): FileOrFolder[] => {
      return items.reduce((acc, item) => {
        acc.push(item);
        if (item.subItems) {
          acc.push(...flattenItems(item.subItems));
        }
        return acc;
      }, [] as FileOrFolder[]);
    };

    const allFlatItems = flattenItems(items);
    const viewableItems = allFlatItems.filter((item) => item.permissions.view);
    const downloadableItems = allFlatItems.filter(
      (item) => item.permissions.download,
    );

    return {
      view: viewableItems.length > 0,
      download: downloadableItems.length > 0,
      partialView:
        viewableItems.length > 0 && viewableItems.length < allFlatItems.length,
      partialDownload:
        downloadableItems.length > 0 &&
        downloadableItems.length < allFlatItems.length,
    };
  };

  const rootPermissions = calculateRootPermissions(allItems);

  return [
    {
      id: "__dataroom_root__",
      name: dataroomName,
      subItems: allItems,
      permissions: rootPermissions,
      itemType: ItemType.DATAROOM_FOLDER,
    },
  ];
};

export default function ExpandableTable({
  dataroomId,
  groupId,
  permissions,
  onSaved,
}: {
  dataroomId: string;
  groupId: string;
  permissions: ViewerGroupAccessControls[];
  onSaved?: () => void | Promise<unknown>;
}) {
  const teamInfo = useTeam();
  const teamId = teamInfo?.currentTeam?.id;
  const { folders, loading } = useDataroomFoldersTree({
    dataroomId,
    include_documents: true,
  });
  const [data, setData] = useState<FileOrFolder[]>([]);
  const [pendingChanges, setPendingChanges] = useState<ItemPermission>({});
  const [isSaving, setIsSaving] = useState(false);
  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  // Use ref to access current data without dependency
  const dataRef = useRef<FileOrFolder[]>([]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const updatePermissions = useCallback(
    (id: string, newPermissions: string[]) => {
      const isRoot = id === "__dataroom_root__";

      const findItemAndParents = (
        items: FileOrFolder[],
        targetId: string,
        parents: FileOrFolder[] = [],
      ): { item: FileOrFolder; parents: FileOrFolder[] } | null => {
        for (const item of items) {
          if (item.id === targetId) {
            return { item, parents };
          }
          if (item.subItems) {
            const result = findItemAndParents(item.subItems, targetId, [
              ...parents,
              item,
            ]);
            if (result) return result;
          }
        }
        return null;
      };

      const result = findItemAndParents(dataRef.current, id);
      if (!result) return;

      const { item, parents } = result;

      const updatedPermissions = {
        view: newPermissions.includes("view"),
        download: newPermissions.includes("download"),
      };

      // Enforce invariants:
      //   - download requires view (you can't download what you can't see)
      //   - turning view off implies turning download off
      if (!updatedPermissions.view) {
        updatedPermissions.download = false;
      } else if (updatedPermissions.download && !updatedPermissions.view) {
        updatedPermissions.view = true;
      }

      // Handle root-level permissions (affects all items)
      if (isRoot) {
        setData((prevData) => {
          const updateAllItems = (items: FileOrFolder[]): FileOrFolder[] => {
            return items.map((currentItem) => {
              if (currentItem.id === "__dataroom_root__") {
                return {
                  ...currentItem,
                  permissions: {
                    view: updatedPermissions.view,
                    download: updatedPermissions.download,
                    partialView: false,
                    partialDownload: false,
                  },
                  subItems: currentItem.subItems
                    ? updateAllItems(currentItem.subItems)
                    : undefined,
                };
              }

              const updatedItem = {
                ...currentItem,
                permissions: {
                  view: updatedPermissions.view,
                  download: updatedPermissions.download,
                  partialView: false,
                  partialDownload: false,
                },
                subItems: currentItem.subItems
                  ? updateAllItems(currentItem.subItems)
                  : undefined,
              };

              return updatedItem;
            });
          };

          return updateAllItems(prevData);
        });

        // Collect changes for all items
        const collectAllChanges = (items: FileOrFolder[]): ItemPermission => {
          let changes: ItemPermission = {};

          const processItems = (items: FileOrFolder[]) => {
            items.forEach((item) => {
              // Don't save the virtual __dataroom_root__ item to database
              if (item.id !== "__dataroom_root__") {
                changes[item.id] = {
                  view: updatedPermissions.view,
                  download: updatedPermissions.download,
                  itemType: item.itemType,
                };
              }

              if (item.subItems) {
                processItems(item.subItems);
              }
            });
          };

          processItems(items);
          return changes;
        };

        const rootChanges = collectAllChanges(dataRef.current);
        setPendingChanges((prev) => ({
          ...prev,
          ...rootChanges,
        }));

        return;
      }

      setData((prevData) => {
        const updateItemInTree = (items: FileOrFolder[]): FileOrFolder[] => {
          return items.map((currentItem) => {
            if (currentItem.id === id) {
              const updatedItem = {
                ...currentItem,
                permissions: {
                  view: updatedPermissions.view,
                  download: updatedPermissions.download,
                  partialView: false,
                  partialDownload: false,
                },
              };

              // If it's a folder, update all subitems
              if (updatedItem.itemType === ItemType.DATAROOM_FOLDER) {
                updatedItem.subItems = updateSubItems(
                  updatedItem.subItems || [],
                  updatedPermissions.view,
                  updatedPermissions.download,
                );
              }

              return updatedItem;
            }

            // if the current item is a parent of the updated item, update the parent's permissions
            if (parents.some((parent) => parent.id === currentItem.id)) {
              const updatedSubItems = currentItem.subItems
                ? updateItemInTree(currentItem.subItems)
                : [];
              return updateParentPermissions(currentItem, updatedSubItems);
            }

            // if the current item has subitems, update the subitems
            if (currentItem.subItems) {
              return {
                ...currentItem,
                subItems: updateItemInTree(currentItem.subItems),
              };
            }
            return currentItem;
          });
        };

        const updateSubItems = (
          items: FileOrFolder[],
          viewState: boolean,
          downloadState: boolean,
        ): FileOrFolder[] => {
          return items.map((item) => ({
            ...item,
            permissions: {
              ...item.permissions,
              view: viewState,
              partialView: false,
              partialDownload: false,
              download: downloadState,
            },
            subItems: item.subItems
              ? updateSubItems(item.subItems, viewState, downloadState)
              : undefined,
          }));
        };

        const updateParentPermissions = (
          parent: FileOrFolder,
          subItems: FileOrFolder[],
        ): FileOrFolder => {
          const isParentRoot = parent.id === "__dataroom_root__";

          // For root folder, calculate based on all descendants
          const calculatePermissions = (items: FileOrFolder[]) => {
            const flattenItems = (items: FileOrFolder[]): FileOrFolder[] => {
              return items.reduce((acc, item) => {
                if (item.id !== "__dataroom_root__") {
                  acc.push(item);
                }
                if (item.subItems) {
                  acc.push(...flattenItems(item.subItems));
                }
                return acc;
              }, [] as FileOrFolder[]);
            };

            const allItems = flattenItems(items);
            const viewableItems = allItems.filter(
              (item) => item.permissions.view,
            );
            const downloadableItems = allItems.filter(
              (item) => item.permissions.download,
            );

            return {
              view: viewableItems.length > 0,
              partialView:
                viewableItems.length > 0 &&
                viewableItems.length < allItems.length,
              download: downloadableItems.length > 0,
              partialDownload:
                downloadableItems.length > 0 &&
                downloadableItems.length < allItems.length,
            };
          };

          if (isParentRoot) {
            const rootPermissions = calculatePermissions(subItems);
            return {
              ...parent,
              permissions: rootPermissions,
              subItems,
            };
          }

          // For regular folders
          const someSubItemViewable = subItems.some(
            (subItem) => subItem.permissions.view,
          );
          const allSubItemsViewable = subItems.every(
            (subItem) => subItem.permissions.view,
          );
          const someSubItemDownloadable = subItems.some(
            (subItem) => subItem.permissions.download,
          );
          const allSubItemsDownloadable = subItems.every(
            (subItem) => subItem.permissions.download,
          );

          return {
            ...parent,
            permissions: {
              view: someSubItemViewable,
              partialView: someSubItemViewable && !allSubItemsViewable,
              download: someSubItemDownloadable,
              partialDownload:
                someSubItemDownloadable && !allSubItemsDownloadable,
            },
            subItems,
          };
        };

        return updateItemInTree(prevData);
      });

      // Collect changes for database update
      const collectChanges = (
        item: FileOrFolder,
        parents: FileOrFolder[],
      ): ItemPermission => {
        let changes: ItemPermission = {};

        // Don't save the virtual __dataroom_root__ item to database
        if (item.id !== "__dataroom_root__") {
          changes[item.id] = {
            view: updatedPermissions.view,
            download: updatedPermissions.download,
            itemType: item.itemType,
          };
        }

        // Collect changes for all subitems
        const collectSubItemChanges = (
          subItems: FileOrFolder[] | undefined,
        ) => {
          if (!subItems) return;
          subItems.forEach((subItem) => {
            // Don't save the virtual __dataroom_root__ item to database
            if (subItem.id !== "__dataroom_root__") {
              changes[subItem.id] = {
                view: updatedPermissions.view,
                download: updatedPermissions.download,
                itemType: subItem.itemType,
              };
            }
            collectSubItemChanges(subItem.subItems);
          });
        };

        collectSubItemChanges(item.subItems);

        // Ensure all parent folders are viewable if the item is being set to viewable
        if (updatedPermissions.view || updatedPermissions.download) {
          parents.forEach((parent) => {
            // Don't save the virtual __dataroom_root__ item to database
            if (parent.id !== "__dataroom_root__") {
              changes[parent.id] = {
                view: true,
                download: updatedPermissions.download
                  ? true
                  : parent.permissions.download,
                itemType: parent.itemType,
              };
            }
          });
        } else {
          // If turning off view, recalculate parent permissions
          [...parents].reverse().forEach((parent) => {
            // Don't save the virtual __dataroom_root__ item to database
            if (parent.id !== "__dataroom_root__") {
              const otherChildren =
                parent.subItems?.filter((subItem) => subItem.id !== item.id) ||
                [];
              const someSubItemViewable = otherChildren.some(
                (subItem) => subItem.permissions.view,
              );
              const someSubItemDownloadable = otherChildren.some(
                (subItem) => subItem.permissions.download,
              );

              changes[parent.id] = {
                view: someSubItemViewable,
                download: someSubItemDownloadable,
                itemType: parent.itemType,
              };
            }
          });
        }

        return changes;
      };

      setPendingChanges((prev) => ({
        ...prev,
        ...collectChanges(item, parents),
      }));
    },
    [],
  );

  // Rebuild the tree from server state when the underlying permissions or
  // folder tree change. We intentionally only do this when there are no
  // pending edits so that an in-flight SWR refetch (e.g. from another tab)
  // never wipes out unsaved work in this view.
  useEffect(() => {
    if (folders && !loading && !hasPendingChanges) {
      const treeData = buildTreeWithRoot(folders, permissions, "Dataroom Home");
      setData(treeData);
    }
  }, [folders, loading, permissions, hasPendingChanges]);

  const handleDiscardChanges = useCallback(() => {
    if (!folders) return;
    setPendingChanges({});
    setData(buildTreeWithRoot(folders, permissions, "Dataroom Home"));
  }, [folders, permissions]);

  const handleSaveChanges = useCallback(async () => {
    if (!hasPendingChanges || isSaving) return;
    setIsSaving(true);
    const changesToSave = pendingChanges;
    try {
      const response = await fetch(
        `/api/teams/${teamId}/datarooms/${dataroomId}/groups/${groupId}/permissions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dataroomId,
            groupId,
            permissions: changesToSave,
          }),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to save permissions");
      }

      toast.success("Permissions updated successfully.");
      await onSaved?.();
      setPendingChanges({});
    } catch (error) {
      console.error("Error saving permissions:", error);
      toast.error("Failed to update permissions", {
        description: "Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  }, [
    hasPendingChanges,
    isSaving,
    pendingChanges,
    teamId,
    dataroomId,
    groupId,
    onSaved,
  ]);

  // Warn the user before they navigate away with unsaved permission changes.
  useEffect(() => {
    if (!hasPendingChanges) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasPendingChanges]);

  const columns = useMemo(
    () => createColumns({ updatePermissions }),
    [updatePermissions],
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.subItems,
    initialState: {
      expanded: {
        "0": true, // Always expand the root folder (first row)
      },
    },
    getRowCanExpand: (row) => {
      // Root folder is always expanded and cannot be collapsed
      if (row.original.id === "__dataroom_root__") {
        return true;
      }
      return (row.subRows?.length ?? 0) > 0;
    },
  });

  if (loading) return <div>Loading...</div>;

  const changedItemCount = Object.keys(pendingChanges).length;

  return (
    <div className="space-y-3">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex flex-col gap-3 rounded-md border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between",
          hasPendingChanges
            ? "border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/40"
            : "border-border bg-muted/40",
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          {hasPendingChanges ? (
            <>
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full bg-amber-500"
              />
              <span className="font-medium text-amber-900 dark:text-amber-100">
                {changedItemCount} unsaved{" "}
                {changedItemCount === 1 ? "change" : "changes"}
              </span>
              <span className="text-muted-foreground">
                Save to apply your updates to this group.
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              All permission changes saved.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDiscardChanges}
            disabled={!hasPendingChanges || isSaving}
          >
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSaveChanges}
            disabled={!hasPendingChanges || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "rounded-md border",
          isSaving && "pointer-events-none opacity-60",
        )}
      >
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="py-2 first:w-12 last:text-right"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => {
                const isRoot = row.original.id === "__dataroom_root__";
                return (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && "selected"}
                    className={cn(
                      isRoot && "bg-blue-50/50 dark:bg-blue-950/50",
                    )}
                  >
                    {row.getVisibleCells().map((cell, index) => (
                      <TableCell
                        key={cell.id}
                        style={
                          index === 0
                            ? {
                                paddingLeft: `${row.depth * 1.25}rem`,
                              }
                            : undefined
                        }
                        className="py-2 last:flex last:justify-end"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
