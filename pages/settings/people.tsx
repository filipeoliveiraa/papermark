import { useRouter } from "next/router";

import { useMemo, useState } from "react";

import { useTeam } from "@/context/team-context";
import { PlanEnum } from "@/ee/stripe/constants";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { mutate } from "swr";

import { useAnalytics } from "@/lib/analytics";
import { usePlan } from "@/lib/swr/use-billing";
import useDataroomsSimple from "@/lib/swr/use-datarooms-simple";
import { useInvitations } from "@/lib/swr/use-invitations";
import useLimits from "@/lib/swr/use-limits";
import { useGetTeam } from "@/lib/swr/use-team";
import { useTeams } from "@/lib/swr/use-teams";
import { CustomUser, TeamRole } from "@/lib/types";
import { cn } from "@/lib/utils";

import { AddSeatModal } from "@/components/billing/add-seat-modal";
import { UnlimitedPlanModal } from "@/components/billing/unlimited-plan-modal";
import AppLayout from "@/components/layouts/app";
import { SettingsHeader } from "@/components/settings/settings-header";
import Folder from "@/components/shared/icons/folder";
import MoreVertical from "@/components/shared/icons/more-vertical";
import { AddTeamMembers } from "@/components/teams/add-team-member-modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { UpgradeButton } from "@/components/ui/upgrade-button";

const ROLE_LABELS: Record<TeamRole, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  MEMBER: "Member",
  DATAROOM_MEMBER: "Data Room Member",
};

const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  ADMIN: "Full access to the team, billing, and all settings.",
  MANAGER: "Manage content and members, except admin-only settings.",
  MEMBER: "Create and manage documents, links, and data rooms.",
  DATAROOM_MEMBER: "Access limited to the specific data rooms you assign.",
};

const ASSIGNABLE_ROLES: TeamRole[] = [
  "ADMIN",
  "MANAGER",
  "MEMBER",
  "DATAROOM_MEMBER",
];

function formatRole(role: string): string {
  return ROLE_LABELS[role as TeamRole] ?? role;
}

