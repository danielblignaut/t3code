import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Replaces the worktree/branch toolbar in single-project sandbox mode: the
 * row under the composer only hosts the settings entry point.
 */
export const ComposerSettingsBar = memo(function ComposerSettingsBar() {
  const navigate = useNavigate();
  const openSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  return (
    <div className="mx-auto flex w-full max-w-208 items-center gap-2 px-2.5 pb-3 pt-1 sm:px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              aria-label="Open settings"
              className="text-muted-foreground/70 hover:text-foreground/80"
              onClick={openSettings}
            >
              <SettingsIcon className="size-3" />
              Settings
            </Button>
          }
        />
        <TooltipPopup side="top">Open settings</TooltipPopup>
      </Tooltip>
    </div>
  );
});
