import { Toaster as Sonner, type ToasterProps } from "sonner";

import { cn, SCOPE } from "./lib/utils.js";

/**
 * Toast host styled like shadcn/ui's "sonner". `RemoteDesktop` reports events
 * with `toast()` from sonner (a peer dependency), so any sonner `<Toaster />`
 * the host renders shows them; render this one if the host has none.
 */
export function Toaster({ className, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      className={cn(SCOPE, "toaster group", className)}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