export default function Billing() {
  const [isTeamMemberInviteModalOpen, setTeamMemberInviteModalOpen] =
    useState<boolean>(false);
  const [isAddSeatModalOpen, setAddSeatModalOpen] = useState<boolean>(false);
  const [leavingUserId, setLeavingUserId] = useState<string>("");

  const { data: session } = useSession();
  const { team, loading } = useGetTeam()!;
  const teamInfo = useTeam();
  const { isTrial, isDataroomsUnlimited } = usePlan();
  const { canAddUsers, showUpgradePlanModal, limits } = useLimits();
  const { teams } = useTeams();
  const analytics = useAnalytics();

  const { invitations } = useInvitations();

  const router = useRouter();

  const documentCountsByUser = useMemo(() => {
    if (!team?.documents) return {};

    const counts: Record<string, number> = {};
    team.documents.forEach((document) => {
      const ownerId = document.owner?.id;
      if (ownerId) {
        counts[ownerId] = (counts[ownerId] || 0) + 1;
      }
    });
    return counts;
  }, [team]);

  const getUserDocumentCount = (userId: string) => {
    return documentCountsByUser[userId] || 0;
  };

  const isCurrentUser = (userId: string) => {
    if ((session?.user as CustomUser)?.id === userId) {
      return true;
    }
    return false;
  };

  const isCurrentUserAdmin = () => {
    return team?.users.some(
      (user) =>
        user.role === "ADMIN" &&
        user.userId === (session?.user as CustomUser)?.id,
    );
  };

  // Member currently being edited in the change-role dialog.
  const [roleMember, setRoleMember] = useState<{
    userId: string;
    teamId: string;
    name: string;
    role: TeamRole;
  } | null>(null);

  const changeRole = async (
    teamId: string,
    userId: string,
    role: "ADMIN" | "MANAGER" | "MEMBER" | "DATAROOM_MEMBER",
    dataroomIds?: string[],
  ) => {
    const response = await fetch(`/api/teams/${teamId}/change-role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userToBeChanged: userId,
        role: role,
        ...(role === "DATAROOM_MEMBER"
          ? { dataroomIds: dataroomIds ?? [] }
          : {}),
      }),
    });

    if (response.status !== 204) {
      const error = await response.json();
      toast.error(error);
      return;
    }

    await mutate(`/api/teams/${teamId}`);
    await mutate("/api/teams");

    analytics.capture("Team Member Role Changed", {
      userId: userId,
      teamId: teamId,
      role: role,
    });

    toast.success("Role changed successfully!");
  };

  const removeTeammate = async (teamId: string, userId: string) => {
    setLeavingUserId(userId);
    const response = await fetch(`/api/teams/${teamId}/remove-teammate`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userToBeDeleted: userId,
      }),
    });

    if (response.status !== 204) {
      const error = await response.json();
      toast.error(error);
      setLeavingUserId("");
      return;
    }

    await mutate(`/api/teams/${teamInfo?.currentTeam?.id}`);
    await mutate("/api/teams");
    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/invitations`);
    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/limits`);

    setLeavingUserId("");
    if (isCurrentUser(userId)) {
      toast.success(`Successfully leaved team ${teamInfo?.currentTeam?.name}`);
      teamInfo?.setCurrentTeam({ id: teams![0].id });
      router.push("/documents");
      return;
    }

    analytics.capture("Team Member Removed", {
      userId: userId,
      teamId: teamInfo?.currentTeam?.id,
    });

    toast.success("Teammate removed successfully!");
  };

  // resend invitation function
  const resendInvitation = async (invitation: { email: string } & any) => {
    const response = await fetch(
      `/api/teams/${teamInfo?.currentTeam?.id}/invitations/resend`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: invitation.email as string,
        }),
      },
    );

    if (response.status !== 200) {
      const error = await response.json();
      toast.error(error);
      return;
    }

    analytics.capture("Team Member Invitation Resent", {
      email: invitation.email as string,
      teamId: teamInfo?.currentTeam?.id,
    });
    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/invitations`);
    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/limits`);

    toast.success("Invitation resent successfully!");
  };

  // revoke invitation function
  const revokeInvitation = async (invitation: { email: string } & any) => {
    const response = await fetch(
      `/api/teams/${teamInfo?.currentTeam?.id}/invitations`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: invitation.email as string,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      toast.error(error);
      return;
    }

    analytics.capture("Team Member Invitation Revoked", {
      email: invitation.email as string,
      teamId: teamInfo?.currentTeam?.id,
    });

    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/invitations`);
    mutate(`/api/teams/${teamInfo?.currentTeam?.id}/limits`);

    toast.success("Invitation revoked successfully!");
  };
  const showInvite = canAddUsers;

  return (
    <AppLayout>
      <main className="relative mx-2 mb-10 mt-4 space-y-8 overflow-hidden px-1 sm:mx-3 md:mx-5 md:mt-5 lg:mx-7 lg:mt-8 xl:mx-10">
        <SettingsHeader />
        <div>
          <div className="mb-4 flex items-center justify-between md:mb-8 lg:mb-12">
            <div className="space-y-1">
              <h3 className="text-2xl font-semibold tracking-tight text-foreground">
                Team Members
              </h3>
              <p className="text-sm text-muted-foreground">
                Manage your team members.{" "}
                {isDataroomsUnlimited ? (
                  <span className="ml-1 font-medium">
                    Your team has unlimited seats 💫
                  </span>
                ) : (
                  <UnlimitedPlanModal>
                    <span className="cursor-pointer underline underline-offset-4 hover:text-foreground">
                      Interested in unlimited team members?
                    </span>
                  </UnlimitedPlanModal>
                )}
              </p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between gap-x-1 rounded-lg border border-border bg-secondary p-4 sm:p-10">
              <div className="flex flex-col space-y-1 sm:space-y-3">
                <h2 className="text-xl font-medium">Team</h2>
                <p className="text-sm text-secondary-foreground">
                  Teammates that have access to this project.
                  {!isDataroomsUnlimited &&
                    limits?.users &&
                    limits.users !== Infinity && (
                      <span className="ml-1">
                        ({limits.usage?.users ?? 0}/{limits.users} seats used)
                      </span>
                    )}
                </p>
              </div>
              {showUpgradePlanModal ? (
                <UpgradeButton
                  text="Invite Members"
                  clickedPlan={PlanEnum.Business}
                  trigger="invite_team_members"
                  highlightItem={["users"]}
                />
              ) : (
                <div className="flex items-center gap-2">
                  {!isDataroomsUnlimited && (
                    <AddSeatModal
                      open={isAddSeatModalOpen}
                      setOpen={setAddSeatModalOpen}
                    >
                      <Button variant="outline" className="whitespace-nowrap">
                        Add Seat
                      </Button>
                    </AddSeatModal>
                  )}
                  {showInvite ? (
                    <AddTeamMembers
                      open={isTeamMemberInviteModalOpen}
                      setOpen={setTeamMemberInviteModalOpen}
                    >
                      <Button>Invite</Button>
                    </AddTeamMembers>
                  ) : (
                    <Button disabled title="Add a seat to invite more members">
                      Invite
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <ul className="mt-6 divide-y rounded-lg border">
            {loading && (
              <div className="flex items-center justify-between px-10 py-4">
                <div className="flex items-center gap-12">
                  <div className="space-y-2">
                    <Skeleton className="h-6 w-36" />
                    <Skeleton className="h-4 w-36" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
                <div className="flex gap-12">
                  <Skeleton className="h-6 w-14" />
                  <Skeleton className="h-6 w-4" />
                </div>
              </div>
            )}
            {team?.users.map((member, index) => (
              <li
                className="flex items-center justify-between gap-12 overflow-auto px-10 py-4"
                key={index}
              >
                <div className="flex items-center gap-12">
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold">
                      {member.user.name}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      {member.user.email}
                    </p>
                  </div>
                  <div className="text-sm">
                    <div className="flex items-center gap-2">
                      <Folder />
                      <span className="text-nowrap text-xs text-foreground">
                        {getUserDocumentCount(member.userId)}{" "}
                        {getUserDocumentCount(member.userId) === 1
                          ? "document"
                          : "documents"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-12">
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm text-foreground">
                      {formatRole(member.role)}
                    </span>
                    {member.status === "BLOCKED_TRIAL_EXPIRED" && (
                      <span className="text-xs font-medium text-red-500">
                        Blocked (Trial Expired)
                      </span>
                    )}
                  </div>
                  {leavingUserId === member.userId ? (
                    <span className="text-xs">leaving...</span>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Open menu</span>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        {isCurrentUser(member.userId) && (
                          <DropdownMenuItem
                            onClick={() =>
                              removeTeammate(member.teamId, member.userId)
                            }
                            className="text-red-500 hover:cursor-pointer focus:bg-destructive focus:text-destructive-foreground"
                          >
                            Leave team
                          </DropdownMenuItem>
                        )}
                        {isCurrentUserAdmin() &&
                        !isCurrentUser(member.userId) ? (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                setRoleMember({
                                  userId: member.userId,
                                  teamId: member.teamId,
                                  name: member.user.name || member.user.email,
                                  role: member.role,
                                })
                              }
                              className="hover:cursor-pointer"
                            >
                              Change role
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                removeTeammate(member.teamId, member.userId)
                              }
                              className="text-red-500 hover:cursor-pointer focus:bg-destructive focus:text-destructive-foreground"
                            >
                              Remove teammate
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem
                            disabled
                            className="text-red-500 focus:bg-destructive focus:text-destructive-foreground"
                          >
                            Remove teammate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            ))}
            {invitations &&
              invitations.map((invitation, index) => (
                <li
                  className="flex items-center justify-between px-10 py-4"
                  key={index}
                >
                  <div className="flex items-center gap-12">
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold">
                        {invitation.email}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {invitation.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-12">
                    <span
                      className="text-sm text-foreground"
                      title={`Expires on ${new Date(
                        invitation.expires,
                      ).toLocaleString()}`}
                    >
                      {new Date(invitation.expires) >= new Date(Date.now())
                        ? "Pending"
                        : "Expired"}
                    </span>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Open menu</span>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem
                          onClick={() => resendInvitation(invitation)}
                          className="text-red-500 hover:cursor-pointer focus:bg-destructive focus:text-destructive-foreground"
                        >
                          Resend
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => revokeInvitation(invitation)}
                          className="text-red-500 hover:cursor-pointer focus:bg-destructive focus:text-destructive-foreground"
                        >
                          Revoke invitation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      </main>

      {roleMember ? (
        <ChangeRoleDialog
          member={roleMember}
          currentAssignments={(team?.userDatarooms ?? [])
            .filter((ud) => ud.userId === roleMember.userId)
            .map((ud) => ud.dataroomId)}
          onClose={() => setRoleMember(null)}
          onSave={async (role, dataroomIds) => {
            await changeRole(
              roleMember.teamId,
              roleMember.userId,
              role,
              dataroomIds,
            );
            setRoleMember(null);
          }}
        />
      ) : null}
    </AppLayout>
  );
}

function ChangeRoleDialog({
  member,
  currentAssignments,
  onClose,
  onSave,
}: {
  member: { userId: string; teamId: string; name: string; role: TeamRole };
  currentAssignments: string[];
  onClose: () => void;
  onSave: (role: TeamRole, dataroomIds: string[]) => Promise<void>;
}) {
  const { datarooms } = useDataroomsSimple();
  const [role, setRole] = useState<TeamRole>(member.role);
  const [selected, setSelected] = useState<string[]>(currentAssignments);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const assignmentsUnchanged =
    selected.length === currentAssignments.length &&
    selected.every((id) => currentAssignments.includes(id));

  const isUnchanged =
    role === member.role &&
    (role !== "DATAROOM_MEMBER" || assignmentsUnchanged);

  const canSave =
    !saving &&
    !isUnchanged &&
    (role !== "DATAROOM_MEMBER" || selected.length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader className="text-start">
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            Update the role for {member.name}.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={role}
          onValueChange={(value) => setRole(value as TeamRole)}
          className="gap-2"
        >
          {ASSIGNABLE_ROLES.map((r) => (
            <label
              key={r}
              htmlFor={`role-${r}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors",
                role === r
                  ? "border-primary bg-muted"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <RadioGroupItem id={`role-${r}`} value={r} className="mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-medium leading-none">{ROLE_LABELS[r]}</p>
                <p className="text-xs text-muted-foreground">
                  {ROLE_DESCRIPTIONS[r]}
                </p>
              </div>
            </label>
          ))}
        </RadioGroup>

        {role === "DATAROOM_MEMBER" ? (
          <div className="grid gap-1.5">
            <div className="space-y-1">
              <Label className="opacity-80">Data rooms</Label>
              <p className="text-xs text-muted-foreground">
                Select the data rooms {member.name} can manage.
              </p>
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border p-1">
              {datarooms && datarooms.length > 0 ? (
                datarooms.map((dataroom) => (
                  <div
                    key={dataroom.id}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      id={`role-dataroom-${dataroom.id}`}
                      checked={selected.includes(dataroom.id)}
                      onCheckedChange={() => toggle(dataroom.id)}
                      className="h-4 w-4"
                    />
                    <label
                      htmlFor={`role-dataroom-${dataroom.id}`}
                      className="flex-1 cursor-pointer truncate"
                    >
                      {dataroom.internalName || dataroom.name}
                    </label>
                  </div>
                ))
              ) : (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  No data rooms available.
                </p>
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            disabled={!canSave}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(role, role === "DATAROOM_MEMBER" ? selected : []);
              } finally {
                setSaving(false);
              }
            }}
            className="h-9 w-full"
          >
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
