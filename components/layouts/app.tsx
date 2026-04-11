import { useRouter } from "next/router";

import { useCallback, useEffect, useRef, useState } from "react";

import Cookies from "js-cookie";

import { AppBreadcrumb } from "@/components/layouts/breadcrumb";
import { MobileBottomNav } from "@/components/layouts/mobile-bottom-nav";
import { MobileHeader } from "@/components/layouts/mobile-header";
import TrialBanner from "@/components/layouts/trial-banner";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

// import { usePlan } from "@/lib/swr/use-billing";
// import YearlyUpgradeBanner from "@/components/billing/yearly-upgrade-banner";

import { BlockingModal } from "./blocking-modal";

const DATAROOM_SIDEBAR_COOKIE_NAME = "sidebar:dataroom-state";

// Helper to get initial sidebar state synchronously (avoids flash)
function getInitialSidebarState(isDataroom: boolean): boolean {
  if (typeof window === "undefined") return false; // SSR: default closed to avoid flash

  // For dataroom pages, check dataroom-specific cookie first
  if (isDataroom) {
    const dataroomCookie = Cookies.get(DATAROOM_SIDEBAR_COOKIE_NAME);
    if (dataroomCookie !== undefined) {
      return dataroomCookie === "true";
    }
    // No dataroom preference set yet - default to closed for datarooms
    return false;
  }

  // For non-dataroom pages, use main cookie
  const mainCookie = Cookies.get(SIDEBAR_COOKIE_NAME);
  if (mainCookie !== undefined) {
    return mainCookie === "true";
  }

  return true; // Default open for non-dataroom pages
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isDataroom = router.pathname.startsWith("/datarooms/[id]");

  // Use lazy initializer to compute initial state synchronously (avoids flash)
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    getInitialSidebarState(isDataroom),
  );

  // Track previous dataroom state for transitions
  const prevIsDataroomRef = useRef<boolean>(isDataroom);
  const isFirstRenderRef = useRef(true);

  // Handle initial mount and transitions between dataroom/non-dataroom
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      // Set cookie on initial mount if in dataroom and no preference exists
      if (
        isDataroom &&
        Cookies.get(DATAROOM_SIDEBAR_COOKIE_NAME) === undefined
      ) {
        Cookies.set(DATAROOM_SIDEBAR_COOKIE_NAME, "false", { expires: 7 });
      }
      return;
    }

    // Transitioning from non-dataroom to dataroom
    if (!prevIsDataroomRef.current && isDataroom) {
      setSidebarOpen(false);
      Cookies.set(DATAROOM_SIDEBAR_COOKIE_NAME, "false", { expires: 7 });
    }

    // Transitioning from dataroom to non-dataroom
    if (prevIsDataroomRef.current && !isDataroom) {
      Cookies.remove(DATAROOM_SIDEBAR_COOKIE_NAME);
      // Restore main sidebar state
      const mainCookie = Cookies.get(SIDEBAR_COOKIE_NAME);
      // setSidebarOpen(mainCookie === "true");
      setSidebarOpen(mainCookie !== undefined ? mainCookie === "true" : true);
    }

    prevIsDataroomRef.current = isDataroom;
  }, [isDataroom]);

  // Handle sidebar state changes - save to appropriate cookie
  const handleSidebarOpenChange = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      if (isDataroom) {
        Cookies.set(DATAROOM_SIDEBAR_COOKIE_NAME, String(open), { expires: 7 });
      }
    },
    [isDataroom],
  );

  // const { isAnnualPlan, isFree } = usePlan();
  // const [showYearlyBanner, setShowYearlyBanner] = useState<boolean | null>(null);

  // Show banner only for paid monthly subscribers (not free, not yearly)
  // useEffect(() => {
  //   // Hide banner for free users or yearly subscribers
  //   if (isFree || isAnnualPlan) {
  //     setShowYearlyBanner(false);
  //     return;
  //   }

  //   // Show banner for monthly paid users (if not dismissed)
  //   if (Cookies.get("hideYearlyUpgradeBanner") !== "yearly-upgrade-banner") {
  //     setShowYearlyBanner(true);
  //   } else {
  //     setShowYearlyBanner(false);
  //   }
  // }, [isFree, isAnnualPlan]);

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={handleSidebarOpenChange}>
      <div className="flex flex-1 flex-col gap-x-1 overflow-x-hidden bg-gray-50 dark:bg-black md:flex-row">
        <AppSidebar />
        <SidebarInset className="overflow-x-hidden ring-0 md:ring-1 md:ring-gray-200 md:dark:ring-gray-800">
          <header className="hidden h-10 shrink-0 items-center gap-2 md:flex">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 h-4" />
              <AppBreadcrumb />
            </div>
          </header>
          <TrialBanner />
          <BlockingModal />
          <main className="flex-1 overflow-x-hidden pt-14 pb-16 md:pt-0 md:pb-0">{children}</main>
        </SidebarInset>
      </div>
      <MobileHeader />
      <MobileBottomNav />
    </SidebarProvider>
  );
}
