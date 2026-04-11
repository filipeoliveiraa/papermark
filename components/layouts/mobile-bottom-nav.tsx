import Link from "next/link";
import { useRouter } from "next/router";

import { useState } from "react";

import {
  FolderIcon,
  HouseIcon,
  MoreHorizontalIcon,
  ServerIcon,
} from "lucide-react";

import { usePlan } from "@/lib/swr/use-billing";
import { PlanEnum } from "@/ee/stripe/constants";
import { cn } from "@/lib/utils";

import { UpgradePlanModal } from "@/components/billing/upgrade-plan-modal";

import { MobileMoreMenu } from "./mobile-more-menu";

export function MobileBottomNav() {
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const { isBusiness, isDatarooms, isDataroomsPlus, isTrial } = usePlan();

  const dataroomsEnabled = isBusiness || isDatarooms || isDataroomsPlus || isTrial;

  const isActive = (match: string) => {
    if (match === "documents") {
      return (
        router.pathname.includes("documents") &&
        !router.pathname.includes("datarooms")
      );
    }
    return router.pathname.includes(match);
  };

  const moreIsActive =
    !["dashboard", "documents", "datarooms"].some((m) => isActive(m));

  const tabClass = (active: boolean) =>
    cn(
      "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors",
      active
        ? "text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex h-16 items-center justify-around">
          <Link href="/dashboard" className={tabClass(isActive("dashboard"))}>
            <HouseIcon className="h-6 w-6" />
            <span>Dashboard</span>
          </Link>
          <Link href="/documents" className={tabClass(isActive("documents"))}>
            <FolderIcon className="h-6 w-6" />
            <span>Documents</span>
          </Link>
          {dataroomsEnabled ? (
            <Link href="/datarooms" className={tabClass(isActive("datarooms"))}>
              <ServerIcon className="h-6 w-6" />
              <span>Datarooms</span>
            </Link>
          ) : (
            <UpgradePlanModal
              clickedPlan={PlanEnum.Business}
              trigger="mobile_nav_datarooms"
              highlightItem={["datarooms"]}
            >
              <button className={tabClass(false)}>
                <ServerIcon className="h-6 w-6" />
                <span>Datarooms</span>
              </button>
            </UpgradePlanModal>
          )}
          <button
            onClick={() => setMoreOpen(true)}
            className={tabClass(moreIsActive)}
          >
            <MoreHorizontalIcon className="h-6 w-6" />
            <span>More</span>
          </button>
        </div>
      </nav>

      <MobileMoreMenu open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}
