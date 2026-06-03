import {
  Dispatch,
  FormEvent,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useTeam } from "@/context/team-context";
import { Agreement } from "@prisma/client";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import { mutate } from "swr";
import { z } from "zod";

import {
  DocumentData,
  createAgreementDocument,
} from "@/lib/documents/create-document";
import { putFile } from "@/lib/files/put-file";
import {
  MAX_SIGNING_TEMPLATE_PDF_BYTES,
  SIGNING_TEMPLATE_PDF_CONTENT_TYPE,
  getSigningTemplateTooLargeMessage,
} from "@/lib/signing/template-upload";
import { getSupportedContentType } from "@/lib/utils/get-content-type";

import SigningTemplateAuthoring from "@/components/agreements/signing-template-authoring";
import DocumentUpload from "@/components/document-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import LoadingSpinner from "@/components/ui/loading-spinner";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

import LinkItem from "../link-item";

const agreementUrlSchema = z
  .string()
  .min(1, "URL is required")
  .url("Please enter a valid URL")
  .refine((url) => url.startsWith("https://"), {
    message: "URL must start with https://",
  });

const SIGNING_RECIPIENT_COUNT = 1;
// Safety net: give up if realtime never reaches a terminal state so the UI never spins forever.
const SIGNING_SETUP_TIMEOUT_MS = 2 * 60 * 1000;

const SIGNING_SETUP_FAILURE_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

const initialData = {
  name: "",
  link: "",
  textContent: "",
  contentType: "SIGNING",
  requireName: true,
};

type AgreementFormState = typeof initialData;

type SigningSetupResponse = {
  presignToken: string;
  expiresAt: string;
  externalId: string | null;
  envelopeId: string;
  host: string;
};

type SigningSetupRunResponse = {
  runId: string;
  publicAccessToken: string;
};

type PendingSigningRun = {
  runId: string;
  accessToken: string;
  agreement: Agreement;
  createdNow: boolean;
};

const isSigningAgreementRecord = (
  agreement: Pick<Agreement, "contentType" | "signingProvider">,
) =>
  agreement.contentType === "SIGNING" ||
  agreement.signingProvider === "DOCUMENSO";

