import type { SandboxPreviewUrl } from "@t3tools/contracts";
import { ExternalLinkIcon, GlobeIcon } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface PreviewUrlsControlProps {
  previewUrls: ReadonlyArray<SandboxPreviewUrl>;
}

export const PreviewUrlsControl = memo(function PreviewUrlsControl({
  previewUrls,
}: PreviewUrlsControlProps) {
  const [open, setOpen] = useState(false);
  const hasPreviewUrls = previewUrls.length > 0;

  const openPreviewUrl = (url: string) => {
    setOpen(false);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="shrink-0"
              aria-label="Open preview"
              variant="ghost"
              size="xs"
              disabled={!hasPreviewUrls}
              onClick={() => setOpen(true)}
            >
              <GlobeIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {hasPreviewUrls ? "Open a preview URL" : "No preview URLs configured for this project."}
        </TooltipPopup>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Open preview</DialogTitle>
            <DialogDescription>Pick a preview URL to open in a new tab.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2 px-6 py-5">
            {previewUrls.map((previewUrl) => (
              <button
                key={`${previewUrl.name}:${previewUrl.url}`}
                type="button"
                onClick={() => openPreviewUrl(previewUrl.url)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {previewUrl.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {previewUrl.url}
                  </span>
                </span>
                <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
});
