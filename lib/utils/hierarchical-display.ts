import { useFeatureFlags } from "@/lib/hooks/use-feature-flags";
import { usePlan } from "@/lib/swr/use-billing";

export function useDataroomIndexEnabled(): boolean {
  const { isFeatureEnabled } = useFeatureFlags();
  const { isDataroomsPlus } = usePlan();
  return isDataroomsPlus || isFeatureEnabled("dataroomIndex");
}

export function useHierarchicalDisplayName(
  name: string,
  hierarchicalIndex?: string | null,
): string {
  const isEnabled = useDataroomIndexEnabled();

  if (isEnabled && hierarchicalIndex) {
    return `${hierarchicalIndex} ${name}`;
  }

  return name;
}

export function getHierarchicalDisplayName(
  name: string,
  hierarchicalIndex?: string | null,
  isFeatureEnabled: boolean = false,
): string {
  if (isFeatureEnabled && hierarchicalIndex) {
    return `${hierarchicalIndex} ${name}`;
  }

  return name;
}

export const HIERARCHICAL_DISPLAY_STYLE = {
  fontVariantNumeric: "tabular-nums" as const,
};