export default function AgreementSheet({
  defaultData,
  editAgreement,
  isOpen,
  setIsOpen,
  isOnlyView = false,
  startSigningAuthoring = false,
  onClose,
  onSaved,
}: {
  defaultData?: {
    name: string;
    link: string;
    requireName: boolean;
    contentType?: string;
    textContent?: string;
  } | null;
  editAgreement?: Agreement | null;
  isOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  isOnlyView?: boolean;
  startSigningAuthoring?: boolean;
  onClose?: () => void;
  onSaved?: (agreement: Agreement) => void;
}) {
  const teamInfo = useTeam();
  const teamId = teamInfo?.currentTeam?.id;
  const isEditing = !!editAgreement;
  const [data, setData] = useState<AgreementFormState>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [signingFile, setSigningFile] = useState<File | null>(null);
  const [urlError, setUrlError] = useState("");
  const [isUrlValid, setIsUrlValid] = useState(true);
  const [createdAgreement, setCreatedAgreement] = useState<Agreement | null>(
    null,
  );
  const [pendingSigningAgreement, setPendingSigningAgreement] =
    useState<Agreement | null>(null);
  const [signingSetup, setSigningSetup] = useState<SigningSetupResponse | null>(
    null,
  );
  const [isSyncingTemplate, setIsSyncingTemplate] = useState(false);
  const [isLoadingSigningAuthoring, setIsLoadingSigningAuthoring] =
    useState(false);
  const [signingRun, setSigningRun] = useState<PendingSigningRun | null>(null);
  const autoStartedSigningAuthoringRef = useRef<string | null>(null);
  // Tracks the run id we've already finalized so the realtime effect and the
  // watchdog timeout can never resolve the same run twice.
  const signingRunFinalizedRef = useRef<string | null>(null);

  useEffect(() => {
    if (editAgreement) {
      const contentType = editAgreement.contentType || "SIGNING";
      setData({
        name: editAgreement.name || "",
        link: contentType === "LINK" ? editAgreement.content || "" : "",
        textContent: contentType === "TEXT" ? editAgreement.content || "" : "",
        contentType,
        requireName: editAgreement.requireName ?? true,
      });
    } else if (defaultData) {
      setData({
        name: defaultData.name || "",
        link: defaultData.link || "",
        textContent: defaultData.textContent || "",
        contentType: defaultData.contentType || "SIGNING",
        requireName: defaultData.requireName ?? true,
      });
    }
  }, [defaultData, editAgreement]);

  const resetState = () => {
    setData(initialData);
    setCurrentFile(null);
    setSigningFile(null);
    setIsLoading(false);
    setUrlError("");
    setIsUrlValid(true);
    setCreatedAgreement(null);
    setPendingSigningAgreement(null);
    setSigningSetup(null);
    setIsSyncingTemplate(false);
    setIsLoadingSigningAuthoring(false);
    setSigningRun(null);
    autoStartedSigningAuthoringRef.current = null;
    signingRunFinalizedRef.current = null;
  };

  const handleClose = (open: boolean) => {
    setIsOpen(open);

    if (!open) {
      resetState();
      onClose?.();
    }
  };

  const validateUrl = (url: string) => {
    if (!url.trim()) {
      setUrlError("");
      setIsUrlValid(true);
      return;
    }

    try {
      agreementUrlSchema.parse(url);
      setUrlError("");
      setIsUrlValid(true);
    } catch (error) {
      if (error instanceof z.ZodError) {
        setUrlError(error.errors[0]?.message || "Invalid URL");
        setIsUrlValid(false);
      }
    }
  };

  const startSigningTemplateSetup = async ({
    agreementId,
    file,
  }: {
    agreementId: string;
    file: File;
  }): Promise<SigningSetupRunResponse> => {
    if (!teamId) {
      throw new Error("Team context is missing.");
    }

    if (file.size > MAX_SIGNING_TEMPLATE_PDF_BYTES) {
      throw new Error(getSigningTemplateTooLargeMessage());
    }

    const { type, data, fileSize } = await putFile({
      file,
      teamId,
    });

    if (!type || !data || !fileSize) {
      throw new Error("Failed to upload the agreement template.");
    }

    const response = await fetch(
      `/api/teams/${teamId}/agreements/${agreementId}/signing/setup`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signer-Count": String(SIGNING_RECIPIENT_COUNT),
        },
        body: JSON.stringify({
          fileName: file.name,
          contentType: SIGNING_TEMPLATE_PDF_CONTENT_TYPE,
          file: {
            data,
            storageType: type,
            fileSize,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(errorText || "Failed to upload the agreement template.");
    }

    const { runId, publicAccessToken } =
      (await response.json()) as SigningSetupRunResponse;

    if (!runId || !publicAccessToken) {
      throw new Error("Failed to start the signing template authoring flow.");
    }

    return { runId, publicAccessToken };
  };

  // One-shot finalize once the run reports COMPLETED — the presign token must be minted server-side, not polled.
  const fetchSigningSetupResult = useCallback(
    async ({
      agreementId,
      runId,
    }: {
      agreementId: string;
      runId: string;
    }): Promise<SigningSetupResponse> => {
      if (!teamId) {
        throw new Error("Team context is missing.");
      }

      const statusResponse = await fetch(
        `/api/teams/${teamId}/agreements/${agreementId}/signing/setup-status?runId=${encodeURIComponent(
          runId,
        )}`,
      );

      if (!statusResponse.ok) {
        const errorText = await statusResponse.text().catch(() => "");
        throw new Error(
          errorText || "Failed to start the signing template authoring flow.",
        );
      }

      return (await statusResponse.json()) as SigningSetupResponse;
    },
    [teamId],
  );

  // Best-effort rollback: a SIGNING agreement without a template/envelope is
  // unusable, so soft-delete the row we just created if template setup fails.
  const rollbackAgreement = useCallback(
    async (agreementId: string) => {
      if (!teamId) {
        return;
      }

      try {
        await fetch(`/api/teams/${teamId}/agreements/${agreementId}`, {
          method: "PUT",
        });
      } catch (error) {
        console.error(
          "Failed to roll back agreement after template setup error.",
          error,
        );
      }
    },
    [teamId],
  );

  const { run: signingSetupRun, error: signingSetupRunError } = useRealtimeRun(
    signingRun?.runId,
    {
      accessToken: signingRun?.accessToken,
      enabled: !!signingRun,
    },
  );

  const failSigningRun = useCallback(
    async (run: PendingSigningRun, message: string) => {
      if (signingRunFinalizedRef.current === run.runId) {
        return;
      }
      signingRunFinalizedRef.current = run.runId;

      if (run.createdNow) {
        // Roll back the row we just created so we never persist a SIGNING
        // agreement without a template.
        await rollbackAgreement(run.agreement.id);
        mutate(`/api/teams/${teamId}/agreements`);
      }

      setSigningRun(null);
      setPendingSigningAgreement(null);
      toast.error(message);
    },
    [rollbackAgreement, teamId],
  );

  // Drive signing template setup from Trigger.dev Realtime instead of polling:
  // react to the run's terminal state as it streams in.
  useEffect(() => {
    if (!signingRun || signingRunFinalizedRef.current === signingRun.runId) {
      return;
    }

    if (signingSetupRunError) {
      void failSigningRun(
        signingRun,
        signingSetupRunError.message ||
          "Failed to start the signing template authoring flow.",
      );
      return;
    }

    const status = signingSetupRun?.status;

    if (status && SIGNING_SETUP_FAILURE_STATUSES.has(status)) {
      void failSigningRun(
        signingRun,
        "Failed to start the signing template authoring flow.",
      );
      return;
    }

    if (status === "COMPLETED") {
      const run = signingRun;
      // Claim the run before the async finalize so re-renders (e.g. metadata
      // updates) can't kick off a second finalize.
      signingRunFinalizedRef.current = run.runId;

      void (async () => {
        try {
          const setup = await fetchSigningSetupResult({
            agreementId: run.agreement.id,
            runId: run.runId,
          });
          setCreatedAgreement(run.agreement);
          setSigningSetup(setup);
          setSigningRun(null);
          setPendingSigningAgreement(null);
        } catch (error) {
          console.error(error);
          // Release the guard so the shared failure handler can run.
          signingRunFinalizedRef.current = null;
          await failSigningRun(
            run,
            error instanceof Error
              ? error.message
              : "Failed to start the signing template authoring flow.",
          );
        }
      })();
    }
  }, [
    signingRun,
    signingSetupRun?.status,
    signingSetupRunError,
    failSigningRun,
    fetchSigningSetupResult,
  ]);

  // Watchdog: never leave the UI spinning if realtime stalls (e.g. the run is
  // stuck QUEUED or the subscription drops without a terminal state).
  useEffect(() => {
    if (!signingRun) {
      return;
    }

    const run = signingRun;
    const timeoutId = setTimeout(() => {
      void failSigningRun(
        run,
        "Signing template setup is taking longer than expected. Please try again.",
      );
    }, SIGNING_SETUP_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [signingRun, failSigningRun]);

  const openExistingSigningTemplate = useCallback(
    async (agreement: Agreement) => {
      if (!teamId) {
        toast.error("Team context is not ready yet. Please try again.");
        return;
      }

      if (!isSigningAgreementRecord(agreement)) {
        toast.error("Only embedded signing agreements can edit fields.");
        return;
      }

      if (!agreement.signingEnvelopeId) {
        toast.error(
          "This signing agreement is missing its template. Please create a new signing agreement.",
        );
        return;
      }

      setIsLoadingSigningAuthoring(true);

      try {
        const response = await fetch(
          `/api/teams/${teamId}/agreements/${agreement.id}/signing/presign`,
          {
            method: "POST",
          },
        );

        if (!response.ok) {
          const errorPayload = (await response
            .clone()
            .json()
            .catch(() => null)) as { error?: string; message?: string } | null;
          const errorText = await response.text().catch(() => "");
          throw new Error(
            errorPayload?.error ||
              errorPayload?.message ||
              errorText ||
              "Failed to open the signing editor.",
          );
        }

        const setup = (await response.json()) as SigningSetupResponse;

        if (!setup.envelopeId) {
          throw new Error(
            "This signing agreement is missing its template. Please create a new signing agreement.",
          );
        }

        setCreatedAgreement(agreement);
        setSigningSetup(setup);
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to open the signing editor.",
        );
      } finally {
        setIsLoadingSigningAuthoring(false);
      }
    },
    [teamId],
  );

  useEffect(() => {
    if (!isOpen || !startSigningAuthoring || !editAgreement || !teamId) {
      return;
    }

    if (!isSigningAgreementRecord(editAgreement)) {
      return;
    }

    if (autoStartedSigningAuthoringRef.current === editAgreement.id) {
      return;
    }

    autoStartedSigningAuthoringRef.current = editAgreement.id;
    void openExistingSigningTemplate(editAgreement);
  }, [
    editAgreement,
    isOpen,
    openExistingSigningTemplate,
    startSigningAuthoring,
    teamId,
  ]);

  const uploadBrowserFile = useCallback(
    async (file: File) => {
      if (isOnlyView) {
        setIsOpen(false);
        toast.error("Cannot upload file in view mode!");
        return;
      }

      if (!teamId) {
        toast.error("Team context is not ready yet. Please try again.");
        return;
      }

      try {
        setIsLoading(true);

        const contentType = file.type;
        const supportedFileType = getSupportedContentType(contentType);

        if (
          !supportedFileType ||
          (supportedFileType !== "pdf" && supportedFileType !== "docs")
        ) {
          toast.error(
            "Unsupported file format. Please upload a PDF or Word file.",
          );
          return;
        }

        const { type, data, numPages, fileSize } = await putFile({
          file,
          teamId,
        });

        const documentData: DocumentData = {
          name: file.name,
          key: data!,
          storageType: type!,
          contentType,
          supportedFileType,
          fileSize,
        };

        const response = await createAgreementDocument({
          documentData,
          teamId,
          numPages,
        });

        if (response) {
          const document = await response.json();
          const linkId = document.links[0].id;
          setData((prevData) => ({
            ...prevData,
            link: `https://www.papermark.com/view/${linkId}`,
          }));
        }
      } catch (error) {
        console.error("An error occurred while uploading the file: ", error);
      } finally {
        setCurrentFile(null);
        setIsLoading(false);
      }
    },
    [isOnlyView, setIsOpen, teamId],
  );

  // Trigger uploads from the file-picker event via a setter wrapper (not an effect on `currentFile`) to avoid re-runs on unrelated dependency changes.
  // Side effects stay out of the state updater (StrictMode may invoke it twice); functional updates are passed through unchanged.
  const contentTypeRef = useRef(data.contentType);
  contentTypeRef.current = data.contentType;

  const setCurrentFileForLinkUpload = useCallback<
    Dispatch<SetStateAction<File | null>>
  >(
    (value) => {
      if (typeof value === "function") {
        setCurrentFile(value);
        return;
      }

      setCurrentFile(value);

      if (value && contentTypeRef.current === "LINK") {
        // Fire-and-forget so the picker stays responsive; errors surface via toast in `uploadBrowserFile`.
        void uploadBrowserFile(value);
      }
    },
    [uploadBrowserFile],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (isOnlyView) {
      handleClose(false);
      toast.error("Agreement cannot be created in view mode");
      return;
    }

    if (!teamId) {
      toast.error("Missing team context");
      return;
    }

    if (data.contentType === "LINK") {
      try {
        agreementUrlSchema.parse(data.link);
      } catch (error) {
        if (error instanceof z.ZodError) {
          toast.error(error.errors[0]?.message || "Please enter a valid URL");
          return;
        }
      }
    }

    if (data.contentType === "TEXT" && !data.textContent.trim()) {
      toast.error("Please enter agreement text content");
      return;
    }

    if (!isEditing && data.contentType === "SIGNING") {
      if (!signingFile) {
        toast.error("Upload the PDF you want signers to sign.");
        return;
      }

      if (signingFile.type !== SIGNING_TEMPLATE_PDF_CONTENT_TYPE) {
        toast.error("Signing templates currently support PDF files only.");
        return;
      }

      if (signingFile.size > MAX_SIGNING_TEMPLATE_PDF_BYTES) {
        toast.error(getSigningTemplateTooLargeMessage());
        return;
      }
    }

    setIsLoading(true);

    try {
      if (isEditing && editAgreement) {
        const updateBody: {
          name: string;
          requireName: boolean;
          content?: string;
        } = {
          name: data.name,
          requireName: data.requireName,
        };

        if (data.contentType === "LINK") {
          updateBody.content = data.link;
        } else if (data.contentType === "TEXT") {
          updateBody.content = data.textContent;
        }

        const response = await fetch(
          `/api/teams/${teamId}/agreements/${editAgreement.id}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(updateBody),
          },
        );

        if (!response.ok) {
          const result = await response.json().catch(() => null);
          toast.error(result?.error || "Error updating agreement");
          return;
        }

        const updated = (await response.json()) as Agreement;
        mutate(`/api/teams/${teamId}/agreements`);
        onSaved?.(updated);
        toast.success("Agreement updated");
        handleClose(false);
        return;
      }

      let agreement = pendingSigningAgreement;
      let createdNow = false;

      if (!agreement) {
        const submitData = {
          name: data.name,
          contentType: data.contentType,
          content:
            data.contentType === "LINK"
              ? data.link
              : data.contentType === "TEXT"
                ? data.textContent
                : undefined,
          requireName: data.requireName,
        };

        const response = await fetch(`/api/teams/${teamId}/agreements`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(submitData),
        });

        if (!response.ok) {
          const result = await response.json().catch(() => null);
          toast.error(result?.error || "Error creating agreement");
          return;
        }

        agreement = (await response.json()) as Agreement;
        createdNow = true;
        mutate(`/api/teams/${teamId}/agreements`);
      }

      if (data.contentType === "SIGNING" && signingFile) {
        setPendingSigningAgreement(agreement);
        signingRunFinalizedRef.current = null;

        try {
          const { runId, publicAccessToken } = await startSigningTemplateSetup({
            agreementId: agreement.id,
            file: signingFile,
          });
          // Hand off to the realtime subscription, which finalizes the setup
          // (or rolls back) once the run reaches a terminal state.
          setSigningRun({
            runId,
            accessToken: publicAccessToken,
            agreement,
            createdNow,
          });
        } catch (error) {
          console.error(error);
          // Failed before the run started: roll back so we never persist a templateless SIGNING agreement, and clear pendingSigningAgreement so the next attempt creates a fresh row.
          if (createdNow) {
            await rollbackAgreement(agreement.id);
            mutate(`/api/teams/${teamId}/agreements`);
          }
          setPendingSigningAgreement(null);
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to start the signing template authoring flow.",
          );
        }
        return;
      }

      onSaved?.(agreement);
      toast.success("Agreement created");
      handleClose(false);
    } catch (error) {
      console.error(error);
      toast.error("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnvelopeSaved = async (envelopeId: string) => {
    if (!teamId || !createdAgreement) {
      toast.error("Missing agreement context for signing sync.");
      return;
    }

    setIsSyncingTemplate(true);

    try {
      const response = await fetch(
        `/api/teams/${teamId}/agreements/${createdAgreement.id}/signing/sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ envelopeId }),
        },
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const updatedAgreement = (await response.json()) as Agreement;

      mutate(`/api/teams/${teamId}/agreements`);
      onSaved?.(updatedAgreement);
      toast.success("Agreement template saved.");
      handleClose(false);
    } catch (error) {
      console.error(error);
      toast.error("Failed to sync the agreement with the signing provider.");
    } finally {
      setIsSyncingTemplate(false);
    }
  };

  const showSigningAuthoring = !!createdAgreement && !!signingSetup;
  const showSigningAuthoringLoader =
    startSigningAuthoring &&
    isEditing &&
    isLoadingSigningAuthoring &&
    !showSigningAuthoring;
  const showSigningSetupLoader = !!signingRun && !showSigningAuthoring;
  const signingSetupStatusText =
    (signingSetupRun?.metadata as { status?: { text?: string } } | undefined)
      ?.status?.text ?? "Preparing signing template...";

  return (
    <Sheet open={isOpen} onOpenChange={handleClose}>
      <SheetContent
        className={`flex h-full flex-col justify-between bg-background px-4 text-foreground md:px-5 ${
          showSigningAuthoring || showSigningAuthoringLoader
            ? "w-[96vw] sm:max-w-5xl"
            : "w-[85%] sm:w-[500px]"
        }`}
      >
        <SheetHeader className="text-start">
          <SheetTitle>
            {showSigningAuthoring
              ? isEditing
                ? "Edit signing fields"
                : "Place signing fields"
              : isOnlyView
                ? "View Agreement"
                : isEditing
                  ? "Edit agreement"
                  : "Create a new agreement"}
          </SheetTitle>
          <SheetDescription>
            {showSigningAuthoring
              ? isEditing
                ? 'Adjust the signing fields on the PDF, then click "Update Template" in the editor to save.'
                : 'Drag the signature, name, and date fields onto the PDF, then click "Update Template" in the editor to finish.'
              : isOnlyView
                ? "View the details of this agreement."
                : isEditing
                  ? "Update the display name, requirements, and content of this agreement."
                  : "Create an agreement that visitors must complete before they can access your link."}
          </SheetDescription>
        </SheetHeader>

        {showSigningAuthoringLoader ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pt-4 text-sm text-muted-foreground">
            <LoadingSpinner className="h-8 w-8" />
            <p>Opening signing editor...</p>
          </div>
        ) : showSigningAuthoring ? (
          <div className="flex min-h-0 flex-1 flex-col pt-4">
            <SigningTemplateAuthoring
              host={signingSetup.host}
              presignToken={signingSetup.presignToken}
              externalId={signingSetup.externalId}
              envelopeId={signingSetup.envelopeId}
              onEnvelopeSaved={handleEnvelopeSaved}
            />
          </div>
        ) : showSigningSetupLoader ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pt-4 text-sm text-muted-foreground">
            <LoadingSpinner className="h-8 w-8" />
            <p>{signingSetupStatusText}</p>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <form className="flex grow flex-col" onSubmit={handleSubmit}>
              <div className="flex-grow space-y-6 pt-2">
                <div className="w-full space-y-2">
                  <Label htmlFor="name">Display name</Label>
                  <Input
                    className="flex w-full rounded-md border-0 bg-background py-1.5 text-foreground shadow-sm ring-1 ring-inset ring-input placeholder:text-muted-foreground focus:ring-2 focus:ring-inset focus:ring-gray-400 sm:text-sm sm:leading-6"
                    id="name"
                    type="text"
                    name="name"
                    required
                    autoComplete="off"
                    data-1p-ignore
                    placeholder="Standard NDA"
                    value={data.name}
                    onChange={(event) =>
                      setData((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    disabled={isOnlyView}
                  />
                </div>

                <div>
                  <LinkItem
                    title="Require viewer's name"
                    enabled={data.requireName}
                    action={() =>
                      setData((prev) => ({
                        ...prev,
                        requireName: !prev.requireName,
                      }))
                    }
                    isAllowed={!isOnlyView}
                  />
                </div>

                <div className="space-y-4">
                  <div className="w-full space-y-2">
                    <Label>Agreement Type</Label>
                    <RadioGroup
                      value={data.contentType}
                      onValueChange={(value) =>
                        setData((prev) => ({
                          ...prev,
                          contentType: value,
                        }))
                      }
                      disabled={isOnlyView || isEditing}
                      className="flex flex-col space-y-2"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="SIGNING" id="signing-type" />
                        <Label htmlFor="signing-type">
                          Embedded signature flow
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="LINK" id="link-type" />
                        <Label htmlFor="link-type">Legacy link document</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="TEXT" id="text-type" />
                        <Label htmlFor="text-type">Legacy text content</Label>
                      </div>
                    </RadioGroup>
                    {isEditing ? (
                      <p className="text-xs text-muted-foreground">
                        The agreement type cannot be changed after creation.
                      </p>
                    ) : null}
                  </div>

                  {data.contentType === "SIGNING" && !isEditing ? (
                    <div className="space-y-2">
                      <Label>Upload the agreement PDF</Label>
                      <DocumentUpload
                        currentFile={signingFile}
                        setCurrentFile={setSigningFile}
                        pdfOnly
                        maxSizeBytes={MAX_SIGNING_TEMPLATE_PDF_BYTES}
                        maxSizeErrorMessage={getSigningTemplateTooLargeMessage()}
                      />
                      <p className="text-xs text-muted-foreground">
                        PDF only, max 30 MB. After upload you place the
                        viewer&apos;s signature, name, and date fields directly
                        on the document.
                      </p>
                    </div>
                  ) : null}

                  {data.contentType === "SIGNING" && isEditing ? (
                    <div className="space-y-3 rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                      <p>
                        The signed PDF and field placement are managed in the
                        signing template. Reopen the signing editor to adjust
                        the viewer&apos;s signature, name, and date fields.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={isLoadingSigningAuthoring}
                        disabled={
                          isLoadingSigningAuthoring ||
                          !editAgreement?.signingEnvelopeId
                        }
                        onClick={() => {
                          if (editAgreement) {
                            void openExistingSigningTemplate(editAgreement);
                          }
                        }}
                      >
                        Edit signing fields
                      </Button>
                      {!editAgreement?.signingEnvelopeId ? (
                        <p>
                          This agreement is missing its signing template. Create
                          a new signing agreement to replace the document.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {data.contentType === "LINK" ? (
                    <div className="w-full space-y-2">
                      <Label htmlFor="link">Link to an agreement</Label>
                      <Input
                        className={`flex w-full rounded-md border-0 bg-background py-1.5 text-foreground shadow-sm ring-1 ring-inset placeholder:text-muted-foreground focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${
                          !isUrlValid
                            ? "ring-red-500 focus:ring-red-500"
                            : "ring-input focus:ring-gray-400"
                        }`}
                        id="link"
                        type="text"
                        name="link"
                        required
                        autoComplete="off"
                        data-1p-ignore
                        placeholder="https://www.papermark.com/nda"
                        value={data.link}
                        onChange={(event) => {
                          const newValue = event.target.value;
                          setData((prev) => ({
                            ...prev,
                            link: newValue,
                          }));
                          validateUrl(newValue);
                        }}
                        onBlur={(event) => validateUrl(event.target.value)}
                        disabled={isOnlyView}
                      />
                      {urlError ? (
                        <p className="mt-1 text-sm text-red-500">{urlError}</p>
                      ) : null}

                      {!isOnlyView ? (
                        <div className="space-y-12">
                          <div className="space-y-2 pb-6">
                            <Label>Or upload an agreement</Label>
                            <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
                              <DocumentUpload
                                currentFile={currentFile}
                                setCurrentFile={setCurrentFileForLinkUpload}
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {data.contentType === "TEXT" ? (
                    <div className="w-full space-y-2">
                      <Label htmlFor="textContent">Agreement Text</Label>
                      <Textarea
                        className="flex w-full rounded-md border-0 bg-background py-1.5 text-foreground shadow-sm ring-1 ring-inset ring-input placeholder:text-muted-foreground focus:ring-2 focus:ring-inset focus:ring-gray-400 sm:text-sm sm:leading-6"
                        id="textContent"
                        name="textContent"
                        required
                        placeholder="By accessing this document, you agree to maintain confidentiality of all information contained herein and not to share, copy, or distribute any content without prior written consent..."
                        value={data.textContent}
                        onChange={(event) =>
                          setData((prev) => ({
                            ...prev,
                            textContent: event.target.value,
                          }))
                        }
                        disabled={isOnlyView}
                        rows={6}
                        maxLength={1500}
                      />
                      <div className="flex justify-between text-xs">
                        <p className="text-muted-foreground">
                          This text will be displayed to users as a compliance
                          agreement before they can access the content.
                        </p>
                        <p
                          className={`${
                            data.textContent.length > 1400
                              ? "text-orange-500"
                              : "text-muted-foreground"
                          } ${
                            data.textContent.length >= 1500
                              ? "font-semibold text-red-500"
                              : ""
                          }`}
                        >
                          {data.textContent.length}/1500
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <SheetFooter
                className={`flex-shrink-0 ${isOnlyView ? "mt-6" : ""}`}
              >
                <div className="flex items-center">
                  {isOnlyView ? (
                    <Button type="button" onClick={() => handleClose(false)}>
                      Close
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      loading={isLoading}
                      disabled={
                        isLoadingSigningAuthoring ||
                        (data.contentType === "LINK" &&
                          !isUrlValid &&
                          data.link.trim() !== "") ||
                        (data.contentType === "TEXT" &&
                          !data.textContent.trim()) ||
                        (!isEditing &&
                          data.contentType === "SIGNING" &&
                          !signingFile) ||
                        !data.name.trim()
                      }
                    >
                      {isEditing
                        ? "Save changes"
                        : data.contentType === "SIGNING"
                          ? "Continue to field placement"
                          : "Create Agreement"}
                    </Button>
                  )}
                </div>
              </SheetFooter>
            </form>
          </ScrollArea>
        )}

        {showSigningAuthoring ? (
          <SheetFooter className="mt-4 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={isSyncingTemplate}
              >
                Cancel
              </Button>
              {isSyncingTemplate ? (
                <Button type="button" disabled loading>
                  Saving template...
                </Button>
              ) : null}
            </div>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
