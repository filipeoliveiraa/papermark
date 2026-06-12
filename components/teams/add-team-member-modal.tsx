import { useState } from "react";
import { useRouter } from "next/router";

import { useTeam } from "@/context/team-context";
import { toast } from "sonner";
import { mutate } from "swr";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAnalytics } from "@/lib/analytics";
import { usePlan } from "@/lib/swr/use-billing";
import useDataroomsSimple from "@/lib/swr/use-datarooms-simple";

type InviteRole = "ADMIN" | "MANAGER" | "MEMBER" | "DATAROOM_MEMBER";

export function AddTeamMembers({
  open,
  setOpen,
  children,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  children?: React.ReactNode;
}) {
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<InviteRole>("MEMBER");
  const [selectedDataroomIds, setSelectedDataroomIds] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const teamInfo = useTeam();
  const teamId = teamInfo?.currentTeam?.id;
  const analytics = useAnalytics();
  const router = useRouter();
  const { datarooms } = useDataroomsSimple();
  const { isDatarooms } = usePlan();

  const toggleDataroom = (id: string) => {
    setSelectedDataroomIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };
  const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(3, { message: "Please enter a valid email." })
    .email({ message: "Please enter a valid email." });

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const validation = emailSchema.safeParse(email);
    if (!validation.success) {
      toast.error(validation.error.errors[0].message);
      return;
    }

    if (role === "DATAROOM_MEMBER" && selectedDataroomIds.length === 0) {
      toast.error("Select at least one data room for a data room member.");
      return;
    }

    setLoading(true);
    const response = await fetch(`/api/teams/${teamId}/invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: validation.data,
        role,
        dataroomIds: role === "DATAROOM_MEMBER" ? selectedDataroomIds : [],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      setLoading(false);
      setOpen(false);
      toast.error(error);
      return;
    }

    analytics.capture("Team Member Invitation Sent", {
      email: validation.data,
      teamId: teamId,
    });

    mutate(`/api/teams/${teamId}/invitations`);
    mutate(`/api/teams/${teamId}/limits`);

    toast.success("An invitation email has been sent!");
    setOpen(false);
    setLoading(false);
    
    // Redirect to team members page
    router.push("/settings/people");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader className="text-start">
          <DialogTitle>Add Member</DialogTitle>
          <DialogDescription>
            You can easily add team members.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <Label htmlFor="email" className="opacity-80">
            Email
          </Label>
          <Input
            id="email"
            placeholder="team@member.com"
            className="mb-4 mt-1 w-full"
            onChange={(e) => setEmail(e.target.value)}
          />

          <Label htmlFor="role" className="opacity-80">
            Role
          </Label>
          <Select
            value={role}
            onValueChange={(value) => setRole(value as InviteRole)}
          >
            <SelectTrigger id="role" className="mb-4 mt-1 w-full">
              <SelectValue placeholder="Select a role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ADMIN">Admin</SelectItem>
              <SelectItem value="MANAGER">Manager</SelectItem>
              <SelectItem value="MEMBER">Member</SelectItem>
              <SelectItem
                value="DATAROOM_MEMBER"
                disabled={!isDatarooms}
                trailingContent={
                  !isDatarooms ? (
                    <span className="ml-auto pl-3 text-xs text-muted-foreground">
                      Data Rooms plan
                    </span>
                  ) : undefined
                }
              >
                Data room member
              </SelectItem>
            </SelectContent>
          </Select>

          {role === "DATAROOM_MEMBER" ? (
            <div className="mb-8">
              <Label className="opacity-80">Data rooms</Label>
              <p className="mb-2 mt-1 text-xs text-muted-foreground">
                The member can only manage the selected data rooms.
              </p>
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
                {datarooms && datarooms.length > 0 ? (
                  datarooms.map((dataroom) => (
                    <label
                      key={dataroom.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={selectedDataroomIds.includes(dataroom.id)}
                        onChange={() => toggleDataroom(dataroom.id)}
                      />
                      <span className="truncate">
                        {dataroom.internalName || dataroom.name}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="px-2 py-1 text-sm text-muted-foreground">
                    No data rooms available.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="mb-8" />
          )}

          <DialogFooter>
            <Button type="submit" className="h-9 w-full">
              {loading ? "Sending email..." : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
