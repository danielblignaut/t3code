import { GitBranchIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import type { SandboxBranchOption, SandboxGate } from "~/hooks/useSandboxRuntime";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";

interface SandboxBranchGateProps {
  gate: SandboxGate;
  onConfirm: (branchName: string | null) => void;
}

function branchLabel(branch: SandboxBranchOption): string {
  return branch.current ? `${branch.name} (current)` : branch.name;
}

/**
 * Full-screen gate shown on every page load: pick the branch to work on
 * before the sandbox open sequence (sign-in, setup, startup) runs.
 */
export const SandboxBranchGate = memo(function SandboxBranchGate({
  gate,
  onConfirm,
}: SandboxBranchGateProps) {
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  const currentBranch = gate.phase === "select" ? gate.currentBranch : null;
  useEffect(() => {
    setSelectedBranch(currentBranch);
  }, [currentBranch]);

  if (gate.phase === "hidden") {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-5 px-8">
        <div className="space-y-1.5 text-center">
          <h1 className="text-lg font-semibold text-foreground">Open project</h1>
          <p className="text-sm text-muted-foreground">
            {gate.phase === "loading"
              ? "Fetching branches..."
              : "Choose the branch to work on. Switching branches restarts the project."}
          </p>
        </div>

        {gate.phase === "loading" ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-5" aria-label="Loading branches" />
          </div>
        ) : (
          <div className="space-y-3">
            <Select
              value={selectedBranch ?? ""}
              onValueChange={(value) => setSelectedBranch(value === "" ? null : value)}
            >
              <SelectTrigger className="w-full" aria-label="Branch" disabled={gate.busy}>
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue>
                    <span className="min-w-0 truncate">{selectedBranch ?? "Select a branch"}</span>
                  </SelectValue>
                </span>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} className="max-h-72 w-(--anchor-width)">
                {gate.branches.map((branch) => (
                  <SelectItem key={branch.name} hideIndicator value={branch.name}>
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{branchLabel(branch)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            <Button
              className="w-full"
              disabled={gate.busy || selectedBranch === null}
              onClick={() => onConfirm(selectedBranch)}
            >
              {gate.busy ? (
                <>
                  <Spinner className="size-3.5" aria-hidden />
                  Opening...
                </>
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
