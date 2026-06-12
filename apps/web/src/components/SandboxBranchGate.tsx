import { GitBranchIcon, GitBranchPlusIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  SANDBOX_NEW_BRANCH_PATTERN,
  type SandboxBranchOption,
  type SandboxBranchSelection,
  type SandboxGate,
} from "~/hooks/useSandboxRuntime";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";

const CREATE_BRANCH_VALUE = "__create-new-branch__";

interface SandboxBranchGateProps {
  gate: SandboxGate;
  onConfirm: (selection: SandboxBranchSelection) => void;
}

function branchLabel(branch: SandboxBranchOption): string {
  return branch.current ? `${branch.name} (current)` : branch.name;
}

function validateNewBranchName(
  name: string,
  existingBranches: ReadonlyArray<SandboxBranchOption>,
): string | null {
  if (name.length === 0) {
    return null;
  }
  if (/\s/.test(name)) {
    return "No spaces allowed.";
  }
  if (!SANDBOX_NEW_BRANCH_PATTERN.test(name)) {
    return "Use letters, numbers, and dashes only (no leading or trailing dash).";
  }
  if (existingBranches.some((branch) => branch.name === name)) {
    return "A branch with this name already exists.";
  }
  return null;
}

/**
 * Full-screen gate shown on every page load: pick the branch to work on —
 * or create a fresh feature branch — before the sandbox open sequence
 * (sign-in, setup, startup) runs.
 */
export const SandboxBranchGate = memo(function SandboxBranchGate({
  gate,
  onConfirm,
}: SandboxBranchGateProps) {
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");

  const currentBranch = gate.phase === "select" ? gate.currentBranch : null;
  useEffect(() => {
    setSelectedValue(currentBranch);
  }, [currentBranch]);

  const isCreating = selectedValue === CREATE_BRANCH_VALUE;
  const branches = gate.phase === "select" ? gate.branches : [];
  const trimmedNewBranchName = newBranchName.trim();
  const newBranchError = useMemo(
    () => (isCreating ? validateNewBranchName(trimmedNewBranchName, branches) : null),
    [branches, isCreating, trimmedNewBranchName],
  );

  if (gate.phase === "hidden") {
    return null;
  }

  const selection: SandboxBranchSelection | null = isCreating
    ? trimmedNewBranchName.length > 0 && newBranchError === null
      ? { kind: "create", name: trimmedNewBranchName }
      : null
    : selectedValue !== null
      ? { kind: "existing", name: selectedValue }
      : null;

  const confirm = () => {
    if (selection !== null) {
      onConfirm(selection);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-5 px-8">
        <div className="space-y-1.5 text-center">
          <h1 className="text-lg font-semibold text-foreground">Open project</h1>
          <p className="text-sm text-muted-foreground">
            {gate.phase === "loading"
              ? "Fetching branches..."
              : "Choose the branch to work on, or start a new one. Switching branches restarts the project."}
          </p>
        </div>

        {gate.phase === "loading" ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-5" aria-label="Loading branches" />
          </div>
        ) : (
          <div className="space-y-3">
            <Select
              value={selectedValue ?? ""}
              onValueChange={(value) => setSelectedValue(value === "" ? null : value)}
            >
              <SelectTrigger className="w-full" aria-label="Branch" disabled={gate.busy}>
                <span className="flex min-w-0 items-center gap-2">
                  {isCreating ? (
                    <GitBranchPlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    <span className="min-w-0 truncate">
                      {isCreating ? "New branch..." : (selectedValue ?? "Select a branch")}
                    </span>
                  </SelectValue>
                </span>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} className="max-h-72 w-(--anchor-width)">
                <SelectItem hideIndicator value={CREATE_BRANCH_VALUE}>
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranchPlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">New branch...</span>
                  </span>
                </SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch.name} hideIndicator value={branch.name}>
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{branchLabel(branch)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            {isCreating && (
              <div className="space-y-1.5">
                <Input
                  autoFocus
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      confirm();
                    }
                  }}
                  placeholder="my-new-feature"
                  aria-label="New branch name"
                  aria-invalid={newBranchError !== null}
                  disabled={gate.busy}
                />
                <p
                  className={
                    newBranchError !== null
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {newBranchError ??
                    `Branches off ${currentBranch ?? "the current branch"}. Letters, numbers, and dashes.`}
                </p>
              </div>
            )}

            <Button className="w-full" disabled={gate.busy || selection === null} onClick={confirm}>
              {gate.busy ? (
                <>
                  <Spinner className="size-3.5" aria-hidden />
                  Opening...
                </>
              ) : isCreating ? (
                "Create branch & open"
              ) : (
                "Open"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
