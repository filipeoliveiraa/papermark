import { useState } from "react";
import { useRouter } from "next/router";

import { useTeam } from "@/context/team-context";
import { toast } from "sonner";
import { mutate } from "swr";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="email" className="opacity-80">
              Email
            </Label>
            <Input
              id="email"
              placeholder="team@member.com"
              className="w-full"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="role" className="opacity-80">
              Role
            </Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as InviteRole)}
            >
              <SelectTrigger id="role" className="w-full">
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
          </div>

          {role === "DATAROOM_MEMBER" ? (
            <div className="grid gap-1.5">
              <div className="space-y-1">
                <Label className="opacity-80">Data rooms</Label>
                <p className="text-xs text-muted-foreground">
                  The member can only manage the selected data rooms.
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
                        id={`add-dataroom-${dataroom.id}`}
                        checked={selectedDataroomIds.includes(dataroom.id)}
                        onCheckedChange={() => toggleDataroom(dataroom.id)}
                        className="h-4 w-4"
                      />
                      <label
                        htmlFor={`add-dataroom-${dataroom.id}`}
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

          <DialogFooter className="mt-2">
            <Button type="submit" className="h-9 w-full">
              {loading ? "Sending email..." : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
